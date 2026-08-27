import { z } from "zod";

export const questionModeSchema = z.enum([
  "VI_TO_EN", "EN_TO_VI", "LISTENING", "SPELLING", "CONTEXT", "GRAMMAR", "TRANSLATION", "DEFINITION", "BOSS"
]);

export const battleBlueprintSchema = z.object({
  title: z.string().min(3).max(80),
  topic: z.string().min(2).max(60),
  level: z.string().min(1).max(20),
  rounds: z.number().int().min(5).max(50),
  timePerQuestion: z.number().int().min(5).max(90),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  modes: z.array(z.object({ type: questionModeSchema, count: z.number().int().positive() })).min(1),
  speedScoring: z.boolean(),
  streakBonus: z.boolean()
}).superRefine((value, context) => {
  const total = value.modes.reduce((sum, mode) => sum + mode.count, 0);
  if (total !== value.rounds) context.addIssue({ code: "custom", path: ["modes"], message: "Mode counts must equal the round count." });
});

export const answerSubmissionSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.string().trim().min(1).max(500)
});

export const generatedQuestionSchema = z.object({
  mode: questionModeSchema,
  prompt: z.string().min(1).max(1000),
  instruction: z.string().max(300).default(""),
  level: z.string().min(1).max(30),
  timeLimit: z.number().int().min(3).max(180),
  publicData: z.record(z.string(), z.unknown()).default({}),
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

export const gameGenerationRequestSchema = z.object({
  roomId: z.string().uuid(),
  request: z.string().trim().min(3).max(1000)
});

export type BattleBlueprintInput = z.infer<typeof battleBlueprintSchema>;
