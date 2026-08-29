import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { evaluateOperationalAlerts } from "@/lib/observability/operations";
import { dispatchNotificationOutbox, enqueueLearningReminders } from "@/lib/notifications/outbox";
import { authorizeInternalRequest } from "@/lib/security/internal-auth";
import { acquireWorkerLease, releaseWorkerLease } from "@/lib/security/worker-lease";

export const runtime = "nodejs";
export const maxDuration = 60;

async function maintain() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const now = new Date().toISOString();
  const staleMemberAt = new Date(Date.now() - 30_000).toISOString();
  const staleAssetAt = new Date(Date.now() - 120_000).toISOString();
  const telemetryCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const operationsCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const securityCutoff = new Date().toISOString();
  const { data: exports } = await admin.from("data_requests").select("id, storage_path").eq("request_type", "export").eq("status", "ready").lt("expires_at", now).limit(100);
  const paths = (exports ?? []).flatMap((row) => row.storage_path ? [row.storage_path] : []);
  if (paths.length) await admin.storage.from("user-exports").remove(paths);
  const exportIds = (exports ?? []).map((row) => row.id);
  if (exportIds.length) await admin.from("data_requests").update({ status: "completed", storage_path: null }).in("id", exportIds);
  const [members, assets, invites, telemetry, operations, securityEvents, receipts] = await Promise.all([
    admin.from("room_members").update({ connection_state: "disconnected", last_disconnected_at: now }).eq("connection_state", "connected").lt("last_seen_at", staleMemberAt).select("user_id"),
    admin.from("question_audio_assets").update({ status: "failed", error_message: "Generation lease expired", lease_token: null, lease_expires_at: null, updated_at: now }).eq("status", "generating").lt("lease_expires_at", staleAssetAt).select("id"),
    admin.from("room_invites").update({ status: "expired", responded_at: now }).eq("status", "pending").lt("expires_at", now).select("id"),
    admin.from("telemetry_events").delete().lt("occurred_at", telemetryCutoff).select("id"),
    admin.from("room_operations").delete().lt("created_at", operationsCutoff).select("id"),
    admin.from("user_security_events").delete().lt("expires_at", securityCutoff).select("id"),
    admin.from("api_mutation_receipts").delete().lt("expires_at", securityCutoff).select("id")
  ]);
  const evaluatedAlerts = await evaluateOperationalAlerts(admin);
  const reminderQueue = await enqueueLearningReminders(admin);
  const notificationDelivery = await dispatchNotificationOutbox(admin);
  return { expiredExports: exportIds.length, disconnectedMembers: members.data?.length ?? 0, releasedAudioLeases: assets.data?.length ?? 0, expiredInvites: invites.data?.length ?? 0, prunedTelemetry: telemetry.data?.length ?? 0, prunedOperations: operations.data?.length ?? 0, prunedSecurityEvents: securityEvents.data?.length ?? 0, prunedMutationReceipts: receipts.data?.length ?? 0, evaluatedAlerts: evaluatedAlerts.length, reminderQueue, notificationDelivery };
}

export async function GET(request: Request) {
  if (!authorizeInternalRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const leaseToken = await acquireWorkerLease("maintenance-worker", 180);
  if (!leaseToken) return NextResponse.json({ processed: false, reason: "already_running" }, { status: 202 });
  try {
    const result = await maintain();
    await releaseWorkerLease("maintenance-worker", leaseToken, "success");
    return NextResponse.json(result);
  } catch (error) {
    await releaseWorkerLease("maintenance-worker", leaseToken, "failed");
    throw error;
  }
}
export async function POST(request: Request) { return GET(request); }
