import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({ resolved: z.boolean(), correctionNote: z.string().trim().max(1000).optional() });

export async function PATCH(request: Request, { params }: { params: Promise<{ errorId: string }> }) {
  const { errorId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Cập nhật không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data, error } = await supabase.from("learning_errors").update({ resolved_at: parsed.data.resolved ? new Date().toISOString() : null, correction_note: parsed.data.correctionNote || null }).eq("id", errorId).eq("user_id", authData.user.id).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Không tìm thấy lỗi học tập" }, { status: 404 });
  return NextResponse.json({ updated: true });
}
