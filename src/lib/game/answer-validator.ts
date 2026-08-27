import { normalizeAnswer } from "./answer-normalizer";

export function validateAnswer(answer: string, acceptedAnswers: string[]) {
  const normalized = normalizeAnswer(answer);
  const accepted = acceptedAnswers.map(normalizeAnswer);
  return { normalized, correct: accepted.includes(normalized) };
}
