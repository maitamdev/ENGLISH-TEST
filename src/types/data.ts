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
};

export type SubmissionView = {
  userId: string;
  answer: string;
  correct: boolean;
  timedOut?: boolean;
  responseMs: number;
  points: number;
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
  currentUserId: string;
  phase: RoomPhase;
  members: RoomMemberData[];
  match: MatchView | null;
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
