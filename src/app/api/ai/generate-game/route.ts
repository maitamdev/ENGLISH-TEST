import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  battleBlueprintSchema,
  gameGenerationRequestSchema,
  generatedGamePackSchema,
  generatedQuestionSchema,
  type BattleBlueprintInput
} from "@/lib/validation/game";

type GroqCompletion = { choices?: { message?: { content?: string } }[] };
type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
type QuestionMode = BattleBlueprintInput["modes"][number]["type"];

export const maxDuration = 120;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestGroqJson(apiKey: string, model: string, prompt: string, maxCompletionTokens: number) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          max_completion_tokens: maxCompletionTokens,
          ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
          response_format: { type: "json_object" },
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

function normalizeCompactItem(value: unknown, mode: QuestionMode, blueprint: BattleBlueprintInput): GeneratedQuestion | null {
  if (!isRecord(value)) return null;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const canonicalAnswer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (!prompt || !canonicalAnswer) return null;

  const acceptedFromGroq = Array.isArray(value.accepted)
    ? value.accepted.filter((answer): answer is string => typeof answer === "string").map((answer) => answer.trim()).filter(Boolean)
    : [];
  const acceptedAnswers = [...new Set([canonicalAnswer, ...acceptedFromGroq])].slice(0, 20);
  const defaultDifficulty = blueprint.difficulty === "Easy" ? 2 : blueprint.difficulty === "Medium" ? 5 : 8;

  const normalized = generatedQuestionSchema.safeParse({
    mode,
    prompt,
    instruction: mode === "VI_TO_EN" ? "Nhập từ hoặc cụm từ tiếng Anh." : mode === "EN_TO_VI" ? "Nhập nghĩa tiếng Việt." : "Nhập câu trả lời của bạn.",
    level: blueprint.level,
    timeLimit: blueprint.timePerQuestion,
    publicData: {},
    canonicalAnswer,
    acceptedAnswers,
    explanation: mode === "VI_TO_EN"
      ? `“${prompt}” trong tiếng Anh là “${canonicalAnswer}”.`
      : mode === "EN_TO_VI" ? `“${prompt}” có nghĩa là “${canonicalAnswer}”.` : `Đáp án đúng là “${canonicalAnswer}”.`,
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
  const explicitRounds = requestedRoundCount(parsed.data.request);
  const blueprintPrompt = [
    "Design only the blueprint for a two-player English learning competition.",
    "Return JSON only: {\"blueprint\":{\"title\":string,\"topic\":string,\"level\":string,\"rounds\":integer,\"timePerQuestion\":integer,\"difficulty\":\"Easy\"|\"Medium\"|\"Hard\",\"modes\":[{\"type\":mode,\"count\":integer}],\"speedScoring\":boolean,\"streakBonus\":boolean}}.",
    "Modes: VI_TO_EN, EN_TO_VI, LISTENING, SPELLING, CONTEXT, GRAMMAR, TRANSLATION, DEFINITION, BOSS.",
    "Use 5-50 rounds. Honor an explicit requested quantity exactly; otherwise use 10.",
    "For vocabulary translation, use VI_TO_EN and EN_TO_VI and split them as evenly as possible unless one direction was explicitly requested.",
    `Players requested: ${parsed.data.request}`
  ].join("\n");

  let pack: z.infer<typeof generatedGamePackSchema>;
  try {
    const blueprintJson = await requestGroqJson(apiKey, model, blueprintPrompt, 650);
    const blueprintEnvelope = z.object({ blueprint: battleBlueprintSchema }).safeParse(blueprintJson);
    if (!blueprintEnvelope.success) throw new Error("Groq returned an invalid match blueprint");
    const initialBlueprint = blueprintEnvelope.data.blueprint;
    const targetRounds = explicitRounds ?? initialBlueprint.rounds;
    const blueprintResult = battleBlueprintSchema.safeParse({
      ...initialBlueprint,
      rounds: targetRounds,
      modes: targetRounds === initialBlueprint.rounds ? initialBlueprint.modes : resizeModes(initialBlueprint.modes, targetRounds)
    });
    if (!blueprintResult.success) throw new Error("The generated match blueprint failed validation");
    const blueprint = blueprintResult.data;
    const schedule = modeSchedule(blueprint);
    const questions: GeneratedQuestion[] = [];
    const batchSize = 10;

    for (let start = 0; start < blueprint.rounds; start += batchSize) {
      if (start > 0) await wait(7000);
      const requiredModes = schedule.slice(start, Math.min(start + batchSize, blueprint.rounds));
      const fallbackMode = requiredModes[0];
      if (!fallbackMode) throw new Error(`No question mode was scheduled for round ${start + 1}`);
      let validBatch: GeneratedQuestion[] | null = null;
      let correction = "";

      for (let attempt = 1; attempt <= 3 && !validBatch; attempt += 1) {
        if (attempt > 1) await wait(7000);
        const batchPrompt = [
          "Generate one compact batch of answer pairs for a two-player English competition.",
          "Return exactly one JSON object and no markdown: {\"items\":[{\"prompt\":string,\"answer\":string,\"accepted\":[string]}]}.",
          `Blueprint: ${JSON.stringify(blueprint)}`,
          `Players requested: ${parsed.data.request}`,
          `Generate exactly ${requiredModes.length} questions for rounds ${start + 1}-${start + requiredModes.length}.`,
          `Required modes in this exact order: ${requiredModes.join(", ")}.`,
          "Do not include instructions, levels, timers, explanations, difficulty, publicData, markdown or extra prose; the server creates those fields.",
          "For VI_TO_EN: prompt is Vietnamese and answer is English. For EN_TO_VI: prompt is English and answer is Vietnamese. For other modes, make prompt and answer match the requested learning task.",
          "accepted contains only legitimate alternative correct answers and may contain just the main answer.",
          "Example item only: {\"prompt\":\"cái bàn\",\"answer\":\"table\",\"accepted\":[\"table\"]}.",
          questions.length > 0 ? `Do not repeat any of these previous prompts: ${JSON.stringify(questions.map((question) => question.prompt))}` : "All prompts must be unique and unambiguous.",
          correction
        ].filter(Boolean).join("\n");
        const batchTokenBudget = Math.max(550, Math.min(1200, requiredModes.length * 90 + 250));
        const batchJson = await requestGroqJson(apiKey, model, batchPrompt, batchTokenBudget);
        const rawQuestions = isRecord(batchJson) && Array.isArray(batchJson.items) ? batchJson.items : [];
        const normalized = rawQuestions.map((question, index) => normalizeCompactItem(question, requiredModes[index] ?? fallbackMode, blueprint)).filter((question): question is GeneratedQuestion => question !== null);
        const normalizedResult = z.array(generatedQuestionSchema).length(requiredModes.length).safeParse(normalized);
        const existingPrompts = new Set(questions.map((question) => question.prompt.trim().toLocaleLowerCase("vi-VN")));
        const normalizedPrompts = normalized.map((question) => question.prompt.trim().toLocaleLowerCase("vi-VN"));
        const hasDuplicate = normalizedPrompts.some((prompt, index) => existingPrompts.has(prompt) || normalizedPrompts.indexOf(prompt) !== index);

        if (normalizedResult.success && !hasDuplicate) validBatch = normalizedResult.data;
        else correction = `Attempt ${attempt} was invalid: expected exactly ${requiredModes.length} complete, unique questions but received ${rawQuestions.length} raw and ${normalized.length} valid. Regenerate the entire batch and follow the schema exactly.`;
      }

      if (!validBatch) throw new Error(`Groq could not produce a valid question batch for rounds ${start + 1}-${start + requiredModes.length} after 3 attempts`);
      questions.push(...validBatch);
    }

    const finalPack = generatedGamePackSchema.safeParse({ blueprint, questions });
    if (!finalPack.success) throw new Error("The combined Groq question pack failed final validation");
    pack = finalPack.data;
  } catch (error) {
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Groq generation failed" }, { status: 502 });
  }

  const { data: match, error: matchError } = await admin.from("matches").insert({
    room_id: room.id, title: pack.blueprint.title, topic: pack.blueprint.topic,
    level: pack.blueprint.level, status: "ready", blueprint: pack.blueprint,
    round_count: pack.blueprint.rounds, current_round: 0
  }).select("id").single();
  if (matchError || !match) {
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
      return { question_id: question.id, canonical_answer: generated.canonicalAnswer, accepted_answers: [...new Set([generated.canonicalAnswer, ...generated.acceptedAnswers])], grading_rules: {}, explanation: generated.explanation };
    }));
    if (answersError) throw answersError;
    await admin.from("rooms").update({ status: "GAME_READY" }).eq("id", room.id);
    return NextResponse.json({ matchId: match.id, blueprint: pack.blueprint }, { status: 201 });
  } catch (error) {
    await admin.from("matches").delete().eq("id", match.id);
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not persist generated match" }, { status: 500 });
  }
}
