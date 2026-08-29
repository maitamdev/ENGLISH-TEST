import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const heartbeatSchema = z.object({
  clientSessionId: z.string().uuid(),
  action: z.enum(["heartbeat", "disconnect"]).default("heartbeat"),
  deviceState: z.record(z.string(), z.unknown()).default({}),
  connectionQuality: z.record(z.string(), z.unknown()).default({})
});

export async function POST(request: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const parsed = heartbeatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid room heartbeat" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  if (parsed.data.action === "disconnect") {
    const { error } = await supabase.rpc("mark_room_disconnected", {
      target_room_id: roomId,
      target_client_session_id: parsed.data.clientSessionId
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ disconnected: true }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const { data, error } = await supabase.rpc("heartbeat_room", {
    target_room_id: roomId,
    target_client_session_id: parsed.data.clientSessionId,
    target_device_state: parsed.data.deviceState,
    target_connection_quality: parsed.data.connectionQuality
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
