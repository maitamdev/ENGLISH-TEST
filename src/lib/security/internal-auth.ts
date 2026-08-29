import "server-only";

import { timingSafeEqual } from "node:crypto";

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Authorizes server-to-server workers. Browser-originated requests are never accepted. */
export function authorizeInternalRequest(request: Request, secret = process.env.CRON_SECRET) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "none") return false;
  if (request.headers.has("origin")) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  return Boolean(secret && supplied && constantTimeEqual(secret, supplied));
}
