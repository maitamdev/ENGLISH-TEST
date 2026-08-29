"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

type Person = { display_name?: string; username?: string };
type Report = {
  id: string;
  category: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: string;
  resolution_note: string | null;
  created_at: string;
  reporter: Person | Person[] | null;
  reported: Person | Person[] | null;
  rooms: { code?: string } | { code?: string }[] | null;
};
type Payload = { reports: Report[]; counts: { status: string; count: number }[] };

function one<T>(value: T | T[] | null) { return Array.isArray(value) ? value[0] ?? null : value; }
function person(value: Person | Person[] | null) { const row = one(value); return row?.display_name || (row?.username ? `@${row.username}` : "Unknown user"); }

export function SafetyConsole() {
  const [status, setStatus] = useState("open");
  const [data, setData] = useState<Payload>({ reports: [], counts: [] });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/safety?status=${encodeURIComponent(status)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không đọc được safety queue");
      setData(body);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không đọc được safety queue"); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function decide(reportId: string, nextStatus: "reviewing" | "resolved" | "dismissed") {
    const resolutionNote = notes[reportId]?.trim();
    if (!resolutionNote) { toast.error("Cần ghi lý do để quyết định có thể kiểm toán."); return; }
    setBusy(reportId);
    try {
      const response = await fetch("/api/admin/safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId, status: nextStatus, resolutionNote }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Không lưu được quyết định");
      toast.success("Đã lưu quyết định moderation.");
      setNotes((value) => ({ ...value, [reportId]: "" }));
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không lưu được quyết định"); }
    finally { setBusy(""); }
  }

  return <div className="admin-workspace"><header className="page-header"><div><span className="eyebrow"><ShieldAlert size={15} /> TRUST &amp; SAFETY</span><h1 className="page-title">Safety investigation queue</h1><p className="page-lead">Mỗi báo cáo, bằng chứng và quyết định đều là record thật có người chịu trách nhiệm.</p></div><button className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /> Làm mới</button></header>
    <section className="admin-metrics">{["open", "reviewing", "resolved", "dismissed"].map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}><span>{value}</span><strong>{data.counts.find((item) => item.status === value)?.count ?? 0}</strong></button>)}</section>
    <section className="surface admin-panel">{loading ? <div className="admin-loading"><LoaderCircle className="animate-spin" /> Đang đọc báo cáo từ Supabase</div> : data.reports.length ? <div className="safety-report-list">{data.reports.map((report) => <article key={report.id}><header><div><span>{report.category.replaceAll("_", " ")}</span><strong>{person(report.reported)}</strong></div><time>{new Intl.DateTimeFormat("vi", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.created_at))}</time></header><p>{report.detail}</p><dl><div><dt>Người báo cáo</dt><dd>{person(report.reporter)}</dd></div><div><dt>Phòng</dt><dd>{one(report.rooms)?.code ?? "Không gắn phòng"}</dd></div></dl>{Object.keys(report.evidence ?? {}).length > 0 && <details><summary>Bằng chứng đính kèm</summary><pre>{JSON.stringify(report.evidence, null, 2)}</pre></details>}{report.resolution_note && <div className="safety-resolution"><CheckCircle2 size={15} />{report.resolution_note}</div>}{status !== "resolved" && status !== "dismissed" && <div className="safety-decision"><textarea value={notes[report.id] ?? ""} onChange={(event) => setNotes((value) => ({ ...value, [report.id]: event.target.value }))} placeholder="Kết quả điều tra / lý do quyết định…" maxLength={2000} /><div><button className="button button-secondary" disabled={busy === report.id} onClick={() => void decide(report.id, "reviewing")}>Nhận xử lý</button><button className="button button-primary" disabled={busy === report.id} onClick={() => void decide(report.id, "resolved")}>Giải quyết</button><button className="button button-danger" disabled={busy === report.id} onClick={() => void decide(report.id, "dismissed")}>Bác báo cáo</button></div></div>}</article>)}</div> : <div className="empty-state"><CheckCircle2 /><h3>Không có báo cáo {status}</h3><p>Đây là trạng thái thật, không phải dữ liệu mẫu.</p></div>}</section>
  </div>;
}
