import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildRoundInterventionCandidates, summarizeInterventionEvidence, type InterventionSubmission } from "@/lib/learning/intervention-policy";

const deliverySchema = z.object({ eventIds: z.array(z.string().uuid()).min(1).max(10) });

async function authMatch(matchId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  const { data: match } = await supabase.from("matches").select("id, room_id, current_round, status, blueprint, rooms(status)").eq("id", matchId).maybeSingle();
  if (!match) return { error: "Không tìm thấy trận", status: 404 } as const;
  return { supabase, admin, user: authData.user, match } as const;
}

export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const auth = await authMatch(matchId);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const roundValue = Number(new URL(request.url).searchParams.get("round") ?? auth.match.current_round);
  if (!Number.isInteger(roundValue) || roundValue < 1 || roundValue > auth.match.current_round) return NextResponse.json({ error: "Vòng không hợp lệ" }, { status: 400 });
  const room = Array.isArray(auth.match.rooms) ? auth.match.rooms[0] : auth.match.rooms;
  const revealed = roundValue < auth.match.current_round || auth.match.status === "completed" || ["ROUND_RESULT", "MATCH_RESULT", "AI_REVIEW"].includes(room?.status ?? "");
  if (!revealed) return NextResponse.json({ error: "Intervention chỉ được tạo sau khi đáp án đã mở" }, { status: 409 });
  const { data: existing } = await auth.admin.from("ai_intervention_events").select("id, policy_code, priority, instruction_vi, ui_message_vi, evidence, delivered_at").eq("match_id", matchId).eq("round_number", roundValue).order("priority", { ascending: false });
  if (existing?.length) return NextResponse.json({ events: existing }, { headers: { "Cache-Control": "private, no-store" } });
  const { data: question } = await auth.admin.from("questions").select("id, mode, prompt, time_limit").eq("match_id", matchId).eq("round_number", roundValue).maybeSingle();
  if (!question) return NextResponse.json({ error: "Không tìm thấy câu hỏi" }, { status: 404 });
  const [{ data: submissions }, { data: players }] = await Promise.all([
    auth.admin.from("submissions").select("user_id, is_correct, timed_out, response_ms, rubric_score, hints_used, match_type").eq("question_id", question.id),
    auth.admin.from("match_players").select("user_id").eq("match_id", matchId)
  ]);
  if ((submissions?.length ?? 0) < (players?.length ?? 2)) return NextResponse.json({ error: "Chưa đủ bằng chứng của cả hai người" }, { status: 409 });
  const policyInput = (submissions ?? []).map((row) => ({ is_correct: row.is_correct, timed_out: row.timed_out, rubric_score: row.rubric_score == null ? null : Number(row.rubric_score), hints_used: row.hints_used })) satisfies InterventionSubmission[];
  const evidence = { ...summarizeInterventionEvidence(question.mode, policyInput), responseMs: submissions?.map((row) => row.response_ms) ?? [] };
  const selected = buildRoundInterventionCandidates(question.mode, roundValue, policyInput);
  if (!selected.length) return NextResponse.json({ events: [] }, { headers: { "Cache-Control": "private, no-store" } });
  const { data: inserted, error } = await auth.admin.from("ai_intervention_events").upsert(selected.map((item) => ({ ...item, match_id: matchId, room_id: auth.match.room_id, round_number: roundValue, evidence })), { onConflict: "match_id,round_number,policy_code" }).select("id, policy_code, priority, instruction_vi, ui_message_vi, evidence, delivered_at").order("priority", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ events: inserted ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const auth = await authMatch(matchId);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = deliverySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Delivery receipt không hợp lệ" }, { status: 400 });
  const { error } = await auth.admin.from("ai_intervention_events").update({ delivered_at: new Date().toISOString() }).eq("match_id", matchId).in("id", parsed.data.eventIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ delivered: parsed.data.eventIds.length });
}
