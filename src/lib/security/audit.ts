import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type SecuritySeverity = "info" | "warning" | "high" | "critical";
type SecurityOutcome = "success" | "blocked" | "failed";

const forbiddenMetadataKey = /token|secret|password|authorization|cookie|answer|transcript|email|ip|user.?agent/iu;

function safeMetadata(value: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([key]) => !forbiddenMetadataKey.test(key))
      .slice(0, 20)
      .map(([key, item]) => [key.slice(0, 60), typeof item === "string" ? item.slice(0, 240) : item])
  );
}

/** Best-effort audit recording. A logging failure must never break a learning action. */
export async function recordUserSecurityEvent(input: {
  userId: string;
  eventType: string;
  severity?: SecuritySeverity;
  outcome: SecurityOutcome;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  const { error } = await admin.rpc("record_user_security_event", {
    target_user_id: input.userId,
    target_event_type: input.eventType.slice(0, 80),
    target_severity: input.severity ?? "info",
    target_outcome: input.outcome,
    target_resource_type: input.resourceType?.slice(0, 40) ?? null,
    target_resource_id: input.resourceId ?? null,
    target_metadata: safeMetadata(input.metadata)
  });
  if (error && process.env.NODE_ENV !== "production") console.warn("Security audit write failed", error.message);
}
