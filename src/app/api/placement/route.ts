import { NextResponse } from "next/server";
import { z } from "zod";
import { generatePlacementItem, placementSkills, publicPlacementSession } from "@/lib/learning/adaptive-placement";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), targetCount: z.number().int().min(12).max(30).default(18) }),
  z.object({ action: z.literal("resume"), sessionId: z.string().uuid() }),
  z.object({ action: z.literal("answer"), sessionId: z.string().uuid(), itemId: z.string().uuid(), requestId: z.string().uuid(), answer: z.string().trim().min(1).max(2000), responseMs: z.number().int().min(0).max(3_600_000) })
]);

async function auth() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { supabase, admin, user: data.user } as const;
}

async function loadPublic(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, userId: string, sessionId?: string) {
  let query = admin.from("placement_sessions").select("id, status, ability_theta, information, standard_error, confidence, estimated_cefr, response_count, target_count, skill_cycle, current_item_id, generation_token, generation_started_at, result, started_at, completed_at, updated_at").eq("user_id", userId);
  query = sessionId ? query.eq("id", sessionId) : query.order("started_at", { ascending: false }).limit(1);
  const { data: session } = await query.maybeSingle();
  if (!session) return null;
  const { data: item } = session.current_item_id ? await admin.from("placement_items").select("id, position, skill, cefr_level, prompt, instruction, public_payload").eq("id", session.current_item_id).maybeSingle() : { data: null };
  return publicPlacementSession(session as unknown as Record<string, unknown>, item as Record<string, unknown> | null);
}

async function claimGeneration(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, userId: string, sessionId: string) {
  const token = crypto.randomUUID();
  const staleAt = new Date(Date.now() - 120_000).toISOString();
  const { data, error } = await admin.from("placement_sessions").update({ status: "generating", generation_token: token, generation_started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", userId).is("current_item_id", null).neq("status", "completed").or(`status.eq.active,and(status.eq.generating,generation_started_at.lt.${staleAt})`).select("id, ability_theta, response_count, skill_cycle, generation_token").maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function completeGeneration(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, session: { id: string; ability_theta: number; response_count: number; skill_cycle: string[]; generation_token: string }) {
  try { await generatePlacementItem(admin, { ...session, ability_theta: Number(session.ability_theta), generation_token: session.generation_token }); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Không tạo được placement item";
    const { data: failed } = await admin.from("placement_sessions").update({ status: "failed", generation_token: null, generation_started_at: null, result: { error: message }, updated_at: new Date().toISOString() }).eq("id", session.id).eq("generation_token", session.generation_token).select("id").maybeSingle();
    if (failed) throw new Error(message);
  }
}

export async function GET() {
  const current = await auth();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: current.status });
  return NextResponse.json({ session: await loadPublic(current.admin, current.user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const current = await auth();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: current.status });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu placement không hợp lệ", details: parsed.error.flatten() }, { status: 400 });

  if (parsed.data.action === "start") {
    await current.admin.from("placement_sessions").update({ status: "abandoned", updated_at: new Date().toISOString() }).eq("user_id", current.user.id).in("status", ["active", "generating"]);
    const generationToken = crypto.randomUUID();
    const { data: session, error } = await current.admin.from("placement_sessions").insert({ user_id: current.user.id, status: "generating", target_count: parsed.data.targetCount, skill_cycle: placementSkills, generation_token: generationToken, generation_started_at: new Date().toISOString() }).select("id, status, ability_theta, response_count, target_count, skill_cycle, generation_token").single();
    if (error || !session) return NextResponse.json({ error: error?.message ?? "Không tạo được placement session" }, { status: 400 });
    try {
      await completeGeneration(current.admin, { id: session.id, ability_theta: Number(session.ability_theta), response_count: session.response_count, skill_cycle: session.skill_cycle, generation_token: session.generation_token });
      return NextResponse.json({ session: await loadPublic(current.admin, current.user.id, session.id) }, { status: 201 });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Không tạo được placement item";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  if (parsed.data.action === "resume") {
    const claimed = await claimGeneration(current.admin, current.user.id, parsed.data.sessionId);
    if (!claimed) return NextResponse.json({ error: "Câu tiếp theo vẫn đang được tạo hoặc phiên đã có câu hoạt động" }, { status: 409 });
    try {
      await completeGeneration(current.admin, { id: claimed.id, ability_theta: Number(claimed.ability_theta), response_count: claimed.response_count, skill_cycle: claimed.skill_cycle, generation_token: claimed.generation_token });
      return NextResponse.json({ session: await loadPublic(current.admin, current.user.id, claimed.id) });
    } catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "Không khôi phục được placement" }, { status: 502 }); }
  }

  const { data: result, error } = await current.supabase.rpc("submit_placement_response", {
    target_session_id: parsed.data.sessionId,
    target_item_id: parsed.data.itemId,
    target_request_id: parsed.data.requestId,
    submitted_answer: parsed.data.answer,
    target_response_ms: parsed.data.responseMs
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  const response = result as { alreadyRecorded?: boolean; correct?: boolean; canonicalAnswer?: string; explanation?: string; session?: Record<string, unknown> };
  const sessionState = response.session;
  if (sessionState?.status !== "completed" && sessionState?.id) {
    try {
      const claimed = await claimGeneration(current.admin, current.user.id, String(sessionState.id));
      if (claimed) await completeGeneration(current.admin, { id: claimed.id, ability_theta: Number(claimed.ability_theta), response_count: claimed.response_count, skill_cycle: claimed.skill_cycle, generation_token: claimed.generation_token });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Không tạo được câu placement tiếp theo";
      return NextResponse.json({ error: message, grading: response }, { status: 502 });
    }
  }
  return NextResponse.json({ grading: { correct: response.correct, canonicalAnswer: response.canonicalAnswer, explanation: response.explanation }, session: await loadPublic(current.admin, current.user.id, parsed.data.sessionId) });
}
