import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type TelemetryInput = {
  name: string;
  severity?: "debug" | "info" | "warning" | "error" | "critical";
  correlationId?: string;
  roomId?: string | null;
  matchId?: string | null;
  userId?: string | null;
  durationMs?: number | null;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export async function recordTelemetry(input: TelemetryInput) {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  let userId = input.userId ?? null;
  let roomId = input.roomId ?? null;
  let matchId = input.matchId ?? null;
  if (userId) {
    const { data: preference } = await admin.from("privacy_preferences").select("allow_learning_analytics").eq("user_id", userId).maybeSingle();
    if (preference?.allow_learning_analytics === false) { userId = null; roomId = null; matchId = null; }
  }
  const safeMetadata = Object.fromEntries(Object.entries(input.metadata ?? {}).slice(0, 30).map(([key, value]) => [key.slice(0, 80), typeof value === "string" ? value.slice(0, 500) : value]));
  await admin.from("telemetry_events").insert({
    correlation_id: input.correlationId ?? randomUUID(), event_name: input.name.slice(0, 100), severity: input.severity ?? "info",
    room_id: roomId, match_id: matchId, user_id: userId,
    duration_ms: input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)), provider: input.provider ?? null,
    model: input.model ?? null, metadata: safeMetadata, error_code: input.errorCode?.slice(0, 120) ?? null,
    error_message: input.errorMessage?.slice(0, 1500) ?? null
  });
}
