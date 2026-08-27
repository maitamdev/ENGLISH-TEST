import Link from "next/link";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="LexiDuel home">
      <span className="brand-mark">LD</span>
      <span>Lexi<em>Duel</em></span>
    </Link>
  );
}
