import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({ endpoint: z.string().url().max(3000), keys: z.object({ p256dh: z.string().min(20).max(500), auth: z.string().min(10).max(500) }) });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Push subscription không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { error } = await supabase.from("push_subscriptions").upsert({ user_id: authData.user.id, endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth_secret: parsed.data.keys.auth, user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "user_id,endpoint" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ subscribed: true });
}

export async function DELETE(request: Request) {
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "Endpoint required" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { error } = await supabase.from("push_subscriptions").delete().eq("user_id", authData.user.id).eq("endpoint", endpoint);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ subscribed: false });
}
