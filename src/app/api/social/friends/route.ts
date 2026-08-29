import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const createSchema = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/u) });
const updateSchema = z.object({ friendshipId: z.string().uuid(), action: z.enum(["accept","decline","block","cancel"]) });

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Username không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: peer } = await admin.from("profiles").select("id").eq("username", parsed.data.username).maybeSingle();
  if (!peer) return NextResponse.json({ error: "Không tìm thấy người dùng này" }, { status: 404 });
  const { data: privacy } = await admin.from("privacy_preferences").select("allow_social_discovery").eq("user_id", peer.id).maybeSingle();
  if (privacy?.allow_social_discovery === false) return NextResponse.json({ error: "Người dùng này đã tắt tìm kiếm cộng đồng" }, { status: 404 });
  if (peer.id === authData.user.id) return NextResponse.json({ error: "Bạn không thể kết bạn với chính mình" }, { status: 409 });
  const [{ data: existing }, { data: blocked }] = await Promise.all([
    admin.from("friendships").select("id, status").or(`and(requester_id.eq.${authData.user.id},addressee_id.eq.${peer.id}),and(requester_id.eq.${peer.id},addressee_id.eq.${authData.user.id})`).maybeSingle(),
    admin.from("user_blocks").select("blocker_id").or(`and(blocker_id.eq.${authData.user.id},blocked_id.eq.${peer.id}),and(blocker_id.eq.${peer.id},blocked_id.eq.${authData.user.id})`).limit(1).maybeSingle()
  ]);
  if (blocked) return NextResponse.json({ error: "Không thể gửi lời mời giữa hai tài khoản đã chặn nhau" }, { status: 403 });
  if (existing?.status === "accepted") return NextResponse.json({ error: "Hai bạn đã là bạn bè" }, { status: 409 });
  if (existing?.status === "pending" || existing?.status === "blocked") return NextResponse.json({ error: existing.status === "blocked" ? "Không thể gửi lời mời cho quan hệ này" : "Đã có lời mời đang chờ" }, { status: 409 });
  if (existing?.status === "declined") {
    const { data: reopened, error: reopenError } = await admin.from("friendships").update({ requester_id: authData.user.id, addressee_id: peer.id, status: "pending", responded_at: null, created_at: new Date().toISOString() }).eq("id", existing.id).select("id").single();
    if (reopenError) return NextResponse.json({ error: reopenError.message }, { status: 400 });
    return NextResponse.json(reopened, { status: 201 });
  }
  const { data, error } = await admin.from("friendships").insert({ requester_id: authData.user.id, addressee_id: peer.id, status: "pending" }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Thao tác không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: friendship } = await admin.from("friendships").select("requester_id, addressee_id, status").eq("id", parsed.data.friendshipId).maybeSingle();
  if (!friendship || ![friendship.requester_id, friendship.addressee_id].includes(authData.user.id)) return NextResponse.json({ error: "Không tìm thấy quan hệ bạn bè" }, { status: 404 });
  if (["accept","decline"].includes(parsed.data.action) && friendship.addressee_id !== authData.user.id) return NextResponse.json({ error: "Chỉ người nhận mới có thể phản hồi" }, { status: 403 });
  if (parsed.data.action === "cancel" && friendship.requester_id !== authData.user.id) return NextResponse.json({ error: "Chỉ người gửi mới có thể hủy" }, { status: 403 });
  const status = parsed.data.action === "accept" ? "accepted" : parsed.data.action === "block" ? "blocked" : "declined";
  const { error } = await admin.from("friendships").update({ status, responded_at: new Date().toISOString() }).eq("id", parsed.data.friendshipId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ status });
}
