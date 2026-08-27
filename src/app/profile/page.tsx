import { Avatar } from "@/components/avatar";
import { ConfigRequired } from "@/components/config-required";
import { ProfileForm } from "@/components/profile-form";
import { SiteHeader } from "@/components/site-header";
import { getDashboardData } from "@/lib/data/dashboard";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const data = await getDashboardData(supabase, user.id);
  return <><SiteHeader app displayName={data.profile.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><h1 className="page-title">Profile and audio.</h1><p className="page-lead">Your profile and learning totals are stored in Supabase.</p></div></header><div className="profile-grid"><section className="surface profile-identity"><Avatar name={data.profile.display_name} src={data.profile.avatar_url ?? undefined} size={118} /><h2>{data.profile.display_name}</h2><p>CEFR estimate: {data.profile.cefr_estimate ?? "Not measured"}</p><div className="profile-stats"><div className="profile-stat"><strong>{data.totalMatches}</strong><span>Matches</span></div><div className="profile-stat"><strong>{data.winCount}</strong><span>Wins</span></div><div className="profile-stat"><strong>{data.masteredWords}</strong><span>Words</span></div></div></section><section className="surface settings-panel"><ProfileForm userId={user.id} displayName={data.profile.display_name} username={data.profile.username} /><div className="settings-section"><h3>Voice devices</h3><p className="text-muted">Microphone and speaker choices are device-local browser preferences, not learning data.</p></div></section></div></div></main></>;
}
