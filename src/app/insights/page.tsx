import { BarChart3 } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { ArenaInsightsExperience } from "@/components/insights/arena-insights-experience";
import { SiteHeader } from "@/components/site-header";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const { configured, user } = await requireAuthenticatedUser();
  const admin = createSupabaseAdminClient();
  if (!configured || !user || !admin) return <ConfigRequired />;
  const [{ data: profile }, { data: friendships }, { data: blocks }] = await Promise.all([
    admin.from("profiles").select("display_name").eq("id", user.id).single(),
    admin.from("friendships").select("requester_id, addressee_id").eq("status", "accepted").or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
    admin.from("user_blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`)
  ]);
  const blocked = new Set((blocks ?? []).map((item) => item.blocker_id === user.id ? item.blocked_id : item.blocker_id));
  const peerIds = [...new Set((friendships ?? []).map((item) => item.requester_id === user.id ? item.addressee_id : item.requester_id).filter((id) => !blocked.has(id)))];
  const { data: peers } = peerIds.length ? await admin.from("profiles").select("id, display_name, avatar_url").in("id", peerIds).order("display_name") : { data: [] };
  return <><SiteHeader app displayName={profile?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><span className="eyebrow"><BarChart3 size={15} /> ARENA INSIGHTS</span><h1 className="page-title">Hai người đang tiến bộ thế nào?</h1><p className="page-lead">So sánh đối đầu từ match, submission, fairness và reconnect thật. Không đọc mastery riêng của người còn lại.</p></div></header><ArenaInsightsExperience peers={(peers ?? []).map((peer) => ({ id: peer.id, displayName: peer.display_name, avatarUrl: peer.avatar_url }))} /></div></main></>;
}
