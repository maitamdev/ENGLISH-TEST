import type { ArenaAdaptiveContext, DifficultyCurve, QuestionMode, SequencingPolicy } from "@/types/game";

export const ARENA_ADAPTATION_VERSION = "arena-adaptation-v1";

const modeSkills: Record<QuestionMode, string> = {
  VI_TO_EN: "vocabulary", EN_TO_VI: "vocabulary", CONTEXT: "vocabulary", DEFINITION: "vocabulary", BOSS: "vocabulary",
  LISTENING: "listening", SPELLING: "listening", MINIMAL_PAIRS: "listening", AUDIO_CHOICE: "listening", STORY_LISTENING: "listening",
  SHADOWING: "phonology", PRONUNCIATION: "phonology", SPEAKING: "speaking", ROLEPLAY: "speaking", DEBATE: "speaking",
  READING: "reading", MULTIPLE_CHOICE: "reading", GRAMMAR: "grammar", SENTENCE_BUILDER: "grammar", CLOZE: "grammar",
  ERROR_CORRECTION: "grammar", COLLOCATION: "grammar", WRITING: "writing", TRANSLATION: "writing"
};

export function skillForArenaMode(mode: QuestionMode) { return modeSkills[mode]; }

export function buildAdaptiveModeSchedule(
  modes: { type: QuestionMode; count: number }[],
  policy: SequencingPolicy,
  context?: ArenaAdaptiveContext
) {
  const remaining = new Map(modes.map((mode) => [mode.type, mode.count]));
  const total = modes.reduce((sum, mode) => sum + mode.count, 0);
  const result: QuestionMode[] = [];
  while (result.length < total) {
    const candidates = modes.filter((mode) => (remaining.get(mode.type) ?? 0) > 0);
    candidates.sort((left, right) => {
      const score = (mode: QuestionMode) => {
        const skill = skillForArenaMode(mode);
        const mastery = context?.skillMastery[skill] ?? 50;
        const due = context?.reviewDueBySkill[skill] ?? 0;
        const recentlyUsed = result.slice(-2).includes(mode) ? 35 : 0;
        const remainingBoost = (remaining.get(mode) ?? 0) * 2;
        if (policy === "WEAKNESS_FIRST") return (100 - mastery) * 1.3 + due * 2 + remainingBoost - recentlyUsed;
        if (policy === "SPACED_RETRIEVAL") return due * 8 + (100 - mastery) * .45 + remainingBoost - recentlyUsed;
        return remainingBoost - recentlyUsed;
      };
      const delta = score(right.type) - score(left.type);
      return delta || left.type.localeCompare(right.type);
    });
    const selected = candidates[0]?.type;
    if (!selected) break;
    result.push(selected);
    remaining.set(selected, (remaining.get(selected) ?? 1) - 1);
  }
  return result;
}

export function buildDifficultySchedule(rounds: number, curve: DifficultyCurve, context?: ArenaAdaptiveContext) {
  const scores = Object.values(context?.skillMastery ?? {});
  const mean = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 50;
  const adaptiveBase = mean < 35 ? 3 : mean < 55 ? 4 : mean < 75 ? 5 : 6;
  return Array.from({ length: rounds }, (_, index) => {
    if (curve === "STEADY") return adaptiveBase;
    if (curve === "RAMP_UP") return Math.min(9, Math.max(2, 3 + Math.floor(index / Math.max(1, rounds / 5))));
    const wave = index % 4 === 3 ? 1 : index % 4 === 0 ? -1 : 0;
    return Math.min(9, Math.max(2, adaptiveBase + wave));
  });
}

export function requiresAudioReadiness(modes: { type: QuestionMode }[]) {
  return modes.some(({ type }) => ["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING", "PRONUNCIATION", "SPEAKING", "ROLEPLAY", "DEBATE"].includes(type));
}

export type ArenaReadinessMember = {
  connectionState: string;
  lastSeenAt: string;
  deviceState: Record<string, unknown>;
  connectionQuality: Record<string, unknown>;
};

export function evaluateArenaReadiness(member: ArenaReadinessMember, options: { needsAudio: boolean; strict: boolean; now?: number }) {
  const blockers: string[] = [];
  const now = options.now ?? Date.now();
  if (member.connectionState !== "connected" || now - new Date(member.lastSeenAt).getTime() > 45_000) blockers.push("Kết nối phòng chưa ổn định");
  const rtt = Number(member.connectionQuality.clockRttMs ?? 0);
  if (options.strict && rtt > 1200) blockers.push("Độ trễ đồng hồ vượt 1,2 giây");
  if (options.needsAudio) {
    if (member.deviceState.preflight !== "ready") blockers.push("Chưa hoàn tất kiểm tra audio");
    if (member.deviceState.microphone !== true) blockers.push("Micro chưa được bật");
  }
  return { passed: blockers.length === 0, blockers, rttMs: Number.isFinite(rtt) ? rtt : null };
}
