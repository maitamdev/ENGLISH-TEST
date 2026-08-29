import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateArenaReadiness, requiresAudioReadiness } from "@/lib/learning/arena-adaptation";
import type { BattleBlueprint } from "@/types/game";

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

  const { data: match } = await admin.from("matches").select("id, blueprint").eq("room_id", roomId).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!match) return NextResponse.json({ error: "Không tìm thấy trận đang chờ xác nhận" }, { status: 409 });
  const blueprint = match.blueprint as BattleBlueprint;
  const needsAudio = Boolean(blueprint.settings?.requireAudioPreflight) && requiresAudioReadiness(blueprint.modes);
  const strict = blueprint.settings?.fairnessMode === "STRICT";
  if (parsed.data.ready) {
    const { data: candidate } = await admin.from("room_members").select("connection_state, last_seen_at, device_state, connection_quality").eq("room_id", roomId).eq("user_id", authData.user.id).single();
    if (!candidate) return NextResponse.json({ error: "Không đọc được readiness hiện tại" }, { status: 409 });
    const readiness = evaluateArenaReadiness({ connectionState: candidate.connection_state, lastSeenAt: candidate.last_seen_at, deviceState: candidate.device_state ?? {}, connectionQuality: candidate.connection_quality ?? {} }, { needsAudio, strict });
    if (!readiness.passed) return NextResponse.json({ error: `Chưa thể START: ${readiness.blockers.join("; ")}`, blockers: readiness.blockers }, { status: 409 });
  }

  const { error: readyError } = await admin.from("room_members").update({ is_ready: parsed.data.ready }).eq("room_id", roomId).eq("user_id", authData.user.id);
  if (readyError) return NextResponse.json({ error: readyError.message }, { status: 500 });

  const { data: members, error: membersError } = await admin.from("room_members").select("user_id, is_ready, connection_state, last_seen_at, device_state, connection_quality").eq("room_id", roomId);
  if (membersError) return NextResponse.json({ error: membersError.message }, { status: 500 });
  if (!members || members.length !== 2) return NextResponse.json({ error: "Exactly two players are required" }, { status: 409 });

  const readyCount = members.filter((member) => member.is_ready).length;
  const allReady = readyCount === 2;
  if (allReady) {
    const readiness = members.map((member) => ({ userId: member.user_id, ...evaluateArenaReadiness({ connectionState: member.connection_state, lastSeenAt: member.last_seen_at, deviceState: member.device_state ?? {}, connectionQuality: member.connection_quality ?? {} }, { needsAudio, strict }) }));
    const blocked = readiness.filter((item) => !item.passed);
    if (blocked.length) {
      await admin.from("room_members").update({ is_ready: false }).eq("room_id", roomId);
      return NextResponse.json({ error: "Readiness đã thay đổi trước countdown", participants: blocked }, { status: 409 });
    }
    const { data: transitioned, error: transitionError } = await admin.from("rooms").update({ status: "COUNTDOWN" }).eq("id", roomId).eq("status", "GAME_READY").select("id").maybeSingle();
    if (transitionError) return NextResponse.json({ error: transitionError.message }, { status: 500 });
    if (!transitioned) return NextResponse.json({ error: "The room state changed before countdown could start" }, { status: 409 });
  }

  return NextResponse.json({ ready: parsed.data.ready, readyCount, allReady });
}
