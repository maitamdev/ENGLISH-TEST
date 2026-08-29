"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Database, ExternalLink, LoaderCircle, Play, RefreshCw, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";

type Source = { id: string; source_key: string; display_name: string; homepage_url: string; license_id: string; license_url: string; attribution_text: string; source_kind: string; enabled: boolean; last_imported_at: string | null };
type Run = { id: string; status: string; fetched_count: number; accepted_count: number; rejected_count: number; error_message: string | null; created_at: string; learning_sources: { display_name?: string; source_key?: string } | { display_name?: string; source_key?: string }[] | null };
type Content = { id: string; external_id: string; content_type: string; language: string; translation_language: string | null; content: Record<string, unknown>; license_id: string; attribution: Record<string, unknown>; moderation_status: string; moderation_notes: string | null; quality_score: number | null; imported_at: string; learning_sources: { display_name?: string; source_key?: string; license_url?: string } | { display_name?: string; source_key?: string; license_url?: string }[] | null };
type Payload = { sources: Source[]; runs: Run[]; content: Content[]; counts: { status: string; count: number }[] };
const empty: Payload = { sources: [], runs: [], content: [], counts: [] };
const sourceOptions = ["tatoeba-en-vi", "cmudict", "meta-covost", "authorized-facebook-page"] as const;

function one<T>(value: T | T[] | null) { return Array.isArray(value) ? value[0] ?? null : value; }

export function ContentAdminStudio({ role }: { role: string }) {
  const [data, setData] = useState<Payload>(empty);
  const [status, setStatus] = useState("pending");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [sourceKey, setSourceKey] = useState<(typeof sourceOptions)[number]>("tatoeba-en-vi");
  const [limit, setLimit] = useState(100);
  const [rightsHolder, setRightsHolder] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/content?status=${encodeURIComponent(status)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không tải được Content Studio");
      setData(body); setSelected([]);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tải được dữ liệu"); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function act(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const response = await fetch("/api/admin/content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Thao tác thất bại");
      toast.success(key === "import" ? `Import hoàn tất: ${body.accepted ?? 0} record được nhận.` : "Đã lưu quyết định moderation.");
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Thao tác thất bại"); }
    finally { setBusy(""); }
  }

  const canImport = role === "owner" || role === "admin";
  return <div className="admin-workspace"><header className="page-header"><div><span className="eyebrow"><Database size={15} /> LICENSED CONTENT</span><h1 className="page-title">Content Admin Studio</h1><p className="page-lead">Nguồn, provenance, license và moderation thật. Không tự động duyệt nội dung Facebook.</p></div><button className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /> Làm mới</button></header>
    <section className="admin-metrics">{["pending","approved","rejected","quarantined"].map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}><span>{value}</span><strong>{data.counts.find((item) => item.status === value)?.count ?? 0}</strong></button>)}</section>
    <div className="admin-two-column"><div className="admin-main-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">MODERATION QUEUE</span><h2>{status} content</h2></div><span>{selected.length} đã chọn</span></div>{loading ? <div className="admin-loading"><LoaderCircle className="animate-spin" /> Đang đọc Supabase</div> : data.content.length ? <div className="content-review-list">{data.content.map((item) => { const source = one(item.learning_sources); const checked = selected.includes(item.id); return <article key={item.id} className={checked ? "selected" : ""}><label><input type="checkbox" checked={checked} onChange={() => setSelected((ids) => checked ? ids.filter((id) => id !== item.id) : [...ids, item.id])} /><span /></label><div><div className="content-review-head"><strong>{item.content_type.replaceAll("_", " ")}</strong><small>{source?.display_name ?? "Unknown source"} · {item.license_id}</small></div><pre>{JSON.stringify(item.content, null, 2)}</pre><div className="content-provenance"><span>{item.external_id}</span><span>{item.language}{item.translation_language ? ` → ${item.translation_language}` : ""}</span>{source?.license_url && <a href={source.license_url} target="_blank" rel="noreferrer">License <ExternalLink size={12} /></a>}</div></div></article>; })}</div> : <div className="empty-state"><ShieldAlert /><h3>Không có record {status}</h3><p>Đây là trạng thái thật của database, không có placeholder hoặc dữ liệu mẫu.</p></div>}{selected.length > 0 && <div className="moderation-bar"><input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ghi chú quyết định (không bắt buộc)" maxLength={1000} /><button className="button button-primary" disabled={Boolean(busy)} onClick={() => void act({ action: "moderate", contentIds: selected, verdict: "approve", note }, "approve")}><Check size={16} /> Duyệt</button><button className="button button-danger" disabled={Boolean(busy)} onClick={() => void act({ action: "moderate", contentIds: selected, verdict: "reject", note }, "reject")}><X size={16} /> Từ chối</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void act({ action: "moderate", contentIds: selected, verdict: "quarantine", note }, "quarantine")}>Cách ly</button></div>}</section></div>
      <aside className="admin-side-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">IMPORT</span><h2>Chạy nguồn thật</h2></div></div><div className="form-stack"><label className="field"><span>Nguồn</span><select value={sourceKey} onChange={(event) => setSourceKey(event.target.value as typeof sourceKey)}>{sourceOptions.map((option) => <option key={option}>{option}</option>)}</select></label><label className="field"><span>Số record cho lần chạy</span><input type="number" min={1} max={500} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label>{sourceKey === "authorized-facebook-page" && <><label className="field"><span>Chủ sở hữu quyền</span><input value={rightsHolder} onChange={(event) => setRightsHolder(event.target.value)} /></label><label className="field"><span>URL bằng chứng quyền sử dụng</span><input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></label></>}<button className="button button-primary" disabled={!canImport || Boolean(busy) || (sourceKey === "authorized-facebook-page" && (!rightsHolder || !evidenceUrl))} onClick={() => void act({ action: "import", sourceKey, limit, rightsHolder: rightsHolder || undefined, authorizationEvidenceUrl: evidenceUrl || undefined }, "import")}>{busy === "import" ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />} Bắt đầu import</button>{!canImport && <small>Role hiện tại chỉ được moderation.</small>}</div></section><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">SOURCES</span><h2>Nguồn đã đăng ký</h2></div></div><div className="source-list">{data.sources.length ? data.sources.map((source) => <article key={source.id}><div><strong>{source.display_name}</strong><span>{source.license_id} · {source.enabled ? "enabled" : "disabled"}</span></div><a href={source.homepage_url} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a></article>) : <div className="empty-inline">Nguồn sẽ xuất hiện sau lần import đầu tiên.</div>}</div></section><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">IMPORT RUNS</span><h2>Lịch sử</h2></div></div><div className="run-list">{data.runs.length ? data.runs.map((run) => <article key={run.id}><div><strong>{one(run.learning_sources)?.display_name ?? "Source"}</strong><span>{run.status} · {run.accepted_count}/{run.fetched_count} accepted</span></div><time>{new Intl.DateTimeFormat("vi", { dateStyle: "short", timeStyle: "short" }).format(new Date(run.created_at))}</time>{run.error_message && <p>{run.error_message}</p>}</article>) : <div className="empty-inline">Chưa có lần import nào.</div>}</div></section></aside></div>
  </div>;
}
