import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const iceServers: RTCIceServer[] = [{ urls: process.env.NEXT_PUBLIC_STUN_URL || "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.TURN_URL || process.env.NEXT_PUBLIC_TURN_URL;
  const turnSecret = process.env.TURN_SHARED_SECRET;
  if (turnUrl && turnSecret) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expires}:${authData.user.id}`;
    const credential = createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrl.split(",").map((item) => item.trim()), username, credential });
  } else if (turnUrl && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrl.split(",").map((item) => item.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }

  return NextResponse.json({ iceServers, expiresIn: 3600, turnConfigured: iceServers.length > 1 }, {
    headers: { "Cache-Control": "private, no-store" }
  });
}
