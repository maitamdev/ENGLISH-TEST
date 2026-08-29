import type { BattleBlueprint, PublicQuestion, RoomPhase } from "./game";

export type ProfileRecord = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  cefr_estimate: string | null;
};

export type LearningStatsRecord = {
  vocabulary_score: number | null;
  grammar_score: number | null;
  listening_score: number | null;
  spelling_score: number | null;
  translation_score: number | null;
  reading_score: number | null;
  speaking_score: number | null;
  pronunciation_score: number | null;
  writing_score: number | null;
  current_streak_days: number;
  last_practice_date: string | null;
};

export type DashboardMatch = {
  id: string;
  roomCode: string;
  title: string;
  level: string;
  roundCount: number;
  score: number;
  opponentScore: number | null;
  opponentName: string | null;
  opponentAvatar: string | null;
  winnerId: string | null;
  status: string;
  createdAt: string;
};

export type DashboardData = {
  profile: ProfileRecord;
  stats: LearningStatsRecord | null;
  matches: DashboardMatch[];
  totalMatches: number;
  masteredWords: number;
  winCount: number;
};

export type RoomMemberData = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  isReady: boolean;
  connectionState: string;
  joinedAt: string;
  score: number;
  streak: number;
  lastSeenAt: string;
  deviceState: Record<string, unknown>;
  connectionQuality: Record<string, unknown>;
};

export type SubmissionView = {
  id: string;
  userId: string;
  answer: string;
  correct: boolean;
  timedOut?: boolean;
  matchType?: "accepted" | "minor_typo" | "incorrect" | "semantic_appeal" | "rubric";
  matchedAnswer?: string | null;
  responseMs: number;
  points: number;
  hintsUsed?: number;
  scoreComponents?: { base?: number; accuracyFactor?: number; difficulty?: number; difficultyBonus?: number; speed?: number; speedBonus?: number; streak?: number; streakBonus?: number; modeFactor?: number; hintDeduction?: number; total?: number; version?: string } | null;
  rubricScore?: number | null;
  assessment?: {
    content?: number;
    pronunciation?: number;
    fluency?: number;
    grammar?: number;
    vocabulary?: number;
    overall?: number;
    task?: number;
    coherence?: number;
    feedbackVi?: string;
    strengths?: string[];
    improvements?: string[];
    intelligibility?: number;
    segmental?: number;
    wordStress?: number;
    rhythm?: number;
    intonation?: number;
    wordFeedback?: { word: string; observed: string; target: string; feedbackVi: string }[];
    phonemeFeedback?: { phoneme: string; issue: string; example: string }[];
    practiceDrills?: string[];
  } | null;
};

export type MatchView = {
  id: string;
  title: string;
  topic: string;
  level: string;
  status: string;
  blueprint: BattleBlueprint;
  roundCount: number;
  currentRound: number;
  roundStartedAt: string | null;
  roundDeadlineAt: string | null;
  roundEpoch: number;
  winnerId: string | null;
  question: PublicQuestion | null;
  submissions: SubmissionView[];
};

export type RoundResolutionData = {
  canonicalAnswer: string;
  acceptedAnswers: string[];
  explanation: string;
  submissions: SubmissionView[];
};

export type RoomBootstrap = {
  roomId: string;
  code: string;
  hostId: string;
  hostEpoch: number;
  stateVersion: number;
  hostLeaseExpiresAt: string;
  currentUserId: string;
  phase: RoomPhase;
  members: RoomMemberData[];
  match: MatchView | null;
  generation: {
    status: "queued" | "generating" | "persisting" | "retrying" | "completed" | "failed" | "cancelled";
    stage: string;
    totalRounds: number | null;
    completedRounds: number;
    errorMessage: string | null;
    updatedAt: string;
  } | null;
  aiSession: {
    id: string;
    coordinatorId: string;
    heartbeatAt: string;
  } | null;
};

export type VocabularyRecord = {
  word: string;
  meaning: string | null;
  example_sentence: string | null;
  topic: string | null;
  mastery: number;
  correct_count: number;
  wrong_count: number;
  next_review_at: string | null;
};
