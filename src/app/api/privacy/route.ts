import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const preferencesSchema = z.object({
  retainVoiceAssessments: z.boolean(), allowLearningAnalytics: z.boolean(),
  allowSocialDiscovery: z.boolean(), allowAuthorizedContentContribution: z.boolean()
});
const requestSchema = z.object({ requestType: z.enum(["export", "delete"]), confirmation: z.string().max(40).optional() });

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const [preferences, requests] = await Promise.all([
    supabase.from("privacy_preferences").select("retain_voice_assessments, allow_learning_analytics, allow_social_discovery, allow_authorized_content_contribution, updated_at").eq("user_id", authData.user.id).maybeSingle(),
    supabase.from("data_requests").select("id, request_type, status, requested_at, completed_at, expires_at, error_message").order("requested_at", { ascending: false }).limit(10)
  ]);
  return NextResponse.json({
    preferences: preferences.data ?? { retain_voice_assessments: false, allow_learning_analytics: true, allow_social_discovery: true, allow_authorized_content_contribution: false },
    requests: requests.data ?? []
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const parsed = preferencesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Thiết lập quyền riêng tư không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { error } = await supabase.from("privacy_preferences").upsert({
    user_id: authData.user.id, retain_voice_assessments: parsed.data.retainVoiceAssessments,
    allow_learning_analytics: parsed.data.allowLearningAnalytics, allow_social_discovery: parsed.data.allowSocialDiscovery,
    allow_authorized_content_contribution: parsed.data.allowAuthorizedContentContribution, updated_at: new Date().toISOString()
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ saved: true });
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu dữ liệu không hợp lệ" }, { status: 400 });
  if (parsed.data.requestType === "delete" && parsed.data.confirmation !== "XOA TAI KHOAN") return NextResponse.json({ error: "Hãy nhập chính xác XOA TAI KHOAN" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: pending } = await admin.from("data_requests").select("id").eq("user_id", authData.user.id).eq("request_type", parsed.data.requestType).in("status", ["queued", "processing", "ready"]).maybeSingle();
  if (pending) return NextResponse.json({ error: "Bạn đã có một yêu cầu cùng loại đang xử lý" }, { status: 409 });
  const { data, error } = await admin.from("data_requests").insert({ user_id: authData.user.id, request_type: parsed.data.requestType, status: "queued" }).select("id, request_type, status, requested_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 202 });
}
