import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function normalizeAnswer(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("vi-VN").replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
}

export async function GET(request: Request, { params }: RouteContext<"/api/matches/[matchId]/resolution">) {
  const { matchId } = await params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  // This RLS-protected read proves the caller belongs to the room.
  const { data: match } = await supabase.from("matches").select("current_round, status, room_id, rooms(status)").eq("id", matchId).single();
  const room = Array.isArray(match?.rooms) ? match.rooms[0] : match?.rooms;
  if (!match || !room) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const requestedRoundValue = Number(new URL(request.url).searchParams.get("round") ?? match.current_round);
  const requestedRound = Number.isInteger(requestedRoundValue) ? requestedRoundValue : match.current_round;
  const isPastRound = requestedRound > 0 && requestedRound < match.current_round;
  const isCurrentRevealedRound = requestedRound === match.current_round && ["ROUND_RESULT", "MATCH_RESULT", "AI_REVIEW"].includes(room.status);
  if (requestedRound < 1 || requestedRound > match.current_round || (!isPastRound && !isCurrentRevealedRound && match.status !== "completed")) {
    return NextResponse.json({ error: "Round answers are still private" }, { status: 409 });
  }

  const { data: question } = await admin.from("questions").select("id, time_limit").eq("match_id", matchId).eq("round_number", requestedRound).single();
  if (!question) return NextResponse.json({ error: "Round question not found" }, { status: 404 });
  const [answerResult, submissionsResult] = await Promise.all([
    admin.from("question_answers").select("canonical_answer, accepted_answers, explanation").eq("question_id", question.id).single(),
    admin.from("submissions").select("user_id, answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used, rubric_score, assessment").eq("question_id", question.id).order("server_received_at")
  ]);
  if (answerResult.error || submissionsResult.error) return NextResponse.json({ error: answerResult.error?.message ?? submissionsResult.error?.message }, { status: 500 });

  return NextResponse.json({
    canonicalAnswer: answerResult.data.canonical_answer,
    acceptedAnswers: answerResult.data.accepted_answers,
    explanation: answerResult.data.explanation,
    submissions: (submissionsResult.data ?? []).map((submission) => {
      const accepted = answerResult.data.accepted_answers as string[];
      const answerCorrect = accepted.some((answer) => normalizeAnswer(answer) === normalizeAnswer(submission.answer));
      const timedOut = submission.timed_out || submission.response_ms > question.time_limit * 1000 || submission.answer === "⏱ Hết giờ";
      return {
        userId: submission.user_id,
        answer: submission.answer,
        correct: submission.match_type ? submission.is_correct : answerCorrect,
        timedOut,
        matchType: submission.match_type ?? (answerCorrect ? "accepted" : "incorrect"),
        matchedAnswer: submission.matched_answer,
        responseMs: submission.response_ms,
        points: submission.points,
        hintsUsed: submission.hints_used,
        rubricScore: submission.rubric_score,
        assessment: submission.assessment
      };
    })
  });
}
