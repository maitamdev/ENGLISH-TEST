import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(_request: Request, { params }: RouteContext<"/api/matches/[matchId]/start">) {
  const { matchId } = await params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data: match } = await supabase.from("matches").select("room_id, status, rooms(host_id, status)").eq("id", matchId).single();
  const room = Array.isArray(match?.rooms) ? match?.rooms[0] : match?.rooms;
  if (!match || !room || room.host_id !== authData.user.id) return NextResponse.json({ error: "Only the room host can start the match" }, { status: 403 });
  if (match.status !== "ready") return NextResponse.json({ error: "Match is not ready" }, { status: 409 });
  if (room.status !== "COUNTDOWN") return NextResponse.json({ error: "The room is not in countdown" }, { status: 409 });
  const { data: members } = await admin.from("room_members").select("user_id, is_ready").eq("room_id", match.room_id);
  if (!members || members.length !== 2) return NextResponse.json({ error: "Exactly two room members are required" }, { status: 409 });
  if (members.some((member) => !member.is_ready)) return NextResponse.json({ error: "Both players must be ready before the match starts" }, { status: 409 });
  
  const { error } = await admin.rpc("start_match", { target_match_id: matchId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { error: resetError } = await admin.from("room_members").update({ is_ready: false }).eq("room_id", match.room_id);
  if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });
  await admin.from("rooms").update({ status: "ROUND_ACTIVE" }).eq("id", match.room_id);
  return NextResponse.json({ matchId, currentRound: 1 });
}
