type ScoreInput = { correct: boolean; responseMs: number; timeLimitMs: number; streak: number; firstCorrect: boolean; boss: boolean };

export function calculateScore(input: ScoreInput) {
  if (!input.correct) return 0;
  const speedRatio = Math.max(0, 1 - input.responseMs / input.timeLimitMs);
  const speedBonus = Math.round(speedRatio * 40);
  const streakBonus = Math.min(input.streak * 4, 20);
  const firstCorrectBonus = input.firstCorrect ? 10 : 0;
  const subtotal = 100 + speedBonus + streakBonus + firstCorrectBonus;
  return input.boss ? subtotal * 2 : subtotal;
}

export function isFairSpeedTie(firstMs: number, secondMs: number, toleranceMs = 150) {
  return Math.abs(firstMs - secondMs) <= toleranceMs;
}
