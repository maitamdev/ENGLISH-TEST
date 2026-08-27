import { NextResponse } from "next/server";
import { answerSubmissionSchema } from "@/lib/validation/game";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const parsed = answerSubmissionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid answer submission", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data, error } = await supabase.rpc("submit_answer", { target_question_id: parsed.data.questionId, submitted_answer: parsed.data.answer });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  if (parsed.data.answer === "⏱ Hết giờ") {
    const admin = await import("@/lib/supabase/admin").then((m) => m.createSupabaseAdminClient());
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
