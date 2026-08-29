import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { QUESTION_GENERATION_POLICY } from "@/lib/ai/question-generation-policy";
import { DEFAULT_MATCH_SETTINGS, getMatchPreset } from "@/lib/game/match-presets";
import {
  battleBlueprintSchema,
  gameGenerationRequestSchema,
  generatedGamePackSchema,
  generatedQuestionSchema,
  matchSettingsSchema,
  type BattleBlueprintInput
} from "@/lib/validation/game";

type GroqCompletion = { choices?: { message?: { content?: string } }[] };
type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
type QuestionMode = BattleBlueprintInput["modes"][number]["type"];
type GroqSchema = { name: string; schema: Record<string, unknown> };

export const maxDuration = 300;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const groqModeValues = [
  "VI_TO_EN", "EN_TO_VI", "LISTENING", "SPELLING", "MULTIPLE_CHOICE", "READING", "CONTEXT", "GRAMMAR",
  "TRANSLATION", "DEFINITION", "PRONUNCIATION", "SPEAKING", "ROLEPLAY", "DEBATE", "WRITING", "BOSS"
] as const;

const blueprintDraftSchema = z.object({
  title: z.string().min(3).max(80),
  topic: z.string().min(2).max(60),
  level: z.string().min(1).max(20),
  rounds: z.number().int().min(5).max(50),
  timePerQuestion: z.number().int().min(5).max(120),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  modes: z.array(z.object({ type: z.enum(groqModeValues), count: z.number().int().positive() })).min(1),
  speedScoring: z.boolean(),
  streakBonus: z.boolean()
});

const blueprintOutputSchema: GroqSchema = {
  name: "match_blueprint",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      blueprint: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" }, topic: { type: "string" }, level: { type: "string" },
          rounds: { type: "integer", minimum: 5, maximum: 50 },
          timePerQuestion: { type: "integer", minimum: 5, maximum: 120 },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] },
          modes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { type: { type: "string", enum: groqModeValues }, count: { type: "integer", minimum: 1 } },
              required: ["type", "count"]
            }
          },
          speedScoring: { type: "boolean" }, streakBonus: { type: "boolean" }
        },
        required: ["title", "topic", "level", "rounds", "timePerQuestion", "difficulty", "modes", "speedScoring", "streakBonus"]
      }
    },
    required: ["blueprint"]
  }
};

function questionBatchOutputSchema(count: number): GroqSchema {
  const nullableString = { type: ["string", "null"] };
  return {
    name: "question_batch",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: count,
          maxItems: count,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              prompt: { type: "string" }, answer: { type: "string" }, accepted: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
              instruction: nullableString, explanation: nullableString,
              options: { type: "array", maxItems: 5, items: { type: "string" } },
              passage: nullableString, audioText: nullableString, targetText: nullableString,
              scenario: nullableString, role: nullableString, writingRequirements: nullableString,
              rubric: { type: "array", maxItems: 5, items: { type: "string" } }
            },
            required: ["prompt", "answer", "accepted", "instruction", "explanation", "options", "passage", "audioText", "targetText", "scenario", "role", "writingRequirements", "rubric"]
          }
        }
      },
      required: ["items"]
    }
  };
}

async function requestGroqJson(apiKey: string, model: string, prompt: string, maxCompletionTokens: number, outputSchema?: GroqSchema) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          max_completion_tokens: maxCompletionTokens,
          ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
          response_format: outputSchema && model.startsWith("openai/gpt-oss")
            ? { type: "json_schema", json_schema: { ...outputSchema, strict: true } }
            : { type: "json_object" },
          messages: [{ role: "system", content: prompt }]
        })
      });
    } catch {
      throw new Error("Could not reach Groq");
    }

    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: { message?: string } };
      const message = failure.error?.message ?? "unknown error";
      if (response.status === 429 && attempt < 3) {
        const headerSeconds = Number(response.headers.get("retry-after"));
        const messageSeconds = Number(message.match(/try again in ([\d.]+)s/i)?.[1]);
        const retrySeconds = Number.isFinite(headerSeconds) && headerSeconds > 0
          ? headerSeconds
          : Number.isFinite(messageSeconds) && messageSeconds > 0 ? messageSeconds : 22;
        await wait(Math.ceil(retrySeconds * 1000) + 500);
        continue;
      }
      throw new Error(`Groq failed (${response.status}): ${message}`);
    }
    const completion = await response.json().catch(() => null) as GroqCompletion | null;
    const content = completion?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned no JSON content");
    try { return JSON.parse(content) as unknown; }
    catch { throw new Error("Groq returned invalid JSON"); }
  }
  throw new Error("Groq rate limit did not recover in time");
}

