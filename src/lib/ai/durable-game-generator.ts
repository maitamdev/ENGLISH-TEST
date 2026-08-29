import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { QUESTION_GENERATION_POLICY } from "./question-generation-policy";
import { DEFAULT_MATCH_SETTINGS, getMatchPreset } from "@/lib/game/match-presets";
import { recordTelemetry } from "@/lib/observability/telemetry";
import { battleBlueprintSchema, gameGenerationRequestSchema, generatedQuestionSchema, matchSettingsSchema, type BattleBlueprintInput } from "@/lib/validation/game";

type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
type JobRow = {
  id: string;
  room_id: string;
  requested_by: string;
  request_payload: unknown;
  batch_size: number;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
  correlation_id: string;
};

type JobState = {
  blueprint: BattleBlueprintInput | null;
  mode_schedule: BattleBlueprintInput["modes"][number]["type"][];
  generated_questions: GeneratedQuestion[];
};

class ProviderFailure extends Error {
  constructor(message: string, readonly code: string, readonly retryAfterSeconds = 20) { super(message); }
}

function requestedRoundCount(request: string) {
  const match = request.match(/(?:^|\s)(\d{1,2})\s*(?:từ|câu|vòng|words?|questions?|rounds?)(?=\s|$|[,.!?])/iu);
  const count = match ? Number(match[1]) : 0;
  return count >= 5 && count <= 50 ? count : null;
}

function presetFromBrief(request: string) {
  const value = request.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("vi-VN");
  if (/\b(shadowing|nhai lai|bat chuoc giong|bat chuoc ngu dieu)\b/u.test(value)) return "shadowing-studio";
  if (/\b(minimal pair|am gan|phan biet am|nghe nham)\b/u.test(value)) return "minimal-pair-duel";
  if (/\b(nghe truyen|nghe hoi thoai|story listening|story quest)\b/u.test(value)) return "story-quest";
  if (/\b(xep cau|xep tu|sentence builder|collocation|cum tu)\b/u.test(value)) return "sentence-forge";
  if (/\b(sua loi|error correction|grammar repair|loi ngu phap)\b/u.test(value)) return "grammar-repair";
  if (/\b(phat am|thi noi|luyen noi|speaking|pronunciation|roleplay|tranh luan|debate)\b/u.test(value)) return "speaking-arena";
  if (/\b(thi nghe|luyen nghe|listening|chep chinh ta|dictation)\b/u.test(value)) return "listening-sprint";
  if (/\b(thi doc|luyen doc|doc hieu|reading)\b/u.test(value)) return "reading-challenge";
  if (/\b(thi viet|luyen viet|viet luan|writing|essay)\b/u.test(value)) return "writing-workshop";
  if (/\b(tong hop|hon hop|mixed|du ky nang)\b/u.test(value)) return "mixed-cefr";
  return "vocabulary-duel";
}

