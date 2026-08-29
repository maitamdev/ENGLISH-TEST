"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, Check, LoaderCircle, Plus, RefreshCw, ServerCog } from "lucide-react";
import { toast } from "sonner";

type Metrics = { activeGenerationJobs: number; failedGenerationJobs24h: number; telemetryErrors1h: number; realtimeReconnects1h: number; audioFailures24h: number; compromisedRounds24h: number; pendingPrivacyRequests: number; oldestActiveJobSeconds: number };
type Event = { id: string; event_name: string; severity: string; duration_ms: number | null; provider: string | null; model: string | null; error_code: string | null; error_message: string | null; occurred_at: string };
type Job = { id: string; status: string; stage: string; total_rounds: number | null; completed_rounds: number; attempt_count: number; max_attempts: number; error_code: string | null; error_message: string | null; created_at: string; updated_at: string; rooms: { code?: string } | { code?: string }[] | null };
type Alert = { id: string; metric: string; observed_value: number | null; threshold: number | null; severity: string; title: string; detail: string | null; status: string; first_seen_at: string; last_seen_at: string; occurrence_count: number };
type Rule = { id: string; name: string; metric: string; comparator: string; threshold: number; window_minutes: number; severity: string; enabled: boolean };
type Snapshot = { checkedAt: string; metrics: Metrics; recentEvents: Event[]; jobs: Job[]; alerts: Alert[]; rules: Rule[] };
const blankMetrics: Metrics = { activeGenerationJobs: 0, failedGenerationJobs24h: 0, telemetryErrors1h: 0, realtimeReconnects1h: 0, audioFailures24h: 0, compromisedRounds24h: 0, pendingPrivacyRequests: 0, oldestActiveJobSeconds: 0 };

