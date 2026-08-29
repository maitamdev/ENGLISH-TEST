import { NextResponse } from "next/server";
import { synthesizeExactEnglish } from "@/lib/ai/direct-tts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function GET(_request: Request, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: item } = await admin.from("placement_items").select("id, skill, private_payload, placement_sessions!inner(user_id, status)").eq("id", itemId).maybeSingle();
  const owner = Array.isArray(item?.placement_sessions) ? item.placement_sessions[0] : item?.placement_sessions;
  if (!item || owner?.user_id !== authData.user.id || item.skill !== "listening") return NextResponse.json({ error: "Audio placement không tồn tại" }, { status: 404 });
  const payload = item.private_payload as Record<string, unknown> | null;
  const text = typeof payload?.audioText === "string" ? payload.audioText.trim() : "";
  if (!text) return NextResponse.json({ error: "Placement item chưa có audio text" }, { status: 422 });
  try {
    const audio = await synthesizeExactEnglish(text);
    return new Response(Uint8Array.from(audio.data), { headers: { "Content-Type": audio.contentType, "Cache-Control": "private, max-age=3600", "Content-Length": String(audio.data.length) } });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Không tạo được audio" }, { status: 502 });
  }
}
