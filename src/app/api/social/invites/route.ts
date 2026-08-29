import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/notifications/web-push";

const createSchema = z.object({ roomId: z.string().uuid(), recipientId: z.string().uuid(), message: z.string().trim().max(200).optional() });
const updateSchema = z.object({ inviteId: z.string().uuid(), action: z.enum(["accept","decline","cancel"]) });

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Lời mời không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const [{ data: membership }, { count }, { data: friendship }, { data: blocked }] = await Promise.all([
    admin.from("room_members").select("user_id").eq("room_id", parsed.data.roomId).eq("user_id", authData.user.id).maybeSingle(),
    admin.from("room_members").select("user_id", { count: "exact", head: true }).eq("room_id", parsed.data.roomId),
    admin.from("friendships").select("id").eq("status", "accepted").or(`and(requester_id.eq.${authData.user.id},addressee_id.eq.${parsed.data.recipientId}),and(requester_id.eq.${parsed.data.recipientId},addressee_id.eq.${authData.user.id})`).maybeSingle(),
    admin.from("user_blocks").select("blocker_id").or(`and(blocker_id.eq.${authData.user.id},blocked_id.eq.${parsed.data.recipientId}),and(blocker_id.eq.${parsed.data.recipientId},blocked_id.eq.${authData.user.id})`).limit(1).maybeSingle()
  ]);
  if (!membership) return NextResponse.json({ error: "Bạn không thuộc phòng này" }, { status: 403 });
  if ((count ?? 0) >= 2) return NextResponse.json({ error: "Phòng đã đủ hai người" }, { status: 409 });
  if (blocked) return NextResponse.json({ error: "Không thể gửi lời mời giữa hai tài khoản đã chặn nhau" }, { status: 403 });
  if (!friendship) return NextResponse.json({ error: "Chỉ có thể mời bạn bè đã xác nhận" }, { status: 403 });
  const { data, error } = await admin.from("room_invites").insert({ room_id: parsed.data.roomId, sender_id: authData.user.id, recipient_id: parsed.data.recipientId, message: parsed.data.message || null }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const [{ data: sender }, { data: room }] = await Promise.all([
    admin.from("profiles").select("display_name").eq("id", authData.user.id).maybeSingle(),
    admin.from("rooms").select("code").eq("id", parsed.data.roomId).maybeSingle()
  ]);
  await sendPushToUser(admin, parsed.data.recipientId, {
    type: "room_invite",
    title: "Lời mời học cùng",
    body: `${sender?.display_name ?? "Một người bạn"} mời bạn vào phòng ${room?.code ?? "LexiDuel"}.`,
    url: "/community",
    tag: `room-invite-${data.id}`
  }).catch(() => undefined);
  return NextResponse.json(data, { status: 201 });
}
export async function PATCH(request: Request) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Phản hồi không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: invite } = await admin.from("room_invites").select("id, room_id, sender_id, recipient_id, status, expires_at, rooms(code)").eq("id", parsed.data.inviteId).maybeSingle();
  if (!invite || ![invite.sender_id, invite.recipient_id].includes(authData.user.id)) return NextResponse.json({ error: "Không tìm thấy lời mời" }, { status: 404 });
  if (parsed.data.action === "cancel" && invite.sender_id !== authData.user.id) return NextResponse.json({ error: "Chỉ người gửi mới có thể hủy" }, { status: 403 });
  if (["accept","decline"].includes(parsed.data.action) && invite.recipient_id !== authData.user.id) return NextResponse.json({ error: "Chỉ người nhận mới có thể phản hồi" }, { status: 403 });
  if (invite.status !== "pending" || new Date(invite.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "Lời mời đã hết hiệu lực" }, { status: 409 });
  if (parsed.data.action === "accept") {
    const { data: joined, error: joinError } = await supabase.rpc("join_room_by_code", { requested_code: (Array.isArray(invite.rooms) ? invite.rooms[0] : invite.rooms)?.code });
    if (joinError) return NextResponse.json({ error: joinError.message }, { status: 409 });
    await admin.from("room_invites").update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", invite.id);
    return NextResponse.json({ status: "accepted", room: Array.isArray(joined) ? joined[0] : joined });
  }
  const status = parsed.data.action === "cancel" ? "cancelled" : "declined";
  await admin.from("room_invites").update({ status, responded_at: new Date().toISOString() }).eq("id", invite.id);
  return NextResponse.json({ status });
}
