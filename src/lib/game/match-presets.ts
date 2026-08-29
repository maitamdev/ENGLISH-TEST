import type { BattleBlueprint, MatchSettings, QuestionMode } from "@/types/game";

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  experience: "DUEL",
  aiPresence: "ACTIVE",
  feedbackStyle: "TEACHER",
  strictness: "STANDARD",
  adaptiveDifficulty: true,
  allowHints: true,
  maxHints: 1,
  hintPenalty: 20,
  shuffleQuestions: true,
  shuffleOptions: true,
  listeningAccent: "US",
  listeningSpeed: 1,
  listeningFocus: "MIXED",
  replayLimit: 2,
  showTranscriptAfter: true,
  speakingSeconds: 45,
  shadowingSeconds: 30,
  answerReveal: "AFTER_BOTH"
};

export type MatchPreset = {
  id: string;
  label: string;
  description: string;
  skill: "Vocabulary" | "Listening" | "Reading" | "Speaking" | "Writing" | "Grammar" | "Mixed" | "Co-op";
  rounds: number;
  timePerQuestion: number;
  modes: { type: QuestionMode; count: number }[];
  settings: Partial<MatchSettings>;
};

export const MATCH_PRESETS: MatchPreset[] = [
  { id: "vocabulary-duel", label: "Đấu từ vựng", description: "Dịch hai chiều, định nghĩa và điền ngữ cảnh.", skill: "Vocabulary", rounds: 10, timePerQuestion: 30, modes: [{ type: "VI_TO_EN", count: 4 }, { type: "EN_TO_VI", count: 4 }, { type: "CONTEXT", count: 2 }], settings: {} },
  { id: "listening-sprint", label: "Thi nghe", description: "Nghe giọng thật, chọn đáp án và chép chính tả.", skill: "Listening", rounds: 10, timePerQuestion: 40, modes: [{ type: "LISTENING", count: 5 }, { type: "SPELLING", count: 3 }, { type: "MULTIPLE_CHOICE", count: 2 }], settings: { replayLimit: 2 } },
  { id: "listening-lab", label: "Listening Lab", description: "Nghe từ, câu và hội thoại ngắn với nhiều kiểu câu hỏi.", skill: "Listening", rounds: 12, timePerQuestion: 50, modes: [{ type: "AUDIO_CHOICE", count: 3 }, { type: "MINIMAL_PAIRS", count: 3 }, { type: "STORY_LISTENING", count: 3 }, { type: "SPELLING", count: 3 }], settings: { replayLimit: 3, listeningFocus: "MIXED" } },
  { id: "minimal-pair-duel", label: "Săn âm gần", description: "Phân biệt các cặp âm tiếng Anh dễ nghe nhầm.", skill: "Listening", rounds: 10, timePerQuestion: 30, modes: [{ type: "MINIMAL_PAIRS", count: 10 }], settings: { replayLimit: 3, listeningFocus: "WORDS" } },
  { id: "story-quest", label: "Story Quest", description: "Nghe mẩu chuyện rồi tìm ý chính, chi tiết và suy luận.", skill: "Listening", rounds: 8, timePerQuestion: 75, modes: [{ type: "STORY_LISTENING", count: 6 }, { type: "AUDIO_CHOICE", count: 2 }], settings: { replayLimit: 2, listeningFocus: "STORIES" } },
  { id: "reading-challenge", label: "Thi đọc", description: "Đọc đoạn ngắn, tìm ý chính, chi tiết và suy luận.", skill: "Reading", rounds: 10, timePerQuestion: 60, modes: [{ type: "READING", count: 6 }, { type: "MULTIPLE_CHOICE", count: 2 }, { type: "DEFINITION", count: 2 }], settings: {} },
  { id: "speaking-arena", label: "Thi nói", description: "Phát âm, phản xạ nói, roleplay và tranh luận ngắn.", skill: "Speaking", rounds: 8, timePerQuestion: 70, modes: [{ type: "PRONUNCIATION", count: 2 }, { type: "SPEAKING", count: 3 }, { type: "ROLEPLAY", count: 2 }, { type: "DEBATE", count: 1 }], settings: { speakingSeconds: 45 } },
  { id: "shadowing-studio", label: "Shadowing Studio", description: "Nghe, bắt chước nhịp điệu, trọng âm và ngữ điệu.", skill: "Speaking", rounds: 8, timePerQuestion: 65, modes: [{ type: "SHADOWING", count: 6 }, { type: "PRONUNCIATION", count: 2 }], settings: { replayLimit: 3, shadowingSeconds: 30 } },
  { id: "writing-workshop", label: "Thi viết", description: "Viết phản hồi, sửa ngữ pháp và dịch theo rubric.", skill: "Writing", rounds: 8, timePerQuestion: 90, modes: [{ type: "WRITING", count: 4 }, { type: "GRAMMAR", count: 2 }, { type: "TRANSLATION", count: 2 }], settings: {} },
  { id: "sentence-forge", label: "Xưởng câu", description: "Xếp từ, điền chỗ trống và hoàn thiện câu tự nhiên.", skill: "Grammar", rounds: 10, timePerQuestion: 45, modes: [{ type: "SENTENCE_BUILDER", count: 4 }, { type: "CLOZE", count: 3 }, { type: "COLLOCATION", count: 3 }], settings: {} },
  { id: "grammar-repair", label: "Sửa lỗi tốc độ", description: "Tìm và sửa lỗi trong câu theo đúng ngữ cảnh.", skill: "Grammar", rounds: 10, timePerQuestion: 50, modes: [{ type: "ERROR_CORRECTION", count: 5 }, { type: "CLOZE", count: 3 }, { type: "GRAMMAR", count: 2 }], settings: {} },
  { id: "mixed-cefr", label: "Đấu tổng hợp", description: "Nghe, đọc, từ vựng, ngữ pháp và nói trong một trận.", skill: "Mixed", rounds: 12, timePerQuestion: 45, modes: [{ type: "VI_TO_EN", count: 2 }, { type: "LISTENING", count: 2 }, { type: "READING", count: 2 }, { type: "GRAMMAR", count: 2 }, { type: "MULTIPLE_CHOICE", count: 2 }, { type: "SPEAKING", count: 2 }], settings: { adaptiveDifficulty: true } },
  { id: "coop-study", label: "Học cùng nhau", description: "Hai người cùng tích điểm đội và được AI giải thích kỹ.", skill: "Co-op", rounds: 10, timePerQuestion: 55, modes: [{ type: "CONTEXT", count: 2 }, { type: "LISTENING", count: 2 }, { type: "READING", count: 2 }, { type: "GRAMMAR", count: 2 }, { type: "SPEAKING", count: 2 }], settings: { experience: "COOP", feedbackStyle: "DETAILED", aiPresence: "ACTIVE", allowHints: true, maxHints: 2 } }
];

export function resolveMatchSettings(blueprint?: Pick<BattleBlueprint, "settings"> | null): MatchSettings {
  return { ...DEFAULT_MATCH_SETTINGS, ...(blueprint?.settings ?? {}) };
}

export function getMatchPreset(id: string) {
  return MATCH_PRESETS.find((preset) => preset.id === id) ?? MATCH_PRESETS[0];
}
