"use client";

import { useMemo, useState } from "react";
import { ArrowRight, BrainCircuit, Check, CircleAlert, LoaderCircle, Sparkles, Target } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

type ReviewCard = { id: string; skill: string; front: Record<string, unknown>; back: Record<string, unknown>; due_at: string; reps: number; lapses: number };
type LearningError = { id: string; error_type: string; skill: string; prompt: string; learner_answer: string; expected_answer: string; explanation: string | null; occurrence_count: number; last_seen_at: string };
type Plan = { id: string; title: string; cefr_start: string | null; cefr_target: string | null; rationale_vi: string; weekly_minutes: number; starts_on: string; ends_on: string | null };
type PlanItem = { id: string; sequence_number: number; skill: string; activity_type: string; title: string; objective: string; target_minutes: number; target_count: number | null; due_on: string | null; completed_at: string | null };

export function StudyHub({ initialCards, dueCount, errors, plan, planItems }: { initialCards: ReviewCard[]; dueCount: number; errors: LearningError[]; plan: Plan | null; planItems: PlanItem[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initialCards);
  const [revealed, setRevealed] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [items, setItems] = useState(planItems);
  const card = cards[0] ?? null;
  const remaining = Math.max(0, dueCount - (initialCards.length - cards.length));
  const skillCounts = useMemo(() => errors.reduce<Record<string, number>>((all, item) => ({ ...all, [item.skill]: (all[item.skill] ?? 0) + item.occurrence_count }), {}), [errors]);

  async function rate(rating: number) {
    if (!card || ratingBusy) return;
    setRatingBusy(true);
    try {
      const response = await fetch("/api/study/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId: card.id, requestId: crypto.randomUUID(), rating }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Không lưu được lượt ôn tập");
      setCards((current) => current.slice(1));
      setRevealed(false);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không lưu được lượt ôn tập"); }
    finally { setRatingBusy(false); }
  }

  async function generatePlan() {
    setPlanBusy(true);
    try {
      const response = await fetch("/api/study/plan", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Không tạo được lộ trình");
      toast.success("Đã tạo lộ trình từ dữ liệu học thật của bạn.");
      router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tạo được lộ trình"); }
    finally { setPlanBusy(false); }
  }

  async function resolveError(errorId: string) {
    const response = await fetch(`/api/study/errors/${errorId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolved: true }) });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) return toast.error(body.error ?? "Không cập nhật được Error Notebook");
    toast.success("Đã đánh dấu lỗi này là đã xử lý.");
    router.refresh();
  }

  async function togglePlanItem(item: PlanItem) {
    const response = await fetch(`/api/study/plan-items/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed: !item.completed_at }) });
    const body = await response.json().catch(() => ({})) as { error?: string; completedAt?: string | null };
    if (!response.ok) return toast.error(body.error ?? "Không cập nhật được mục học");
    setItems((current) => current.map((value) => value.id === item.id ? { ...value, completed_at: body.completedAt ?? null } : value));
  }

  return <div className="study-grid">
    <section className="surface study-review-panel">
      <div className="panel-heading"><div><span className="eyebrow"><BrainCircuit size={14} /> FSRS-6</span><h2>Ôn đúng lúc</h2></div><strong className="due-badge">{remaining} thẻ đến hạn</strong></div>
      {card ? <div className="flashcard-shell">
        <div className={`flashcard ${revealed ? "revealed" : ""}`}>
          <div><span>{card.skill}</span><h3>{String(card.front.prompt ?? card.front.word ?? "Nội dung ôn tập")}</h3><p>{String(card.front.instruction ?? "Nhớ lại câu trả lời trước khi lật thẻ.")}</p></div>
          {revealed && <div className="flashcard-answer"><small>ĐÁP ÁN</small><strong>{String(card.back.answer ?? card.back.meaning ?? "")}</strong><p>{String(card.back.explanation ?? "")}</p></div>}
        </div>
        {!revealed ? <button className="button button-primary button-wide" onClick={() => setRevealed(true)}>Hiện đáp án <ArrowRight size={17} /></button> : <div className="rating-grid">{[[1,"Quên"],[2,"Khó"],[3,"Tốt"],[4,"Dễ"]].map(([rating,label]) => <button key={rating} onClick={() => void rate(Number(rating))} disabled={ratingBusy}><strong>{label}</strong><span>{rating === 1 ? "Học lại" : rating === 2 ? "Khoảng ngắn" : rating === 3 ? "Theo lịch" : "Khoảng dài"}</span></button>)}</div>}
      </div> : <div className="empty-state study-empty"><Check size={26} /><h3>Hôm nay đã ôn xong</h3><p>Thẻ mới chỉ được tạo từ trận đấu thật và nội dung nguồn mở đã duyệt.</p></div>}
    </section>

    <aside className="study-aside">
      <section className="surface study-plan-card">
        <div className="panel-heading"><div><span className="eyebrow"><Sparkles size={14} /> AI STUDY PLAN</span><h2>{plan?.title ?? "Chưa có lộ trình"}</h2></div><Target size={20} /></div>
        {plan ? <><p>{plan.rationale_vi}</p><div className="plan-meta"><span>{plan.cefr_start ?? "?"} → {plan.cefr_target ?? "?"}</span><span>{plan.weekly_minutes} phút/tuần</span></div><div className="plan-list">{items.map((item) => <article key={item.id}><span>{String(item.sequence_number).padStart(2,"0")}</span><div><strong>{item.title}</strong><p>{item.objective}</p><small>{item.skill} · {item.target_minutes} phút{item.target_count ? ` · ${item.target_count} lượt` : ""}</small></div><button className={item.completed_at ? "plan-check complete" : "plan-check"} aria-label={item.completed_at ? "Đánh dấu chưa xong" : "Đánh dấu hoàn thành"} onClick={() => void togglePlanItem(item)}><Check size={16} /></button></article>)}</div></> : <p>Lexi sẽ dùng điểm kỹ năng, lỗi lặp lại và lịch sử FSRS thật để tạo kế hoạch 7 ngày.</p>}
        <button className="button button-secondary button-wide" onClick={() => void generatePlan()} disabled={planBusy}>{planBusy ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />} {plan ? "Tạo lại từ dữ liệu mới" : "Tạo lộ trình cá nhân"}</button>
      </section>
    </aside>

    <section className="surface error-notebook">
      <div className="panel-heading"><div><span className="eyebrow"><CircleAlert size={14} /> ERROR NOTEBOOK</span><h2>Lỗi cần xử lý</h2></div><div className="error-skill-summary">{Object.entries(skillCounts).slice(0,4).map(([skill,count]) => <span key={skill}>{skill} {count}</span>)}</div></div>
      {errors.length ? <div className="error-list">{errors.map((item) => <article key={item.id}><div className="error-count">×{item.occurrence_count}</div><div><span>{item.skill} · {item.error_type.replaceAll("_"," ")}</span><h3>{item.prompt}</h3><p className="learner-error">Bạn trả lời: {item.learner_answer}</p><p className="expected-answer">Đúng: {item.expected_answer}</p>{item.explanation && <small>{item.explanation}</small>}</div><button className="suggestion" onClick={() => void resolveError(item.id)}><Check size={15} /> Đã hiểu</button></article>)}</div> : <div className="empty-inline">Không còn lỗi chưa xử lý. Lỗi mới chỉ xuất hiện sau bài làm thật.</div>}
    </section>
  </div>;
}
