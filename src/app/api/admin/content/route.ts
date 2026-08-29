import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";
import { importLearningSource } from "@/lib/learning/source-importer";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const sourceKey = z.enum(["tatoeba-en-vi", "cmudict", "meta-covost", "authorized-facebook-page"]);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import"), sourceKey, limit: z.number().int().min(1).max(500).default(100), cursor: z.object({ after: z.union([z.string(), z.number()]).optional(), line: z.number().int().min(0).optional() }).optional(), rightsHolder: z.string().trim().min(2).max(200).optional(), authorizationEvidenceUrl: z.string().url().max(1000).optional() }),
  z.object({ action: z.literal("moderate"), contentIds: z.array(z.string().uuid()).min(1).max(200), verdict: z.enum(["approve", "reject", "quarantine", "restore"]), note: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal("source_state"), sourceId: z.string().uuid(), enabled: z.boolean() })
]);

export async function GET(request: Request) {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  const [sources, runs, content, counts] = await Promise.all([
    auth.admin.from("learning_sources").select("id, source_key, display_name, homepage_url, license_id, license_url, attribution_text, source_kind, enabled, last_imported_at, created_at").order("display_name"),
    auth.admin.from("source_import_runs").select("id, source_id, status, cursor_state, imported_count, skipped_count, rejected_count, error_message, started_at, completed_at, created_at, learning_sources(display_name, source_key)").order("created_at", { ascending: false }).limit(30),
    auth.admin.from("learning_content").select("id, source_id, source_record_id, content_type, language, translation_language, content, license_id, attribution, moderation_status, moderation_notes, quality_score, imported_at, learning_sources(display_name, source_key, license_url)").eq("moderation_status", ["pending","approved","rejected","quarantined"].includes(status) ? status : "pending").order("imported_at", { ascending: false }).limit(100),
    Promise.all(["pending","approved","rejected","quarantined"].map(async (value) => ({ status: value, count: (await auth.admin.from("learning_content").select("id", { count: "exact", head: true }).eq("moderation_status", value)).count ?? 0 })))
  ]);
  const error = sources.error ?? runs.error ?? content.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const normalizedRuns = (runs.data ?? []).map((run) => ({
    ...run,
    cursor: run.cursor_state,
    fetched_count: run.imported_count + run.skipped_count + run.rejected_count,
    accepted_count: run.imported_count
  }));
  const normalizedContent = (content.data ?? []).map((item) => ({ ...item, external_id: item.source_record_id }));
  return NextResponse.json({ sources: sources.data ?? [], runs: normalizedRuns, content: normalizedContent, counts }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin", "moderator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid admin content action", details: parsed.error.flatten() }, { status: 400 });

  if (parsed.data.action === "import") {
    if (auth.role === "moderator") return NextResponse.json({ error: "Admin role required to import sources" }, { status: 403 });
    try {
      const result = await importLearningSource(auth.admin, parsed.data);
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Content import failed" }, { status: 502 });
    }
  }

  if (parsed.data.action === "source_state") {
    if (auth.role === "moderator") return NextResponse.json({ error: "Admin role required to change a source" }, { status: 403 });
    const { data, error } = await auth.admin.from("learning_sources").update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() }).eq("id", parsed.data.sourceId).select("id, enabled").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  }

  if (parsed.data.action !== "moderate") return NextResponse.json({ error: "Unsupported content action" }, { status: 400 });
  const moderation = parsed.data;
  const nextStatus = moderation.verdict === "approve" || moderation.verdict === "restore" ? "approved" : moderation.verdict === "reject" ? "rejected" : "quarantined";
  const { data: existing, error: readError } = await auth.admin.from("learning_content").select("id, moderation_status").in("id", moderation.contentIds);
  if (readError) return NextResponse.json({ error: readError.message }, { status: 400 });
  const now = new Date().toISOString();
  const { data, error } = await auth.admin.from("learning_content").update({ moderation_status: nextStatus, moderation_notes: moderation.note ?? null, moderated_at: now, updated_at: now }).in("id", moderation.contentIds).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (data?.length) await auth.admin.from("content_moderation_actions").insert(data.map((item) => ({
    content_id: item.id,
    actor_id: auth.user.id,
    action: moderation.verdict,
    previous_status: existing?.find((row) => row.id === item.id)?.moderation_status ?? null,
    next_status: nextStatus,
    note: moderation.note ?? null,
    evidence: { interface: "content_admin_studio" }
  })));
  return NextResponse.json({ updated: data?.length ?? 0, status: nextStatus });
}
