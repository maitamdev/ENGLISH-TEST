import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

type LearningQuestion = { id: string; mode: string; prompt: string };
type LearningSubmission = { user_id: string; question_id: string; is_correct: boolean };

async function updateLearningHistory(admin: SupabaseClient, matchId: string, topic: string) {
  const [playersResult, questionsResult, submissionsResult] = await Promise.all([
    admin.from("match_players").select("user_id").eq("match_id", matchId),
    admin.from("questions").select("id, mode, prompt").eq("match_id", matchId),
    admin.from("submissions").select("user_id, question_id, is_correct").eq("match_id", matchId)
  ]);
  if (playersResult.error || questionsResult.error || submissionsResult.error) throw playersResult.error ?? questionsResult.error ?? submissionsResult.error;
  const questions = (questionsResult.data ?? []) as LearningQuestion[];
  const submissions = (submissionsResult.data ?? []) as LearningSubmission[];
  const { data: answerRows, error: answerError } = await admin.from("question_answers").select("question_id, canonical_answer").in("question_id", questions.map((question) => question.id));
  if (answerError) throw answerError;

  const scoreFields: Record<string, string> = {
    GRAMMAR: "grammar_score", ERROR_CORRECTION: "grammar_score", CLOZE: "grammar_score", SENTENCE_BUILDER: "grammar_score",
    LISTENING: "listening_score", AUDIO_CHOICE: "listening_score", STORY_LISTENING: "listening_score", MINIMAL_PAIRS: "listening_score", SPELLING: "spelling_score",
    TRANSLATION: "translation_score", VI_TO_EN: "vocabulary_score", EN_TO_VI: "vocabulary_score",
    CONTEXT: "vocabulary_score", DEFINITION: "vocabulary_score", BOSS: "vocabulary_score",
    MULTIPLE_CHOICE: "vocabulary_score", READING: "reading_score", PRONUNCIATION: "pronunciation_score",
    SHADOWING: "pronunciation_score", SPEAKING: "speaking_score", ROLEPLAY: "speaking_score", DEBATE: "speaking_score", WRITING: "writing_score",
    COLLOCATION: "vocabulary_score"
  };
  const today = new Date();
  const todayDate = today.toISOString().slice(0, 10);

  for (const player of playersResult.data ?? []) {
    const { data: priorUpdate } = await admin.from("match_learning_updates").select("match_id").eq("match_id", matchId).eq("user_id", player.user_id).maybeSingle();
    if (priorUpdate) continue;
    const mine = submissions.filter((submission) => submission.user_id === player.user_id);
    const grouped = new Map<string, { correct: number; total: number }>();
    for (const submission of mine) {
      const question = questions.find((item) => item.id === submission.question_id);
      const field = question ? scoreFields[question.mode] : undefined;
      if (field) {
        const current = grouped.get(field) ?? { correct: 0, total: 0 };
        current.total += 1; current.correct += submission.is_correct ? 1 : 0; grouped.set(field, current);
      }
      if (!question || !["VI_TO_EN", "EN_TO_VI", "CONTEXT", "DEFINITION", "BOSS"].includes(question.mode)) continue;
      const answer = answerRows?.find((item) => item.question_id === question.id)?.canonical_answer;
      if (!answer) continue;
      const { data: existing } = await admin.from("user_vocabulary").select("correct_count, wrong_count").eq("user_id", player.user_id).eq("word", answer).maybeSingle();
      const correctCount = (existing?.correct_count ?? 0) + (submission.is_correct ? 1 : 0);
      const wrongCount = (existing?.wrong_count ?? 0) + (submission.is_correct ? 0 : 1);
      const nextReview = new Date(today.getTime() + (submission.is_correct ? 7 : 1) * 86_400_000).toISOString();
      await admin.from("user_vocabulary").upsert({
        user_id: player.user_id, word: answer, meaning: question.prompt, topic,
        correct_count: correctCount, wrong_count: wrongCount,
        mastery: Math.round((correctCount / (correctCount + wrongCount)) * 10000) / 100,
        last_seen: today.toISOString(), next_review_at: nextReview
      });
    }

    const { data: previous } = await admin.from("user_learning_stats").select("current_streak_days, last_practice_date, vocabulary_score, grammar_score, listening_score, spelling_score, translation_score, reading_score, speaking_score, pronunciation_score, writing_score").eq("user_id", player.user_id).single();
    let streak = 1;
    if (previous?.last_practice_date === todayDate) streak = previous.current_streak_days;
    else if (previous?.last_practice_date) {
      const prior = new Date(`${previous.last_practice_date}T00:00:00Z`);
      const current = new Date(`${todayDate}T00:00:00Z`);
      if ((current.getTime() - prior.getTime()) / 86_400_000 === 1) streak = previous.current_streak_days + 1;
    }
    const scores = Object.fromEntries([...grouped].map(([field, value]) => {
      const matchScore = Math.round(value.correct / value.total * 100);
      const oldScore = previous?.[field as keyof typeof previous];
      return [field, typeof oldScore === "number" ? Math.round(oldScore * 0.7 + matchScore * 0.3) : matchScore];
    }));
    await admin.from("user_learning_stats").upsert({ user_id: player.user_id, ...scores, current_streak_days: streak, last_practice_date: todayDate, updated_at: today.toISOString() });
    const { error: ledgerError } = await admin.from("match_learning_updates").insert({ match_id: matchId, user_id: player.user_id });
    if (ledgerError && ledgerError.code !== "23505") throw ledgerError;
  }
}