function resizeModes(modes: BattleBlueprintInput["modes"], rounds: number) {
  const types = [...new Set(modes.map((mode) => mode.type))];
  const usable = types.length ? types : ["VI_TO_EN", "EN_TO_VI"] as const;
  const counts = new Map(usable.map((type) => [type, 0]));
  for (let index = 0; index < rounds; index += 1) counts.set(usable[index % usable.length], (counts.get(usable[index % usable.length]) ?? 0) + 1);
  return usable.map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

function fairTimeLimit(modes: BattleBlueprintInput["modes"]) {
  if (modes.some((item) => item.type === "WRITING")) return 90;
  if (modes.some((item) => ["SPEAKING", "ROLEPLAY", "DEBATE"].includes(item.type))) return 70;
  if (modes.some((item) => ["READING", "STORY_LISTENING", "SHADOWING"].includes(item.type))) return 60;
  if (modes.some((item) => ["LISTENING", "AUDIO_CHOICE", "PRONUNCIATION"].includes(item.type))) return 50;
  return 40;
}

function createModeSchedule(blueprint: BattleBlueprintInput) {
  const remaining = blueprint.modes.map((mode) => ({ ...mode }));
  const result: BattleBlueprintInput["modes"][number]["type"][] = [];
  while (result.length < blueprint.rounds) {
    for (const mode of remaining) if (mode.count > 0 && result.length < blueprint.rounds) { result.push(mode.type); mode.count -= 1; }
  }
  return result;
}

function answerKey(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("vi-VN").replace(/^(a|an|the)\s+/u, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function responseText(body: unknown) {
  if (!body || typeof body !== "object") return "";
  return (body as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
}

async function requestGroq(prompt: string, maxTokens: number) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL;
  if (!apiKey || !model) throw new ProviderFailure("GROQ_API_KEY and GROQ_MODEL are required", "configuration", 0);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.65, max_completion_tokens: maxTokens,
      ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }]
    }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { error?: { message?: string } }).error?.message ?? `Groq failed with status ${response.status}`;
    const fromHeader = Number(response.headers.get("retry-after"));
    const fromMessage = Number(message.match(/try again in ([\d.]+)s/iu)?.[1]);
    const retry = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number.isFinite(fromMessage) && fromMessage > 0 ? fromMessage : 20;
    throw new ProviderFailure(message, response.status === 429 ? "rate_limited" : `http_${response.status}`, Math.ceil(retry));
  }
  const content = responseText(body);
  if (!content) throw new ProviderFailure("Groq returned no JSON content", "empty_response", 10);
  try { return JSON.parse(content) as unknown; }
  catch { throw new ProviderFailure("Groq returned invalid JSON", "invalid_json", 5); }
}

async function loadSourceContext(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, modes: string[]) {
  const contentTypes = modes.some((mode) => ["PRONUNCIATION", "MINIMAL_PAIRS", "SHADOWING"].includes(mode))
    ? ["pronunciation_entry", "sentence_pair"]
    : ["sentence_pair", "vocabulary_entry", "reading_passage", "authorized_social_post"];
  const { data } = await admin.from("learning_content")
    .select("id, content_type, content, license_id, attribution")
    .eq("moderation_status", "approved")
    .in("content_type", contentTypes)
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(12);
  return data ?? [];
}

async function buildBlueprint(request: z.infer<typeof gameGenerationRequestSchema>) {
  const preset = getMatchPreset(request.preferences?.presetId ?? presetFromBrief(request.request));
  const requestedSettings = matchSettingsSchema.parse({ ...DEFAULT_MATCH_SETTINGS, ...preset.settings, ...(request.preferences?.settings ?? {}) });
  const prompt = [
    "Design a two-player English learning match. Return one JSON object with key blueprint.",
    "Blueprint fields: title, topic, level, rounds, timePerQuestion, difficulty, modes, speedScoring, streakBonus.",
    "difficulty must be Easy, Medium or Hard. modes is an array of {type,count}.",
    `Allowed modes: ${preset.modes.map((mode) => mode.type).join(", ")}.`,
    `The learners requested: ${request.request}`,
    `Preferred CEFR: ${request.preferences?.level ?? "Mixed"}.`,
    "Use Vietnamese only for the title if it is natural. Do not include questions yet."
  ].join("\n");
  const raw = await requestGroq(prompt, 700);
  const draft = z.object({ blueprint: battleBlueprintSchema.omit({ settings: true }).passthrough() }).safeParse(raw);
  if (!draft.success) throw new ProviderFailure("Groq returned an invalid match blueprint", "invalid_blueprint", 5);
  const rounds = requestedRoundCount(request.request) ?? request.preferences?.rounds ?? draft.data.blueprint.rounds;
  const modes = resizeModes(request.preferences?.modes?.length ? request.preferences.modes : preset.modes, rounds);
  const parsed = battleBlueprintSchema.safeParse({
    ...draft.data.blueprint,
    rounds,
    modes,
    level: request.preferences?.level && request.preferences.level !== "Mixed" ? request.preferences.level : draft.data.blueprint.level,
    difficulty: request.preferences?.difficulty ?? draft.data.blueprint.difficulty,
    timePerQuestion: Math.max(fairTimeLimit(modes), request.preferences?.timePerQuestion ?? draft.data.blueprint.timePerQuestion),
    speedScoring: !modes.some((item) => ["LISTENING","SPELLING","MINIMAL_PAIRS","AUDIO_CHOICE","STORY_LISTENING","PRONUNCIATION","SHADOWING","SPEAKING","ROLEPLAY","DEBATE","WRITING"].includes(item.type)) && draft.data.blueprint.speedScoring,
    settings: requestedSettings
  });
  if (!parsed.success) throw new ProviderFailure("Generated blueprint failed validation", "invalid_blueprint", 5);
  return parsed.data;
}

