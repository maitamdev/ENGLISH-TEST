import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { evaluateOperationalAlerts } from "@/lib/observability/operations";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function maintain() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const now = new Date().toISOString();
  const staleMemberAt = new Date(Date.now() - 30_000).toISOString();
  const staleAssetAt = new Date(Date.now() - 120_000).toISOString();
  const telemetryCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const operationsCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: exports } = await admin.from("data_requests").select("id, storage_path").eq("request_type", "export").eq("status", "ready").lt("expires_at", now).limit(100);
  const paths = (exports ?? []).flatMap((row) => row.storage_path ? [row.storage_path] : []);
  if (paths.length) await admin.storage.from("user-exports").remove(paths);
  const exportIds = (exports ?? []).map((row) => row.id);
  if (exportIds.length) await admin.from("data_requests").update({ status: "completed", storage_path: null }).in("id", exportIds);
  const [members, assets, invites, telemetry, operations] = await Promise.all([
    admin.from("room_members").update({ connection_state: "disconnected", last_disconnected_at: now }).eq("connection_state", "connected").lt("last_seen_at", staleMemberAt).select("user_id"),
    admin.from("question_audio_assets").update({ status: "failed", error_message: "Generation lease expired", lease_token: null, lease_expires_at: null, updated_at: now }).eq("status", "generating").lt("lease_expires_at", staleAssetAt).select("id"),
    admin.from("room_invites").update({ status: "expired", responded_at: now }).eq("status", "pending").lt("expires_at", now).select("id"),
    admin.from("telemetry_events").delete().lt("occurred_at", telemetryCutoff).select("id"),
    admin.from("room_operations").delete().lt("created_at", operationsCutoff).select("id")
  ]);
  const evaluatedAlerts = await evaluateOperationalAlerts(admin);
  return { expiredExports: exportIds.length, disconnectedMembers: members.data?.length ?? 0, releasedAudioLeases: assets.data?.length ?? 0, expiredInvites: invites.data?.length ?? 0, prunedTelemetry: telemetry.data?.length ?? 0, prunedOperations: operations.data?.length ?? 0, evaluatedAlerts: evaluatedAlerts.length };
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await maintain());
}
export async function POST(request: Request) { return GET(request); }
