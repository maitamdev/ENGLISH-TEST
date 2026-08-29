import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { importLearningSource } from "@/lib/learning/source-importer";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  sourceKey: z.enum(["tatoeba-en-vi", "cmudict", "meta-covost", "authorized-facebook-page"]),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.object({ after: z.union([z.string(), z.number()]).optional(), line: z.number().int().min(0).optional() }).optional(),
  rightsHolder: z.string().trim().min(2).max(200).optional(),
  authorizationEvidenceUrl: z.string().url().max(1000).optional()
});

function authorized(request: Request) {
  const expected = process.env.CONTENT_IMPORT_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Import authorization failed" }, { status: 401 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid import request", details: parsed.error.flatten() }, { status: 400 });
  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase service role is not configured" }, { status: 503 });

  const started = Date.now();
  try {
    const result = await importLearningSource(admin, parsed.data);
    return NextResponse.json({ sourceKey: parsed.data.sourceKey, ...result, durationMs: Date.now() - started }, {
      headers: { "Cache-Control": "private, no-store" }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Content import failed" }, { status: 502 });
  }
}
