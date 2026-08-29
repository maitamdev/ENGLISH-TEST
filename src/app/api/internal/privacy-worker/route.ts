import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordTelemetry } from "@/lib/observability/telemetry";
import { authorizeInternalRequest } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

async function exportUser(userId: string) {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const tables = [
    ["profile", "profiles", "id"], ["learningStats", "user_learning_stats", "user_id"], ["vocabulary", "user_vocabulary", "user_id"],
    ["reviewCards", "review_cards", "user_id"], ["reviewLogs", "review_logs", "user_id"], ["learningErrors", "learning_errors", "user_id"],
    ["studyPlans", "study_plans", "user_id"], ["speakingSessions", "speaking_sessions", "created_by"], ["pronunciationFeedback", "pronunciation_feedback", "user_id"],
    ["ratings", "player_ratings", "user_id"], ["ratingEvents", "rating_events", "user_id"], ["matchParticipation", "match_players", "user_id"],
    ["submissions", "submissions", "user_id"], ["privacyPreferences", "privacy_preferences", "user_id"]
  ] as const;
  const results = await Promise.all(tables.map(async ([name, table, field]) => {
    const { data, error } = await admin.from(table).select("*").eq(field, userId).limit(10000);
    if (error) throw error; return [name, data ?? []] as const;
  }));
  const payload = { format: "LexiDuel user export", version: 1, generatedAt: new Date().toISOString(), userId, data: Object.fromEntries(results) };
  return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
}

async function work() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const { data: rows, error } = await admin.from("data_requests").select("id, user_id, request_type").eq("status", "queued").order("requested_at").limit(3);
  if (error) throw error;
  const results: { id: string; status: string }[] = [];
  for (const row of rows ?? []) {
    const { data: claimed } = await admin.from("data_requests").update({ status: "processing", error_message: null }).eq("id", row.id).eq("status", "queued").select("id").maybeSingle();
    if (!claimed) continue;
    try {
      if (row.request_type === "export") {
        const output = await exportUser(row.user_id);
        const path = `${row.user_id}/${row.id}.json`;
        const { error: uploadError } = await admin.storage.from("user-exports").upload(path, output, { contentType: "application/json", cacheControl: "0", upsert: true });
        if (uploadError) throw uploadError;
        await admin.from("data_requests").update({ status: "ready", storage_path: path, completed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() }).eq("id", row.id);
        results.push({ id: row.id, status: "ready" });
      } else {
        const { data: files } = await admin.storage.from("user-exports").list(row.user_id, { limit: 1000 });
        const paths = (files ?? []).map((file) => `${row.user_id}/${file.name}`);
        if (paths.length) await admin.storage.from("user-exports").remove(paths);
        const { error: deleteError } = await admin.auth.admin.deleteUser(row.user_id, false);
        if (deleteError) throw deleteError;
        results.push({ id: row.id, status: "deleted" });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Privacy worker failed";
      await admin.from("data_requests").update({ status: "failed", error_message: message.slice(0, 1800), completed_at: new Date().toISOString() }).eq("id", row.id);
      await recordTelemetry({ name: "privacy.request_failed", severity: "error", errorCode: row.request_type, errorMessage: message, metadata: { requestId: row.id } });
      results.push({ id: row.id, status: "failed" });
    }
  }
  return results;
}

export async function GET(request: Request) {
  if (!authorizeInternalRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ results: await work() });
}
export async function POST(request: Request) { return GET(request); }
