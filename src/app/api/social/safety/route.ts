import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("block"), userId: z.string().uuid(), reason: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("report"), userId: z.string().uuid(), roomId: z.string().uuid().optional(), category: z.enum(["harassment","spam","cheating","unsafe_content","privacy","other"]), detail: z.string().trim().min(5).max(2000) })
]);

async function authenticated() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { user: data.user, admin, supabase } as const;
}

export async function GET() {
  const auth = await authenticated();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [blocks, reports] = await Promise.all([
    auth.admin.from("user_blocks").select("blocked_id, reason, created_at, profiles!user_blocks_blocked_id_fkey(display_name, username, avatar_url)").eq("blocker_id", auth.user.id).order("created_at", { ascending: false }),
    auth.admin.from("user_reports").select("id, reported_user_id, room_id, category, detail, status, resolution_note, created_at").eq("reporter_id", auth.user.id).order("created_at", { ascending: false }).limit(50)
  ]);
  const error = blocks.error ?? reports.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ blocks: blocks.data ?? [], reports: reports.data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authenticated();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu an toàn không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.userId === auth.user.id) return NextResponse.json({ error: "Không thể thực hiện với chính mình" }, { status: 409 });
  const { data: target } = await auth.admin.from("profiles").select("id").eq("id", parsed.data.userId).maybeSingle();
  if (!target) return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404 });

  if (parsed.data.action === "block") {
    const now = new Date().toISOString();
    const { error } = await auth.admin.from("user_blocks").upsert({ blocker_id: auth.user.id, blocked_id: parsed.data.userId, reason: parsed.data.reason ?? null, created_at: now }, { onConflict: "blocker_id,blocked_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await Promise.all([
      auth.admin.from("friendships").update({ status: "blocked", responded_at: now }).or(`and(requester_id.eq.${auth.user.id},addressee_id.eq.${parsed.data.userId}),and(requester_id.eq.${parsed.data.userId},addressee_id.eq.${auth.user.id})`),
      auth.admin.from("room_invites").update({ status: "cancelled", responded_at: now }).eq("status", "pending").or(`and(sender_id.eq.${auth.user.id},recipient_id.eq.${parsed.data.userId}),and(sender_id.eq.${parsed.data.userId},recipient_id.eq.${auth.user.id})`)
    ]);
    return NextResponse.json({ blocked: true });
  }

  if (parsed.data.roomId) {
    const { data: membership } = await auth.admin.from("room_members").select("user_id").eq("room_id", parsed.data.roomId).eq("user_id", auth.user.id).maybeSingle();
    if (!membership) return NextResponse.json({ error: "Bạn không thuộc phòng được báo cáo" }, { status: 403 });
  }
  const { data, error } = await auth.admin.from("user_reports").insert({ reporter_id: auth.user.id, reported_user_id: parsed.data.userId, room_id: parsed.data.roomId ?? null, category: parsed.data.category, detail: parsed.data.detail, evidence: { submittedFrom: "community_safety" } }).select("id, status").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(request: Request) {
  const auth = await authenticated();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId || !z.string().uuid().safeParse(userId).success) return NextResponse.json({ error: "Valid userId required" }, { status: 400 });
  const { error } = await auth.admin.from("user_blocks").delete().eq("blocker_id", auth.user.id).eq("blocked_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ blocked: false });
}
