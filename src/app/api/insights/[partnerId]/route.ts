import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  const parsed = z.string().uuid().safeParse(partnerId);
  if (!parsed.success) return NextResponse.json({ error: "Bạn học không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data, error } = await supabase.rpc("get_head_to_head_insights", { target_partner_id: parsed.data });
  if (error) return NextResponse.json({ error: error.message }, { status: error.message.includes("friendship") ? 403 : 409 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
