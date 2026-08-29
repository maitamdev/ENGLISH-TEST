import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: match } = await supabase.from("matches").select("room_id, status, current_round, round_started_at, rooms(host_id, status)").eq("id", matchId).single();
  const room = Array.isArray(match?.rooms) ? match.rooms[0] : match?.rooms;
  if (!match || !room || room.host_id !== authData.user.id) return NextResponse.json({ error: "Only the host can force resolution" }, { status: 403 });
  if (match.status !== "active" || room.status !== "ROUND_ACTIVE") return NextResponse.json({ error: "Round is not active" }, { status: 409 });

  const { data: q } = await admin.from("questions").select("id, time_limit, mode").eq("match_id", matchId).eq("round_number", match.current_round).single();
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  const deadline = new Date(match.round_started_at ?? 0).getTime() + q.time_limit * 1000;
  const spokenGrace = ["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE", "WRITING"].includes(q.mode) ? 15_000 : 2000;
  if (!match.round_started_at || Date.now() < deadline + spokenGrace) return NextResponse.json({ error: "The round deadline has not passed" }, { status: 409 });

  const { data: players } = await admin.from("match_players").select("user_id, current_streak, correct_count, incorrect_count, avg_response_ms").eq("match_id", matchId);
  const { data: submissions } = await admin.from("submissions").select("user_id").eq("question_id", q.id);

  if (players && submissions && players.length > submissions.length) {
    const submittedIds = new Set(submissions.map((s) => s.user_id));
    const missing = players.filter((p) => !submittedIds.has(p.user_id));
    for (const m of missing) {
      await admin.from("submissions").insert({
        match_id: matchId, question_id: q.id, user_id: m.user_id,
        answer: "⏱ Hết giờ", normalized_answer: "⏱ hết giờ", is_correct: false,
        timed_out: true, match_type: "incorrect",
        response_ms: q.time_limit * 1000, points: 0
      });
      const totalBefore = m.correct_count + m.incorrect_count;
      await admin.from("match_players").update({
        current_streak: 0,
        incorrect_count: m.incorrect_count + 1,
        avg_response_ms: Math.round((((m.avg_response_ms ?? 0) * totalBefore) + q.time_limit * 1000) / (totalBefore + 1))
      }).eq("match_id", matchId).eq("user_id", m.user_id);
    }
  }

  const { error } = await admin.from("rooms").update({ status: "ROUND_RESULT" }).eq("id", match.room_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
