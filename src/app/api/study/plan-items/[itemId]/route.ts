import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({ completed: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(itemId).success || !parsed.success) return NextResponse.json({ error: "Cập nhật mục học không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data, error } = await supabase.from("study_plan_items").update({ completed_at: parsed.data.completed ? new Date().toISOString() : null }).eq("id", itemId).select("id, completed_at, study_plans!inner(user_id)").maybeSingle();
  const owner = Array.isArray(data?.study_plans) ? data.study_plans[0] : data?.study_plans;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data || owner?.user_id !== authData.user.id) return NextResponse.json({ error: "Không tìm thấy mục học" }, { status: 404 });
  return NextResponse.json({ id: data.id, completedAt: data.completed_at });
}
