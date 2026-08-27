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
  | "CONTEXT"
  | "GRAMMAR"
  | "TRANSLATION"
  | "DEFINITION"
  | "BOSS";

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