function one<T>(value: T | T[] | null) { return Array.isArray(value) ? value[0] ?? null : value; }
function duration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.round(seconds / 60)}m`; return `${(seconds / 3600).toFixed(1)}h`; }

export function OperationsConsole({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<Snapshot>({ checkedAt: "", metrics: blankMetrics, recentEvents: [], jobs: [], alerts: [], rules: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [rule, setRule] = useState({ name: "", metric: "telemetry_errors", comparator: "gt", threshold: "5", windowMinutes: "60", severity: "error" });
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/operations", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không tải được operations");
      setData(body);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tải được operations"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = window.setInterval(() => void load(), 30_000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);

  async function action(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const response = await fetch("/api/admin/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Operations action failed");
      toast.success(payload.action === "evaluate" ? `Đã đánh giá ${body.evaluated?.length ?? 0} rule.` : "Đã cập nhật operations.");
      if (payload.action === "create_rule") setRule((value) => ({ ...value, name: "" }));
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Operations action failed"); }
    finally { setBusy(""); }
  }

  const metricCards = [
    ["Generation active", data.metrics.activeGenerationJobs], ["Generation failed · 24h", data.metrics.failedGenerationJobs24h],
    ["Errors · 1h", data.metrics.telemetryErrors1h], ["Reconnect · 1h", data.metrics.realtimeReconnects1h],
    ["Audio failed · 24h", data.metrics.audioFailures24h], ["Fairness compromised · 24h", data.metrics.compromisedRounds24h],
    ["Privacy pending", data.metrics.pendingPrivacyRequests], ["Oldest active job", duration(data.metrics.oldestActiveJobSeconds)]
  ] as const;

  return <div className="admin-workspace"><header className="page-header"><div><span className="eyebrow"><Activity size={15} /> LIVE OPERATIONS</span><h1 className="page-title">Operations Console</h1><p className="page-lead">Job, provider error, reconnect, audio và fairness được tổng hợp trực tiếp từ sự kiện thật.</p></div><div className="header-actions"><button className="button button-secondary" onClick={() => void action({ action: "evaluate" }, "evaluate")} disabled={!canEdit || Boolean(busy)}><ServerCog size={17} /> Evaluate alerts</button><button className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /> Refresh</button></div></header>
    <section className="ops-metric-grid">{metricCards.map(([label, value]) => <article className="surface" key={label}><span>{label}</span><strong>{value}</strong></article>)}</section>
    <div className="admin-two-column ops-layout"><div className="admin-main-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow"><AlertTriangle size={13} /> ALERTS</span><h2>Durable incidents</h2></div><span>{data.alerts.filter((item) => item.status !== "resolved").length} open</span></div>{data.alerts.length ? <div className="ops-alert-list">{data.alerts.map((alert) => <article key={alert.id} className={`severity-${alert.severity}`}><div><span>{alert.severity} · {alert.status}</span><strong>{alert.title}</strong><p>{alert.detail}</p><small>Last seen {new Intl.DateTimeFormat("vi", { dateStyle: "short", timeStyle: "medium" }).format(new Date(alert.last_seen_at))}</small></div>{alert.status !== "resolved" && <div><button className="suggestion" disabled={!canEdit || Boolean(busy)} onClick={() => void action({ action: "alert_status", alertId: alert.id, status: "acknowledged" }, alert.id)}><Check size={14} /> Acknowledge</button><button className="suggestion" disabled={!canEdit || Boolean(busy)} onClick={() => void action({ action: "alert_status", alertId: alert.id, status: "resolved" }, alert.id)}>Resolve</button></div>}</article>)}</div> : <div className="empty-state"><Check /><h3>Không có alert record</h3><p>Alert chỉ xuất hiện khi một rule thật được kích hoạt.</p></div>}</section><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">GENERATION QUEUE</span><h2>Job gần đây</h2></div></div><div className="ops-job-list">{data.jobs.length ? data.jobs.map((job) => <article key={job.id}><div><strong>{one(job.rooms)?.code ?? "Room"} · {job.status}</strong><span>{job.stage}</span>{job.error_message && <p>{job.error_code}: {job.error_message}</p>}</div><div><b>{job.completed_rounds}/{job.total_rounds ?? "?"}</b><small>{job.attempt_count}/{job.max_attempts} failures</small></div></article>) : <div className="empty-inline">Chưa có generation job thật.</div>}</div></section></div>
      <aside className="admin-side-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow"><Plus size={13} /> ALERT RULE</span><h2>Tạo ngưỡng vận hành</h2></div></div><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void action({ action: "create_rule", name: rule.name, metric: rule.metric, comparator: rule.comparator, threshold: Number(rule.threshold), windowMinutes: Number(rule.windowMinutes), severity: rule.severity }, "rule"); }}><label className="field"><span>Tên</span><input value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} required /></label><label className="field"><span>Metric</span><select value={rule.metric} onChange={(event) => setRule({ ...rule, metric: event.target.value })}>{["generation_failed","generation_active","telemetry_errors","realtime_reconnects","audio_failures","fairness_compromised","privacy_pending"].map((value) => <option key={value}>{value}</option>)}</select></label><div className="admin-form-grid"><label className="field"><span>So sánh</span><select value={rule.comparator} onChange={(event) => setRule({ ...rule, comparator: event.target.value })}>{["gt","gte","lt","lte","eq"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="field"><span>Ngưỡng</span><input type="number" value={rule.threshold} onChange={(event) => setRule({ ...rule, threshold: event.target.value })} /></label></div><div className="admin-form-grid"><label className="field"><span>Window phút</span><input type="number" min="1" value={rule.windowMinutes} onChange={(event) => setRule({ ...rule, windowMinutes: event.target.value })} /></label><label className="field"><span>Severity</span><select value={rule.severity} onChange={(event) => setRule({ ...rule, severity: event.target.value })}>{["info","warning","error","critical"].map((value) => <option key={value}>{value}</option>)}</select></label></div><button className="button button-primary" disabled={!canEdit || busy === "rule"}>{busy === "rule" ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />} Lưu rule</button></form><div className="ops-rule-list">{data.rules.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.metric} {item.comparator} {item.threshold} / {item.window_minutes}m</span></div><i className={item.enabled ? "enabled" : ""} /></article>)}</div></section><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">EVENT STREAM</span><h2>Sự kiện gần nhất</h2></div></div><div className="ops-event-list">{data.recentEvents.length ? data.recentEvents.slice(0, 30).map((event) => <article key={event.id}><i className={`severity-${event.severity}`} /><div><strong>{event.event_name}</strong><span>{event.provider ?? "app"}{event.duration_ms != null ? ` · ${event.duration_ms}ms` : ""}</span>{event.error_message && <p>{event.error_message}</p>}</div><time>{new Intl.DateTimeFormat("vi", { timeStyle: "medium" }).format(new Date(event.occurred_at))}</time></article>) : <div className="empty-inline">Chưa có telemetry event.</div>}</div></section></aside></div>
  </div>;
}
