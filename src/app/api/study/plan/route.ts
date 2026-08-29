import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const planSchema = z.object({
  title: z.string().min(3).max(120), cefrStart: z.string().max(10), cefrTarget: z.string().max(10),
  rationaleVi: z.string().min(10).max(1500), weeklyMinutes: z.number().int().min(30).max(2100),
  items: z.array(z.object({ skill: z.string().min(2).max(40), activityType: z.string().min(2).max(60), title: z.string().min(3).max(120), objective: z.string().min(5).max(500), targetMinutes: z.number().int().min(5).max(180), targetCount: z.number().int().min(1).max(200).nullable(), dueInDays: z.number().int().min(0).max(90) })).min(3).max(14)
});

function text(body: unknown) { return (body as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""; }

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: privacy } = await admin.from("privacy_preferences").select("allow_learning_analytics").eq("user_id", authData.user.id).maybeSingle();
  if (privacy?.allow_learning_analytics === false) return NextResponse.json({ error: "Bạn đã tắt phân tích học tập cá nhân trong phần quyền riêng tư" }, { status: 403 });
  const [profileResult, statsResult, errorsResult, reviewsResult, matchesResult] = await Promise.all([
    admin.from("profiles").select("cefr_estimate").eq("id", authData.user.id).single(),
    admin.from("user_learning_stats").select("*").eq("user_id", authData.user.id).maybeSingle(),
    admin.from("learning_errors").select("error_type, skill, prompt, expected_answer, occurrence_count, last_seen_at").eq("user_id", authData.user.id).is("resolved_at", null).order("occurrence_count", { ascending: false }).limit(30),
    admin.from("review_logs").select("rating, state, scheduled_days, reviewed_at").eq("user_id", authData.user.id).order("reviewed_at", { ascending: false }).limit(100),
    admin.from("match_players").select("score, correct_count, incorrect_count, avg_response_ms, matches!inner(title, topic, level, ended_at)").eq("user_id", authData.user.id).order("ended_at", { referencedTable: "matches", ascending: false }).limit(20)
  ]);
  const evidence = { cefr: profileResult.data?.cefr_estimate ?? "A1", stats: statsResult.data, unresolvedErrors: errorsResult.data ?? [], recentReviews: reviewsResult.data ?? [], recentMatches: matchesResult.data ?? [] };
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_PLANNING_MODEL || "gemini-3.7-flash").replace(/^models\//, "");
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY chưa được cấu hình" }, { status: 503 });
  const prompt = [
    "You are an adaptive English curriculum designer for a Vietnamese learner.",
    "Use only the supplied real evidence. Never invent completed activities, scores or errors. Return JSON only.",
    "Build a practical seven-day plan. Prioritize unresolved recurring errors and the weakest measured skills. Include FSRS review, listening, speaking, reading and production only when supported by evidence.",
    "Schema: {title:string,cefrStart:string,cefrTarget:string,rationaleVi:string,weeklyMinutes:number,items:{skill:string,activityType:string,title:string,objective:string,targetMinutes:number,targetCount:number|null,dueInDays:number}[]}",
    `Evidence: ${JSON.stringify(evidence)}`
  ].join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.25 } }), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ error: (body as { error?: { message?: string } }).error?.message ?? "Gemini không tạo được lộ trình" }, { status: 502 });
  let raw: unknown;
  try { raw = JSON.parse(text(body)); } catch { raw = null; }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Lộ trình AI không hợp lệ" }, { status: 502 });
  await admin.from("study_plans").update({ status: "archived", updated_at: new Date().toISOString() }).eq("user_id", authData.user.id).eq("status", "active");
  const { data: plan, error: planError } = await admin.from("study_plans").insert({ user_id: authData.user.id, title: parsed.data.title, cefr_start: parsed.data.cefrStart, cefr_target: parsed.data.cefrTarget, status: "active", rationale_vi: parsed.data.rationaleVi, weekly_minutes: parsed.data.weeklyMinutes, evidence_snapshot: evidence, provider: "gemini", model, starts_on: new Date().toISOString().slice(0, 10), ends_on: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }).select("id").single();
  if (planError || !plan) return NextResponse.json({ error: planError?.message ?? "Không lưu được lộ trình" }, { status: 500 });
  const items = parsed.data.items.map((item, index) => ({ plan_id: plan.id, sequence_number: index + 1, skill: item.skill, activity_type: item.activityType, title: item.title, objective: item.objective, target_minutes: item.targetMinutes, target_count: item.targetCount, source_filters: { onlyApprovedLicensedContent: true, prioritizeUserErrors: true }, due_on: new Date(Date.now() + item.dueInDays * 86_400_000).toISOString().slice(0, 10) }));
  const { error: itemError } = await admin.from("study_plan_items").insert(items);
  if (itemError) { await admin.from("study_plans").delete().eq("id", plan.id); return NextResponse.json({ error: itemError.message }, { status: 500 }); }
  return NextResponse.json({ planId: plan.id }, { status: 201 });
}
