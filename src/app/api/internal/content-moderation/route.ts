import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeInternalRequest } from "@/lib/security/internal-auth";

const schema = z.object({ contentIds: z.array(z.string().uuid()).min(1).max(200), action: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() });

export async function POST(request: Request) {
  if (!authorizeInternalRequest(request, process.env.CONTENT_IMPORT_SECRET)) return NextResponse.json({ error: "Moderation authorization failed" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid moderation request" }, { status: 400 });
  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase service role is not configured" }, { status: 503 });
  const { data, error } = await admin.from("learning_content").update({ moderation_status: parsed.data.action === "approve" ? "approved" : "rejected", moderation_notes: parsed.data.note ?? null, moderated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", parsed.data.contentIds).eq("moderation_status", "pending").select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ updated: data?.length ?? 0, status: parsed.data.action === "approve" ? "approved" : "rejected" });
}
