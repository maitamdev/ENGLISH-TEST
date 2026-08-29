import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = process.env.HEALTHCHECK_SECRET || process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ status: "unconfigured" }, { status: 503 });
  const started = performance.now();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const staleLease = new Date(Date.now() - 30_000).toISOString();
  const [jobs, failedJobs, staleMembers, audioFailures, errors, privacyQueue] = await Promise.all([
    admin.from("generation_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "generating", "persisting", "retrying"]),
    admin.from("generation_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", dayAgo),
    admin.from("room_members").select("user_id", { count: "exact", head: true }).eq("connection_state", "connected").lt("last_seen_at", staleLease),
    admin.from("question_audio_assets").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", dayAgo),
    admin.from("telemetry_events").select("id", { count: "exact", head: true }).in("severity", ["error", "critical"]).gte("occurred_at", hourAgo),
    admin.from("data_requests").select("id", { count: "exact", head: true }).in("status", ["queued", "processing"])
  ]);
  const counts = { generationActive: jobs.count ?? 0, generationFailed24h: failedJobs.count ?? 0, staleConnectedMembers: staleMembers.count ?? 0, audioFailed24h: audioFailures.count ?? 0, errors1h: errors.count ?? 0, privacyQueue: privacyQueue.count ?? 0 };
  const degraded = counts.staleConnectedMembers > 0 || counts.errors1h > 10 || counts.generationFailed24h > 5;
  return NextResponse.json({ status: degraded ? "degraded" : "healthy", checkedAt: new Date().toISOString(), databaseLatencyMs: Math.round(performance.now() - started), counts }, { status: degraded ? 503 : 200, headers: { "Cache-Control": "private, no-store" } });
}
