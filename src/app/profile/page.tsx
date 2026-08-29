import { Avatar } from "@/components/avatar";
import { ConfigRequired } from "@/components/config-required";
import { ProfileForm } from "@/components/profile-form";
import { PrivacyControls } from "@/components/privacy/privacy-controls";
import { SiteHeader } from "@/components/site-header";
import { getDashboardData } from "@/lib/data/dashboard";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const data = await getDashboardData(supabase, user.id);
  const [privacyResult, requestsResult] = await Promise.all([
    supabase.from("privacy_preferences").select("retain_voice_assessments, allow_learning_analytics, allow_social_discovery, allow_authorized_content_contribution").eq("user_id", user.id).maybeSingle(),
    supabase.from("data_requests").select("id, request_type, status, requested_at, completed_at, expires_at, error_message").order("requested_at", { ascending: false }).limit(10)
  ]);
  const preferences = privacyResult.data ?? { retain_voice_assessments: false, allow_learning_analytics: true, allow_social_discovery: true, allow_authorized_content_contribution: false };
  return <><SiteHeader app displayName={data.profile.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><h1 className="page-title">Hồ sơ, giọng nói và dữ liệu.</h1><p className="page-lead">Bạn quyết định dữ liệu nào được dùng để cá nhân hóa việc học.</p></div></header><div className="profile-grid"><section className="surface profile-identity"><Avatar name={data.profile.display_name} src={data.profile.avatar_url ?? undefined} size={118} /><h2>{data.profile.display_name}</h2><p>CEFR: {data.profile.cefr_estimate ?? "Chưa đo"}</p><div className="profile-stats"><div className="profile-stat"><strong>{data.totalMatches}</strong><span>Trận</span></div><div className="profile-stat"><strong>{data.winCount}</strong><span>Thắng</span></div><div className="profile-stat"><strong>{data.masteredWords}</strong><span>Từ</span></div></div></section><section className="surface settings-panel"><ProfileForm userId={user.id} displayName={data.profile.display_name} username={data.profile.username} /><div className="settings-section"><h3>Thiết bị giọng nói</h3><p className="text-muted">Micro và loa được lưu cục bộ trong trình duyệt, không phải dữ liệu học tập.</p></div><PrivacyControls initialPreferences={preferences} initialRequests={(requestsResult.data ?? []) as never[]} /></section></div></div></main></>;
}
