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
  return NextResponse.json(data);
}
