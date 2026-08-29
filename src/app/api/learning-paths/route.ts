import { NextResponse } from "next/server";
import { z } from "zod";
import { generateSharedLearningPath } from "@/lib/learning/shared-learning-path";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { dispatchNotificationOutbox } from "@/lib/notifications/outbox";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const createSchema = z.object({
  partnerId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  targetCefr: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]),
  focusSkills: z.array(z.enum(["vocabulary", "grammar", "reading", "listening", "writing", "speaking", "phonology", "mediation", "online_interaction"])).min(1).max(9),
  startsOn: z.string().date().optional(),
  targetDate: z.string().date().optional(),
  sessionsPerWeek: z.number().int().min(1).max(14),
  minutesPerSession: z.number().int().min(5).max(180)
}).refine((value) => !value.startsOn || !value.targetDate || value.targetDate >= value.startsOn, { message: "Ngày kết thúc phải sau ngày bắt đầu", path: ["targetDate"] });
const updateSchema = z.object({ goalId: z.string().uuid(), action: z.enum(["accept", "retry_generation", "decline", "pause", "resume", "archive", "complete_item"]), itemId: z.string().uuid().optional() });

async function authenticate() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase chưa được cấu hình", status: 503 } as const;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Bạn cần đăng nhập", status: 401 } as const;
  return { supabase, admin, user: data.user } as const;
}

