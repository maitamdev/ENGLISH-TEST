import { NextResponse } from "next/server";
import { drainGenerationQueue } from "@/lib/ai/durable-game-generator";
import { authorizeInternalRequest } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!authorizeInternalRequest(request)) return NextResponse.json({ error: "Worker authorization failed" }, { status: 401 });
  const results = await drainGenerationQueue({ maxBatches: 4, timeBudgetMs: 100_000 });
  return NextResponse.json({ results }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  return GET(request);
}
