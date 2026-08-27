import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const requestSchema = z.object({ roomId: z.string().uuid() });

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
    return NextResponse.json({ error: tokenBody.error?.message ?? "Gemini did not issue an ephemeral token" }, { status: 502 });
  }

  const { data: aiSession, error: sessionError } = await admin.from("ai_sessions").insert({
    room_id: room.id,
    coordinator_id: authData.user.id,
    state: { status: "token_issued", model }
  }).select("id").single();
  if (sessionError || !aiSession) return NextResponse.json({ error: sessionError?.message ?? "Could not create the AI session" }, { status: 500 });

  return NextResponse.json({ token: tokenBody.name, model, sessionId: aiSession.id });
}
