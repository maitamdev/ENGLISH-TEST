"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, Check, CirclePause, LoaderCircle, Route, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";

type Friend = { id: string; display_name: string };
type PathItem = { id: string; sequence_number: number; skill: string; activity_type: string; title: string; objective: string; target_minutes: number; target_count: number | null; due_at: string | null; assignment: "both" | "creator" | "partner"; source_filters: { destination?: string }; completed_by: string[] };
type Goal = { id: string; created_by: string; partner_id: string; title: string; target_cefr: string; focus_skills: string[]; status: string; schedule: { rationaleVi?: string; sessionsPerWeek?: number; minutesPerSession?: number }; starts_on: string | null; target_date: string | null; updated_at: string; creator: Friend | null; partner: Friend | null; shared_learning_path_items: PathItem[] };

const skillOptions = ["vocabulary", "grammar", "reading", "listening", "writing", "speaking", "phonology", "mediation", "online_interaction"];

export function SharedPathsExperience({ userId, friends }: { userId: string; friends: Friend[] }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [clock, setClock] = useState(0);
  const [form, setForm] = useState({ partnerId: friends[0]?.id ?? "", title: "", targetCefr: "B2", focusSkills: ["speaking", "listening"], startsOn: new Date().toISOString().slice(0, 10), targetDate: "", sessionsPerWeek: 3, minutesPerSession: 30 });
  const load = useCallback(async () => {
    const response = await fetch("/api/learning-paths", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Không đọc được learning paths");
    setGoals(body.goals ?? []);
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load().catch((error) => toast.error(error.message)).finally(() => setLoading(false)), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const initial = window.setTimeout(() => setClock(Date.now()), 0); const timer = window.setInterval(() => setClock(Date.now()), 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, []);
  const active = useMemo(() => goals.filter((goal) => ["proposed", "generating", "generation_failed", "active", "paused"].includes(goal.status)), [goals]);

  async function createGoal(event: React.FormEvent) {
    event.preventDefault(); setBusy("create");
    try {
      const response = await fetch("/api/learning-paths", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, targetDate: form.targetDate || undefined }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không tạo được learning path");
      setGoals(body.goals ?? []); setForm((current) => ({ ...current, title: "" })); toast.success("Đã gửi đề xuất. Chỉ đọc evidence chung sau khi người kia đồng ý.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tạo được learning path"); }
    finally { setBusy(""); }
  }

  async function act(goalId: string, action: string, itemId?: string) {
    setBusy(itemId ?? `${goalId}:${action}`);
    try {
      const response = await fetch("/api/learning-paths", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goalId, action, itemId }) });
      const body = await response.json();
      if (!response.ok) { if (body.goals) setGoals(body.goals); throw new Error(body.error ?? "Không cập nhật được learning path"); }
      setGoals(body.goals ?? []);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không cập nhật được learning path"); }
    finally { setBusy(""); }
  }

  return <div className="paths-layout">
    <header className="paths-hero"><div><span className="eyebrow"><Users size={14} /> PAIR LEARNING CONTROL</span><h1>Lộ trình của hai người,<br />được dẫn bởi bằng chứng.</h1><p>AI đọc placement, mastery, lịch ôn và hoạt động thật của cả hai để xếp một kế hoạch chung. Người được mời phải đồng ý trước khi lộ trình bắt đầu.</p></div><div className="paths-metric"><strong>{active.length}</strong><span>lộ trình đang mở</span></div></header>
    <section className="surface path-builder"><div className="panel-heading"><div><span className="eyebrow"><Sparkles size={13} /> EVIDENCE-DRIVEN</span><h2>Tạo shared learning goal</h2></div></div>{friends.length ? <form onSubmit={createGoal} className="path-form"><label><span>Học cùng</span><select className="input" value={form.partnerId} onChange={(event) => setForm({ ...form, partnerId: event.target.value })}>{friends.map((friend) => <option key={friend.id} value={friend.id}>{friend.display_name}</option>)}</select></label><label className="path-title-field"><span>Mục tiêu</span><input className="input" required minLength={3} maxLength={160} placeholder="Ví dụ: Tự tin giao tiếp công việc B2" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label><span>CEFR đích</span><select className="input" value={form.targetCefr} onChange={(event) => setForm({ ...form, targetCefr: event.target.value })}>{["A1", "A2", "B1", "B2", "C1", "C2"].map((level) => <option key={level}>{level}</option>)}</select></label><div className="path-skill-picker"><span>Kỹ năng ưu tiên</span><div>{skillOptions.map((skill) => <button type="button" key={skill} className={form.focusSkills.includes(skill) ? "selected" : ""} onClick={() => setForm((current) => ({ ...current, focusSkills: current.focusSkills.includes(skill) ? current.focusSkills.filter((value) => value !== skill) : [...current.focusSkills, skill] }))}>{skill.replaceAll("_", " ")}</button>)}</div></div><label><span>Buổi / tuần</span><input className="input" type="number" min={1} max={14} value={form.sessionsPerWeek} onChange={(event) => setForm({ ...form, sessionsPerWeek: Number(event.target.value) })} /></label><label><span>Phút / buổi</span><input className="input" type="number" min={5} max={180} value={form.minutesPerSession} onChange={(event) => setForm({ ...form, minutesPerSession: Number(event.target.value) })} /></label><label><span>Bắt đầu</span><input className="input" type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label><label><span>Ngày đích (tùy chọn)</span><input className="input" type="date" value={form.targetDate} onChange={(event) => setForm({ ...form, targetDate: event.target.value })} /></label><button className="button button-primary path-create" disabled={busy === "create" || !form.partnerId || !form.title || !form.focusSkills.length}>{busy === "create" ? <LoaderCircle size={17} className="animate-spin" /> : <Route size={17} />}Phân tích và tạo lộ trình</button></form> : <div className="empty-state"><Users size={30} /><h3>Chưa có bạn bè đã xác nhận</h3><p>Kết bạn trong Community trước để tạo lộ trình dùng chung.</p><Link className="button button-secondary" href="/community">Mở Community</Link></div>}</section>
    <section className="path-list"><div className="panel-heading"><h2>Lộ trình của hai bạn</h2>{loading && <LoaderCircle size={17} className="animate-spin" />}</div>{!loading && !goals.length && <div className="surface empty-state large"><Route size={38} /><h3>Chưa có learning path</h3><p>Khi tạo, hệ thống chỉ dùng dữ liệu học thật đang có trong Supabase.</p></div>}{goals.map((goal) => { const isPartner = goal.partner_id === userId; const peer = goal.created_by === userId ? goal.partner : goal.creator; const staleGeneration = goal.status === "generating" && clock > 0 && clock - new Date(goal.updated_at).getTime() > 120_000; return <article className="surface path-card" key={goal.id}><header><div><span className={`path-status ${goal.status}`}>{goal.status.replaceAll("_", " ")}</span><h2>{goal.title}</h2><p>Với {peer?.display_name ?? "người học cùng"} · CEFR {goal.target_cefr} · {goal.focus_skills.join(" · ")}</p></div><div className="path-actions">{goal.status === "proposed" && isPartner && <><button className="button button-primary" onClick={() => void act(goal.id, "accept")} disabled={Boolean(busy)}>Đồng ý và tạo path</button><button className="button button-secondary" onClick={() => void act(goal.id, "decline")} disabled={Boolean(busy)}>Từ chối</button></>}{goal.status === "generating" && (staleGeneration ? <button className="button button-primary" onClick={() => void act(goal.id, "retry_generation")} disabled={Boolean(busy)}>Khôi phục tạo path</button> : <span className="path-generating"><LoaderCircle size={16} className="animate-spin" />Đang phân tích evidence sau consent</span>)}{goal.status === "generation_failed" && <button className="button button-primary" onClick={() => void act(goal.id, "retry_generation")} disabled={Boolean(busy)}>Thử tạo lại</button>}{goal.status === "active" && <button className="button button-secondary" onClick={() => void act(goal.id, "pause")} disabled={Boolean(busy)}><CirclePause size={16} />Tạm dừng</button>}{goal.status === "paused" && <button className="button button-primary" onClick={() => void act(goal.id, "resume")} disabled={Boolean(busy)}>Tiếp tục</button>}</div></header>{goal.schedule.rationaleVi && <blockquote>{goal.schedule.rationaleVi}</blockquote>}{goal.status === "generation_failed" && <p className="path-error">Provider chưa hoàn thành lần sinh path. Evidence vẫn riêng tư và bạn có thể thử lại.</p>}<div className="path-timeline">{goal.shared_learning_path_items.map((item) => { const required = item.assignment === "both" || (item.assignment === "creator" ? goal.created_by : goal.partner_id) === userId; const done = item.completed_by.includes(userId); const destination = item.source_filters?.destination ?? "/study"; return <div className={done ? "path-step done" : "path-step"} key={item.id}><span className="path-step-number">{done ? <Check size={16} /> : item.sequence_number}</span><div><span>{item.activity_type} · {item.skill} · {item.assignment === "both" ? "cả hai" : item.assignment === "creator" ? goal.creator?.display_name : goal.partner?.display_name}</span><h3>{item.title}</h3><p>{item.objective}</p><small><CalendarDays size={13} />{item.due_at ? new Date(item.due_at).toLocaleDateString("vi-VN") : "Không có hạn"} · {item.target_minutes} phút{item.target_count ? ` · ${item.target_count} lượt` : ""}</small></div><div>{!done && required && goal.status === "active" && <button className="button button-secondary" onClick={() => void act(goal.id, "complete_item", item.id)} disabled={Boolean(busy)}>{busy === item.id ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}Hoàn thành</button>}<Link href={destination}>Mở hoạt động <ArrowRight size={14} /></Link></div></div>; })}</div></article>; })}</section>
  </div>;
}
