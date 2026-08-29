import { describe, expect, it } from "vitest";
import { informationToConfidence, informationToStandardError, thetaToCefr } from "./ability-model";
import { buildRoundInterventionCandidates, skillForQuestionMode } from "./intervention-policy";

describe("adaptive ability model", () => {
  it("maps every theta boundary to the intended diagnostic CEFR band", () => {
    expect([thetaToCefr(-3), thetaToCefr(-2), thetaToCefr(-1), thetaToCefr(0), thetaToCefr(1), thetaToCefr(2)]).toEqual(["A1", "A2", "B1", "B2", "C1", "C2"]);
  });
  it("increases confidence and reduces standard error as information accumulates", () => {
    expect(informationToConfidence(4)).toBeGreaterThan(informationToConfidence(1));
    expect(informationToStandardError(4)).toBeLessThan(informationToStandardError(1));
    expect(informationToConfidence(100)).toBeLessThanOrEqual(0.99);
  });
});

describe("round intervention policy", () => {
  it("prioritizes a timeout strategy when both learners time out", () => {
    const events = buildRoundInterventionCandidates("LISTENING", 1, [
      { is_correct: false, timed_out: true, rubric_score: null, hints_used: 0 },
      { is_correct: false, timed_out: true, rubric_score: null, hints_used: 0 }
    ]);
    expect(events[0].policy_code).toBe("both_timed_out");
    expect(skillForQuestionMode("LISTENING")).toBe("listening");
  });
  it("uses only revealed evidence and selects at most two focused interventions", () => {
    const events = buildRoundInterventionCandidates("SPEAKING", 2, [
      { is_correct: true, timed_out: false, rubric_score: 82, hints_used: 0 },
      { is_correct: false, timed_out: false, rubric_score: 54, hints_used: 2 }
    ]);
    expect(events.map((event) => event.policy_code)).toEqual(["rubric_gap", "split_outcome"]);
    expect(events).toHaveLength(2);
  });
  it("stays quiet on an ordinary successful round", () => {
    expect(buildRoundInterventionCandidates("READING", 2, [
      { is_correct: true, timed_out: false, rubric_score: null, hints_used: 0 },
      { is_correct: true, timed_out: false, rubric_score: null, hints_used: 0 }
    ])).toEqual([]);
  });
});
