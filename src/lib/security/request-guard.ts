const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RequestGuardInput = {
  method: string;
  pathname: string;
  origin: string | null;
  referer: string | null;
  fetchSite: string | null;
  targetOrigin: string;
};

export type RequestGuardDecision = { allowed: true } | { allowed: false; code: "cross_site" | "origin_mismatch" | "invalid_origin" };

function sourceOrigin(input: RequestGuardInput) {
  const source = input.origin || input.referer;
  if (!source) return null;
  try { return new URL(source).origin; }
  catch { return "invalid"; }
}

export function guardStateChangingRequest(input: RequestGuardInput): RequestGuardDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase()) || !input.pathname.startsWith("/api/") || input.pathname.startsWith("/api/internal/")) return { allowed: true };
  if (input.fetchSite === "cross-site" || input.fetchSite === "same-site") return { allowed: false, code: "cross_site" };
  const source = sourceOrigin(input);
  if (source === "invalid") return { allowed: false, code: "invalid_origin" };
  if (source && source !== input.targetOrigin) return { allowed: false, code: "origin_mismatch" };
  // Same-origin Fetch Metadata is sufficient when privacy tooling strips Origin/Referer.
  if (!source && input.fetchSite !== "same-origin") return { allowed: false, code: "cross_site" };
  return { allowed: true };
}

export function applySecurityHeaders(headers: Headers, options: { api: boolean; production: boolean }) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  const scriptPolicy = options.production ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const upgradePolicy = options.production ? "; upgrade-insecure-requests" : "";
  headers.set("Content-Security-Policy", `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' https: wss:; worker-src 'self' blob:${upgradePolicy}`);
  if (options.api) {
    headers.set("Cache-Control", "private, no-store, max-age=0");
    const vary = new Set((headers.get("Vary") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    for (const item of ["Origin", "Sec-Fetch-Site", "Cookie", "Authorization"]) vary.add(item);
    headers.set("Vary", [...vary].join(", "));
  }
  if (options.production) headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
}
