import { describe, expect, it } from "vitest";
import { assessQuestionBatch, normalizeLearningText, textSimilarity, type QualityQuestion } from "./question-quality";

function question(overrides: Partial<QualityQuestion> = {}): QualityQuestion {
  return {
    mode: "VI_TO_EN",
    prompt: "Cái bàn trong tiếng Anh là gì?",
    instruction: "Nhập một từ tiếng Anh.",
    level: "A1",
    timeLimit: 40,
    publicData: {},
    privateData: {},
    canonicalAnswer: "table",
    acceptedAnswers: ["table"],
    explanation: "Table là danh từ tiếng Anh chỉ một chiếc bàn.",
    difficulty: 2,
    ...overrides
  };
}

describe("normalizeLearningText", () => {
  it("normalizes Unicode, articles, punctuation and spacing without removing Vietnamese meaning", () => {
    expect(normalizeLearningText("  The “Dining–Table”! ")).toBe("dining table");
    expect(normalizeLearningText("TỦ   lạnh")).toBe("tủ lạnh");
  });
});

describe("textSimilarity", () => {
  it("detects semantic token overlap used by duplicate prompt prevention", () => {
    expect(textSimilarity("Dịch từ cái bàn sang tiếng Anh", "Hãy dịch cái bàn sang tiếng Anh")).toBeGreaterThan(0.7);
    expect(textSimilarity("Dịch từ cái bàn", "Nghe câu chuyện về sân bay")).toBeLessThan(0.25);
  });
});

describe("assessQuestionBatch", () => {
  it("passes a structurally sound bilingual question", () => {
    const report = assessQuestionBatch([question()]);
    expect(report.passed).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(0.86);
  });

  it("rejects duplicate answers and near-duplicate prompts across rounds", () => {
    const report = assessQuestionBatch([question()], [{ prompt: "Cái bàn trong tiếng Anh là gì?", canonicalAnswer: "table" }]);
    expect(report.passed).toBe(false);
    expect(report.checks.some((check) => check.code === "unique_canonical_answer" && !check.passed)).toBe(true);
    expect(report.checks.some((check) => check.code === "unique_prompt_semantics" && !check.passed)).toBe(true);
  });

  it("rejects a multiple-choice question with more than one accepted visible option", () => {
    const report = assessQuestionBatch([question({ mode: "MULTIPLE_CHOICE", prompt: "Chọn từ chỉ ghế.", canonicalAnswer: "chair", acceptedAnswers: ["chair", "seat"], publicData: { options: ["chair", "seat", "table"] } })]);
    expect(report.passed).toBe(false);
    expect(report.checks.some((check) => check.code === "single_correct_option" && !check.passed)).toBe(true);
  });

  it("keeps listening transcript private", () => {
    const safe = assessQuestionBatch([question({ mode: "LISTENING", prompt: "Nghe và nhập từ bạn nghe được.", canonicalAnswer: "window", acceptedAnswers: ["window"], privateData: { audioText: "window" } })]);
    const leaked = assessQuestionBatch([question({ mode: "LISTENING", prompt: "Nghe và nhập từ bạn nghe được.", canonicalAnswer: "window", acceptedAnswers: ["window"], privateData: { audioText: "window" }, publicData: { transcript: "window" } })]);
    expect(safe.passed).toBe(true);
    expect(leaked.checks.some((check) => check.code === "audio_text_not_public" && !check.passed)).toBe(true);
  });

  it("rejects provenance ids outside approved grounding context", () => {
    const report = assessQuestionBatch([question({ privateData: { sourceContentId: "22222222-2222-4222-8222-222222222222" } })], [], new Set(["11111111-1111-4111-8111-111111111111"]));
    expect(report.passed).toBe(false);
    expect(report.checks.some((check) => check.code === "source_provenance_valid" && !check.passed)).toBe(true);
  });
});
