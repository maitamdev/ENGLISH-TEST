import { z } from "zod";

export const questionModeSchema = z.enum([
  "VI_TO_EN", "EN_TO_VI", "LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING",
  "MULTIPLE_CHOICE", "READING", "SENTENCE_BUILDER", "CLOZE", "ERROR_CORRECTION", "COLLOCATION", "CONTEXT", "GRAMMAR",
  "TRANSLATION", "DEFINITION", "PRONUNCIATION", "SPEAKING", "ROLEPLAY", "DEBATE", "WRITING", "BOSS"
]);

export const matchSettingsSchema = z.object({
  experience: z.enum(["DUEL", "COOP", "PRACTICE"]).default("DUEL"),
  aiPresence: z.enum(["QUIET", "BALANCED", "ACTIVE"]).default("ACTIVE"),
  feedbackStyle: z.enum(["CONCISE", "TEACHER", "DETAILED"]).default("TEACHER"),
  strictness: z.enum(["LENIENT", "STANDARD", "STRICT"]).default("STANDARD"),
  adaptiveDifficulty: z.boolean().default(true),
  allowHints: z.boolean().default(true),
  maxHints: z.number().int().min(0).max(3).default(1),
  hintPenalty: z.number().int().min(0).max(50).default(20),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  listeningAccent: z.enum(["US", "UK", "AU"]).default("US"),
  listeningSpeed: z.union([z.literal(0.75), z.literal(1), z.literal(1.25)]).default(1),
  listeningFocus: z.enum(["WORDS", "SENTENCES", "STORIES", "MIXED"]).default("MIXED"),
  replayLimit: z.number().int().min(1).max(5).default(2),
  showTranscriptAfter: z.boolean().default(true),
  speakingSeconds: z.number().int().min(10).max(120).default(45),
  shadowingSeconds: z.number().int().min(10).max(90).default(30),
  answerReveal: z.literal("AFTER_BOTH").default("AFTER_BOTH"),
  sequencingPolicy: z.enum(["BALANCED", "WEAKNESS_FIRST", "SPACED_RETRIEVAL"]).default("BALANCED"),
  difficultyCurve: z.enum(["STEADY", "RAMP_UP", "ADAPTIVE"]).default("ADAPTIVE"),
  remediationPolicy: z.enum(["AUTO", "WRONG_ONLY", "OFF"]).default("AUTO"),
  fairnessMode: z.enum(["STANDARD", "STRICT"]).default("STANDARD"),
  requireAudioPreflight: z.boolean().default(true)
});

export const battleBlueprintSchema = z.object({
  title: z.string().min(3).max(80),
  topic: z.string().min(2).max(60),
  level: z.string().min(1).max(20),
  rounds: z.number().int().min(5).max(50),
  timePerQuestion: z.number().int().min(5).max(120),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  modes: z.array(z.object({ type: questionModeSchema, count: z.number().int().positive() })).min(1),
  speedScoring: z.boolean(),
  streakBonus: z.boolean(),
  settings: matchSettingsSchema.optional().transform((value) => matchSettingsSchema.parse(value ?? {}))
}).superRefine((value, context) => {
  const total = value.modes.reduce((sum, mode) => sum + mode.count, 0);
  if (total !== value.rounds) context.addIssue({ code: "custom", path: ["modes"], message: "Mode counts must equal the round count." });
});

export const answerSubmissionSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.string().trim().min(1).max(1500)
});

export const generatedQuestionSchema = z.object({
  mode: questionModeSchema,
  prompt: z.string().min(1).max(1000),
  instruction: z.string().max(300).default(""),
  level: z.string().min(1).max(30),
  timeLimit: z.number().int().min(3).max(180),
  publicData: z.record(z.string(), z.unknown()).default({}),
  privateData: z.record(z.string(), z.unknown()).default({}),
  canonicalAnswer: z.string().min(1).max(500),
  acceptedAnswers: z.array(z.string().min(1).max(500)).min(1).max(20),
  explanation: z.string().min(1).max(1000),
  difficulty: z.number().int().min(1).max(10)
});

export const generatedGamePackSchema = z.object({
  blueprint: battleBlueprintSchema,
  questions: z.array(generatedQuestionSchema).min(5).max(50)
}).superRefine((value, context) => {
  if (value.questions.length !== value.blueprint.rounds) context.addIssue({ code: "custom", path: ["questions"], message: "Question count must equal blueprint rounds." });
  const normalizedPrompts = value.questions.map((question) => question.prompt.trim().toLocaleLowerCase());
  if (new Set(normalizedPrompts).size !== normalizedPrompts.length) context.addIssue({ code: "custom", path: ["questions"], message: "Question prompts must be unique." });
});

export const gameGenerationPreferencesSchema = z.object({
  presetId: z.string().trim().min(1).max(40).optional(),
  rounds: z.number().int().min(5).max(50).optional(),
  timePerQuestion: z.number().int().min(10).max(120).optional(),
  level: z.enum(["A1", "A2", "B1", "B2", "C1", "C2", "Mixed"]).optional(),
  difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
  modes: z.array(z.object({ type: questionModeSchema, count: z.number().int().positive() })).min(1).optional(),
  settings: matchSettingsSchema.partial().optional()
});

export const arenaAdaptiveContextSchema = z.object({
  skillMastery: z.record(z.string(), z.number().min(0).max(100)).default({}),
  reviewDueBySkill: z.record(z.string(), z.number().int().nonnegative()).default({}),
  evidenceCount: z.number().int().nonnegative().default(0),
  analyticsParticipants: z.number().int().min(0).max(2).default(0)
});

export const gameGenerationRequestSchema = z.object({
  roomId: z.string().uuid(),
  request: z.string().trim().min(3).max(1000),
  preferences: gameGenerationPreferencesSchema.optional(),
  adaptiveContext: arenaAdaptiveContextSchema.optional()
});

export type BattleBlueprintInput = z.infer<typeof battleBlueprintSchema>;
