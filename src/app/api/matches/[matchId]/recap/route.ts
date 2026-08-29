import { NextResponse } from "next/server";
import { getOrCreateMatchRecap } from "@/lib/learning/match-recap";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  try { return NextResponse.json(await getOrCreateMatchRecap(admin, data.user.id, matchId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "Không tạo được recap" }, { status: 400 }); }
}
