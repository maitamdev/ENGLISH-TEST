import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reviewSemanticAnswer } from "@/lib/ai/semantic-answer-review";

export const runtime = "nodejs";
export const maxDuration = 30;

const requestSchema = z.object({ submissionId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Yêu cầu phúc khảo không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });

  const { data: submission } = await admin.from("submissions").select("id, user_id, question_id, answer, is_correct, timed_out, match_type, points, score_components").eq("id", parsed.data.submissionId).maybeSingle();
  if (!submission || submission.user_id !== authData.user.id) return NextResponse.json({ error: "Không tìm thấy câu trả lời của bạn" }, { status: 404 });
  if (submission.timed_out) return NextResponse.json({ error: "Không thể phúc khảo câu đã hết giờ" }, { status: 409 });
  if (submission.is_correct) return NextResponse.json({ error: "Câu này đã được chấm đúng" }, { status: 409 });
  const { data: existing } = await admin.from("answer_appeals").select("id, status, reviewed_verdict, explanation_vi, score_delta").eq("submission_id", submission.id).eq("user_id", authData.user.id).maybeSingle();
  if (existing && ["accepted", "rejected"].includes(existing.status)) return NextResponse.json(existing);
  if (existing?.status === "reviewing") return NextResponse.json({ ...existing, message: "Phúc khảo đang được xử lý" }, { status: 202 });

  const [{ data: question }, { data: secret }] = await Promise.all([
    admin.from("questions").select("prompt, instruction, mode, level").eq("id", submission.question_id).single(),
    admin.from("question_answers").select("canonical_answer, accepted_answers, explanation, grading_rules").eq("question_id", submission.question_id).single()
  ]);
  if (!question || !secret) return NextResponse.json({ error: "Thiếu dữ liệu chấm gốc" }, { status: 500 });

  let appealId = existing?.id as string | undefined;
  if (!appealId) {
    const { data: created, error } = await admin.from("answer_appeals").insert({
      submission_id: submission.id,
      user_id: authData.user.id,
      reason: parsed.data.reason,
      status: "reviewing",
      original_verdict: { correct: submission.is_correct, matchType: submission.match_type, points: submission.points, scoreComponents: submission.score_components }
    }).select("id").single();
    if (error || !created) return NextResponse.json({ error: error?.message ?? "Không tạo được phúc khảo" }, { status: 500 });
    appealId = created.id;
  } else await admin.from("answer_appeals").update({ status: "reviewing", reason: parsed.data.reason }).eq("id", appealId);

  let reviewed: Awaited<ReturnType<typeof reviewSemanticAnswer>>;
  try { reviewed = await reviewSemanticAnswer({ mode: question.mode, level: question.level, prompt: question.prompt, instruction: question.instruction, canonicalAnswer: secret.canonical_answer, acceptedAnswers: secret.accepted_answers, explanation: secret.explanation, learnerAnswer: submission.answer, learnerReason: parsed.data.reason }); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "Gemini không xử lý được phúc khảo";
    await admin.from("answer_appeals").update({ status: "failed", explanation_vi: message }).eq("id", appealId);
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const { data: applied, error: applyError } = await admin.rpc("apply_answer_appeal", {
    target_appeal_id: appealId,
    target_verdict: { ...reviewed.verdict, provider: "gemini", model: reviewed.model }
  });
  if (applyError) return NextResponse.json({ error: applyError.message }, { status: 500 });
  return NextResponse.json({ appealId, verdict: applied }, { headers: { "Cache-Control": "private, no-store" } });
}
