import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PlatformRole = "owner" | "admin" | "moderator" | "observer";

export async function authorizePlatformAdmin(required: PlatformRole[] = ["owner", "admin", "moderator", "observer"]) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { ok: false as const, status: 503, error: "Supabase is not configured" };
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { ok: false as const, status: 401, error: "Authentication required" };

  const bootstrapIds = new Set((process.env.PLATFORM_ADMIN_USER_IDS ?? "").split(/[;,\s]+/u).map((value) => value.trim()).filter(Boolean));
  if (bootstrapIds.has(authData.user.id)) {
    return { ok: true as const, user: authData.user, role: "owner" as const, admin, supabase, bootstrap: true };
  }

  const { data: membership, error } = await admin.from("platform_admins").select("role").eq("user_id", authData.user.id).maybeSingle();
  if (error || !membership || !required.includes(membership.role as PlatformRole)) return { ok: false as const, status: 403, error: "Platform administrator access required" };
  return { ok: true as const, user: authData.user, role: membership.role as PlatformRole, admin, supabase, bootstrap: false };
}
