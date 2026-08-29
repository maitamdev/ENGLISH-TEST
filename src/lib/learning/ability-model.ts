export function thetaToCefr(theta: number) {
  if (theta < -2) return "A1";
  if (theta < -1) return "A2";
  if (theta < 0) return "B1";
  if (theta < 1) return "B2";
  if (theta < 2) return "C1";
  return "C2";
}

export function informationToStandardError(information: number) {
  return 1 / Math.sqrt(Math.max(information, 0.000001));
}

export function informationToConfidence(information: number) {
  return Math.min(0.99, 1 - Math.exp(-Math.max(information, 0) / 2));
}
