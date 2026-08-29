import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const generatedPathSchema = z.object({
  rationaleVi: z.string().trim().min(10).max(1500),
  items: z.array(z.object({
    skill: z.enum(["vocabulary", "grammar", "reading", "listening", "writing", "speaking", "phonology", "mediation", "online_interaction"]),
    activityType: z.enum(["review", "match", "speaking", "listening", "reading", "writing", "placement", "reflection"]),
    title: z.string().trim().min(3).max(160),
    objective: z.string().trim().min(8).max(600),
    targetMinutes: z.number().int().min(5).max(180),
    targetCount: z.number().int().positive().max(500).nullable().default(null),
    daysFromStart: z.number().int().min(0).max(365),
    assignment: z.enum(["both", "creator", "partner"]),
    destination: z.enum(["/review", "/study", "/speaking", "/dashboard", "/placement", "/progress"])
  })).min(3).max(20)
});
const allowedDestination = { review: "/review", match: "/dashboard", speaking: "/speaking", listening: "/study", reading: "/study", writing: "/study", placement: "/placement", reflection: "/progress" } as const;

function responseText(body: unknown) {
  return (body as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
}

async function readAll<T>(loader: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const result = await loader(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < pageSize) return rows;
  }
}

export async function generateSharedLearningPath(admin: SupabaseClient, goalId: string) {
  const { data: goal, error: goalReadError } = await admin.from("shared_learning_goals").select("id, created_by, partner_id, title, target_cefr, focus_skills, status, partner_accepted_at, schedule, starts_on, target_date").eq("id", goalId).maybeSingle();
  if (goalReadError || !goal) throw new Error(goalReadError?.message ?? "Không tìm thấy shared goal");
  if (goal.status !== "generating" || !goal.partner_accepted_at) throw new Error("Cần partner đồng ý trước khi đọc evidence của cả hai");
  const { count: existingCount } = await admin.from("shared_learning_path_items").select("id", { count: "exact", head: true }).eq("goal_id", goal.id);
  if ((existingCount ?? 0) >= 3) {
    await admin.from("shared_learning_goals").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", goal.id).eq("status", "generating");
    return goal.id;
  }
  const input = { creatorId: goal.created_by, partnerId: goal.partner_id, title: goal.title, targetCefr: goal.target_cefr, focusSkills: goal.focus_skills, startsOn: goal.starts_on ?? undefined, targetDate: goal.target_date ?? undefined, schedule: goal.schedule as Record<string, unknown> };
  const now = new Date();
  const start = input.startsOn ? new Date(`${input.startsOn}T00:00:00Z`) : now;
  const [{ data: profiles }, { data: mastery }, placements, reviewCards, allEvidence] = await Promise.all([
    admin.from("profiles").select("id, display_name").in("id", [input.creatorId, input.partnerId]),
    admin.from("learner_skill_mastery").select("user_id, skill, mastery_score, confidence, evidence_count, cefr_evidence, latest_score, last_evidence_at").in("user_id", [input.creatorId, input.partnerId]).order("mastery_score"),
    readAll<{ user_id: string; estimated_cefr: string; confidence: number; standard_error: number; completed_at: string }>((from, to) => admin.from("placement_sessions").select("user_id, estimated_cefr, confidence, standard_error, completed_at").in("user_id", [input.creatorId, input.partnerId]).eq("status", "completed").order("completed_at", { ascending: false }).range(from, to)),
    readAll<{ user_id: string; skill: string; state: number; due_at: string; reps: number; lapses: number; difficulty: number; stability: number }>((from, to) => admin.from("review_cards").select("user_id, skill, state, due_at, reps, lapses, difficulty, stability").in("user_id", [input.creatorId, input.partnerId]).is("suspended_at", null).order("due_at").range(from, to)),
    readAll<{ user_id: string; skill: string; cefr_level: string; score: number; source_type: string; occurred_at: string }>((from, to) => admin.from("skill_evidence_events").select("user_id, skill, cefr_level, score, source_type, occurred_at").in("user_id", [input.creatorId, input.partnerId]).order("occurred_at", { ascending: false }).range(from, to))
  ]);
  const latestPlacement = [input.creatorId, input.partnerId].map((userId) => placements.find((row) => row.user_id === userId) ?? null);
  const reviewSummary = [...new Set(reviewCards.map((card) => `${card.user_id}:${card.skill}`))].map((key) => {
    const [userId, skill] = key.split(":"); const rows = reviewCards.filter((card) => card.user_id === userId && card.skill === skill);
    return { userId, skill, cards: rows.length, due: rows.filter((card) => new Date(card.due_at).getTime() <= now.getTime()).length, reps: rows.reduce((sum, card) => sum + card.reps, 0), lapses: rows.reduce((sum, card) => sum + card.lapses, 0), averageDifficulty: rows.length ? rows.reduce((sum, card) => sum + Number(card.difficulty), 0) / rows.length : 0 };
  });
  const evidenceSummary = [...new Set(allEvidence.map((event) => `${event.user_id}:${event.skill}`))].map((key) => {
    const [userId, skill] = key.split(":"); const rows = allEvidence.filter((event) => event.user_id === userId && event.skill === skill);
    return { userId, skill, count: rows.length, averageScore: rows.length ? rows.reduce((sum, event) => sum + Number(event.score), 0) / rows.length : 0, latestScore: Number(rows[0]?.score ?? 0), latestAt: rows[0]?.occurred_at ?? null, sourceCounts: Object.fromEntries([...new Set(rows.map((event) => event.source_type))].map((source) => [source, rows.filter((event) => event.source_type === source).length])) };
  });
  const evidenceSnapshot = {
    capturedAt: now.toISOString(),
    learners: profiles ?? [],
    mastery: mastery ?? [],
    latestPlacement,
    reviewSummary,
    evidenceSummary
  };
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL;
  if (!apiKey || !model) throw new Error("GROQ_API_KEY và GROQ_MODEL cần được cấu hình để tạo learning path");
  const prompt = [
    "Design one evidence-driven shared English learning path for exactly two Vietnamese learners. Return JSON only.",
    "Schema: {rationaleVi,items:[{skill,activityType,title,objective,targetMinutes,targetCount,daysFromStart,assignment,destination}]}",
    "Use 3-20 purposeful activities. Do not invent learner scores, history, source content, or completed work. Base every prioritization only on the supplied evidence.",
    "Allowed activityType and destination pairs: review→/review, match→/dashboard, speaking→/speaking, listening→/study, reading→/study, writing→/study, placement→/placement, reflection→/progress.",
    "Use assignment=both for collaborative work; creator or partner only when evidence identifies an individual need. Space retrieval and practice over time. Explain objectives in Vietnamese.",
    `Goal: ${JSON.stringify({ title: input.title, targetCefr: input.targetCefr, focusSkills: input.focusSkills, schedule: input.schedule, startsOn: input.startsOn ?? null, targetDate: input.targetDate ?? null })}`,
    `Real evidence snapshot: ${JSON.stringify(evidenceSnapshot)}`
  ].join("\n");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.3, max_completion_tokens: 2600, response_format: { type: "json_object" }, messages: [{ role: "system", content: prompt }], ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}) }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: { message?: string } }).error?.message ?? `Groq learning path failed (${response.status})`);
  let raw: unknown;
  try { raw = JSON.parse(responseText(body)); } catch { raw = null; }
  const generated = generatedPathSchema.safeParse(raw);
  if (!generated.success) throw new Error("Groq trả learning path không đúng schema an toàn");
  if (generated.data.items.some((item) => allowedDestination[item.activityType] !== item.destination)) throw new Error("Learning path chứa activity destination không đúng contract");
  const deduped = generated.data.items.filter((item, index, all) => all.findIndex((candidate) => candidate.title.toLocaleLowerCase("vi") === item.title.toLocaleLowerCase("vi")) === index);
  if (deduped.length < 3) throw new Error("Learning path không có đủ hoạt động khác nhau");
  const pathRows = deduped.map((item, index) => ({
    goal_id: goal.id,
    sequence_number: index + 1,
    skill: item.skill,
    activity_type: item.activityType,
    title: item.title,
    objective: item.objective,
    target_minutes: item.targetMinutes,
    target_count: item.targetCount,
    due_at: new Date(start.getTime() + item.daysFromStart * 86_400_000).toISOString(),
    assignment: item.assignment,
    source_filters: { destination: item.destination, generatedFromEvidenceAt: evidenceSnapshot.capturedAt }
  }));
  const { error: pathError } = await admin.from("shared_learning_path_items").insert(pathRows);
  if (pathError) throw new Error(pathError.message);
  const { data: activated, error: activateError } = await admin.from("shared_learning_goals").update({ status: "active", schedule: { ...input.schedule, rationaleVi: generated.data.rationaleVi }, evidence_snapshot: evidenceSnapshot, provider: "groq", model, updated_at: new Date().toISOString() }).eq("id", goal.id).eq("status", "generating").select("id").maybeSingle();
  if (activateError || !activated) throw new Error(activateError?.message ?? "Shared goal không còn ở trạng thái generating");
  return goal.id;
}