export async function POST(request: Request, { params }: RouteContext<"/api/matches/[matchId]/advance">) {
  const { matchId } = await params;
  const idempotencyKey = z.string().uuid().safeParse(request.headers.get("idempotency-key"));
  if (!idempotencyKey.success) return NextResponse.json({ error: "A valid idempotency key is required" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data: match } = await supabase.from("matches").select("room_id, topic, status, current_round, round_count, blueprint, rooms(host_id, status)").eq("id", matchId).single();
  const room = Array.isArray(match?.rooms) ? match?.rooms[0] : match?.rooms;
  if (!match || !room || room.host_id !== authData.user.id) return NextResponse.json({ error: "Only the room host can advance the match" }, { status: 403 });
  if (match.status !== "active") return NextResponse.json({ error: "Match is not active" }, { status: 409 });
  if (room.status !== "ROUND_RESULT") return NextResponse.json({ error: "Both players must submit before advancing" }, { status: 409 });
  const { data: readyMembers } = await admin.from("room_members").select("is_ready").eq("room_id", match.room_id);
  if (!readyMembers || readyMembers.length !== 2 || readyMembers.some((member) => !member.is_ready)) {
    return NextResponse.json({ error: "Both players must confirm before advancing" }, { status: 409 });
  }

  if (match.current_round >= match.round_count) {
    const { data: players } = await admin.from("match_players").select("user_id, score").eq("match_id", matchId).order("score", { ascending: false });
    const cooperative = (match.blueprint as { settings?: { experience?: string } })?.settings?.experience === "COOP";
    const winnerId = !cooperative && players && players.length > 1 && players[0].score !== players[1].score ? players[0].user_id : null;
    const { error: ratingError } = await admin.rpc("finalize_match_ratings", { target_match_id: matchId });
    if (ratingError) return NextResponse.json({ error: ratingError.message }, { status: 500 });
    try { await updateLearningHistory(admin, matchId, match.topic); }
    catch (learningError) { return NextResponse.json({ error: learningError instanceof Error ? learningError.message : "Could not update learning history" }, { status: 500 }); }
    const { error } = await admin.from("matches").update({ status: "completed", winner_id: winnerId, ended_at: new Date().toISOString() }).eq("id", matchId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await admin.from("room_members").update({ is_ready: false }).eq("room_id", match.room_id);
    await admin.from("rooms").update({ status: "MATCH_RESULT" }).eq("id", match.room_id);
    return NextResponse.json({ completed: true, winnerId });
  }

  const nextRound = match.current_round + 1;
  const { data: schedule, error } = await supabase.rpc("schedule_match_round", {
    target_match_id: matchId,
    target_round: nextRound,
    target_idempotency_key: idempotencyKey.data,
    lead_time_ms: 3000
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { error: resetError } = await admin.from("room_members").update({ is_ready: false }).eq("room_id", match.room_id);
  if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });
  return NextResponse.json({ completed: false, currentRound: nextRound, schedule });
}
