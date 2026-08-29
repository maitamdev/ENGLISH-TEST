import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { gameGenerationPreferencesSchema } from "@/lib/validation/game";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  configuration: gameGenerationPreferencesSchema,
  makeDefault: z.boolean().default(false)
});
const mutateSchema = z.object({ id: z.string().uuid(), action: z.enum(["make_default", "delete"]) });

async function authenticate() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { supabase, user: data.user } as const;
}

export async function GET() {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const presets: unknown[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await auth.supabase.from("user_arena_presets").select("id, name, description, configuration, is_default, created_at, updated_at").order("is_default", { ascending: false }).order("updated_at", { ascending: false }).range(from, from + 499);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    presets.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return NextResponse.json({ presets }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Cấu hình arena không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await auth.supabase.from("user_arena_presets").insert({
    user_id: auth.user.id,
    name: parsed.data.name,
    description: parsed.data.description || null,
    configuration: parsed.data.configuration,
    is_default: false
  }).select("id, name, description, configuration, is_default, created_at, updated_at").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "Bạn đã có cấu hình cùng tên" : error.message }, { status: error.code === "23505" ? 409 : 400 });
  if (parsed.data.makeDefault) {
    const { error: defaultError } = await auth.supabase.rpc("set_default_arena_preset", { target_preset_id: data.id });
    if (defaultError) return NextResponse.json({ error: defaultError.message }, { status: 409 });
  }
  return NextResponse.json({ ...data, is_default: parsed.data.makeDefault }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = mutateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Thao tác preset không hợp lệ" }, { status: 400 });
  if (parsed.data.action === "delete") {
    const { error } = await auth.supabase.from("user_arena_presets").delete().eq("id", parsed.data.id).eq("user_id", auth.user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ deleted: true });
  }
  const { error } = await auth.supabase.rpc("set_default_arena_preset", { target_preset_id: parsed.data.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ defaultPresetId: parsed.data.id });
}
