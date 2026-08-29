import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const timeValue = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u).nullable();
const preferencesSchema = z.object({
  review_due: z.boolean(),
  shared_goal_reminders: z.boolean(),
  room_invites: z.boolean(),
  quiet_hours_start: timeValue,
  quiet_hours_end: timeValue,
  timezone: z.string().trim().min(1).max(100)
});

async function auth() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { supabase, user: data.user } as const;
}

export async function GET() {
  const current = await auth();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: current.status });
  const { data, error } = await current.supabase.from("notification_preferences").select("review_due, shared_goal_reminders, room_invites, quiet_hours_start, quiet_hours_end, timezone").eq("user_id", current.user.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ preferences: data }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(request: Request) {
  const current = await auth();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: current.status });
  const parsed = preferencesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Notification settings không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  try { new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone }).format(new Date()); }
  catch { return NextResponse.json({ error: "Múi giờ IANA không hợp lệ" }, { status: 400 }); }
  if (Boolean(parsed.data.quiet_hours_start) !== Boolean(parsed.data.quiet_hours_end)) return NextResponse.json({ error: "Cần nhập đủ giờ bắt đầu và kết thúc yên lặng" }, { status: 400 });
  const { data, error } = await current.supabase.from("notification_preferences").upsert({ user_id: current.user.id, ...parsed.data, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select("review_due, shared_goal_reminders, room_invites, quiet_hours_start, quiet_hours_end, timezone").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ preferences: data });
}
