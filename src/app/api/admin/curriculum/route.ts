import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const descriptorSchema = z.object({ externalId: z.string().trim().min(1).max(300), cefrLevel: z.enum(["Pre-A1", "A1", "A2", "B1", "B2", "C1", "C2"]), skill: z.enum(["vocabulary", "grammar", "reading", "listening", "writing", "speaking", "spoken_interaction", "mediation", "phonology", "online_interaction"]), descriptorText: z.string().trim().min(10).max(2000), metadata: z.record(z.string(), z.unknown()).optional() });
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_framework"), frameworkKey: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]+$/u).max(100), displayName: z.string().trim().min(3).max(200), publisher: z.string().trim().min(2).max(200), sourceUrl: z.string().url().max(1000), licenseId: z.string().trim().min(2).max(100), licenseUrl: z.string().url().max(1000), attributionText: z.string().trim().min(3).max(1000), versionLabel: z.string().trim().max(100).optional(), provenance: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal("import_descriptors"), frameworkId: z.string().uuid(), descriptors: z.array(descriptorSchema).min(1) }),
  z.object({ action: z.literal("moderate"), descriptorIds: z.array(z.string().uuid()).min(1), verdict: z.enum(["approve", "reject", "quarantine", "restore"]), note: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal("framework_state"), frameworkId: z.string().uuid(), enabled: z.boolean() })
]);

export async function GET(request: Request) {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const requested = new URL(request.url).searchParams.get("status") ?? "pending";
  const status = ["pending", "approved", "rejected", "quarantined"].includes(requested) ? requested : "pending";
  const [frameworks, descriptors, counts] = await Promise.all([
    auth.admin.from("curriculum_frameworks").select("id, framework_key, display_name, publisher, source_url, license_id, license_url, attribution_text, version_label, provenance, enabled, created_at").order("display_name"),
    auth.admin.from("curriculum_descriptors").select("id, framework_id, external_id, cefr_level, skill, descriptor_text, metadata, moderation_status, moderation_note, created_at, curriculum_frameworks(display_name, publisher, source_url, license_id, license_url)").eq("moderation_status", status).order("created_at", { ascending: false }),
    Promise.all(["pending", "approved", "rejected", "quarantined"].map(async (value) => ({ status: value, count: (await auth.admin.from("curriculum_descriptors").select("id", { count: "exact", head: true }).eq("moderation_status", value)).count ?? 0 })))
  ]);
  const error = frameworks.error ?? descriptors.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ frameworks: frameworks.data ?? [], descriptors: descriptors.data ?? [], counts }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin", "moderator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Curriculum action không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  const action = parsed.data;
  const adminOnly = action.action !== "moderate";
  if (adminOnly && auth.role === "moderator") return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  if (action.action === "create_framework") {
    const { data, error } = await auth.admin.from("curriculum_frameworks").insert({ framework_key: action.frameworkKey, display_name: action.displayName, publisher: action.publisher, source_url: action.sourceUrl, license_id: action.licenseId, license_url: action.licenseUrl, attribution_text: action.attributionText, version_label: action.versionLabel || null, provenance: action.provenance ?? {}, created_by: auth.user.id }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data, { status: 201 });
  }
  if (action.action === "framework_state") {
    const { data, error } = await auth.admin.from("curriculum_frameworks").update({ enabled: action.enabled, updated_at: new Date().toISOString() }).eq("id", action.frameworkId).select("id, enabled").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  }
  if (action.action === "import_descriptors") {
    const { data: framework } = await auth.admin.from("curriculum_frameworks").select("id, source_url, license_id, license_url, attribution_text").eq("id", action.frameworkId).maybeSingle();
    if (!framework) return NextResponse.json({ error: "Framework không tồn tại" }, { status: 404 });
    const rows = action.descriptors.map((descriptor) => ({ framework_id: framework.id, external_id: descriptor.externalId, cefr_level: descriptor.cefrLevel, skill: descriptor.skill, descriptor_text: descriptor.descriptorText, descriptor_hash: createHash("sha256").update(descriptor.descriptorText.normalize("NFKC").replace(/\s+/gu, " ").trim()).digest("hex"), metadata: { ...(descriptor.metadata ?? {}), importedBy: auth.user.id, sourceUrl: framework.source_url, licenseId: framework.license_id, licenseUrl: framework.license_url, attributionText: framework.attribution_text }, moderation_status: "pending" }));
    const { data, error } = await auth.admin.from("curriculum_descriptors").upsert(rows, { onConflict: "framework_id,external_id", ignoreDuplicates: true }).select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ received: rows.length, inserted: data?.length ?? 0 }, { status: 201 });
  }
  const nextStatus = action.verdict === "approve" || action.verdict === "restore" ? "approved" : action.verdict === "reject" ? "rejected" : "quarantined";
  const { data: existing } = await auth.admin.from("curriculum_descriptors").select("id, moderation_status").in("id", action.descriptorIds);
  const now = new Date().toISOString();
  const { data, error } = await auth.admin.from("curriculum_descriptors").update({ moderation_status: nextStatus, moderation_note: action.note ?? null, moderated_by: auth.user.id, moderated_at: now, updated_at: now }).in("id", action.descriptorIds).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (data?.length) await auth.admin.from("curriculum_moderation_actions").insert(data.map((row) => ({ descriptor_id: row.id, actor_id: auth.user.id, action: action.verdict, previous_status: existing?.find((value) => value.id === row.id)?.moderation_status ?? null, next_status: nextStatus, note: action.note ?? null })));
  return NextResponse.json({ updated: data?.length ?? 0, status: nextStatus });
}