async function loadGoals(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, userId: string) {
  const [{ data, error }, { data: blocks }] = await Promise.all([
    admin.from("shared_learning_goals").select("id, created_by, partner_id, title, target_cefr, focus_skills, status, creator_accepted_at, partner_accepted_at, schedule, starts_on, target_date, created_at, updated_at, shared_learning_path_items(id, sequence_number, skill, activity_type, title, objective, target_minutes, target_count, due_at, assignment, source_filters, completed_by, completion_evidence)").or(`created_by.eq.${userId},partner_id.eq.${userId}`).neq("status", "archived").order("created_at", { ascending: false }),
    admin.from("user_blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
  ]);
  if (error) throw new Error(error.message);
  const blockedPeers = new Set((blocks ?? []).map((block) => block.blocker_id === userId ? block.blocked_id : block.blocker_id));
  const visible = (data ?? []).filter((goal) => !blockedPeers.has(goal.created_by === userId ? goal.partner_id : goal.created_by));
  const peerIds = [...new Set(visible.flatMap((goal) => [goal.created_by, goal.partner_id]))];
  const { data: profiles } = peerIds.length ? await admin.from("profiles").select("id, display_name, avatar_url").in("id", peerIds) : { data: [] };
  const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return visible.map((goal) => ({ ...goal, creator: profileMap.get(goal.created_by) ?? null, partner: profileMap.get(goal.partner_id) ?? null, shared_learning_path_items: [...(goal.shared_learning_path_items ?? [])].sort((a, b) => a.sequence_number - b.sequence_number) }));
}

export async function GET() {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try { return NextResponse.json({ goals: await loadGoals(auth.admin, auth.user.id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Không đọc được learning paths" }, { status: 400 }); }
}

export async function POST(request: Request) {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Learning goal không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.partnerId === auth.user.id) return NextResponse.json({ error: "Learning path cần hai người khác nhau" }, { status: 400 });
  const [{ data: friendship }, { data: blocked }] = await Promise.all([
    auth.admin.from("friendships").select("id").eq("status", "accepted").or(`and(requester_id.eq.${auth.user.id},addressee_id.eq.${parsed.data.partnerId}),and(requester_id.eq.${parsed.data.partnerId},addressee_id.eq.${auth.user.id})`).maybeSingle(),
    auth.admin.from("user_blocks").select("blocker_id").or(`and(blocker_id.eq.${auth.user.id},blocked_id.eq.${parsed.data.partnerId}),and(blocker_id.eq.${parsed.data.partnerId},blocked_id.eq.${auth.user.id})`).limit(1).maybeSingle()
  ]);
  if (blocked) return NextResponse.json({ error: "Không thể tạo learning path giữa hai tài khoản đã chặn nhau" }, { status: 403 });
  if (!friendship) return NextResponse.json({ error: "Chỉ có thể tạo learning path với bạn bè đã xác nhận" }, { status: 403 });
  try {
    const { data: goal, error: goalError } = await auth.admin.from("shared_learning_goals").insert({ created_by: auth.user.id, partner_id: parsed.data.partnerId, title: parsed.data.title, target_cefr: parsed.data.targetCefr, focus_skills: parsed.data.focusSkills, starts_on: parsed.data.startsOn ?? new Date().toISOString().slice(0, 10), target_date: parsed.data.targetDate ?? null, schedule: { sessionsPerWeek: parsed.data.sessionsPerWeek, minutesPerSession: parsed.data.minutesPerSession }, evidence_snapshot: { proposalCreatedAt: new Date().toISOString(), evidenceAccess: "awaiting_partner_consent" } }).select("id").single();
    if (goalError || !goal) throw new Error(goalError?.message ?? "Không lưu được shared goal proposal");
    const goalId = goal.id;
    const [{ data: creator }, { data: preference }] = await Promise.all([
      auth.admin.from("profiles").select("display_name").eq("id", auth.user.id).maybeSingle(),
      auth.admin.from("notification_preferences").select("shared_goal_reminders").eq("user_id", parsed.data.partnerId).maybeSingle()
    ]);
    if (preference?.shared_goal_reminders !== false) {
      await auth.admin.from("notification_outbox").upsert({ user_id: parsed.data.partnerId, notification_type: "shared_goal_invite", dedupe_key: `shared-goal-invite:${goalId}`, title: "Lộ trình học chung mới", body: `${creator?.display_name ?? "Một người bạn"} mời bạn tham gia “${parsed.data.title}”.`, destination_url: "/paths", payload: { goalId }, scheduled_for: new Date().toISOString() }, { onConflict: "dedupe_key", ignoreDuplicates: true });
      await dispatchNotificationOutbox(auth.admin, new Date(), { userId: parsed.data.partnerId }).catch(() => undefined);
    }
    return NextResponse.json({ goalId, goals: await loadGoals(auth.admin, auth.user.id) }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Không tạo được learning path" }, { status: 502 }); }
}

export async function PATCH(request: Request) {
  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (parsed.data.action === "complete_item" && !parsed.data.itemId)) return NextResponse.json({ error: "Thao tác learning path không hợp lệ" }, { status: 400 });
  const { data: targetGoal } = await auth.admin.from("shared_learning_goals").select("created_by, partner_id").eq("id", parsed.data.goalId).maybeSingle();
  if (!targetGoal || ![targetGoal.created_by, targetGoal.partner_id].includes(auth.user.id)) return NextResponse.json({ error: "Không tìm thấy shared goal" }, { status: 404 });
  const { data: blocked } = await auth.admin.from("user_blocks").select("blocker_id").or(`and(blocker_id.eq.${targetGoal.created_by},blocked_id.eq.${targetGoal.partner_id}),and(blocker_id.eq.${targetGoal.partner_id},blocked_id.eq.${targetGoal.created_by})`).limit(1).maybeSingle();
  if (blocked) return NextResponse.json({ error: "Learning path không khả dụng sau khi một tài khoản chặn tài khoản kia" }, { status: 403 });
  const { error } = await auth.supabase.rpc("update_shared_learning_goal", { target_goal_id: parsed.data.goalId, requested_action: parsed.data.action, target_item_id: parsed.data.itemId ?? null });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (["accept", "retry_generation"].includes(parsed.data.action)) {
    try { await generateSharedLearningPath(auth.admin, parsed.data.goalId); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Không sinh được shared learning path";
      const { data: failedGoal } = await auth.admin.from("shared_learning_goals").select("schedule").eq("id", parsed.data.goalId).maybeSingle();
      await auth.admin.from("shared_learning_goals").update({ status: "generation_failed", schedule: { ...((failedGoal?.schedule as Record<string, unknown> | null) ?? {}), generationError: message }, updated_at: new Date().toISOString() }).eq("id", parsed.data.goalId).eq("status", "generating");
      return NextResponse.json({ error: message, retryable: true, goals: await loadGoals(auth.admin, auth.user.id) }, { status: 502 });
    }
  }
  return NextResponse.json({ goals: await loadGoals(auth.admin, auth.user.id) });
}
