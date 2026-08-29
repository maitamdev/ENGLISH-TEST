export type RoomPhase =
  | "idle"
  | "ai-joining"
  | "ai-discussion"
  | "config"
  | "generating"
  | "countdown"
  | "battle"
  | "round-result"
  | "result";

export type QuestionMode =
  | "VI_TO_EN"
  | "EN_TO_VI"
  | "LISTENING"
  | "SPELLING"
  | "MINIMAL_PAIRS"
  | "AUDIO_CHOICE"
  | "STORY_LISTENING"
  | "SHADOWING"
  | "MULTIPLE_CHOICE"
  | "READING"
  | "SENTENCE_BUILDER"
  | "CLOZE"
  | "ERROR_CORRECTION"
  | "COLLOCATION"
  | "CONTEXT"
  | "GRAMMAR"
  | "TRANSLATION"
  | "DEFINITION"
  | "PRONUNCIATION"
  | "SPEAKING"
  | "ROLEPLAY"
  | "DEBATE"
  | "WRITING"
  | "BOSS";

export type MatchExperience = "DUEL" | "COOP" | "PRACTICE";
export type AiPresence = "QUIET" | "BALANCED" | "ACTIVE";
export type FeedbackStyle = "CONCISE" | "TEACHER" | "DETAILED";
export type AnswerStrictness = "LENIENT" | "STANDARD" | "STRICT";
export type ListeningAccent = "US" | "UK" | "AU";
export type ListeningFocus = "WORDS" | "SENTENCES" | "STORIES" | "MIXED";
export type SequencingPolicy = "BALANCED" | "WEAKNESS_FIRST" | "SPACED_RETRIEVAL";
export type DifficultyCurve = "STEADY" | "RAMP_UP" | "ADAPTIVE";
export type RemediationPolicy = "AUTO" | "WRONG_ONLY" | "OFF";
export type FairnessMode = "STANDARD" | "STRICT";

export type MatchSettings = {
  experience: MatchExperience;
  aiPresence: AiPresence;
  feedbackStyle: FeedbackStyle;
  strictness: AnswerStrictness;
  adaptiveDifficulty: boolean;
  allowHints: boolean;
  maxHints: number;
  hintPenalty: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  listeningAccent: ListeningAccent;
  listeningSpeed: 0.75 | 1 | 1.25;
  listeningFocus: ListeningFocus;
  replayLimit: number;
  showTranscriptAfter: boolean;
  speakingSeconds: number;
  shadowingSeconds: number;
  answerReveal: "AFTER_BOTH";
  sequencingPolicy: SequencingPolicy;
  difficultyCurve: DifficultyCurve;
  remediationPolicy: RemediationPolicy;
  fairnessMode: FairnessMode;
  requireAudioPreflight: boolean;
};

export type ArenaAdaptiveContext = {
  skillMastery: Record<string, number>;
  reviewDueBySkill: Record<string, number>;
  evidenceCount: number;
  analyticsParticipants: number;
};

export type GameGenerationPreferences = {
  presetId?: string;
  rounds?: number;
  timePerQuestion?: number;
  level?: "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "Mixed";
  difficulty?: "Easy" | "Medium" | "Hard";
  modes?: { type: QuestionMode; count: number }[];
  settings?: Partial<MatchSettings>;
};

export type PublicQuestion = {
  id: string;
  mode: QuestionMode;
  prompt: string;
  instruction: string;
  level: string;
  timeLimit: number;
  publicData?: Record<string, unknown>;
};

export type BattleBlueprint = {
  title: string;
  topic: string;
  level: string;
  rounds: number;
  timePerQuestion: number;
  difficulty: "Easy" | "Medium" | "Hard";
  modes: { type: QuestionMode; count: number }[];
  speedScoring: boolean;
  streakBonus: boolean;
  settings?: MatchSettings;
};

export type Player = {
  id: string;
  name: string;
  initials: string;
  score: number;
  streak: number;
  connected: boolean;
  speaking: boolean;
  avatar?: string;
};

export type RoundResolution = {
  playerId: string;
  answer: string;
  correct: boolean;
  responseMs: number;
  points: number;
};
