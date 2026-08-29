import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const READINESS_VERSION = "web-audio-preflight-v1";
const schema = z.object({
  status: z.enum(["ready", "warning"]),
  microphone: z.boolean(),
  inputLevel: z.number().int().min(0).max(100),
  outputDevice: z.boolean(),
  relayCandidate: z.boolean(),
  turnConfigured: z.boolean(),
  message: z.string().trim().max(500)
});

export async function POST(request: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Kết quả kiểm tra thiết bị không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const [{ data: member }, { data: match }] = await Promise.all([
    admin.from("room_members").select("device_state").eq("room_id", roomId).eq("user_id", auth.user.id).maybeSingle(),
    admin.from("matches").select("id").eq("room_id", roomId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (!member) return NextResponse.json({ error: "Bạn không thuộc phòng này" }, { status: 403 });
  const passed = parsed.data.status === "ready" && parsed.data.microphone && parsed.data.outputDevice && (!parsed.data.turnConfigured || parsed.data.relayCandidate);
  const blockers = [
    ...(!parsed.data.microphone ? ["microphone_unavailable"] : []),
    ...(!parsed.data.outputDevice ? ["audio_output_unavailable"] : []),
    ...(parsed.data.turnConfigured && !parsed.data.relayCandidate ? ["turn_relay_unavailable"] : []),
    ...(parsed.data.status !== "ready" ? ["preflight_warning"] : [])
  ];
  const now = new Date().toISOString();
  const metrics = { ...parsed.data, checkedAt: now };
  const { error } = await admin.from("room_members").update({
    device_state: { ...((member.device_state as Record<string, unknown> | null) ?? {}), preflight: parsed.data.status, microphone: parsed.data.microphone, audioOutput: parsed.data.outputDevice, relayCandidate: parsed.data.relayCandidate },
    readiness_checked_at: now,
    readiness_version: READINESS_VERSION
  }).eq("room_id", roomId).eq("user_id", auth.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await admin.from("room_readiness_events").insert({ room_id: roomId, user_id: auth.user.id, match_id: match?.id ?? null, passed, blockers, metrics, readiness_version: READINESS_VERSION });
  return NextResponse.json({ passed, blockers, checkedAt: now }, { headers: { "Cache-Control": "private, no-store" } });
}
