import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const statusSchema = z.object({ status: z.enum(["AI_DISCUSSION", "COUNTDOWN"]) });

export async function PATCH(request: Request, { params }: RouteContext<"/api/rooms/[roomId]/status">) {
  const { roomId } = await params;
  const parsed = statusSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid room status" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data: room } = await supabase.from("rooms").select("host_id, status").eq("id", roomId).single();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", roomId).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a room member can update room state" }, { status: 403 });
  if (parsed.data.status === "COUNTDOWN" && room.host_id !== authData.user.id) return NextResponse.json({ error: "Only the host can start the match" }, { status: 403 });
  const validTransition = parsed.data.status === "AI_DISCUSSION"
    ? ["ROOM_IDLE", "GAME_READY", "MATCH_RESULT"].includes(room.status)
    : room.status === "GAME_READY";
  if (!validTransition) return NextResponse.json({ error: `Cannot move from ${room.status} to ${parsed.data.status}` }, { status: 409 });
  if (parsed.data.status === "AI_DISCUSSION" && room.status === "ROOM_IDLE") {
    const { count } = await admin.from("room_members").select("user_id", { count: "exact", head: true }).eq("room_id", roomId);
    if (count !== 2) return NextResponse.json({ error: "Your friend must join before starting Gemini" }, { status: 409 });
  }
  if (parsed.data.status === "AI_DISCUSSION") {
    const { error: resetError } = await admin.from("room_members").update({ is_ready: false }).eq("room_id", roomId);
    if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });
  }
  if (parsed.data.status === "COUNTDOWN") {
    const { data: members } = await admin.from("room_members").select("is_ready").eq("room_id", roomId);
    if (!members || members.length !== 2 || members.some((member) => !member.is_ready)) {
      return NextResponse.json({ error: "Both players must be ready before countdown" }, { status: 409 });
    }
    const { data: match } = await supabase.from("matches").select("status").eq("room_id", roomId).order("created_at", { ascending: false }).limit(1).single();
    if (!match || match.status !== "ready") return NextResponse.json({ error: "The generated match is not ready" }, { status: 409 });
  }
  const { error } = await admin.from("rooms").update({ status: parsed.data.status }).eq("id", roomId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: parsed.data.status });
}
