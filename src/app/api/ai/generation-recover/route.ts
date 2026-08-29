import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const requestSchema = z.object({ roomId: z.string().uuid() });
const staleAfterMs = 330_000;

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid room" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: room } = await supabase.from("rooms").select("id, status").eq("id", parsed.data.roomId).maybeSingle();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", room.id).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a room member can recover generation" }, { status: 403 });
  if (room.status !== "GENERATING_GAME") return NextResponse.json({ error: "The room is not generating a match" }, { status: 409 });

  const { data: job } = await admin.from("generation_jobs").select("id, status, updated_at").eq("room_id", room.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!job || !["queued", "generating", "persisting"].includes(job.status)) {
    return NextResponse.json({ error: "No active generation job was found" }, { status: 409 });
  }
  if (Date.now() - new Date(job.updated_at).getTime() < staleAfterMs) {
    return NextResponse.json({ error: "AI vẫn đang tạo nội dung. Hãy chờ tiến độ cập nhật." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { data: recoveredJob, error: jobError } = await admin.from("generation_jobs").update({
    status: "failed",
    stage: "Đã khôi phục sau khi tiến trình bị gián đoạn",
    error_message: "Generation function exceeded its execution window or lost its connection.",
    updated_at: now,
    completed_at: now
  }).eq("id", job.id).in("status", ["queued", "generating", "persisting"]).select("id").maybeSingle();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  if (!recoveredJob) return NextResponse.json({ error: "Generation finished while recovery was being requested" }, { status: 409 });
  const { error: roomError } = await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id).eq("status", "GENERATING_GAME");
  if (roomError) return NextResponse.json({ error: roomError.message }, { status: 500 });
  return NextResponse.json({ recovered: true });
}
