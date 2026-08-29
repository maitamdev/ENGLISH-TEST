import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { thetaToCefr } from "./ability-model";

export const placementSkills = ["vocabulary", "grammar", "reading", "listening"] as const;
export type PlacementSkill = (typeof placementSkills)[number];
export const PLACEMENT_PROMPT_VERSION = "placement-irt-v1";

const itemSchema = z.object({
  prompt: z.string().trim().min(3).max(1000),
  instruction: z.string().trim().min(3).max(300),
  contextText: z.string().trim().max(1400).optional().default(""),
  audioText: z.string().trim().max(800).optional().default(""),
  options: z.array(z.string().trim().min(1).max(300)).length(4),
  canonicalAnswer: z.string().trim().min(1).max(300),
  acceptedAnswers: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  explanationVi: z.string().trim().min(5).max(1000)
});

function responseText(body: unknown) {
  return (body as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}'-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export async function generatePlacementItem(admin: SupabaseClient, session: { id: string; ability_theta: number; response_count: number; skill_cycle: string[]; generation_token: string }) {
  const configuredCycle = session.skill_cycle.filter((value): value is PlacementSkill => placementSkills.includes(value as PlacementSkill));
  const activeCycle = configuredCycle.length ? configuredCycle : [...placementSkills];
  const skill = activeCycle[session.response_count % activeCycle.length] ?? "vocabulary";
  const cefr = thetaToCefr(Number(session.ability_theta));
  const [{ data: descriptors }, { data: previous }] = await Promise.all([
    admin.from("curriculum_descriptors").select("id, descriptor_text, curriculum_frameworks!inner(display_name, source_url, license_id)").eq("moderation_status", "approved").eq("skill", skill).eq("cefr_level", cefr).limit(3),
    admin.from("placement_items").select("prompt, content_fingerprint").eq("session_id", session.id).order("position").limit(30)
  ]);
  const descriptor = descriptors?.[session.response_count % Math.max(descriptors.length, 1)] ?? null;
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL;
  if (!apiKey || !model) throw new Error("GROQ_API_KEY và GROQ_MODEL cần được cấu hình để chạy placement");
  const skillRules = skill === "listening"
    ? "Create a listening-comprehension item. Put the exact spoken English only in audioText. Do not copy it into prompt or contextText. Options may be English or Vietnamese."
    : skill === "reading"
      ? "Create a short reading-comprehension item. Put the passage in contextText and ask one inference or detail question."
      : skill === "grammar"
        ? "Create one contextual grammar item that tests use, not terminology memorization."
        : "Create one contextual vocabulary item that distinguishes meaning or natural use.";
  const prompt = [
    "Create exactly one adaptive English diagnostic item for a Vietnamese learner. Return JSON only.",
    "Schema: {prompt,instruction,contextText,audioText,options:[four unique strings],canonicalAnswer,acceptedAnswers,explanationVi}.",
    `Target skill: ${skill}. Target CEFR: ${cefr}. Ability theta: ${Number(session.ability_theta).toFixed(3)}.`,
    skillRules,
    "canonicalAnswer must equal exactly one option after case/space normalization. acceptedAnswers must contain canonicalAnswer. Distractors must be plausible but unambiguously wrong.",
    "Use Vietnamese for instruction and explanationVi. Do not claim this is an official CEFR certification.",
    descriptor ? `Approved curriculum descriptor for alignment only: ${JSON.stringify(descriptor.descriptor_text)}` : "No approved descriptor has been imported for this cell; align only to the named CEFR level and skill without inventing provenance.",
    previous?.length ? `Do not repeat or paraphrase these earlier prompts: ${JSON.stringify(previous.map((item) => item.prompt))}` : "This is the first item."
  ].join("\n");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.35, max_completion_tokens: 900, response_format: { type: "json_object" }, messages: [{ role: "system", content: prompt }], ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}) }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: { message?: string } }).error?.message ?? `Groq placement failed (${response.status})`);
  let raw: unknown;
  try { raw = JSON.parse(responseText(body)); } catch { raw = null; }
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Groq trả placement item không đúng schema");
  const item = parsed.data;
  const normalizedOptions = item.options.map(normalize);
  const canonical = normalize(item.canonicalAnswer);
  if (new Set(normalizedOptions).size !== 4 || normalizedOptions.filter((option) => option === canonical).length !== 1) throw new Error("Placement item không có đúng một lựa chọn chính xác");
  if (!item.acceptedAnswers.map(normalize).includes(canonical)) throw new Error("Placement canonical answer không nằm trong accepted answers");
  if (skill === "listening" && (!item.audioText || normalize(item.prompt).includes(normalize(item.audioText)))) throw new Error("Placement listening item làm lộ transcript");
  const fingerprint = createHash("sha256").update(JSON.stringify({ skill, cefr, prompt: normalize(item.prompt), context: normalize(item.contextText), answer: canonical })).digest("hex");
  if (previous?.some((value) => value.content_fingerprint === fingerprint)) throw new Error("Placement item bị trùng nội dung trước đó");
  const position = session.response_count + 1;
  const { data: lease } = await admin.from("placement_sessions").select("id").eq("id", session.id).eq("status", "generating").eq("generation_token", session.generation_token).is("current_item_id", null).maybeSingle();
  if (!lease) throw new Error("Placement generation lease đã được thay thế");
  await admin.from("placement_items").delete().eq("session_id", session.id).eq("position", position);
  const { data: stored, error } = await admin.from("placement_items").insert({
    session_id: session.id,
    position,
    skill,
    cefr_level: cefr,
    difficulty_theta: Number(session.ability_theta),
    prompt: item.prompt,
    instruction: item.instruction,
    public_payload: { options: item.options, contextText: item.contextText || null, hasAudio: skill === "listening" },
    private_payload: { audioText: item.audioText || null },
    canonical_answer: item.canonicalAnswer,
    accepted_answers: [...new Set([item.canonicalAnswer, ...item.acceptedAnswers])],
    explanation: item.explanationVi,
    curriculum_descriptor_id: descriptor?.id ?? null,
    content_fingerprint: fingerprint,
    prompt_version: PLACEMENT_PROMPT_VERSION
  }).select("id, position, skill, cefr_level, prompt, instruction, public_payload").single();
  if (error || !stored) throw new Error(error?.message ?? "Không lưu được placement item");
  const { data: claimed, error: sessionError } = await admin.from("placement_sessions").update({ status: "active", current_item_id: stored.id, generation_token: null, generation_started_at: null, provider: "groq", model, updated_at: new Date().toISOString() }).eq("id", session.id).eq("generation_token", session.generation_token).is("current_item_id", null).select("id").maybeSingle();
  if (sessionError || !claimed) {
    await admin.from("placement_items").delete().eq("id", stored.id);
    if (sessionError) throw new Error(sessionError.message);
    const { data: winner } = await admin.from("placement_sessions").select("current_item_id").eq("id", session.id).maybeSingle();
    if (!winner?.current_item_id) throw new Error("Không thể nhận quyền tạo placement item");
  }
  return stored;
}

export function publicPlacementSession(session: Record<string, unknown>, item: Record<string, unknown> | null) {
  return {
    id: session.id,
    status: session.status,
    responseCount: session.response_count,
    targetCount: session.target_count,
    estimatedCefr: session.estimated_cefr,
    confidence: Number(session.confidence ?? 0),
    standardError: session.standard_error == null ? null : Number(session.standard_error),
    updatedAt: session.updated_at,
    result: session.result,
    item: item ? { id: item.id, position: item.position, skill: item.skill, cefrLevel: item.cefr_level, prompt: item.prompt, instruction: item.instruction, publicData: item.public_payload } : null
  };
}
