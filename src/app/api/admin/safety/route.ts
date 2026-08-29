import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";

export const dynamic = "force-dynamic";

const mutationSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["reviewing", "resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3).max(2000)
});

export async function GET(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin", "moderator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const requested = new URL(request.url).searchParams.get("status") ?? "open";
  const status = ["open", "reviewing", "resolved", "dismissed"].includes(requested) ? requested : "open";
  const [reports, counts] = await Promise.all([
    auth.admin.from("user_reports").select("id, reporter_id, reported_user_id, room_id, category, detail, evidence, status, assigned_to, resolution_note, created_at, updated_at, reporter:profiles!user_reports_reporter_id_fkey(display_name, username), reported:profiles!user_reports_reported_user_id_fkey(display_name, username), rooms(code)").eq("status", status).order("created_at", { ascending: true }).limit(100),
    Promise.all(["open", "reviewing", "resolved", "dismissed"].map(async (value) => ({ status: value, count: (await auth.admin.from("user_reports").select("id", { count: "exact", head: true }).eq("status", value)).count ?? 0 })))
  ]);
  if (reports.error) return NextResponse.json({ error: reports.error.message }, { status: 400 });
  return NextResponse.json({ reports: reports.data ?? [], counts }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin", "moderator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid safety decision", details: parsed.error.flatten() }, { status: 400 });
  const now = new Date().toISOString();
  const { data, error } = await auth.admin.from("user_reports").update({
    status: parsed.data.status,
    assigned_to: auth.user.id,
    resolution_note: parsed.data.resolutionNote,
    updated_at: now
  }).eq("id", parsed.data.reportId).select("id, status").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
