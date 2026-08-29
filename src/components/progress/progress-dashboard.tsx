"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Bell, BrainCircuit, CheckCircle2, Gauge, LoaderCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";

type Mastery = { skill: string; mastery_score: number; confidence: number; evidence_count: number; cefr_evidence: Record<string, number>; latest_score: number | null; last_evidence_at: string | null };
type Evidence = { id: string; skill: string; cefr_level: string; score: number; source_type: string; occurred_at: string };
type Recap = { match_id: string; summary_vi: string; strengths: { skill?: string; evidence?: string }[]; needs_work: { skill?: string; evidence?: string }[]; next_actions: { priority?: number; skill?: string; action?: string }[]; algorithm_version: string; created_at: string };
type Preferences = { review_due: boolean; shared_goal_reminders: boolean; room_invites: boolean; quiet_hours_start: string | null; quiet_hours_end: string | null; timezone: string };

export function ProgressDashboard({ profile, mastery, evidence, placement, recaps: initialRecaps, dueCount, requestedMatchId, preferences }: { profile: { cefr: string | null }; mastery: Mastery[]; evidence: Evidence[]; placement: { estimated_cefr: string; confidence: number; standard_error: number; response_count: number; completed_at: string } | null; recaps: Recap[]; dueCount: number; requestedMatchId: string | null; preferences: Preferences | null }) {
  const [recaps, setRecaps] = useState(initialRecaps);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(preferences ?? { review_due: true, shared_goal_reminders: true, room_invites: true, quiet_hours_start: null, quiet_hours_end: null, timezone: "Asia/Bangkok" });
  async function createRecap() {
    if (!requestedMatchId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/matches/${requestedMatchId}/recap`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không tạo được recap");
      setRecaps((items) => [body, ...items.filter((item) => item.match_id !== body.match_id)]);
      toast.success("Đã tổng hợp trận từ evidence thật.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tạo được recap"); }
    finally { setBusy(false); }
  }
  async function updatePreferences(next: Preferences) {
    const previous = prefs; setPrefs(next);
    const response = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    if (!response.ok) { setPrefs(previous); const body = await response.json().catch(() => ({})); toast.error(body.error ?? "Không lưu được notification settings"); }
  }
  const requestedRecap = requestedMatchId ? recaps.find((item) => item.match_id === requestedMatchId) : null;
  return <div className="progress-layout"><section className="surface progress-overview"><div><span className="eyebrow"><Gauge size={14} /> CURRENT ESTIMATE</span><strong>{placement?.estimated_cefr ?? profile.cefr ?? "—"}</strong><p>{placement ? `${Math.round(Number(placement.confidence) * 100)}% confidence · SEM ±${Number(placement.standard_error).toFixed(2)} · ${placement.response_count} items` : "Chưa có placement có độ tin cậy."}</p></div><div><span className="eyebrow"><BrainCircuit size={14} /> DUE NOW</span><strong>{dueCount}</strong><p>FSRS cards đến hạn từ lịch sử thật.</p><Link href="/study">Ôn ngay <ArrowRight size={14} /></Link></div><Link className="button button-secondary" href="/placement">{placement ? "Đánh giá lại" : "Làm placement"}</Link></section>
    <section className="surface progress-panel"><div className="panel-heading"><div><span className="eyebrow">MASTERY GRAPH</span><h2>Khả năng và độ chắc chắn</h2></div><span>{mastery.reduce((sum, item) => sum + item.evidence_count, 0)} evidence events</span></div>{mastery.length ? <div className="mastery-list">{mastery.map((item) => <article key={item.skill}><div><strong>{item.skill.replaceAll("_", " ")}</strong><span>{item.evidence_count} bằng chứng · confidence {Math.round(Number(item.confidence) * 100)}%</span></div><i><b style={{ width: `${Number(item.mastery_score)}%` }} /></i><strong>{Math.round(Number(item.mastery_score))}</strong></article>)}</div> : <div className="empty-state"><BrainCircuit /><h3>Chưa đủ evidence</h3><p>Làm placement, thi, luyện nói hoặc FSRS để mastery graph bắt đầu hình thành.</p></div>}</section>
    {requestedMatchId && <section className="surface progress-panel"><div className="panel-heading"><div><span className="eyebrow"><Sparkles size={14} /> MATCH RECAP</span><h2>Tổng kết trận vừa chọn</h2></div>{!requestedRecap && <button className="button button-primary" onClick={() => void createRecap()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />} Tổng hợp</button>}</div>{requestedRecap ? <RecapCard recap={requestedRecap} /> : <div className="empty-inline">Bấm Tổng hợp để tạo recap từ submissions thật của cả hai người.</div>}</section>}
    <div className="progress-columns"><section className="surface progress-panel"><div className="panel-heading"><div><span className="eyebrow">RECENT EVIDENCE</span><h2>Dòng bằng chứng</h2></div></div><div className="evidence-list">{evidence.length ? evidence.map((item) => <article key={item.id}><CheckCircle2 size={15} className={Number(item.score) >= .65 ? "text-accent" : "review-wrong"} /><div><strong>{item.skill} · {Math.round(Number(item.score) * 100)}%</strong><span>{item.source_type.replaceAll("_", " ")} · {item.cefr_level}</span></div><time>{new Intl.DateTimeFormat("vi", { dateStyle: "short", timeStyle: "short" }).format(new Date(item.occurred_at))}</time></article>) : <div className="empty-inline">Chưa có evidence event.</div>}</div></section><section className="surface progress-panel"><div className="panel-heading"><div><span className="eyebrow">RECAP HISTORY</span><h2>Trận đã tổng hợp</h2></div></div><div className="recap-list">{recaps.length ? recaps.map((recap) => <RecapCard key={recap.match_id} recap={recap} compact />) : <div className="empty-inline">Chưa có recap. Mở Progress từ màn hình kết quả trận.</div>}</div></section></div>
    <section className="surface progress-panel"><div className="panel-heading"><div><span className="eyebrow"><Bell size={14} /> NOTIFICATIONS</span><h2>Nhắc đúng hoạt động thật</h2></div></div><div className="preference-grid">{[["review_due","FSRS đến hạn"],["shared_goal_reminders","Lịch học chung"],["room_invites","Lời mời phòng"]].map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(prefs[key as keyof Preferences])} onChange={(event) => void updatePreferences({ ...prefs, [key]: event.target.checked })} /><span>{label}</span></label>)}<label><span>Yên lặng từ</span><input type="time" value={prefs.quiet_hours_start?.slice(0, 5) ?? ""} onChange={(event) => setPrefs({ ...prefs, quiet_hours_start: event.target.value || null })} /></label><label><span>Đến</span><input type="time" value={prefs.quiet_hours_end?.slice(0, 5) ?? ""} onChange={(event) => setPrefs({ ...prefs, quiet_hours_end: event.target.value || null })} onBlur={() => void updatePreferences(prefs)} /></label><label><span>Múi giờ IANA</span><input value={prefs.timezone} onChange={(event) => setPrefs({ ...prefs, timezone: event.target.value })} onBlur={() => void updatePreferences(prefs)} /></label></div></section>
  </div>;
}

function RecapCard({ recap, compact = false }: { recap: Recap; compact?: boolean }) {
  return <article className={`recap-card ${compact ? "compact" : ""}`}><p>{recap.summary_vi}</p>{!compact && <><div className="recap-evidence"><div><strong>Điểm mạnh</strong>{recap.strengths.length ? recap.strengths.map((item) => <span key={`${item.skill}:${item.evidence}`}>{item.skill}: {item.evidence}</span>) : <span>Cần thêm bằng chứng.</span>}</div><div><strong>Cần tập trung</strong>{recap.needs_work.length ? recap.needs_work.map((item) => <span key={`${item.skill}:${item.evidence}`}>{item.skill}: {item.evidence}</span>) : <span>Không có kỹ năng dưới ngưỡng.</span>}</div></div><ol>{recap.next_actions.map((item) => <li key={`${item.priority}:${item.skill}`}>{item.action}</li>)}</ol></>}<footer><span>{recap.algorithm_version}</span><Link href={`/review/${recap.match_id}`}>Ôn lại trận <ArrowRight size={13} /></Link></footer></article>;
}
