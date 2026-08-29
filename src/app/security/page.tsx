import { Activity, Check, KeyRound, LockKeyhole, ShieldCheck, TriangleAlert } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { SiteHeader } from "@/components/site-header";
import { SecurityActions } from "@/components/security/security-actions";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

type SecurityEvent = {
  id: string;
  event_type: string;
  severity: "info" | "warning" | "high" | "critical";
  outcome: "success" | "blocked" | "failed";
  resource_type: string | null;
  occurred_at: string;
};

const eventLabels: Record<string, string> = {
  "auth.session.created": "Đăng nhập thành công",
  "auth.sessions.revoked": "Đã đăng xuất tất cả thiết bị",
  "privacy.preferences.updated": "Đã cập nhật quyền riêng tư",
  "privacy.export.requested": "Đã yêu cầu xuất dữ liệu",
  "privacy.delete.requested": "Đã yêu cầu xóa tài khoản",
  "room.generate.queued": "Đã xếp hàng tạo trận AI",
  "room.generate.denied": "Đã chặn yêu cầu tạo trận trái phép"
};

function dateTime(value: string | null | undefined) {
  if (!value) return "Chưa có";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
}

export default async function SecurityPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const [profileResult, privacyResult, eventsResult, requestsResult, blocksResult] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    supabase.from("privacy_preferences").select("retain_voice_assessments, allow_learning_analytics, allow_social_discovery, updated_at").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_security_events").select("id, event_type, severity, outcome, resource_type, occurred_at").eq("user_id", user.id).order("occurred_at", { ascending: false }).limit(30),
    supabase.from("data_requests").select("id", { count: "exact", head: true }).in("status", ["queued", "processing", "ready"]),
    supabase.from("user_blocks").select("blocked_id", { count: "exact", head: true }).eq("blocker_id", user.id)
  ]);
  const privacy = privacyResult.data;
  const events = (eventsResult.data ?? []) as SecurityEvent[];
  const provider = String(user.app_metadata.provider ?? "email");
  const emailConfirmed = Boolean(user.email_confirmed_at);

  return <>
    <SiteHeader app displayName={profileResult.data?.display_name ?? "Security"} />
    <main className="page-shell security-page">
      <div className="app-container">
        <header className="page-header security-hero">
          <div><span className="eyebrow"><ShieldCheck size={16} /> Security Center</span><h1 className="page-title">Tài khoản và dữ liệu của bạn đang được bảo vệ.</h1><p className="page-lead">Theo dõi phiên đăng nhập, quyền riêng tư và các thao tác nhạy cảm. Nhật ký chỉ hiển thị cho chính bạn.</p></div>
          <div className="security-score"><strong>{emailConfirmed ? "Tốt" : "Cần kiểm tra"}</strong><span>Trạng thái bảo mật</span></div>
        </header>

        <section className="security-posture-grid" aria-label="Security posture">
          <article className="surface security-posture-card"><span className="security-icon"><KeyRound size={20} /></span><div><small>Đăng nhập</small><strong>{provider}</strong><p>{emailConfirmed ? "Email đã xác minh" : "Email chưa xác minh"}</p></div><Check size={20} className={emailConfirmed ? "security-ok" : "security-warn"} /></article>
          <article className="surface security-posture-card"><span className="security-icon"><LockKeyhole size={20} /></span><div><small>Đăng nhập gần nhất</small><strong>{dateTime(user.last_sign_in_at)}</strong><p>Phiên được Supabase xác thực</p></div><Check size={20} className="security-ok" /></article>
          <article className="surface security-posture-card"><span className="security-icon"><Activity size={20} /></span><div><small>Yêu cầu dữ liệu đang mở</small><strong>{requestsResult.count ?? 0}</strong><p>{blocksResult.count ?? 0} tài khoản đã chặn</p></div><Check size={20} className="security-ok" /></article>
        </section>

        <div className="security-content-grid">
          <section className="surface security-panel">
            <div className="security-panel-heading"><div><span className="eyebrow">Privacy posture</span><h2>Ranh giới dữ liệu</h2></div><a className="button button-secondary" href="/profile">Điều chỉnh</a></div>
            <ul className="security-checklist">
              <li><Check size={18} /><div><strong>Âm thanh mặc định không lưu</strong><span>{privacy?.retain_voice_assessments ? "Bạn đang cho phép giữ bản đánh giá giọng nói." : "Chỉ kết quả đánh giá cần thiết được lưu."}</span></div></li>
              <li><Check size={18} /><div><strong>Cá nhân hóa học tập</strong><span>{privacy?.allow_learning_analytics === false ? "Đã tắt theo lựa chọn của bạn." : "Đang bật để tạo bài học phù hợp."}</span></div></li>
              <li><Check size={18} /><div><strong>Khám phá xã hội</strong><span>{privacy?.allow_social_discovery === false ? "Hồ sơ không xuất hiện trong tìm kiếm." : "Bạn bè có thể tìm thấy hồ sơ."}</span></div></li>
            </ul>
          </section>

          <section className="surface security-panel">
            <div className="security-panel-heading"><div><span className="eyebrow">Private audit trail</span><h2>Hoạt động bảo mật</h2></div><span className="security-retention">Lưu 180 ngày</span></div>
            {events.length ? <ol className="security-event-list">{events.map((event) => <li key={event.id}><span className={`security-event-dot ${event.severity}`} /><div><strong>{eventLabels[event.event_type] ?? event.event_type}</strong><span>{dateTime(event.occurred_at)}{event.resource_type ? ` · ${event.resource_type}` : ""}</span></div><em className={`security-outcome ${event.outcome}`}>{event.outcome}</em></li>)}</ol> : <div className="security-empty"><ShieldCheck size={28} /><p>Nhật ký sẽ xuất hiện sau các thao tác bảo mật tiếp theo. Không có dữ liệu mẫu.</p></div>}
          </section>
        </div>

        {!emailConfirmed && <aside className="surface security-alert"><TriangleAlert size={22} /><div><strong>Hãy xác minh email</strong><p>Mở email từ nhà cung cấp đăng nhập để hoàn tất lớp bảo vệ tài khoản.</p></div></aside>}
        <section className="surface security-session-control"><div><span className="eyebrow">Session control</span><h2>Thiết bị đăng nhập</h2><p>Nếu nghi ngờ tài khoản bị truy cập, hãy thu hồi toàn bộ refresh token và đăng nhập lại trên thiết bị tin cậy.</p></div><SecurityActions /></section>
      </div>
    </main>
  </>;
}
