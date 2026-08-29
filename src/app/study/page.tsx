import { Clock3 } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { SiteHeader } from "@/components/site-header";
import { StudyHub } from "@/components/study/study-hub";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function StudyPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const [profileResult, cardsResult, countResult, errorsResult, planResult] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).single(),
    supabase.from("review_cards").select("id, skill, front, back, due_at, reps, lapses").is("suspended_at", null).lte("due_at", new Date().toISOString()).order("due_at").limit(30),
    supabase.from("review_cards").select("id", { count: "exact", head: true }).is("suspended_at", null).lte("due_at", new Date().toISOString()),
    supabase.from("learning_errors").select("id, error_type, skill, prompt, learner_answer, expected_answer, explanation, occurrence_count, last_seen_at").is("resolved_at", null).order("occurrence_count", { ascending: false }).limit(50),
    supabase.from("study_plans").select("id, title, cefr_start, cefr_target, rationale_vi, weekly_minutes, starts_on, ends_on").eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  const plan = planResult.data;
  const itemsResult = plan ? await supabase.from("study_plan_items").select("id, sequence_number, skill, activity_type, title, objective, target_minutes, target_count, due_on, completed_at").eq("plan_id", plan.id).order("sequence_number") : { data: [] };
  return <><SiteHeader app displayName={profileResult.data?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><span className="eyebrow"><Clock3 size={15} /> LEARNING SYSTEM</span><h1 className="page-title">Học từ chính những gì bạn đã làm.</h1><p className="page-lead">FSRS, Error Notebook và lộ trình AI đều đọc dữ liệu thật trong Supabase. Không có thẻ hay tiến độ mẫu.</p></div></header><StudyHub initialCards={cardsResult.data ?? []} dueCount={countResult.count ?? 0} errors={errorsResult.data ?? []} plan={plan ?? null} planItems={itemsResult.data ?? []} /></div></main></>;
}
