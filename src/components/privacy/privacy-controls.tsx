"use client";

import { useState } from "react";
import { Download, LoaderCircle, Save, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

type Preferences = { retain_voice_assessments: boolean; allow_learning_analytics: boolean; allow_social_discovery: boolean; allow_authorized_content_contribution: boolean };
type DataRequest = { id: string; request_type: "export" | "delete"; status: string; requested_at: string; completed_at: string | null; expires_at: string | null; error_message: string | null };

export function PrivacyControls({ initialPreferences, initialRequests }: { initialPreferences: Preferences; initialRequests: DataRequest[] }) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [requests, setRequests] = useState(initialRequests);
  const [busy, setBusy] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function save() {
    setBusy("save");
    try {
      const response = await fetch("/api/privacy", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retainVoiceAssessments: preferences.retain_voice_assessments, allowLearningAnalytics: preferences.allow_learning_analytics, allowSocialDiscovery: preferences.allow_social_discovery, allowAuthorizedContentContribution: preferences.allow_authorized_content_contribution }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Không lưu được thiết lập");
      toast.success("Đã lưu quyền riêng tư.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không lưu được thiết lập"); }
    finally { setBusy(""); }
  }

  async function createRequest(requestType: "export" | "delete") {
    setBusy(requestType);
    try {
      const response = await fetch("/api/privacy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType, confirmation: requestType === "delete" ? confirmation : undefined }) });
      const body = await response.json().catch(() => ({})) as DataRequest & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Không tạo được yêu cầu");
      setRequests((current) => [body, ...current]);
      toast.success(requestType === "export" ? "Đã xếp hàng tạo bản dữ liệu." : "Đã xếp hàng xóa tài khoản.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tạo được yêu cầu"); }
    finally { setBusy(""); }
  }

  function toggle(key: keyof Preferences) { setPreferences((current) => ({ ...current, [key]: !current[key] })); }

  return <div className="settings-section privacy-controls">
    <div className="panel-heading"><div><span className="eyebrow"><ShieldCheck size={14} /> PRIVACY</span><h3>Dữ liệu của bạn</h3></div></div>
    <div className="privacy-toggles">
      <PrivacyToggle label="Giữ kết quả chấm giọng nói" description="Chỉ giữ transcript và rubric. Audio micro vẫn không được lưu." checked={preferences.retain_voice_assessments} onChange={() => toggle("retain_voice_assessments")} />
      <PrivacyToggle label="Phân tích học tập cá nhân" description="Cho phép Error Notebook, FSRS và AI Study Plan dùng hoạt động của bạn." checked={preferences.allow_learning_analytics} onChange={() => toggle("allow_learning_analytics")} />
      <PrivacyToggle label="Tìm thấy trong cộng đồng" description="Cho phép người khác tìm bạn bằng username chính xác." checked={preferences.allow_social_discovery} onChange={() => toggle("allow_social_discovery")} />
      <PrivacyToggle label="Đóng góp nội dung đã cho phép" description="Chỉ dùng khi bạn chủ động cấp quyền và cung cấp bằng chứng quyền sử dụng." checked={preferences.allow_authorized_content_contribution} onChange={() => toggle("allow_authorized_content_contribution")} />
    </div>
    <button className="button button-primary" onClick={() => void save()} disabled={busy === "save"}>{busy === "save" ? <LoaderCircle className="animate-spin" size={17} /> : <Save size={17} />} Lưu quyền riêng tư</button>
    <div className="data-actions">
      <div><h4>Xuất dữ liệu</h4><p>Tạo tệp JSON từ dữ liệu thật của tài khoản. Liên kết tải riêng tư hết hạn sau 7 ngày.</p><button className="button button-secondary" disabled={busy === "export"} onClick={() => void createRequest("export")}>{busy === "export" ? <LoaderCircle className="animate-spin" size={17} /> : <Download size={17} />} Tạo bản xuất</button></div>
      <div className="danger-zone"><h4>Xóa tài khoản</h4><p>Xóa tài khoản và dữ liệu liên quan là không thể hoàn tác. Nhập <strong>XOA TAI KHOAN</strong> để xác nhận.</p><input className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="XOA TAI KHOAN" /><button className="button button-danger" disabled={busy === "delete" || confirmation !== "XOA TAI KHOAN"} onClick={() => void createRequest("delete")}>{busy === "delete" ? <LoaderCircle className="animate-spin" size={17} /> : <Trash2 size={17} />} Xếp hàng xóa</button></div>
    </div>
    {requests.length ? <div className="data-request-list"><h4>Yêu cầu gần đây</h4>{requests.map((request) => <article key={request.id}><div><strong>{request.request_type === "export" ? "Xuất dữ liệu" : "Xóa tài khoản"}</strong><span>{new Intl.DateTimeFormat("vi", { dateStyle: "medium", timeStyle: "short" }).format(new Date(request.requested_at))}</span>{request.error_message ? <small>{request.error_message}</small> : null}</div><b className={`request-status ${request.status}`}>{request.status}</b>{request.request_type === "export" && request.status === "ready" ? <a className="button button-secondary" href={`/api/privacy/exports/${request.id}`}>Tải JSON</a> : null}</article>)}</div> : null}
  </div>;
}

function PrivacyToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: () => void }) {
  return <label className="privacy-toggle"><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={checked} onChange={onChange} /><i aria-hidden="true" /></label>;
}
