import { describe, expect, it } from "vitest";
import { buildAdaptiveModeSchedule, buildDifficultySchedule, evaluateArenaReadiness, requiresAudioReadiness } from "./arena-adaptation";

describe("arena adaptation", () => {
  it("preserves exact mode counts while prioritizing the weakest skill", () => {
    const schedule = buildAdaptiveModeSchedule([{ type: "READING", count: 2 }, { type: "LISTENING", count: 2 }, { type: "GRAMMAR", count: 1 }], "WEAKNESS_FIRST", { skillMastery: { reading: 80, listening: 22, grammar: 60 }, reviewDueBySkill: {}, evidenceCount: 20, analyticsParticipants: 2 });
    expect(schedule[0]).toBe("LISTENING");
    expect(schedule.filter((mode) => mode === "READING")).toHaveLength(2);
    expect(schedule.filter((mode) => mode === "LISTENING")).toHaveLength(2);
    expect(schedule).toHaveLength(5);
  });

  it("creates a bounded ramp without changing round count", () => {
    const values = buildDifficultySchedule(12, "RAMP_UP");
    expect(values).toHaveLength(12);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...values)).toBeLessThanOrEqual(9);
    expect(values.at(-1)).toBeGreaterThan(values[0]);
  });

  it("requires audio readiness only for audio and spoken modes", () => {
    expect(requiresAudioReadiness([{ type: "READING" }, { type: "GRAMMAR" }])).toBe(false);
    expect(requiresAudioReadiness([{ type: "READING" }, { type: "SPEAKING" }])).toBe(true);
  });

  it("blocks stale audio participants in strict matches", () => {
    const result = evaluateArenaReadiness({ connectionState: "connected", lastSeenAt: "2026-08-29T00:00:00.000Z", deviceState: { preflight: "warning", microphone: false }, connectionQuality: { clockRttMs: 1400 } }, { needsAudio: true, strict: true, now: new Date("2026-08-29T00:01:00.000Z").getTime() });
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(4);
  });
});
