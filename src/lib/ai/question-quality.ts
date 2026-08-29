import type { z } from "zod";
import type { generatedQuestionSchema } from "@/lib/validation/game";

export const QUESTION_PROMPT_VERSION = "generation-v2";
export const QUESTION_QUALITY_POLICY_VERSION = "quality-2026-08-30";

export type QualityQuestion = z.infer<typeof generatedQuestionSchema>;
export type QualityCheck = {
  code: string;
  passed: boolean;
  severity: "info" | "warning" | "error";
  roundIndex: number | null;
  detail: string;
};
export type QualityReport = {
  passed: boolean;
  score: number;
  fingerprint: string;
  checks: QualityCheck[];
};

const listeningModes = new Set(["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING"]);
const optionModes = new Set(["MULTIPLE_CHOICE", "AUDIO_CHOICE", "MINIMAL_PAIRS", "STORY_LISTENING"]);
const spokenModes = new Set(["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE"]);

export function normalizeLearningText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("vi-VN")
    .replace(/[“”„‟]/gu, "\"").replace(/[‘’‚‛]/gu, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, " ").replace(/\s+/gu, " ").trim()
    .replace(/^(a|an|the)\s+/u, "");
}

function tokenSet(value: string) {
  return new Set(normalizeLearningText(value).split(" ").filter(Boolean));
}

export function textSimilarity(left: string, right: string) {
  const a = tokenSet(left); const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stableFingerprint(value: string) {
  let first = 2166136261; let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619);
    second = Math.imul(second ^ value.charCodeAt(index), 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function add(checks: QualityCheck[], passed: boolean, code: string, severity: QualityCheck["severity"], roundIndex: number | null, detail: string) {
  checks.push({ code, passed, severity, roundIndex, detail });
}

export function assessQuestionBatch(
  questions: QualityQuestion[],
  previous: Pick<QualityQuestion, "prompt" | "canonicalAnswer">[] = [],
  allowedSourceIds: ReadonlySet<string> = new Set()
): QualityReport {
  const checks: QualityCheck[] = [];
  const seenPrompts = previous.map((question) => question.prompt);
  const seenAnswers = new Set(previous.map((question) => normalizeLearningText(question.canonicalAnswer)));

  questions.forEach((question, roundIndex) => {
    const answer = normalizeLearningText(question.canonicalAnswer);
    const accepted = [...new Set(question.acceptedAnswers.map(normalizeLearningText).filter(Boolean))];
    const prompt = normalizeLearningText(question.prompt);
    const options = strings(question.publicData.options);
    const normalizedOptions = options.map(normalizeLearningText);
    const sourceContentId = typeof question.privateData.sourceContentId === "string" ? question.privateData.sourceContentId : null;

    add(checks, Boolean(prompt && answer), "non_empty_learning_content", "error", roundIndex, "Prompt and canonical answer must contain meaningful text.");
    add(checks, accepted.includes(answer), "canonical_in_accepted_answers", "error", roundIndex, "Canonical answer must be represented in accepted answers after normalization.");
    add(checks, !seenAnswers.has(answer), "unique_canonical_answer", "error", roundIndex, "Canonical answer must not repeat an earlier round.");
    const promptSimilarity = seenPrompts.reduce((highest, item) => Math.max(highest, textSimilarity(item, question.prompt)), 0);
    add(checks, promptSimilarity < 0.88, "unique_prompt_semantics", "error", roundIndex, `Highest prompt similarity is ${promptSimilarity.toFixed(3)}.`);
    add(checks, !prompt.includes(answer) || answer.length <= 2, "answer_not_revealed_in_prompt", "error", roundIndex, "Prompt must not reveal the normalized canonical answer.");
    add(checks, accepted.length <= 12, "focused_accepted_answers", "warning", roundIndex, "Accepted answers should remain context-specific rather than overly broad.");
    add(checks, question.explanation.trim().length >= 12, "useful_explanation", "warning", roundIndex, "Explanation should teach why the answer is correct.");

    if (optionModes.has(question.mode) || options.length > 0) {
      add(checks, options.length >= 2 && options.length <= 6, "valid_option_count", "error", roundIndex, "Choice questions require two to six options.");
      add(checks, new Set(normalizedOptions).size === normalizedOptions.length, "unique_options", "error", roundIndex, "Options must be unique after normalization.");
      add(checks, normalizedOptions.filter((option) => accepted.includes(option)).length === 1, "single_correct_option", "error", roundIndex, "Exactly one visible option may be accepted as correct.");
    }

    if (listeningModes.has(question.mode)) {
      const audioText = typeof question.privateData.audioText === "string" ? normalizeLearningText(question.privateData.audioText) : "";
      add(checks, Boolean(audioText), "private_audio_text_present", "error", roundIndex, "Listening and shadowing questions require private audioText.");
      const publicDump = normalizeLearningText(JSON.stringify(question.publicData));
      add(checks, !audioText || !publicDump.includes(audioText), "audio_text_not_public", "error", roundIndex, "Private audioText must never be copied into publicData.");
    }

    if (question.mode === "SENTENCE_BUILDER") {
      const tokens = strings(question.publicData.tokens);
      add(checks, tokens.length >= 2, "builder_tokens_present", "error", roundIndex, "Sentence builder requires public shuffled tokens.");
      add(checks, normalizeLearningText(tokens.join(" ")) !== answer, "builder_tokens_shuffled", "warning", roundIndex, "Sentence builder tokens should not already be in answer order.");
    }

    if (spokenModes.has(question.mode)) {
      const target = typeof question.publicData.targetText === "string" ? question.publicData.targetText.trim() : "";
      const scenario = typeof question.publicData.scenario === "string" ? question.publicData.scenario.trim() : "";
      add(checks, Boolean(target || scenario), "speaking_target_present", "error", roundIndex, "Speaking questions require a targetText or scenario.");
    }

    add(checks, !sourceContentId || allowedSourceIds.has(sourceContentId), "source_provenance_valid", "error", roundIndex, "Claimed sourceContentId must be part of approved grounding context.");
    seenPrompts.push(question.prompt);
    seenAnswers.add(answer);
  });

  const relevant = checks.filter((check) => check.severity !== "info");
  const penalty = relevant.reduce((sum, check) => sum + (check.passed ? 0 : check.severity === "error" ? 1 : 0.25), 0);
  const score = Math.max(0, Math.min(1, relevant.length ? 1 - penalty / relevant.length : 1));
  const passed = checks.every((check) => check.severity !== "error" || check.passed) && score >= 0.86;
  const fingerprint = stableFingerprint(questions.map((question) => `${question.mode}|${normalizeLearningText(question.prompt)}|${normalizeLearningText(question.canonicalAnswer)}`).join("\n"));
  return { passed, score: Math.round(score * 10_000) / 10_000, fingerprint, checks };
}
