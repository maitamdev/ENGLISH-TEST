"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FlaskConical, LoaderCircle, Play, Plus, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

type EvaluationCase = { id: string; name: string; suite: string; input: Record<string, unknown>; expectations: Record<string, unknown>; tags: string[]; enabled: boolean; created_at: string };
type Result = { id: string; case_id: string; passed: boolean; score: number; checks: { code?: string; passed?: boolean; detail?: string }[]; latency_ms: number | null; error_message: string | null };
type Run = { id: string; suite: string; provider: string; model: string; status: string; passed_cases: number; failed_cases: number; aggregate_score: number | null; created_at: string; error_message: string | null; ai_evaluation_results: Result[] };
type Payload = { cases: EvaluationCase[]; runs: Run[] };

export function AiEvalConsole({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<Payload>({ cases: [], runs: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ name: "", suite: "generation-regression", request: "", topic: "", level: "B1", difficulty: "Medium", modes: "VI_TO_EN,EN_TO_VI", forbiddenTerms: "", minimumQuality: "0.9" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/ai-evals", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không tải được AI evaluations");
      setData(body);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tải được dữ liệu"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function action(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const response = await fetch("/api/admin/ai-evals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Evaluation action failed");
      toast.success(payload.action === "run_case" ? body.passed ? "Case đã pass quality gate." : "Case chạy xong nhưng chưa đạt." : "Đã lưu evaluation case.");
      if (payload.action === "create_case") setForm((value) => ({ ...value, name: "", request: "", topic: "" }));
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Evaluation action failed"); }
    finally { setBusy(""); }
  }

  function createCase(event: React.FormEvent) {
    event.preventDefault();
    const modes = form.modes.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean).slice(0, 4);
    const forbiddenTerms = form.forbiddenTerms.split(",").map((value) => value.trim()).filter(Boolean);
    void action({
      action: "create_case", name: form.name, suite: form.suite,
      input: { request: form.request, topic: form.topic, level: form.level, difficulty: form.difficulty, modes, timePerQuestion: 45 },
      expectations: { requiredModes: modes, forbiddenTerms, minimumQuality: Number(form.minimumQuality) },
      tags: [form.level, form.difficulty, ...modes]
    }, "create");
  }

  return <div className="admin-workspace"><header className="page-header"><div><span className="eyebrow"><FlaskConical size={15} /> MODEL REGRESSION</span><h1 className="page-title">AI Quality Gate</h1><p className="page-lead">Mỗi case là yêu cầu thật do quản trị viên định nghĩa. Run gọi model thật, kiểm tra output thật và lưu toàn bộ bằng chứng.</p></div><button className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /> Làm mới</button></header>
    <div className="admin-two-column eval-layout"><div className="admin-main-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">CASES</span><h2>Regression suite</h2></div><span>{data.cases.filter((item) => item.enabled).length} active</span></div>{loading ? <div className="admin-loading"><LoaderCircle className="animate-spin" /> Đang đọc Supabase</div> : data.cases.length ? <div className="eval-case-list">{data.cases.map((item) => { const latest = data.runs.flatMap((run) => run.ai_evaluation_results ?? []).find((result) => result.case_id === item.id); return <article key={item.id}><div className="eval-status">{latest ? latest.passed ? <CheckCircle2 /> : <XCircle /> : <FlaskConical />}</div><div><strong>{item.name}</strong><span>{item.suite} · {String(item.input.level ?? "-")} · {(item.input.modes as string[] | undefined)?.join(", ")}</span><p>{String(item.input.request ?? "")}</p>{latest && <small>{Math.round(Number(latest.score) * 100)}% · {latest.latency_ms ?? 0}ms{latest.error_message ? ` · ${latest.error_message}` : ""}</small>}</div><button className="button button-secondary" disabled={!canEdit || Boolean(busy) || !item.enabled} onClick={() => void action({ action: "run_case", caseId: item.id }, item.id)}>{busy === item.id ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />} Run</button></article>; })}</div> : <div className="empty-state"><FlaskConical /><h3>Chưa có evaluation case</h3><p>Tạo case đầu tiên từ yêu cầu thật mà bạn muốn AI luôn xử lý đúng.</p></div>}</section><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow">RUN HISTORY</span><h2>Kết quả model</h2></div></div><div className="eval-run-list">{data.runs.length ? data.runs.map((run) => <article key={run.id}><div><strong>{run.suite}</strong><span>{run.provider} · {run.model}</span></div><b className={run.passed_cases > 0 ? "text-accent" : "review-wrong"}>{run.aggregate_score == null ? run.status : `${Math.round(Number(run.aggregate_score) * 100)}%`}</b><time>{new Intl.DateTimeFormat("vi", { dateStyle: "short", timeStyle: "short" }).format(new Date(run.created_at))}</time></article>) : <div className="empty-inline">Chưa có lần chạy model nào.</div>}</div></section></div>
      <aside className="admin-side-stack"><section className="surface admin-panel"><div className="panel-heading"><div><span className="eyebrow"><Plus size={13} /> NEW CASE</span><h2>Định nghĩa kỳ vọng</h2></div></div><form className="form-stack" onSubmit={createCase}><label className="field"><span>Tên case</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required minLength={3} /></label><label className="field"><span>Suite</span><input value={form.suite} onChange={(event) => setForm({ ...form, suite: event.target.value })} required /></label><label className="field"><span>Yêu cầu người học thật</span><textarea value={form.request} onChange={(event) => setForm({ ...form, request: event.target.value })} required minLength={3} /></label><label className="field"><span>Chủ đề</span><input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} required /></label><div className="admin-form-grid"><label className="field"><span>CEFR</span><select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>{["A1","A2","B1","B2","C1","C2"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="field"><span>Độ khó</span><select value={form.difficulty} onChange={(event) => setForm({ ...form, difficulty: event.target.value })}>{["Easy","Medium","Hard"].map((value) => <option key={value}>{value}</option>)}</select></label></div><label className="field"><span>Modes, tối đa 4</span><input value={form.modes} onChange={(event) => setForm({ ...form, modes: event.target.value })} /></label><label className="field"><span>Từ tuyệt đối không xuất hiện</span><input value={form.forbiddenTerms} onChange={(event) => setForm({ ...form, forbiddenTerms: event.target.value })} placeholder="phân cách bằng dấu phẩy" /></label><label className="field"><span>Quality tối thiểu 0–1</span><input type="number" min="0" max="1" step="0.01" value={form.minimumQuality} onChange={(event) => setForm({ ...form, minimumQuality: event.target.value })} /></label><button className="button button-primary" disabled={!canEdit || busy === "create"}>{busy === "create" ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />} Lưu case thật</button></form></section></aside></div>
  </div>;
}