async function buildQuestionBatch(request: z.infer<typeof gameGenerationRequestSchema>, blueprint: BattleBlueprintInput, modes: string[], previous: GeneratedQuestion[], sourceContext: unknown[]) {
  const start = previous.length + 1;
  const prompt = [
    "Generate a compact batch of real English-learning questions. Return JSON only as {items:[...]}, with exactly the requested number of items.",
    "Each item must have: mode, prompt, instruction, level, timeLimit, publicData, privateData, canonicalAnswer, acceptedAnswers, explanation, difficulty.",
    "publicData and privateData are JSON objects. acceptedAnswers must include the canonicalAnswer and all genuinely equivalent answers in this context.",
    "If and only if an item directly uses one supplied licensed source record, set privateData.sourceContentId to that record id. Otherwise omit it. Never invent a source id.",
    "For listening and shadowing put audioText only in privateData, never in prompt or publicData. For multiple choice put options in publicData. For sentence builder put shuffled tokens in publicData.",
    "For pronunciation put targetText in publicData. For speaking, roleplay and debate put scenario, role, maxSeconds and rubric in publicData.",
    "Do not treat merely related words as synonyms. Keep Vietnamese diacritics accurate. Keep every prompt and canonical answer unique.",
    QUESTION_GENERATION_POLICY,
    `Topic: ${blueprint.topic}. CEFR: ${blueprint.level}. Difficulty: ${blueprint.difficulty}.`,
    `Rounds ${start}-${start + modes.length - 1}. Modes in exact order: ${modes.join(", ")}.`,
    `Learners requested: ${request.request}`,
    previous.length ? `Do not repeat these answers: ${JSON.stringify(previous.map((item) => item.canonicalAnswer))}` : "No previous questions.",
    sourceContext.length ? `Licensed source records are supplied as grounding context. Use only records that fit the requested topic and keep their facts unchanged: ${JSON.stringify(sourceContext)}` : "No approved imported source record matches this batch. Generate original educational items, never pretend they came from an external dataset."
  ].join("\n");
  const raw = await requestGroq(prompt, Math.min(3000, Math.max(1000, modes.length * 550)));
  const envelope = z.object({ items: z.array(generatedQuestionSchema) }).safeParse(raw);
  if (!envelope.success || envelope.data.items.length !== modes.length) throw new ProviderFailure("Groq returned an invalid question batch", "invalid_batch", 5);
  const sourceIds = new Set(sourceContext.flatMap((row) => row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : []));
  const items = envelope.data.items.map((item, index) => {
    const claimedSource = typeof item.privateData.sourceContentId === "string" ? item.privateData.sourceContentId : null;
    const privateData = { ...item.privateData, ...(claimedSource && sourceIds.has(claimedSource) ? { sourceContentId: claimedSource } : {}) };
    if (!claimedSource || !sourceIds.has(claimedSource)) delete privateData.sourceContentId;
    return { ...item, privateData, mode: modes[index] as GeneratedQuestion["mode"], level: blueprint.level, timeLimit: blueprint.timePerQuestion };
  });
  const parsed = z.array(generatedQuestionSchema).length(modes.length).safeParse(items);
  if (!parsed.success) throw new ProviderFailure("Question batch failed schema validation", "invalid_batch", 5);
  const previousAnswers = new Set(previous.map((item) => answerKey(item.canonicalAnswer)));
  const answers = parsed.data.map((item) => answerKey(item.canonicalAnswer));
  if (answers.some((answer, index) => !answer || previousAnswers.has(answer) || answers.indexOf(answer) !== index)) throw new ProviderFailure("Question batch contained duplicate answers", "duplicate_batch", 5);
  return parsed.data;
}

