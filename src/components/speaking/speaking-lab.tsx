"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Mic, RotateCcw, Square, Sparkles, Volume2 } from "lucide-react";
import { toast } from "sonner";

type Scenario = { learnerRole?: string; aiRole?: string; goal?: string; setting?: string; successCriteria?: string[]; usefulLanguage?: string[] };
type Session = { id: string; title: string; scenario: Scenario; cefr_level: string; status: string; max_turns: number; current_turn: number };
type Assessment = { task?: number; intelligibility?: number; pronunciation?: number; fluency?: number; grammar?: number; vocabulary?: number; overall?: number; feedbackVi?: string; corrections?: { original: string; improved: string; reasonVi: string }[]; strengths?: string[]; nextFocus?: string };
type Turn = { id: string; turn_number: number; speaker_type: "learner" | "peer" | "ai"; transcript: string; prompt_context?: Record<string, unknown>; assessment?: Assessment | null; completed_at?: string };

const SCENARIOS = [
  ["roleplay", "Nhập vai"], ["interview", "Phỏng vấn"], ["debate", "Tranh luận"],
  ["storytelling", "Kể chuyện"], ["problem_solving", "Giải quyết vấn đề"], ["free_conversation", "Trò chuyện tự do"]
] as const;

export function SpeakingLab({ initialSession, initialTurns }: { initialSession: Session | null; initialTurns: Turn[] }) {
  const [session, setSession] = useState(initialSession);
  const [turns, setTurns] = useState(initialTurns);
  const [scenarioType, setScenarioType] = useState("roleplay");
  const [topic, setTopic] = useState("");
  const [cefr, setCefr] = useState("B1");
  const [exchanges, setExchanges] = useState(6);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  async function playTurn(turnId: string) {
    try {
      const audio = new Audio(`/api/speaking/turns/${turnId}/audio`);
      await audio.play();
    } catch { toast.error("Trình duyệt chưa phát được giọng AI. Bấm nút loa để thử lại."); }
  }

  async function createSession() {
    if (topic.trim().length < 3) return toast.error("Hãy nhập chủ đề cụ thể hơn.");
    setBusy(true);
    try {
      const response = await fetch("/api/speaking/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenarioType, topic, cefrLevel: cefr, exchanges }) });
      const body = await response.json() as { error?: string; session?: Session; turns?: Turn[] };
      if (!response.ok || !body.session) throw new Error(body.error ?? "Không tạo được buổi nói");
      setSession(body.session); setTurns(body.turns ?? []);
      const opening = body.turns?.[0]; if (opening) void playTurn(opening.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không tạo được buổi nói"); }
    finally { setBusy(false); }
  }

  async function sendAudio(blob: Blob) {
    if (!session) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("requestId", crypto.randomUUID());
      form.set("audio", new File([blob], "speaking-turn.webm", { type: blob.type || "audio/webm" }));
      const response = await fetch(`/api/speaking/sessions/${session.id}/turns`, { method: "POST", body: form });
      const body = await response.json() as { error?: string; learnerTurn?: Turn; aiTurn?: Turn; status?: string };
      if (!response.ok || !body.learnerTurn || !body.aiTurn) throw new Error(body.error ?? "Không chấm được lượt nói");
      setTurns((current) => [...current, body.learnerTurn!, body.aiTurn!]);
      setSession((current) => current ? { ...current, status: body.status ?? current.status, current_turn: body.aiTurn!.turn_number } : current);
      void playTurn(body.aiTurn.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Không chấm được lượt nói"); }
    finally { setBusy(false); }
  }

  async function startRecording() {
    if (!session || busy || session.status === "completed") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream; chunksRef.current = [];
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferred });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        stream.getTracks().forEach((track) => track.stop()); streamRef.current = null;
        if (blob.size >= 1000) void sendAudio(blob); else toast.error("Đoạn ghi âm quá ngắn.");
      };
      recorder.start(250); setRecording(true);
    } catch { toast.error("Không mở được micro. Hãy kiểm tra quyền micro trong trình duyệt."); }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  }

  if (!session) return <section className="surface speaking-setup">
    <div><span className="eyebrow"><Sparkles size={14} /> GEMINI SPEAKING LAB</span><h2>Tạo một cuộc hội thoại có mục tiêu.</h2><p>Gemini sẽ tạo tình huống mới từ chủ đề của bạn. Không có hội thoại mẫu được chèn sẵn.</p></div>
    <div className="speaking-settings">
      <label className="field"><span>Kiểu luyện</span><select className="select" value={scenarioType} onChange={(event) => setScenarioType(event.target.value)}>{SCENARIOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>Trình độ</span><select className="select" value={cefr} onChange={(event) => setCefr(event.target.value)}>{["A1","A2","B1","B2","C1","C2"].map((level) => <option key={level}>{level}</option>)}</select></label>
      <label className="field"><span>Số lượt trả lời</span><select className="select" value={exchanges} onChange={(event) => setExchanges(Number(event.target.value))}>{[3,4,5,6,8,10,12].map((count) => <option key={count}>{count}</option>)}</select></label>
      <label className="field speaking-topic"><span>Bạn muốn nói về gì?</span><textarea value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Ví dụ: phỏng vấn xin việc frontend ở công ty quốc tế" maxLength={240} /></label>
    </div>
    <button className="button button-primary" disabled={busy || topic.trim().length < 3} onClick={() => void createSession()}>{busy ? <LoaderCircle className="animate-spin" size={18} /> : <Sparkles size={18} />} Tạo buổi nói thật</button>
  </section>;

  const scenario = session.scenario ?? {};
  return <div className="speaking-workspace">
    <aside className="surface speaking-brief"><span className="eyebrow">{session.cefr_level} · {session.status === "completed" ? "HOÀN THÀNH" : "ĐANG LUYỆN"}</span><h1>{session.title}</h1><dl><dt>Bối cảnh</dt><dd>{scenario.setting}</dd><dt>Vai của bạn</dt><dd>{scenario.learnerRole}</dd><dt>Mục tiêu</dt><dd>{scenario.goal}</dd></dl>{scenario.usefulLanguage?.length ? <div><h3>Ngôn ngữ hữu ích</h3>{scenario.usefulLanguage.map((item) => <span className="mode-chip" key={item}>{item}</span>)}</div> : null}<button className="button button-ghost" onClick={() => { setSession(null); setTurns([]); }}><RotateCcw size={16} /> Buổi mới</button></aside>
    <section className="surface speaking-conversation">
      <div className="speaking-turns" aria-live="polite">{turns.map((turn) => <article className={`speaking-turn ${turn.speaker_type}`} key={turn.id}><div className="speaking-turn-head">{turn.speaker_type === "ai" ? <><Bot size={17} /> Gemini</> : <><Mic size={17} /> Bạn</>}<span>Lượt {turn.turn_number}</span></div><p>{turn.transcript}</p>{turn.speaker_type === "ai" ? <button className="icon-button speaking-play" aria-label="Phát giọng Gemini" onClick={() => void playTurn(turn.id)}><Volume2 size={17} /></button> : turn.assessment ? <AssessmentCard value={turn.assessment} /> : null}</article>)}</div>
      <div className="speaking-recorder">{session.status === "completed" ? <div><strong>Đã hoàn thành buổi nói</strong><p>Rubric từng lượt đã được lưu để lộ trình học có thể dùng làm bằng chứng.</p><button className="button button-primary" onClick={() => { setSession(null); setTurns([]); }}>Tạo buổi tiếp theo</button></div> : <><p>{busy ? "Gemini đang nghe, chấm và chuẩn bị câu đáp..." : recording ? "Đang ghi âm. Nói tự nhiên rồi bấm dừng." : "Bấm micro và trả lời bằng tiếng Anh."}</p><button className={`record-button ${recording ? "recording" : ""}`} disabled={busy} onClick={recording ? stopRecording : () => void startRecording()}>{busy ? <LoaderCircle className="animate-spin" /> : recording ? <Square /> : <Mic />}</button></>}</div>
    </section>
  </div>;
}

function AssessmentCard({ value }: { value: Assessment }) {
  return <div className="turn-assessment"><div className="assessment-score"><b>{Math.round(value.overall ?? 0)}</b><span>/100</span></div><div><p>{value.feedbackVi}</p><div className="assessment-metrics"><span>Dễ hiểu {Math.round(value.intelligibility ?? 0)}</span><span>Phát âm {Math.round(value.pronunciation ?? 0)}</span><span>Trôi chảy {Math.round(value.fluency ?? 0)}</span><span>Ngữ pháp {Math.round(value.grammar ?? 0)}</span></div>{value.corrections?.map((item, index) => <small key={`${item.original}:${index}`}><s>{item.original}</s> → <strong>{item.improved}</strong> · {item.reasonVi}</small>)}{value.nextFocus ? <em>Tiếp theo: {value.nextFocus}</em> : null}</div></div>;
}
