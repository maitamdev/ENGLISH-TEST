import "server-only";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./server";

export async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { supabase: null, user: null, configured: false } as const;
  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : data.user, configured: true } as const;
}

export async function requireAuthenticatedUser() {
  const auth = await getAuthenticatedUser();
  if (!auth.configured) return auth;
  if (!auth.user) redirect("/login");
  return auth;
}
