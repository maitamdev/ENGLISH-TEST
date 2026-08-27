import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const readySchema = z.object({ ready: z.boolean() });

export async function PATCH(request: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const parsed = readySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid ready state" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: room } = await supabase.from("rooms").select("id, status").eq("id", roomId).single();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  if (room.status !== "GAME_READY") return NextResponse.json({ error: "The match is not waiting for player confirmation" }, { status: 409 });

  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", roomId).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a room member can confirm readiness" }, { status: 403 });

  const { error: readyError } = await admin.from("room_members").update({ is_ready: parsed.data.ready }).eq("room_id", roomId).eq("user_id", authData.user.id);
  if (readyError) return NextResponse.json({ error: readyError.message }, { status: 500 });

  const { data: members, error: membersError } = await admin.from("room_members").select("user_id, is_ready").eq("room_id", roomId);
  if (membersError) return NextResponse.json({ error: membersError.message }, { status: 500 });
  if (!members || members.length !== 2) return NextResponse.json({ error: "Exactly two players are required" }, { status: 409 });

  const readyCount = members.filter((member) => member.is_ready).length;
  const allReady = readyCount === 2;
  if (allReady) {
    const { data: transitioned, error: transitionError } = await admin.from("rooms").update({ status: "COUNTDOWN" }).eq("id", roomId).eq("status", "GAME_READY").select("id").maybeSingle();
    if (transitionError) return NextResponse.json({ error: transitionError.message }, { status: 500 });
    if (!transitioned) return NextResponse.json({ error: "The room state changed before countdown could start" }, { status: 409 });
  }

  return NextResponse.json({ ready: parsed.data.ready, readyCount, allReady });
}
