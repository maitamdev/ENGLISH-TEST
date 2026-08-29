import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const sessionSchema = z.object({ roomId: z.string().uuid(), sessionId: z.string().uuid() });

async function context(request: Request) {
  const parsed = sessionSchema.safeParse(await request.json());
  if (!parsed.success) return { error: NextResponse.json({ error: "Invalid Gemini session" }, { status: 400 }) };
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: NextResponse.json({ error: "Supabase is not configured" }, { status: 503 }) };
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  return { parsed: parsed.data, admin, userId: authData.user.id };
}

export async function POST(request: Request) {
  const result = await context(request);
  if (result.error) return result.error;
  const { parsed, admin, userId } = result;
  const { data: session, error } = await admin.from("ai_sessions").update({
    heartbeat_at: new Date().toISOString()
  }).eq("id", parsed.sessionId).eq("room_id", parsed.roomId).eq("coordinator_id", userId).is("ended_at", null).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: "Gemini coordinator lease is no longer active" }, { status: 409 });
  return NextResponse.json({ active: true });
}

export async function DELETE(request: Request) {
  const result = await context(request);
  if (result.error) return result.error;
  const { parsed, admin, userId } = result;
  const { error } = await admin.from("ai_sessions").update({
    ended_at: new Date().toISOString(),
    state: { status: "released" }
  }).eq("id", parsed.sessionId).eq("room_id", parsed.roomId).eq("coordinator_id", userId).is("ended_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ active: false });
}
