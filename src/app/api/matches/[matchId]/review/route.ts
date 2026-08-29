import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: match } = await admin.from("matches")
    .select("id, room_id, title, topic, level, status, round_count, started_at, ended_at, blueprint")
    .eq("id", matchId)
    .maybeSingle();
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const { data: membership } = await admin.from("room_members")
    .select("user_id")
    .eq("room_id", match.room_id)
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "Only players in this match can review it" }, { status: 403 });
  if (match.status !== "completed") return NextResponse.json({ error: "The match must finish before review" }, { status: 409 });

  const [playersResult, questionsResult] = await Promise.all([
    admin.from("match_players").select("user_id, score, correct_count, incorrect_count, avg_response_ms, profiles(display_name, avatar_url)").eq("match_id", matchId),
    admin.from("questions").select("id, round_number, mode, prompt, instruction, time_limit, public_payload, learning_content(id, license_id, attribution, learning_sources(display_name, homepage_url, license_url))").eq("match_id", matchId).order("round_number")
  ]);
  if (playersResult.error || questionsResult.error) {
    return NextResponse.json({ error: playersResult.error?.message ?? questionsResult.error?.message }, { status: 500 });
  }

  const questions = questionsResult.data ?? [];
  const questionIds = questions.map((question) => question.id);
  const [answersResult, submissionsResult] = questionIds.length === 0
    ? [{ data: [], error: null }, { data: [], error: null }]
    : await Promise.all([
      admin.from("question_answers").select("question_id, canonical_answer, accepted_answers, explanation, grading_rules").in("question_id", questionIds),
      admin.from("submissions").select("question_id, user_id, answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used, rubric_score, assessment, score_components").in("question_id", questionIds)
    ]);
  if (answersResult.error || submissionsResult.error) {
    return NextResponse.json({ error: answersResult.error?.message ?? submissionsResult.error?.message }, { status: 500 });
  }

  const players = (playersResult.data ?? []).map((player) => {
    const profile = Array.isArray(player.profiles) ? player.profiles[0] : player.profiles;
    return {
      userId: player.user_id,
      displayName: profile?.display_name ?? "Người chơi",
      avatarUrl: profile?.avatar_url ?? null,
      score: player.score,
      correctCount: player.correct_count,
      incorrectCount: player.incorrect_count,
      avgResponseMs: player.avg_response_ms
    };
  });

  const blueprint = match.blueprint as { settings?: { showTranscriptAfter?: boolean } } | null;
  const showTranscript = blueprint?.settings?.showTranscriptAfter !== false;

  return NextResponse.json({
    match: {
      id: match.id,
      title: match.title,
      topic: match.topic,
      level: match.level,
      rounds: match.round_count,
      startedAt: match.started_at,
      endedAt: match.ended_at
    },
    players,
    rounds: questions.map((question) => {
      const answer = (answersResult.data ?? []).find((item) => item.question_id === question.id);
      return {
        id: question.id,
        round: question.round_number,
        mode: question.mode,
        prompt: question.prompt,
        instruction: question.instruction,
        timeLimit: question.time_limit,
        publicData: {
          ...(question.public_payload as Record<string, unknown> ?? {}),
          ...(showTranscript && (answer?.grading_rules as Record<string, unknown> | null)?.audioText
            ? { audioText: (answer?.grading_rules as Record<string, unknown>).audioText }
            : {})
        },
        canonicalAnswer: answer?.canonical_answer ?? "",
        acceptedAnswers: answer?.accepted_answers ?? [],
        explanation: answer?.explanation ?? "",
        source: question.learning_content ?? null,
        submissions: (submissionsResult.data ?? []).filter((item) => item.question_id === question.id).map((submission) => ({
          userId: submission.user_id,
          answer: submission.answer,
          correct: submission.is_correct,
          timedOut: submission.timed_out,
          matchedAnswer: submission.matched_answer,
          matchType: submission.match_type,
          responseMs: submission.response_ms,
          points: submission.points,
          hintsUsed: submission.hints_used,
          rubricScore: submission.rubric_score,
          assessment: submission.assessment,
          scoreComponents: submission.score_components
        }))
      };
    })
  }, { headers: { "Cache-Control": "private, no-store" } });
}
