import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const readySchema = z.object({ ready: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const parsed = readySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid ready state" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: match } = await supabase.from("matches").select("id, room_id, status, rooms(status)").eq("id", matchId).single();
  const room = Array.isArray(match?.rooms) ? match.rooms[0] : match?.rooms;
  if (!match || !room) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  if (match.status !== "active" || room.status !== "ROUND_RESULT") return NextResponse.json({ error: "The round is not waiting for both players" }, { status: 409 });

  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", match.room_id).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a match player can continue" }, { status: 403 });

  const { error: readyError } = await admin.from("room_members").update({ is_ready: parsed.data.ready }).eq("room_id", match.room_id).eq("user_id", authData.user.id);
  if (readyError) return NextResponse.json({ error: readyError.message }, { status: 500 });
  const { data: members, error: membersError } = await admin.from("room_members").select("user_id, is_ready").eq("room_id", match.room_id);
  if (membersError) return NextResponse.json({ error: membersError.message }, { status: 500 });
  if (!members || members.length !== 2) return NextResponse.json({ error: "Exactly two players are required" }, { status: 409 });

  const readyCount = members.filter((member) => member.is_ready).length;
  return NextResponse.json({ ready: parsed.data.ready, readyCount, allReady: readyCount === 2 });
}
