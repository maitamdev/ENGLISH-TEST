import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({ userId: z.string().uuid(), action: z.enum(["mute","unmute","kick"]), reason: z.string().trim().max(500).optional() });

export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Thao tác moderation không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data, error } = await supabase.rpc("moderate_room_member", { target_room_id: roomId, target_user_id: parsed.data.userId, target_action: parsed.data.action, target_reason: parsed.data.reason ?? null });
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
