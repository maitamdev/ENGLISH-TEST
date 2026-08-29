import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const requestSchema = z.object({ roomId: z.string().uuid(), sessionId: z.string().uuid().optional() });

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid room" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase server credentials are not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: room } = await supabase.from("rooms").select("id, status").eq("id", parsed.data.roomId).single();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const { data: membership } = await admin.from("room_members").select("user_id").eq("room_id", room.id).eq("user_id", authData.user.id).maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only a room member can start Gemini" }, { status: 403 });
  if (!["AI_DISCUSSION", "GAME_READY", "ROUND_ACTIVE", "ROUND_RESULT"].includes(room.status)) {
    return NextResponse.json({ error: "Gemini is not available in the current room phase" }, { status: 409 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview").replace(/^models\//, "");
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY is missing on the server" }, { status: 503 });

  const staleBefore = new Date(Date.now() - 75_000).toISOString();
  await admin.from("ai_sessions").update({
    ended_at: new Date().toISOString(),
    state: { status: "lease_expired", model }
  }).eq("room_id", room.id).is("ended_at", null).lt("heartbeat_at", staleBefore);

  let sessionId = parsed.data.sessionId;
  let newlyCreated = false;
  if (sessionId) {
    const { data: resumedSession, error: resumeError } = await admin.from("ai_sessions").update({
      heartbeat_at: new Date().toISOString(),
      state: { status: "token_refresh", model }
    }).eq("id", sessionId).eq("room_id", room.id).eq("coordinator_id", authData.user.id).is("ended_at", null).select("id").maybeSingle();
    if (resumeError || !resumedSession) {
      return NextResponse.json({ error: "Phiên Gemini đã hết quyền điều phối. Hãy bật lại AI." }, { status: 409 });
    }
  } else {
    const { data: createdSession, error: sessionError } = await admin.from("ai_sessions").insert({
      room_id: room.id,
      coordinator_id: authData.user.id,
      heartbeat_at: new Date().toISOString(),
      state: { status: "claiming", model }
    }).select("id").single();
    if (sessionError || !createdSession) {
      if (sessionError?.code === "23505") {
        return NextResponse.json({ error: "Gemini đã được người còn lại bật trong phòng." }, { status: 409 });
      }
      return NextResponse.json({ error: sessionError?.message ?? "Could not claim the AI coordinator lease" }, { status: 500 });
    }
    sessionId = createdSession.id;
    newlyCreated = true;
  }

  const now = Date.now();
  const tokenResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString()
    }),
    cache: "no-store"
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { name?: string; error?: { message?: string } };
  if (!tokenResponse.ok || !tokenBody.name) {
    if (newlyCreated && sessionId) {
      await admin.from("ai_sessions").update({ ended_at: new Date().toISOString(), state: { status: "token_failed", model } }).eq("id", sessionId);
    }
    return NextResponse.json({ error: tokenBody.error?.message ?? "Gemini did not issue an ephemeral token" }, { status: 502 });
  }

  await admin.from("ai_sessions").update({
    heartbeat_at: new Date().toISOString(),
    state: { status: "token_issued", model }
  }).eq("id", sessionId!);

  return NextResponse.json({ token: tokenBody.name, model, sessionId });
}