function requestedRoundCount(request: string) {
  const match = request.match(/(?:^|\s)(\d{1,2})\s*(?:từ|câu|vòng|words?|questions?|rounds?)(?=\s|$|[,.!?])/iu);
  const count = match ? Number(match[1]) : 0;
  return count >= 5 && count <= 50 ? count : null;
}

function presetFromBrief(request: string) {
  const normalized = request.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("vi-VN");
  if (/\b(co-op|coop|cung doi|hoc cung|hop tac)\b/u.test(normalized)) return "coop-study";
  if (/\b(phat am|thi noi|luyen noi|speaking|pronunciation|roleplay|tranh luan|debate)\b/u.test(normalized)) return "speaking-arena";
  if (/\b(thi nghe|luyen nghe|listening|chep chinh ta|dictation)\b/u.test(normalized)) return "listening-sprint";
  if (/\b(thi doc|luyen doc|doc hieu|reading)\b/u.test(normalized)) return "reading-challenge";
  if (/\b(thi viet|luyen viet|viet luan|writing|essay)\b/u.test(normalized)) return "writing-workshop";
  if (/\b(tong hop|hon hop|mixed|du ky nang)\b/u.test(normalized)) return "mixed-cefr";
  if (/\b(tu vung|vocabulary|dich tu|do vat|con vat|thuc pham)\b/u.test(normalized)) return "vocabulary-duel";
  return null;
}

