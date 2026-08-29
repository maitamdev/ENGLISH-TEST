import { NextResponse } from "next/server";
import { recordUserSecurityEvent } from "@/lib/security/audit";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await recordUserSecurityEvent({ userId: data.user.id, eventType: "auth.sessions.revoked", severity: "high", outcome: "success", resourceType: "account" });
  return NextResponse.json({ signedOut: true });
}
