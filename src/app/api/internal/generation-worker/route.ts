import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { drainGenerationQueue } from "@/lib/ai/durable-game-generator";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Worker authorization failed" }, { status: 401 });
  const results = await drainGenerationQueue({ maxBatches: 4, timeBudgetMs: 100_000 });
  return NextResponse.json({ results }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  return GET(request);
}