async function releaseJob(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, job: JobRow, values: { status: string; stage: string; completed: number; nextRound: number; retry?: number; code?: string | null; error?: string | null }) {
  const { error } = await admin.rpc("release_generation_job", {
    target_job_id: job.id,
    worker_token: job.lease_token,
    target_status: values.status,
    target_stage: values.stage,
    target_completed_rounds: values.completed,
    target_next_round: values.nextRound,
    retry_after_seconds: values.retry ?? 0,
    target_error_code: values.code ?? null,
    target_error_message: values.error ?? null
  });
  if (error) throw error;
}

async function persistCompletedMatch(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, job: JobRow, blueprint: BattleBlueprintInput, questions: GeneratedQuestion[]) {
  const { data: members, error: memberError } = await admin.from("room_members").select("user_id").eq("room_id", job.room_id);
  if (memberError || !members || members.length !== 2) throw new ProviderFailure("The room no longer has exactly two members", "room_members_changed", 0);
  const { data: match, error: matchError } = await admin.from("matches").insert({ room_id: job.room_id, title: blueprint.title, topic: blueprint.topic, level: blueprint.level, status: "ready", blueprint, round_count: blueprint.rounds, current_round: 0, scoring_version: "v3" }).select("id").single();
  if (matchError || !match) throw new ProviderFailure(matchError?.message ?? "Could not persist match", "persist_match", 5);
  try {
    const { error: playersError } = await admin.from("match_players").insert(members.map((member) => ({ match_id: match.id, user_id: member.user_id })));
    if (playersError) throw playersError;
    const { data: storedQuestions, error: questionError } = await admin.from("questions").insert(questions.map((question, index) => ({ match_id: match.id, round_number: index + 1, mode: question.mode, prompt: question.prompt, instruction: question.instruction, level: question.level, public_payload: question.publicData, difficulty: question.difficulty, time_limit: question.timeLimit, learning_content_id: typeof question.privateData.sourceContentId === "string" ? question.privateData.sourceContentId : null }))).select("id, round_number");
    if (questionError || !storedQuestions) throw questionError ?? new Error("Questions were not persisted");
    const { error: answerError } = await admin.from("question_answers").insert(storedQuestions.map((stored) => {
      const generated = questions[stored.round_number - 1];
      return { question_id: stored.id, canonical_answer: generated.canonicalAnswer, accepted_answers: [...new Set([generated.canonicalAnswer, ...generated.acceptedAnswers])], grading_rules: { mode: generated.mode, strictness: blueprint.settings.strictness, rubric: generated.publicData.rubric ?? [], ...generated.privateData }, explanation: generated.explanation };
    }));
    if (answerError) throw answerError;
    await admin.from("rooms").update({ status: "GAME_READY" }).eq("id", job.room_id);
    await admin.from("generation_jobs").update({ match_id: match.id }).eq("id", job.id);
    return match.id as string;
  } catch (error) {
    await admin.from("matches").delete().eq("id", match.id);
    throw error;
  }
}

