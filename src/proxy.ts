import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { applySecurityHeaders, guardStateChangingRequest } from "@/lib/security/request-guard";

export async function proxy(request: NextRequest) {
  const targetOrigin = request.nextUrl.origin;
  const decision = guardStateChangingRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    referer: request.headers.get("referer"),
    fetchSite: request.headers.get("sec-fetch-site"),
    targetOrigin
  });
  if (!decision.allowed) {
    const blocked = NextResponse.json({ error: "Cross-origin state change rejected", code: decision.code }, { status: 403 });
    applySecurityHeaders(blocked.headers, { api: true, production: process.env.NODE_ENV === "production" });
    return blocked;
  }
  const response = await updateSession(request);
  applySecurityHeaders(response.headers, { api: request.nextUrl.pathname.startsWith("/api/"), production: process.env.NODE_ENV === "production" });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};
