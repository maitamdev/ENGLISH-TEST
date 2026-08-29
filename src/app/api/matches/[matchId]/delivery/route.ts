import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deliverySchema = z.object({
  questionId: z.string().uuid(),
  clientSessionId: z.string().uuid(),
  phase: z.enum(["received", "rendered", "input_enabled", "audio_ready", "answer_sent"]),
  clientReportedAt: z.string().datetime().optional(),
  metrics: z.object({
    clockOffsetMs: z.number().finite().min(-60_000).max(60_000).optional(),
    clockRttMs: z.number().finite().min(0).max(60_000).optional(),
    realtimeState: z.string().max(40).optional(),
    webrtcState: z.string().max(40).optional(),
    visibility: z.enum(["visible", "hidden", "prerender", "unloaded"]).optional(),
    effectiveType: z.string().max(20).optional()
  }).default({})
});

export async function POST(request: Request, context: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await context.params;
  const parsed = deliverySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid delivery receipt", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: question } = await supabase.from("questions").select("id").eq("id", parsed.data.questionId).eq("match_id", matchId).maybeSingle();
  if (!question) return NextResponse.json({ error: "Question does not belong to this match" }, { status: 404 });
  const { data, error } = await supabase.rpc("acknowledge_question_delivery", {
    target_question_id: parsed.data.questionId,
    target_client_session_id: parsed.data.clientSessionId,
    target_phase: parsed.data.phase,
    target_client_reported_at: parsed.data.clientReportedAt ?? null,
    target_metrics: parsed.data.metrics
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request, context: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await context.params;
  const questionId = new URL(request.url).searchParams.get("questionId");
  if (!questionId || !z.string().uuid().safeParse(questionId).success) return NextResponse.json({ error: "Valid questionId required" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data, error } = await supabase.from("question_fairness_assessments")
    .select("question_id, participant_count, render_skew_ms, input_skew_ms, max_clock_rtt_ms, hidden_participant_count, decision, reasons, assessed_at")
    .eq("question_id", questionId).eq("match_id", matchId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ assessment: data ?? null }, { headers: { "Cache-Control": "private, no-store" } });
}
