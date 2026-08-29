import "server-only";

import { createHash } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type MutationClaim =
  | { state: "claimed" }
  | { state: "processing" | "conflict" }
  | { state: "replay"; responseStatus: number; responseBody: unknown };

export function requestPayloadHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function claimMutation(input: { userId: string; scope: string; key: string; requestHash: string }): Promise<MutationClaim> {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const { data, error } = await admin.rpc("claim_api_mutation", {
    target_user_id: input.userId,
    target_scope: input.scope,
    target_idempotency_key: input.key,
    target_request_hash: input.requestHash
  });
  if (error) throw error;
  return data as MutationClaim;
}

export async function completeMutation(input: { userId: string; scope: string; key: string; status: number; body: unknown; failed?: boolean }) {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  const { error } = await admin.rpc("complete_api_mutation", {
    target_user_id: input.userId,
    target_scope: input.scope,
    target_idempotency_key: input.key,
    target_status: input.status,
    target_body: input.body,
    target_failed: input.failed ?? false
  });
  if (error) throw error;
}
