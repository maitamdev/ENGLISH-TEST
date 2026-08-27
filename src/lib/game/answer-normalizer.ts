export function normalizeAnswer(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}
