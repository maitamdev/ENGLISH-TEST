import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function acquireWorkerLease(workerKey: string, leaseSeconds = 120) {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("Supabase service role is not configured");
  const token = randomUUID();
  const { data, error } = await admin.rpc("claim_worker_lease", {
    target_worker_key: workerKey,
    target_lease_token: token,
    target_lease_seconds: leaseSeconds
  });
  if (error) throw error;
  return data ? token : null;
}

export async function releaseWorkerLease(workerKey: string, token: string, outcome: "success" | "failed") {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin.rpc("release_worker_lease", {
    target_worker_key: workerKey,
    target_lease_token: token,
    target_outcome: outcome
  });
}
