import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";
import { evaluateOperationalAlerts, getOperationsSnapshot } from "@/lib/observability/operations";

export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_rule"), name: z.string().trim().min(3).max(120), metric: z.enum(["generation_failed","generation_active","telemetry_errors","realtime_reconnects","audio_failures","fairness_compromised","privacy_pending"]), comparator: z.enum(["gt","gte","lt","lte","eq"]), threshold: z.number().finite(), windowMinutes: z.number().int().min(1).max(10080), severity: z.enum(["info","warning","error","critical"]) }),
  z.object({ action: z.literal("toggle_rule"), ruleId: z.string().uuid(), enabled: z.boolean() }),
  z.object({ action: z.literal("alert_status"), alertId: z.string().uuid(), status: z.enum(["acknowledged","resolved"]) }),
  z.object({ action: z.literal("evaluate") })
]);

export async function GET() {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(await getOperationsSnapshot(auth.admin), { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid operations action", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.action === "evaluate") return NextResponse.json({ evaluated: await evaluateOperationalAlerts(auth.admin) });
  if (parsed.data.action === "create_rule") {
    const { data, error } = await auth.admin.from("operational_alert_rules").insert({ name: parsed.data.name, metric: parsed.data.metric, comparator: parsed.data.comparator, threshold: parsed.data.threshold, window_minutes: parsed.data.windowMinutes, severity: parsed.data.severity, created_by: auth.user.id }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data, { status: 201 });
  }
  if (parsed.data.action === "toggle_rule") {
    const { error } = await auth.admin.from("operational_alert_rules").update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() }).eq("id", parsed.data.ruleId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ enabled: parsed.data.enabled });
  }
  const now = new Date().toISOString();
  const values = parsed.data.status === "acknowledged" ? { status: "acknowledged", acknowledged_by: auth.user.id, acknowledged_at: now } : { status: "resolved", resolved_by: auth.user.id, resolved_at: now };
  const { error } = await auth.admin.from("operational_alerts").update(values).eq("id", parsed.data.alertId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ status: parsed.data.status });
}
