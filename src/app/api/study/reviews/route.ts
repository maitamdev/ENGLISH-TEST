import { NextResponse } from "next/server";
import { z } from "zod";
import { fsrs, generatorParameters, type Card, type Grade } from "ts-fsrs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  cardId: z.string().uuid(),
  requestId: z.string().uuid(),
  rating: z.number().int().min(1).max(4),
  durationMs: z.number().int().min(0).max(3_600_000).optional()
});

const DEFAULT_FSRS_PARAMETERS = [0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542];

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const [cardsResult, profileResult, dueCountResult] = await Promise.all([
    supabase.from("review_cards").select("id, card_key, skill, front, back, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review_at").is("suspended_at", null).lte("due_at", new Date().toISOString()).order("due_at").limit(30),
    supabase.from("fsrs_profiles").select("algorithm_version, desired_retention, parameters, maximum_interval").eq("user_id", authData.user.id).maybeSingle(),
    supabase.from("review_cards").select("id", { count: "exact", head: true }).is("suspended_at", null).lte("due_at", new Date().toISOString())
  ]);
  if (cardsResult.error || profileResult.error || dueCountResult.error) return NextResponse.json({ error: cardsResult.error?.message ?? profileResult.error?.message ?? dueCountResult.error?.message }, { status: 500 });
  return NextResponse.json({ cards: cardsResult.data ?? [], dueCount: dueCountResult.count ?? 0, profile: profileResult.data ?? { algorithm_version: "FSRS-6", desired_retention: 0.9, parameters: DEFAULT_FSRS_PARAMETERS, maximum_interval: 36500 } }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = reviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Lượt ôn tập không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const [{ data: row, error: cardError }, { data: profile }] = await Promise.all([
    supabase.from("review_cards").select("id, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review_at").eq("id", parsed.data.cardId).eq("user_id", authData.user.id).maybeSingle(),
    supabase.from("fsrs_profiles").select("desired_retention, parameters, maximum_interval").eq("user_id", authData.user.id).maybeSingle()
  ]);
  if (cardError || !row) return NextResponse.json({ error: cardError?.message ?? "Không tìm thấy thẻ ôn tập" }, { status: 404 });
  const parameters = Array.isArray(profile?.parameters) && profile.parameters.length === 21 ? profile.parameters as number[] : DEFAULT_FSRS_PARAMETERS;
  const scheduler = fsrs(generatorParameters({ request_retention: Number(profile?.desired_retention ?? 0.9), maximum_interval: profile?.maximum_interval ?? 36500, w: parameters, enable_fuzz: true, enable_short_term: true }));
  const card: Card = {
    due: new Date(row.due_at), stability: Number(row.stability), difficulty: Number(row.difficulty),
    elapsed_days: row.elapsed_days, scheduled_days: row.scheduled_days, reps: row.reps, lapses: row.lapses,
    learning_steps: row.learning_steps, state: row.state, last_review: row.last_review_at ? new Date(row.last_review_at) : undefined
  } as Card;
  const result = scheduler.next(card, new Date(), parsed.data.rating as Grade);
  const nextCard = {
    due: result.card.due.toISOString(), stability: result.card.stability, difficulty: result.card.difficulty,
    elapsed_days: result.card.elapsed_days, scheduled_days: result.card.scheduled_days, reps: result.card.reps,
    lapses: result.card.lapses, learning_steps: result.card.learning_steps, state: result.card.state,
    last_review: result.card.last_review?.toISOString() ?? ""
  };
  const log = {
    state: result.log.state, due: result.log.due.toISOString(), stability: result.log.stability,
    difficulty: result.log.difficulty, elapsed_days: result.log.elapsed_days,
    last_elapsed_days: result.log.last_elapsed_days, scheduled_days: result.log.scheduled_days,
    review: result.log.review.toISOString()
  };
  const { data, error } = await supabase.rpc("record_fsrs_review", { target_card_id: row.id, target_request_id: parsed.data.requestId, target_rating: parsed.data.rating, target_card: nextCard, target_log: log, target_duration_ms: parsed.data.durationMs ?? null });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ...data, card: nextCard }, { headers: { "Cache-Control": "private, no-store" } });
}
