import { after, NextResponse } from "next/server";
import { drainGenerationQueue } from "@/lib/ai/durable-game-generator";
import { recordTelemetry } from "@/lib/observability/telemetry";
import { recordUserSecurityEvent } from "@/lib/security/audit";
import { claimMutation, completeMutation, requestPayloadHash } from "@/lib/security/mutation-receipt";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { gameGenerationRequestSchema } from "@/lib/validation/game";
import type { ArenaAdaptiveContext } from "@/types/game";

export const runtime = "nodejs";
export const maxDuration = 300;

async function buildAdaptiveContext(admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, userIds: string[]): Promise<ArenaAdaptiveContext> {
  const { data: privacy } = await admin.from("privacy_preferences").select("user_id, allow_learning_analytics").in("user_id", userIds);
  const optedOut = new Set((privacy ?? []).filter((item) => item.allow_learning_analytics === false).map((item) => item.user_id));
  const participants = userIds.filter((id) => !optedOut.has(id));
  if (!participants.length) return { skillMastery: {}, reviewDueBySkill: {}, evidenceCount: 0, analyticsParticipants: 0 };
  const { data: mastery, error } = await admin.from("learner_skill_mastery").select("skill, mastery_score, evidence_count").in("user_id", participants);
  if (error) throw error;
  const skillTotals = new Map<string, { score: number; count: number }>();
  for (const row of mastery ?? []) {
    const current = skillTotals.get(row.skill) ?? { score: 0, count: 0 };
    current.score += Number(row.mastery_score); current.count += 1; skillTotals.set(row.skill, current);
  }
  const reviewDueBySkill: Record<string, number> = {};
  const now = new Date().toISOString();
  for (let from = 0; ; from += 500) {
    const { data, error: reviewError } = await admin.from("review_cards").select("skill").in("user_id", participants).is("suspended_at", null).lte("due_at", now).range(from, from + 499);
    if (reviewError) throw reviewError;
    for (const row of data ?? []) reviewDueBySkill[row.skill] = (reviewDueBySkill[row.skill] ?? 0) + 1;
    if (!data || data.length < 500) break;
  }
  return {
    skillMastery: Object.fromEntries([...skillTotals].map(([skill, value]) => [skill, Math.round(value.score / value.count * 100) / 100])),
    reviewDueBySkill,
    evidenceCount: (mastery ?? []).reduce((sum, row) => sum + Number(row.evidence_count), 0),
    analyticsParticipants: participants.length
  };
}

export async function POST(request: Request) {
  const parsed = gameGenerationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu tạo trận không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
    return NextResponse.json({ error: "Thiếu Idempotency-Key hợp lệ", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  if (!process.env.GROQ_API_KEY || !process.env.GROQ_MODEL) return NextResponse.json({ error: "GROQ_API_KEY và GROQ_MODEL chưa được cấu hình. Hệ thống không tạo câu hỏi fallback." }, { status: 503 });

  const [{ data: room }, { data: membership }, { data: members }] = await Promise.all([
    supabase.from("rooms").select("id, status").eq("id", parsed.data.roomId).maybeSingle(),
    admin.from("room_members").select("user_id").eq("room_id", parsed.data.roomId).eq("user_id", authData.user.id).maybeSingle(),
    admin.from("room_members").select("user_id").eq("room_id", parsed.data.roomId)
  ]);
  if (!room) return NextResponse.json({ error: "Không tìm thấy phòng" }, { status: 404 });
  if (!membership) {
    await recordUserSecurityEvent({ userId: authData.user.id, eventType: "room.generate.denied", severity: "warning", outcome: "blocked", resourceType: "room", resourceId: parsed.data.roomId });
    return NextResponse.json({ error: "Chỉ thành viên phòng mới có thể tạo trận" }, { status: 403 });
  }
  if (!members || members.length !== 2) return NextResponse.json({ error: "Phòng phải có đúng hai thành viên" }, { status: 409 });
  const receipt = await claimMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, requestHash: requestPayloadHash(parsed.data) });
  if (receipt.state === "conflict") return NextResponse.json({ error: "Idempotency-Key đã được dùng cho một yêu cầu khác", code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  if (receipt.state === "processing") return NextResponse.json({ error: "Yêu cầu này đang được xử lý", code: "REQUEST_IN_PROGRESS" }, { status: 409, headers: { "Retry-After": "2" } });
  if (receipt.state === "replay") return NextResponse.json(receipt.responseBody, { status: receipt.responseStatus, headers: { "Idempotent-Replay": "true" } });
  let adaptiveContext: ArenaAdaptiveContext;
  try {
    adaptiveContext = await buildAdaptiveContext(admin, members.map((member) => member.user_id));
  } catch (error) {
    const body = { error: error instanceof Error ? error.message : "Không đọc được dữ liệu thích ứng" };
    await completeMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, status: 500, body, failed: true });
    return NextResponse.json(body, { status: 500 });
  }

  const { data: claimed, error: claimError } = await admin.from("rooms").update({ status: "GENERATING_GAME" }).eq("id", room.id).eq("status", "AI_DISCUSSION").select("id").maybeSingle();
  if (claimError) {
    const body = { error: claimError.message };
    await completeMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, status: 500, body, failed: true });
    return NextResponse.json(body, { status: 500 });
  }
  if (!claimed) {
    const body = { error: `Không thể tạo trận khi phòng đang ở trạng thái ${room.status}` };
    await completeMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, status: 409, body, failed: true });
    return NextResponse.json(body, { status: 409 });
  }

  const { data: job, error: jobError } = await admin.from("generation_jobs").insert({
    room_id: room.id, requested_by: authData.user.id, status: "queued",
    stage: "Đã xếp hàng · đang chờ thiết kế trận đấu", request_payload: { ...parsed.data, adaptiveContext },
    batch_size: 4, next_round: 1, max_attempts: 8
  }).select("id, correlation_id").single();
  if (jobError || !job) {
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id).eq("status", "GENERATING_GAME");
    const body = { error: jobError?.message ?? "Không tạo được tiến trình sinh câu hỏi" };
    await completeMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, status: 500, body, failed: true });
    return NextResponse.json(body, { status: 500 });
  }

  await recordTelemetry({ name: "generation.queued", correlationId: job.correlation_id, roomId: room.id, userId: authData.user.id, provider: "groq", metadata: { jobId: job.id, batchSize: 4 } });
  after(async () => {
    try { await drainGenerationQueue({ maxBatches: 2, timeBudgetMs: 90_000 }); }
    catch (cause) { await recordTelemetry({ name: "generation.after_failed", severity: "error", correlationId: job.correlation_id, roomId: room.id, userId: authData.user.id, errorCode: "after_worker", errorMessage: cause instanceof Error ? cause.message : "Background generation failed", metadata: { jobId: job.id } }); }
  });
  const responseBody = { jobId: job.id, queued: true, message: "Đã xếp hàng tạo trận theo từng batch" };
  await completeMutation({ userId: authData.user.id, scope: "ai.generate-game", key: idempotencyKey, status: 202, body: responseBody });
  await recordUserSecurityEvent({ userId: authData.user.id, eventType: "room.generate.queued", outcome: "success", resourceType: "room", resourceId: room.id, metadata: { jobId: job.id } });
  return NextResponse.json(responseBody, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
