"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Gauge, Headphones, LoaderCircle, Play, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";

type Item = { id: string; position: number; skill: string; cefrLevel: string; prompt: string; instruction: string; publicData: { options?: string[]; contextText?: string | null; hasAudio?: boolean } };
type Session = { id: string; status: string; responseCount: number; targetCount: number; estimatedCefr: string | null; confidence: number; standardError: number | null; updatedAt: string; result: { estimatedCefr?: string; theta?: number; standardError?: number; confidence?: number; responses?: number } | null; item: Item | null };
type Grading = { correct?: boolean; canonicalAnswer?: string; explanation?: string };

export function PlacementExperience() {
  const [session, setSession] = useState<Session | null>(null);
  const [nextSession, setNextSession] = useState<Session | null>(null);
  const [grading, setGrading] = useState<Grading | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(0);
  const itemStartedAt = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/placement", { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Không đọc được placement");
        setSession(body.session);
      }).catch((error) => toast.error(error instanceof Error ? error.message : "Không đọc được placement")).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!session?.item?.id) return;
    itemStartedAt.current = Date.now();
  }, [session?.item?.id]);

  useEffect(() => {
    if (!session || session.status === "completed" || session.item || !["active", "generating"].includes(session.status)) return;
    const initial = window.setTimeout(() => setClock(Date.now()), 0);
    const timer = window.setInterval(() => {
      setClock(Date.now());
      void fetch("/api/placement", { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (response.ok && body.session) setSession(body.session);
      }).catch(() => undefined);
    }, 2000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [session]);

  async function start() {
    setBusy(true); setGrading(null); setSelected("");
    try {
      const response = await fetch("/api/placement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", targetCount: 18 }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không bắt đầu được placement");
      setSession(body.session); itemStartedAt.current = Date.now();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không bắt đầu được placement"); }
    finally { setBusy(false); }
  }

  async function answer() {
    if (!session?.item || !selected || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/placement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "answer", sessionId: session.id, itemId: session.item.id, requestId: crypto.randomUUID(), answer: selected, responseMs: Date.now() - itemStartedAt.current }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không chấm được placement item");
      setGrading(body.grading); setNextSession(body.session);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không chấm được placement item"); }
    finally { setBusy(false); }
  }

  async function resume() {
    if (!session) return;
    setBusy(true);
    try {
      const response = await fetch("/api/placement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume", sessionId: session.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Không khôi phục được placement");
      setSession(body.session); itemStartedAt.current = Date.now();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không khôi phục được placement"); }
    finally { setBusy(false); }
  }

  function continuePlacement() {
    setSession(nextSession); setNextSession(null); setGrading(null); setSelected(""); itemStartedAt.current = Date.now();
  }

  if (loading) return <section className="surface placement-shell"><LoaderCircle className="animate-spin" /><p>Đang đọc assessment thật từ Supabase…</p></section>;
  if (!session || ["completed", "abandoned", "failed"].includes(session.status)) {
    const result = session?.status === "completed" ? session.result : null;
    const failed = session?.status === "failed";
    return <section className="surface placement-shell placement-intro"><Gauge size={42} className="text-accent" />{result ? <><span className="eyebrow">DIAGNOSTIC RESULT</span><h2>{result.estimatedCefr ?? session?.estimatedCefr}</h2><div className="placement-result-grid"><div><span>Độ tin cậy</span><strong>{Math.round(Number(result.confidence ?? session?.confidence ?? 0) * 100)}%</strong></div><div><span>Sai số chuẩn</span><strong>±{Number(result.standardError ?? session?.standardError ?? 0).toFixed(2)}</strong></div><div><span>Bằng chứng</span><strong>{result.responses ?? session?.responseCount} câu</strong></div></div><p>Đây là ước lượng chẩn đoán để cá nhân hóa LexiDuel, không phải chứng chỉ CEFR chính thức.</p></> : <>{failed && <span className="eyebrow review-wrong">ASSESSMENT INTERRUPTED</span>}<h2>{failed ? "Phiên đánh giá chưa hoàn tất" : "Adaptive CEFR placement"}</h2><p>{failed ? "Bạn có thể bắt đầu phiên mới; kết quả dở dang không được dùng làm mức năng lực." : "18 câu được sinh theo năng lực hiện tại, xen kẽ vocabulary, grammar, reading và listening. Không có câu hỏi mẫu được lưu sẵn."}</p></>}<button className="button button-primary" onClick={() => void start()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" size={17} /> : result || failed ? <RotateCcw size={17} /> : <Play size={17} />}{result ? "Đánh giá lại" : failed ? "Bắt đầu phiên mới" : "Bắt đầu đánh giá"}</button></section>;
  }
  if (session.status === "generating" || !session.item) { const stale = clock > 0 && clock - new Date(session.updatedAt).getTime() > 120_000; return <section className="surface placement-shell"><LoaderCircle className="animate-spin" /><h2>Đang tạo câu thích ứng tiếp theo</h2><p>Groq đang căn độ khó theo toàn bộ câu trả lời vừa ghi nhận.</p>{stale && <button className="button button-secondary" disabled={busy} onClick={() => void resume()}><RotateCcw size={16} />Khôi phục generation</button>}</section>; }
  const item = session.item;
  if (grading) return <section className="surface placement-shell placement-feedback">{grading.correct ? <CheckCircle2 className="text-accent" size={38} /> : <XCircle className="review-wrong" size={38} />}<h2>{grading.correct ? "Chính xác" : `Đáp án: ${grading.canonicalAnswer}`}</h2><p>{grading.explanation}</p><button className="button button-primary" onClick={continuePlacement}>{nextSession?.status === "completed" ? "Xem kết quả" : "Câu tiếp theo"}<ArrowRight size={17} /></button></section>;
  return <section className="surface placement-card"><div className="placement-progress"><div><span>{item.skill.replaceAll("_", " ")} · target {item.cefrLevel}</span><strong>{session.responseCount + 1}/{session.targetCount}</strong></div><div><span style={{ width: `${Math.round(session.responseCount / session.targetCount * 100)}%` }} /></div></div><p className="placement-instruction">{item.instruction}</p>{item.publicData.contextText && <blockquote>{item.publicData.contextText}</blockquote>}{item.publicData.hasAudio && <audio className="placement-audio" controls preload="none" src={`/api/placement/items/${item.id}/audio`} aria-label="Placement listening audio" />}<h2>{item.prompt}</h2><div className="placement-options">{(item.publicData.options ?? []).map((option) => <button type="button" key={option} className={selected === option ? "selected" : ""} onClick={() => setSelected(option)}>{item.publicData.hasAudio && <Headphones size={15} />}{option}</button>)}</div><button className="button button-primary button-wide" disabled={!selected || busy} onClick={() => void answer()}>{busy ? <LoaderCircle className="animate-spin" size={17} /> : "Xác nhận"}</button></section>;
}