export async function processNextGenerationJob() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const workerToken = randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc("claim_generation_job", { worker_token: workerToken, lease_seconds: 110 });
  if (claimError) throw claimError;
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as JobRow | null;
  if (!job) return { processed: false };
  job.lease_token = workerToken;

  let completed = 0;
  let nextRound = 1;
  try {
    const request = gameGenerationRequestSchema.parse(job.request_payload);
    const { data: storedState } = await admin.from("generation_job_states").select("blueprint, mode_schedule, generated_questions").eq("job_id", job.id).maybeSingle();
    const state: JobState = {
      blueprint: storedState?.blueprint ? battleBlueprintSchema.parse(storedState.blueprint) : null,
      mode_schedule: Array.isArray(storedState?.mode_schedule) ? storedState.mode_schedule as JobState["mode_schedule"] : [],
      generated_questions: Array.isArray(storedState?.generated_questions) ? z.array(generatedQuestionSchema).parse(storedState.generated_questions) : []
    };
    if (!state.blueprint) {
      state.blueprint = await buildBlueprint(request);
      state.mode_schedule = createModeSchedule(state.blueprint);
      await admin.from("generation_jobs").update({ total_rounds: state.blueprint.rounds, stage: `Đã thiết kế trận · đang tạo 0/${state.blueprint.rounds} câu`, updated_at: new Date().toISOString() }).eq("id", job.id);
      await admin.from("generation_job_states").upsert({ job_id: job.id, blueprint: state.blueprint, mode_schedule: state.mode_schedule, generated_questions: [], updated_at: new Date().toISOString() });
    }

    const start = state.generated_questions.length;
    completed = start;
    nextRound = start + 1;
    if (start < state.blueprint.rounds) {
      const modes = state.mode_schedule.slice(start, Math.min(start + job.batch_size, state.blueprint.rounds));
      const sourceContext = await loadSourceContext(admin, modes);
      const batch = await buildQuestionBatch(request, state.blueprint, modes, state.generated_questions, sourceContext);
      state.generated_questions.push(...batch);
      completed = state.generated_questions.length;
      nextRound = completed + 1;
      await admin.from("generation_job_states").upsert({ job_id: job.id, blueprint: state.blueprint, mode_schedule: state.mode_schedule, generated_questions: state.generated_questions, updated_at: new Date().toISOString() });
    }

    if (state.generated_questions.length < state.blueprint.rounds) {
      await releaseJob(admin, job, { status: "queued", stage: `Đã tạo ${completed}/${state.blueprint.rounds} câu · tiếp tục batch kế tiếp`, completed, nextRound });
      return { processed: true, completed: false, jobId: job.id, completedRounds: completed };
    }

    await admin.from("generation_jobs").update({ status: "persisting", stage: "Đang lưu và kiểm tra trận đấu", updated_at: new Date().toISOString() }).eq("id", job.id).eq("lease_token", workerToken);
    const matchId = await persistCompletedMatch(admin, job, state.blueprint, state.generated_questions);
    await releaseJob(admin, job, { status: "completed", stage: "Trận đấu đã sẵn sàng", completed: state.blueprint.rounds, nextRound: state.blueprint.rounds + 1 });
    await recordTelemetry({ name: "generation.completed", correlationId: job.correlation_id, roomId: job.room_id, userId: job.requested_by, provider: "groq", metadata: { jobId: job.id, rounds: state.blueprint.rounds, batches: Math.ceil(state.blueprint.rounds / job.batch_size) } });
    return { processed: true, completed: true, jobId: job.id, matchId };
  } catch (error) {
    const failure = error instanceof ProviderFailure ? error : new ProviderFailure(error instanceof Error ? error.message : "Generation failed", "internal", 10);
    const terminal = failure.retryAfterSeconds === 0 || job.attempt_count + 1 >= job.max_attempts;
    await releaseJob(admin, job, { status: terminal ? "failed" : "retrying", stage: terminal ? "Tạo trận thất bại" : `Tạm dừng · sẽ thử lại từ câu ${nextRound}`, completed, nextRound, retry: failure.retryAfterSeconds, code: failure.code, error: failure.message.slice(0, 1800) });
    await recordTelemetry({ name: terminal ? "generation.failed" : "generation.retry_scheduled", severity: terminal ? "error" : "warning", correlationId: job.correlation_id, roomId: job.room_id, userId: job.requested_by, provider: "groq", errorCode: failure.code, errorMessage: failure.message, metadata: { jobId: job.id, completedRounds: completed, retryAfterSeconds: failure.retryAfterSeconds } });
    if (terminal) await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", job.room_id).eq("status", "GENERATING_GAME");
    return { processed: true, completed: false, failed: terminal, retryAfterSeconds: failure.retryAfterSeconds, error: failure.message };
  }
}

export async function drainGenerationQueue(options: { maxBatches?: number; timeBudgetMs?: number } = {}) {
  const maxBatches = Math.max(1, Math.min(8, options.maxBatches ?? 4));
  const deadline = performance.now() + Math.max(10_000, Math.min(110_000, options.timeBudgetMs ?? 100_000));
  const results: Awaited<ReturnType<typeof processNextGenerationJob>>[] = [];
  while (results.length < maxBatches && performance.now() < deadline) {
    const result = await processNextGenerationJob();
    results.push(result);
    if (!result.processed || ("failed" in result && result.failed)) break;
  }
  return results;
}
