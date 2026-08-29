import { Activity } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { ProgressDashboard } from "@/components/progress/progress-dashboard";
import { SiteHeader } from "@/components/site-header";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function ProgressPage({ searchParams }: { searchParams: Promise<{ matchId?: string }> }) {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const params = await searchParams;
  const [profile, mastery, evidence, placement, recaps, due, preferences] = await Promise.all([
    supabase.from("profiles").select("display_name, cefr_estimate").eq("id", user.id).single(),
    supabase.from("learner_skill_mastery").select("skill, mastery_score, confidence, evidence_count, cefr_evidence, latest_score, last_evidence_at").eq("user_id", user.id).order("mastery_score", { ascending: false }),
    supabase.from("skill_evidence_events").select("id, skill, cefr_level, score, source_type, metadata, occurred_at").eq("user_id", user.id).order("occurred_at", { ascending: false }).limit(40),
    supabase.from("placement_sessions").select("id, estimated_cefr, confidence, standard_error, response_count, result, completed_at").eq("user_id", user.id).eq("status", "completed").order("completed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("match_recaps").select("match_id, summary_vi, strengths, needs_work, next_actions, algorithm_version, created_at").order("created_at", { ascending: false }).limit(12),
    supabase.from("review_cards").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("suspended_at", null).lte("due_at", new Date().toISOString()),
    supabase.from("notification_preferences").select("review_due, shared_goal_reminders, room_invites, quiet_hours_start, quiet_hours_end, timezone").eq("user_id", user.id).maybeSingle()
  ]);
  return <><SiteHeader app displayName={profile.data?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><span className="eyebrow"><Activity size={15} /> EVIDENCE-BASED PROGRESS</span><h1 className="page-title">Tiến bộ có thể kiểm chứng.</h1><p className="page-lead">Mastery, confidence và khuyến nghị đều truy ngược được về trận, bài nói, placement hoặc lượt FSRS thật.</p></div></header><ProgressDashboard profile={{ cefr: profile.data?.cefr_estimate ?? null }} mastery={mastery.data ?? []} evidence={evidence.data ?? []} placement={placement.data ?? null} recaps={recaps.data ?? []} dueCount={due.count ?? 0} requestedMatchId={params.matchId ?? null} preferences={preferences.data ?? null} /></div></main></>;
}
