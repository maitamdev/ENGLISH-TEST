import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const updateSchema = z.object({ id: z.string().uuid(), status: z.enum(["pending", "in_progress", "completed", "dismissed"]) });

async function authenticate() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { supabase, admin, user: data.user } as const;
}

export async function GET() {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rows: unknown[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await auth.admin.from("match_remediation_items")
      .select("id, match_id, question_id, skill, reason, priority, action_type, status, due_at, evidence, created_at, questions(prompt, instruction, mode), matches(title, topic)")
      .eq("user_id", auth.user.id).in("status", ["pending", "in_progress"]).order("priority", { ascending: false }).order("due_at").range(from, from + 499);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return NextResponse.json({ items: rows }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Trạng thái remediation không hợp lệ" }, { status: 400 });
  const { data, error } = await auth.supabase.rpc("update_match_remediation", { target_item_id: parsed.data.id, target_status: parsed.data.status });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json(data);
}