function resizeModes(modes: BattleBlueprintInput["modes"], rounds: number) {
  const types = [...new Set(modes.map((mode) => mode.type))];
  const usableTypes = types.length > 0 ? types : ["VI_TO_EN", "EN_TO_VI"] as const;
  const counts = new Map(usableTypes.map((type) => [type, 0]));
  for (let index = 0; index < rounds; index += 1) {
    const type = usableTypes[index % usableTypes.length];
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return usableTypes.map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

function modeSchedule(blueprint: BattleBlueprintInput) {
  const remaining = blueprint.modes.map((mode) => ({ ...mode }));
  const schedule: BattleBlueprintInput["modes"][number]["type"][] = [];
  while (schedule.length < blueprint.rounds) {
    for (const mode of remaining) {
      if (mode.count > 0) {
        schedule.push(mode.type);
        mode.count -= 1;
      }
    }
  }
  return schedule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerKey(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("vi-VN")
    .replace(/^(a|an|the)\s+/u, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function shuffled<T>(values: T[]) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function normalizeCompactItem(value: unknown, mode: QuestionMode, blueprint: BattleBlueprintInput): GeneratedQuestion | null {
  if (!isRecord(value)) return null;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const canonicalAnswer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (!prompt || !canonicalAnswer) return null;

  const acceptedFromGroq = Array.isArray(value.accepted)
    ? value.accepted.filter((answer): answer is string => typeof answer === "string").map((answer) => answer.trim()).filter(Boolean)
    : [];
  const acceptedAnswers = [...new Map([canonicalAnswer, ...acceptedFromGroq].map((answer) => [answerKey(answer), answer])).values()].slice(0, 12);
  const defaultDifficulty = blueprint.difficulty === "Easy" ? 2 : blueprint.difficulty === "Medium" ? 5 : 8;
  const rawOptions = Array.isArray(value.options)
    ? value.options.filter((option): option is string => typeof option === "string").map((option) => option.trim()).filter(Boolean)
    : [];
  const uniqueOptions = [...new Map(rawOptions.map((option) => [answerKey(option), option])).values()];
  const options = blueprint.settings.shuffleOptions ? shuffled(uniqueOptions) : uniqueOptions;
  if (["MULTIPLE_CHOICE", "READING"].includes(mode) && (options.length < 2 || !options.some((option) => answerKey(option) === answerKey(canonicalAnswer)))) return null;

  const settings = blueprint.settings;
  const publicData: Record<string, unknown> = {};
  const privateData: Record<string, unknown> = {};
  if (mode === "MULTIPLE_CHOICE") publicData.options = options.slice(0, 5);
  if (mode === "READING") {
    if (typeof value.passage !== "string" || value.passage.trim().length < 40) return null;
    publicData.passage = value.passage.trim();
    if (options.length > 1) publicData.options = options.slice(0, 5);
  }
  if (mode === "LISTENING" || mode === "SPELLING") {
    const audioText = typeof value.audioText === "string" ? value.audioText.trim() : mode === "SPELLING" ? canonicalAnswer : "";
    if (!audioText) return null;
    privateData.audioText = audioText;
    publicData.accent = settings.listeningAccent;
    publicData.speed = settings.listeningSpeed;
    publicData.replayLimit = settings.replayLimit;
    if (options.length > 1) publicData.options = options.slice(0, 5);
  }
  if (mode === "PRONUNCIATION") publicData.targetText = typeof value.targetText === "string" ? value.targetText.trim() : canonicalAnswer;
  if (["SPEAKING", "ROLEPLAY", "DEBATE"].includes(mode)) {
    publicData.maxSeconds = settings.speakingSeconds;
    publicData.rubric = Array.isArray(value.rubric) ? value.rubric.filter((item): item is string => typeof item === "string").slice(0, 5) : ["task completion", "pronunciation", "fluency", "grammar", "vocabulary"];
  }
  if (["ROLEPLAY", "DEBATE"].includes(mode)) {
    publicData.scenario = typeof value.scenario === "string" ? value.scenario.trim() : prompt;
    if (typeof value.role === "string") publicData.role = value.role.trim();
  }
  if (mode === "WRITING") {
    publicData.writingRequirements = typeof value.writingRequirements === "string" ? value.writingRequirements.trim() : "Viết một phản hồi rõ ý, đúng trình độ và bám sát yêu cầu.";
    publicData.rubric = Array.isArray(value.rubric) ? value.rubric.filter((item): item is string => typeof item === "string").slice(0, 5) : ["task completion", "coherence", "grammar", "vocabulary"];
  }

  const instructionByMode: Partial<Record<QuestionMode, string>> = {
    VI_TO_EN: "Nhập từ hoặc cụm từ tiếng Anh.", EN_TO_VI: "Nhập nghĩa tiếng Việt.",
    LISTENING: "Nghe audio rồi trả lời bằng tiếng Anh.", SPELLING: "Nghe và chép lại chính xác.",
    MULTIPLE_CHOICE: "Chọn một đáp án đúng nhất.", READING: "Đọc đoạn văn rồi trả lời câu hỏi.",
    PRONUNCIATION: "Đọc thành tiếng rõ ràng theo câu mẫu.", SPEAKING: "Trả lời bằng tiếng Anh qua micro.",
    ROLEPLAY: "Nhập vai và phản hồi bằng tiếng Anh qua micro.", DEBATE: "Trình bày quan điểm bằng tiếng Anh qua micro.",
    WRITING: "Viết câu trả lời tiếng Anh đầy đủ."
  };
  const generatedInstruction = typeof value.instruction === "string" ? value.instruction.trim() : "";
  const generatedExplanation = typeof value.explanation === "string" ? value.explanation.trim() : "";

  const normalized = generatedQuestionSchema.safeParse({
    mode,
    prompt,
    instruction: generatedInstruction || instructionByMode[mode] || "Nhập câu trả lời của bạn.",
    level: blueprint.level,
    timeLimit: blueprint.timePerQuestion,
    publicData,
    privateData,
    canonicalAnswer,
    acceptedAnswers,
    explanation: generatedExplanation || (mode === "VI_TO_EN"
      ? `“${prompt}” trong tiếng Anh là “${canonicalAnswer}”.`
      : mode === "EN_TO_VI" ? `“${prompt}” có nghĩa là “${canonicalAnswer}”.` : `Đáp án đúng là “${canonicalAnswer}”.`),
    difficulty: defaultDifficulty
  });
  return normalized.success ? normalized.data : null;
}

export async function POST(request: Request) {
  const parsed = gameGenerationRequestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid generation request", details: parsed.error.flatten() }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase server credentials are not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: room, error: roomError } = await supabase.from("rooms").select("id, status").eq("id", parsed.data.roomId).single();
  if (roomError || !room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", room.id).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a room member can generate a match" }, { status: 403 });

  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL;
  if (!apiKey || !model) return NextResponse.json({ error: "GROQ_API_KEY and GROQ_MODEL are required. No fallback question data is generated." }, { status: 503 });

  const { data: members, error: memberError } = await admin.from("room_members").select("user_id").eq("room_id", room.id);
  if (memberError) return NextResponse.json({ error: memberError.message }, { status: 500 });
  if (!members || members.length !== 2) return NextResponse.json({ error: "Exactly two room members are required before generating a match" }, { status: 409 });

  const { data: claimedRoom, error: claimError } = await admin.from("rooms").update({ status: "GENERATING_GAME" }).eq("id", room.id).eq("status", "AI_DISCUSSION").select("id").maybeSingle();
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
  if (!claimedRoom) return NextResponse.json({ error: `A match cannot be generated while the room is ${room.status}` }, { status: 409 });
  const { data: generationJob, error: generationJobError } = await admin.from("generation_jobs").insert({
    room_id: room.id,
    requested_by: authData.user.id,
    status: "generating",
    stage: "Đang phân tích yêu cầu và thiết kế trận đấu"
  }).select("id").single();
  if (generationJobError || !generationJob) {
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: generationJobError?.message ?? "Could not create generation progress" }, { status: 500 });
  }
  const updateGenerationJob = async (values: Record<string, unknown>) => {
    await admin.from("generation_jobs").update({ ...values, updated_at: new Date().toISOString() }).eq("id", generationJob.id);
  };
  const ensureGenerationActive = async () => {
    const { data: currentJob } = await admin.from("generation_jobs").select("status").eq("id", generationJob.id).maybeSingle();
    if (!currentJob || !["queued", "generating", "persisting"].includes(currentJob.status)) {
      throw new Error("Generation job was cancelled or recovered by a room member");
    }
  };
  const explicitRounds = requestedRoundCount(parsed.data.request);
  const preferences = parsed.data.preferences;
  const detectedPresetId = presetFromBrief(parsed.data.request);
  const preset = getMatchPreset(detectedPresetId ?? preferences?.presetId ?? "vocabulary-duel");
  const requestedSettings = matchSettingsSchema.parse({
    ...DEFAULT_MATCH_SETTINGS,
    ...preset.settings,
    ...(preferences?.settings ?? {})
  });
  const blueprintPrompt = [
    "Design only the blueprint for a two-player English learning competition.",
    "Return JSON only: {\"blueprint\":{\"title\":string,\"topic\":string,\"level\":string,\"rounds\":integer,\"timePerQuestion\":integer,\"difficulty\":\"Easy\"|\"Medium\"|\"Hard\",\"modes\":[{\"type\":mode,\"count\":integer}],\"speedScoring\":boolean,\"streakBonus\":boolean}}.",
    "Modes: VI_TO_EN, EN_TO_VI, LISTENING, SPELLING, MULTIPLE_CHOICE, READING, CONTEXT, GRAMMAR, TRANSLATION, DEFINITION, PRONUNCIATION, SPEAKING, ROLEPLAY, DEBATE, WRITING, BOSS.",
    "Use 5-50 rounds. Honor an explicit requested quantity exactly; otherwise use 10.",
    "For vocabulary translation, use VI_TO_EN and EN_TO_VI and split them as evenly as possible unless one direction was explicitly requested.",
    `Selected experience: ${preset.label}. Selected CEFR: ${preferences?.level ?? "auto"}.`,
    `Players requested: ${parsed.data.request}`
  ].join("\n");

  let pack: z.infer<typeof generatedGamePackSchema>;
  try {
    const blueprintJson = await requestGroqJson(apiKey, model, blueprintPrompt, 650, blueprintOutputSchema);
    const blueprintEnvelope = z.object({ blueprint: blueprintDraftSchema }).safeParse(blueprintJson);
    if (!blueprintEnvelope.success) throw new Error("Groq returned an invalid match blueprint");
    const initialBlueprint = blueprintEnvelope.data.blueprint;
    const targetRounds = explicitRounds ?? preferences?.rounds ?? initialBlueprint.rounds;
    const preferredModes = detectedPresetId ? preset.modes : preferences?.modes ?? preset.modes;
    const selectedModes = preferredModes.length > 0 ? resizeModes(preferredModes, targetRounds) : resizeModes(initialBlueprint.modes, targetRounds);
    const blueprintResult = battleBlueprintSchema.safeParse({
      ...initialBlueprint,
      level: preferences?.level && preferences.level !== "Mixed" ? preferences.level : initialBlueprint.level,
      difficulty: preferences?.difficulty ?? initialBlueprint.difficulty,
      rounds: targetRounds,
      timePerQuestion: preferences?.timePerQuestion ?? Math.max(20, initialBlueprint.timePerQuestion),
      modes: selectedModes,
      speedScoring: !selectedModes.some((item) => ["PRONUNCIATION", "SPEAKING", "ROLEPLAY", "DEBATE", "WRITING"].includes(item.type)) && initialBlueprint.speedScoring,
      settings: requestedSettings
    });
    if (!blueprintResult.success) throw new Error("The generated match blueprint failed validation");
    const blueprint = blueprintResult.data;
    await updateGenerationJob({ total_rounds: blueprint.rounds, stage: `Đang tạo 0/${blueprint.rounds} câu hỏi` });
    const schedule = modeSchedule(blueprint);
    const questions: GeneratedQuestion[] = [];
    const batchSize = 6;

    for (let start = 0; start < blueprint.rounds; start += batchSize) {
      await ensureGenerationActive();
      if (start > 0) {
        await updateGenerationJob({ stage: `Đã tạo ${questions.length}/${blueprint.rounds} câu · đang điều tiết giới hạn AI` });
        await wait(18_000);
      }
      const requiredModes = schedule.slice(start, Math.min(start + batchSize, blueprint.rounds));
      const fallbackMode = requiredModes[0];
      if (!fallbackMode) throw new Error(`No question mode was scheduled for round ${start + 1}`);
      let validBatch: GeneratedQuestion[] | null = null;
      let correction = "";

      for (let attempt = 1; attempt <= 3 && !validBatch; attempt += 1) {
        if (attempt > 1) await wait(2200);
        const batchPrompt = [
          "Generate one compact batch of high-quality questions for a two-player English learning competition.",
          "Return exactly one JSON object and no markdown. Include every schema field for every item; use null for irrelevant nullable text fields and [] for irrelevant list fields.",
          "Mode rules: VI_TO_EN has Vietnamese prompt and English answer; EN_TO_VI is the reverse. MULTIPLE_CHOICE requires 4 plausible options including answer. READING requires a 60-180 word passage and preferably 4 options. LISTENING requires audioText plus a comprehension prompt. SPELLING requires audioText equal to the phrase to transcribe. PRONUNCIATION requires targetText. SPEAKING, ROLEPLAY and DEBATE require a concrete prompt, scenario or rubric and a short reference answer, but allow natural open responses. WRITING requires writingRequirements, rubric and a short reference answer, but accepts many valid responses.",
          "For speaking modes, never make speed the learning objective. For reading/listening, the question must be answerable from the supplied passage/audioText only.",
          "accepted must include common exact synonyms and legitimate spelling/number variants for this specific context; never include merely related words.",
          QUESTION_GENERATION_POLICY,
          "Example item only: {\"prompt\":\"cái bàn\",\"answer\":\"table\",\"accepted\":[\"table\"]}.",
          `Topic: ${blueprint.topic}. CEFR: ${blueprint.level}. Difficulty: ${blueprint.difficulty}.`,
          `Players requested: ${parsed.data.request}`,
          `Randomness seed: ${Math.floor(Math.random() * 1000000)}. Ensure the chosen words/phrases are highly diverse, unexpected, and different every time.`,
          `Generate exactly ${requiredModes.length} questions for rounds ${start + 1}-${start + requiredModes.length}.`,
          `Required modes in this exact order: ${requiredModes.join(", ")}.`,
          questions.length > 0 ? `Do not repeat any of these previous prompts: ${JSON.stringify(questions.map((question) => question.prompt))}` : "All prompts must be unique and unambiguous.",
          correction
        ].filter(Boolean).join("\n");
        const complexCount = requiredModes.filter((mode) => ["READING", "LISTENING", "SPEAKING", "ROLEPLAY", "DEBATE"].includes(mode)).length;
        const batchTokenBudget = Math.max(800, Math.min(2300, requiredModes.length * 150 + complexCount * 180 + 300));
        const batchJson = await requestGroqJson(apiKey, model, batchPrompt, batchTokenBudget, questionBatchOutputSchema(requiredModes.length));
        const rawQuestions = isRecord(batchJson) && Array.isArray(batchJson.items) ? batchJson.items : [];
        const normalized = rawQuestions.map((question, index) => normalizeCompactItem(question, requiredModes[index] ?? fallbackMode, blueprint)).filter((question): question is GeneratedQuestion => question !== null);
        const normalizedResult = z.array(generatedQuestionSchema).length(requiredModes.length).safeParse(normalized);
        const existingPrompts = new Set(questions.map((question) => question.prompt.trim().toLocaleLowerCase("vi-VN")));
        const existingAnswers = new Set(questions.map((question) => answerKey(question.canonicalAnswer)));
        const normalizedPrompts = normalized.map((question) => question.prompt.trim().toLocaleLowerCase("vi-VN"));
        const normalizedAnswers = normalized.map((question) => answerKey(question.canonicalAnswer));
        const hasDuplicate = normalizedPrompts.some((prompt, index) => existingPrompts.has(prompt) || normalizedPrompts.indexOf(prompt) !== index)
          || normalizedAnswers.some((answer, index) => existingAnswers.has(answer) || normalizedAnswers.indexOf(answer) !== index);

        if (normalizedResult.success && !hasDuplicate) validBatch = normalizedResult.data;
        else correction = `Attempt ${attempt} was invalid: expected exactly ${requiredModes.length} complete, unique questions but received ${rawQuestions.length} raw and ${normalized.length} valid. Regenerate the entire batch and follow the schema exactly.`;
      }

      if (!validBatch) throw new Error(`Groq could not produce a valid question batch for rounds ${start + 1}-${start + requiredModes.length} after 3 attempts`);
      questions.push(...validBatch);
      await updateGenerationJob({ completed_rounds: questions.length, stage: `Đã tạo ${questions.length}/${blueprint.rounds} câu hỏi` });
    }

    const finalPack = generatedGamePackSchema.safeParse({ blueprint, questions });
    if (!finalPack.success) throw new Error("The combined Groq question pack failed final validation");
    pack = {
      ...finalPack.data,
      questions: finalPack.data.blueprint.settings.shuffleQuestions ? shuffled(finalPack.data.questions) : finalPack.data.questions
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Groq generation failed";
    await updateGenerationJob({ status: "failed", stage: "Tạo trận thất bại", error_message: errorMessage.slice(0, 1000), completed_at: new Date().toISOString() });
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: errorMessage }, { status: 502 });
  }

  try {
    await ensureGenerationActive();
  } catch (error) {
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id).eq("status", "GENERATING_GAME");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Generation was cancelled" }, { status: 409 });
  }
  await updateGenerationJob({ status: "persisting", stage: "Đang lưu và kiểm tra trận đấu" });
  const { data: match, error: matchError } = await admin.from("matches").insert({
    room_id: room.id, title: pack.blueprint.title, topic: pack.blueprint.topic,
    level: pack.blueprint.level, status: "ready", blueprint: pack.blueprint,
    round_count: pack.blueprint.rounds, current_round: 0
  }).select("id").single();
  if (matchError || !match) {
    await updateGenerationJob({ status: "failed", stage: "Không thể lưu trận đấu", error_message: (matchError?.message ?? "Could not persist match").slice(0, 1000), completed_at: new Date().toISOString() });
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: matchError?.message || "Could not persist match" }, { status: 500 });
  }

  try {
    const { error: playersError } = await admin.from("match_players").insert(members.map((member) => ({ match_id: match.id, user_id: member.user_id })));
    if (playersError) throw playersError;
    const { data: questions, error: questionsError } = await admin.from("questions").insert(pack.questions.map((question, index) => ({
      match_id: match.id, round_number: index + 1, mode: question.mode, prompt: question.prompt,
      instruction: question.instruction, level: question.level, public_payload: question.publicData,
      difficulty: question.difficulty, time_limit: question.timeLimit
    }))).select("id, round_number");
    if (questionsError || !questions) throw questionsError ?? new Error("Questions were not persisted");
    const { error: answersError } = await admin.from("question_answers").insert(questions.map((question) => {
      const generated = pack.questions[question.round_number - 1];
      if (!generated) throw new Error(`Generated question ${question.round_number} is missing`);
      return { question_id: question.id, canonical_answer: generated.canonicalAnswer, accepted_answers: [...new Set([generated.canonicalAnswer, ...generated.acceptedAnswers])], grading_rules: { mode: generated.mode, strictness: pack.blueprint.settings.strictness, rubric: generated.publicData.rubric ?? [], ...generated.privateData }, explanation: generated.explanation };
    }));
    if (answersError) throw answersError;
    await admin.from("rooms").update({ status: "GAME_READY" }).eq("id", room.id);
    await updateGenerationJob({ status: "completed", stage: "Trận đấu đã sẵn sàng", completed_rounds: pack.blueprint.rounds, match_id: match.id, completed_at: new Date().toISOString() });
    return NextResponse.json({ matchId: match.id, blueprint: pack.blueprint }, { status: 201 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Could not persist generated match";
    await admin.from("matches").delete().eq("id", match.id);
    await updateGenerationJob({ status: "failed", stage: "Không thể hoàn tất trận đấu", error_message: errorMessage.slice(0, 1000), completed_at: new Date().toISOString() });
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
