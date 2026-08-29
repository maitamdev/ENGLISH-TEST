import { after, NextResponse } from "next/server";
import { drainGenerationQueue } from "@/lib/ai/durable-game-generator";
import { recordTelemetry } from "@/lib/observability/telemetry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { gameGenerationRequestSchema } from "@/lib/validation/game";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const parsed = gameGenerationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu tạo trận không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
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
  if (!membership) return NextResponse.json({ error: "Chỉ thành viên phòng mới có thể tạo trận" }, { status: 403 });
  if (!members || members.length !== 2) return NextResponse.json({ error: "Phòng phải có đúng hai thành viên" }, { status: 409 });

  const { data: claimed, error: claimError } = await admin.from("rooms").update({ status: "GENERATING_GAME" }).eq("id", room.id).eq("status", "AI_DISCUSSION").select("id").maybeSingle();
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
  if (!claimed) return NextResponse.json({ error: `Không thể tạo trận khi phòng đang ở trạng thái ${room.status}` }, { status: 409 });

  const { data: job, error: jobError } = await admin.from("generation_jobs").insert({
    room_id: room.id, requested_by: authData.user.id, status: "queued",
    stage: "Đã xếp hàng · đang chờ thiết kế trận đấu", request_payload: parsed.data,
    batch_size: 4, next_round: 1, max_attempts: 8
  }).select("id, correlation_id").single();
  if (jobError || !job) {
    await admin.from("rooms").update({ status: "AI_DISCUSSION" }).eq("id", room.id).eq("status", "GENERATING_GAME");
    return NextResponse.json({ error: jobError?.message ?? "Không tạo được tiến trình sinh câu hỏi" }, { status: 500 });
  }

  await recordTelemetry({ name: "generation.queued", correlationId: job.correlation_id, roomId: room.id, userId: authData.user.id, provider: "groq", metadata: { jobId: job.id, batchSize: 4 } });
  after(async () => {
    try { await drainGenerationQueue({ maxBatches: 2, timeBudgetMs: 90_000 }); }
    catch (cause) { await recordTelemetry({ name: "generation.after_failed", severity: "error", correlationId: job.correlation_id, roomId: room.id, userId: authData.user.id, errorCode: "after_worker", errorMessage: cause instanceof Error ? cause.message : "Background generation failed", metadata: { jobId: job.id } }); }
  });
  return NextResponse.json({ jobId: job.id, queued: true, message: "Đã xếp hàng tạo trận theo từng batch" }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
