import { NextResponse } from "next/server";
import { answerSubmissionSchema } from "@/lib/validation/game";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reviewSemanticAnswer } from "@/lib/ai/semantic-answer-review";
import { recordTelemetry } from "@/lib/observability/telemetry";

export const runtime = "nodejs";
export const maxDuration = 30;

const SEMANTIC_MODES = new Set(["VI_TO_EN", "EN_TO_VI", "CONTEXT", "DEFINITION", "TRANSLATION", "READING", "COLLOCATION", "CLOZE", "ERROR_CORRECTION", "GRAMMAR"]);

export async function POST(request: Request) {
  const parsed = answerSubmissionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid answer submission", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data, error } = await supabase.rpc("submit_answer", { target_question_id: parsed.data.questionId, submitted_answer: parsed.data.answer });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const submissionResult = data as { submissionId?: string; correct?: boolean; timedOut?: boolean; points?: number; alreadySubmitted?: boolean } | null;
  if (submissionResult?.submissionId && submissionResult.correct === false && !submissionResult.timedOut && !submissionResult.alreadySubmitted) {
    const [{ data: question }, { data: secret }] = await Promise.all([
      admin.from("questions").select("mode, level, prompt, instruction").eq("id", parsed.data.questionId).maybeSingle(),
      admin.from("question_answers").select("canonical_answer, accepted_answers, explanation").eq("question_id", parsed.data.questionId).maybeSingle()
    ]);
    if (question && secret && SEMANTIC_MODES.has(question.mode)) {
      try {
        const { data: appeal } = await admin.from("answer_appeals").insert({
          submission_id: submissionResult.submissionId, user_id: authData.user.id, reason: "Tự động kiểm tra đáp án tương đương", status: "reviewing",
          original_verdict: { correct: false, points: submissionResult.points ?? 0, source: "automatic_semantic_review" }
        }).select("id").single();
        if (appeal) {
          const reviewed = await reviewSemanticAnswer({ mode: question.mode, level: question.level, prompt: question.prompt, instruction: question.instruction, canonicalAnswer: secret.canonical_answer, acceptedAnswers: secret.accepted_answers, explanation: secret.explanation, learnerAnswer: parsed.data.answer });
          const { data: applied, error: applyError } = await admin.rpc("apply_answer_appeal", { target_appeal_id: appeal.id, target_verdict: { ...reviewed.verdict, provider: "gemini", model: reviewed.model, automatic: true } });
          if (!applyError && (applied as { accepted?: boolean } | null)?.accepted) {
            return NextResponse.json({ ...submissionResult, correct: true, matchType: "semantic_appeal", semanticReview: applied });
          }
        }
      } catch (semanticError) {
        await recordTelemetry({ name: "grading.semantic_review_failed", severity: "warning", userId: authData.user.id, errorCode: "semantic_review", errorMessage: semanticError instanceof Error ? semanticError.message : "Semantic review failed", metadata: { questionId: parsed.data.questionId } });
      }
    }
  }

  if (parsed.data.answer === "⏱ Hết giờ") {
    if (admin) {
      const { data: q } = await admin.from("questions").select("match_id, time_limit").eq("id", parsed.data.questionId).single();
      if (q) {
        const { data: players } = await admin.from("match_players").select("user_id").eq("match_id", q.match_id);
        const { data: submissions } = await admin.from("submissions").select("user_id").eq("question_id", parsed.data.questionId);
        if (players && submissions && players.length > submissions.length) {
          const submittedIds = new Set(submissions.map((s) => s.user_id));
          const missing = players.filter((p) => !submittedIds.has(p.user_id));
          for (const m of missing) {
            await admin.from("submissions").insert({
              match_id: q.match_id, question_id: parsed.data.questionId, user_id: m.user_id,
              answer: "⏱ Hết giờ", normalized_answer: "⏱ hết giờ", is_correct: false,
              response_ms: q.time_limit * 1000, points: 0
            });
          }
          const { data: match } = await admin.from("matches").select("room_id").eq("id", q.match_id).single();
          if (match) await admin.from("rooms").update({ status: "ROUND_RESULT" }).eq("id", match.room_id);
        }
      }
    }
  }

  return NextResponse.json(data);
}
