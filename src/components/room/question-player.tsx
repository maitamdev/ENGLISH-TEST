"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, BookOpenText, Check, CircleStop, Headphones, Lightbulb,
  LoaderCircle, Mic, Play, RotateCcw, Undo2, Volume2
} from "lucide-react";
import type { MatchSettings, PublicQuestion } from "@/types/game";

const spokenModes = new Set(["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE"]);
const listeningModes = new Set(["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING"]);

type Props = {
  question: PublicQuestion;
  value: string;
  settings: MatchSettings;
  seconds: number;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSpeakingSubmitted: () => void;
  onWritingSubmitted: () => void;
  onHint?: () => Promise<string | null>;
};

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function QuestionPlayer(props: Props) {
  const { question } = props;
  if (spokenModes.has(question.mode)) return <SpeakingQuestion {...props} />;
  if (question.mode === "WRITING") return <WritingQuestion {...props} />;
  if (listeningModes.has(question.mode)) return <ListeningQuestion {...props} />;
  if (question.mode === "READING") return <ReadingQuestion {...props} />;
  if (question.mode === "SENTENCE_BUILDER") return <SentenceBuilderQuestion {...props} />;
  if (question.mode === "MULTIPLE_CHOICE" || strings(question.publicData?.options).length > 1) return <MultipleChoiceQuestion {...props} />;
  return <TextQuestion {...props} />;
}

function WritingQuestion({ question, value, seconds, busy, settings, onChange, onWritingSubmitted, onHint }: Props) {
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState("");
  async function submitWriting() {
    if (!value.trim() || grading || busy) return;
    setGrading(true); setError("");
    try {
      const response = await fetch("/api/ai/grade-writing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, answer: value })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "AI chưa chấm được bài viết");
      onWritingSubmitted();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Không gửi được bài viết"); }
    finally { setGrading(false); }
  }
  return <>
    <QuestionPrompt question={question} />
    {typeof question.publicData?.writingRequirements === "string" && <div className="roleplay-brief"><span>YÊU CẦU</span><p>{question.publicData.writingRequirements}</p></div>}
    <div className="answer-form writing-answer"><textarea className="input answer-textarea" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Viết câu trả lời tiếng Anh của bạn" autoFocus maxLength={1500} /><div className="writing-meta"><span>{value.trim() ? value.trim().split(/\s+/u).length : 0} từ</span><button className="button button-primary" onClick={submitWriting} disabled={grading || busy || !value.trim() || seconds <= 0}>{grading ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />} {grading ? "Gemini đang chấm" : "Nộp bài viết"}</button></div></div>
    {error && <div className="gemini-error">{error}</div>}
    <HintAction enabled={settings.allowHints} onHint={onHint} />
  </>;
}

function TextQuestion({ question, value, seconds, busy, settings, onChange, onSubmit, onHint }: Props) {
  return <>
    <QuestionPrompt question={question} />
    <form className="answer-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {question.mode === "WRITING"
        ? <textarea className="input answer-textarea" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Viết câu trả lời của bạn" autoFocus maxLength={1500} />
        : <input className="input" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Nhập câu trả lời" autoFocus maxLength={500} />}
      <button className="button button-primary" disabled={busy || !value.trim() || seconds <= 0}>Nộp đáp án <ArrowRight size={17} /></button>
    </form>
    <HintAction enabled={settings.allowHints} onHint={onHint} />
  </>;
}

function MultipleChoiceQuestion({ question, value, seconds, busy, settings, onChange, onSubmit, onHint }: Props) {
  const options = useMemo(() => strings(question.publicData?.options), [question.publicData]);
  return <>
    <QuestionPrompt question={question} />
    <div className="choice-grid" role="radiogroup" aria-label="Đáp án">
      {options.map((option, index) => <button type="button" key={`${option}-${index}`} role="radio" aria-checked={value === option} className={`choice-option ${value === option ? "selected" : ""}`} onClick={() => onChange(option)}>
        <span>{String.fromCharCode(65 + index)}</span><strong>{option}</strong>{value === option && <Check size={18} />}
      </button>)}
    </div>
    <button className="button button-primary button-wide" onClick={onSubmit} disabled={busy || !value || seconds <= 0}>Chốt đáp án <ArrowRight size={17} /></button>
    <HintAction enabled={settings.allowHints} onHint={onHint} />
  </>;
}

function ReadingQuestion(props: Props) {
  const passage = typeof props.question.publicData?.passage === "string" ? props.question.publicData.passage : "";
  const options = strings(props.question.publicData?.options);
  return <>
    {passage && <article className="reading-passage"><span><BookOpenText size={16} /> ĐOẠN ĐỌC</span><p>{passage}</p></article>}
    {options.length > 0 ? <MultipleChoiceQuestion {...props} /> : <TextQuestion {...props} />}
  </>;
}

function ListeningQuestion(props: Props) {
  const { question } = props;
  return <>
    <QuestionPrompt question={question} />
    <AudioConsole question={question} settings={props.settings} />
    {strings(question.publicData?.options).length > 1
      ? <MultipleChoiceQuestion {...props} question={{ ...question, prompt: "", instruction: "" }} />
      : <TextQuestion {...props} question={{ ...question, prompt: "", instruction: "" }} />}
  </>;
}

function AudioConsole({ question, settings }: Pick<Props, "question" | "settings">) {
  const [plays, setPlays] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const limit = Number(question.publicData?.replayLimit ?? settings.replayLimit);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    const load = async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(`/api/ai/tts?questionId=${encodeURIComponent(question.id)}`, { cache: "force-cache", signal: controller.signal });
        if (response.status === 425 && attempt < 3) { await new Promise((resolve) => window.setTimeout(resolve, 1500 * (attempt + 1))); continue; }
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Không tạo được audio");
        return response;
      }
      throw new Error("Gemini vẫn đang chuẩn bị audio");
    };
    load()
      .then(async (response) => {
        objectUrl = URL.createObjectURL(await response.blob());
        const audio = new Audio(objectUrl);
        audio.playbackRate = settings.listeningSpeed;
        audioRef.current = audio;
      })
      .catch((caught: Error) => { if (caught.name !== "AbortError") setError(caught.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); audioRef.current?.pause(); audioRef.current = null; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [question.id, settings.listeningSpeed]);

  async function playAudio() {
    if (plays >= limit || loading) return;
    setLoading(true);
    setError("");
    try {
      const audio = audioRef.current;
      if (!audio) throw new Error("Audio chưa sẵn sàng");
      await audio.play();
      setPlays((count) => count + 1);
    } catch {
      setError("Chưa tải được giọng Gemini. Hãy kiểm tra cấu hình Gemini TTS rồi thử lại.");
    } finally { setLoading(false); }
  }

  return <>
    <div className="listening-console">
      <div className="listening-orb"><Headphones size={30} /></div>
      <div><strong>{question.mode === "SHADOWING" ? "Nghe mẫu trước khi bắt chước" : question.mode === "STORY_LISTENING" ? "Nghe hết câu chuyện trước khi trả lời" : "Nghe kỹ trước khi trả lời"}</strong><span>{plays}/{limit} lượt nghe đã dùng · {settings.listeningAccent} · {settings.listeningSpeed}x</span></div>
      <button type="button" className="button button-secondary" onClick={playAudio} disabled={plays >= limit || loading}>{loading ? <LoaderCircle size={17} className="animate-spin" /> : plays === 0 ? <Play size={17} /> : <RotateCcw size={17} />}{loading ? "Đang chuẩn bị" : plays === 0 ? "Phát audio" : plays < limit ? "Nghe lại" : "Đã hết lượt"}</button>
    </div>
    {error && <div className="gemini-error">{error}</div>}
  </>;
}

type BuilderToken = { id: number; text: string };

function SentenceBuilderQuestion({ question, seconds, busy, settings, onChange, onSubmit, onHint }: Props) {
  const [available, setAvailable] = useState<BuilderToken[]>(() => strings(question.publicData?.tokens).map((text, id) => ({ id, text })));
  const [selected, setSelected] = useState<BuilderToken[]>([]);

  function publish(next: BuilderToken[]) {
    setSelected(next);
    onChange(next.map((token) => token.text).join(" "));
  }
  function choose(token: BuilderToken) {
    setAvailable((items) => items.filter((item) => item.id !== token.id));
    publish([...selected, token]);
  }
  function undo() {
    const token = selected.at(-1);
    if (!token) return;
    setAvailable((items) => [...items, token].sort((a, b) => a.id - b.id));
    publish(selected.slice(0, -1));
  }
  function reset() {
    setAvailable([...available, ...selected].sort((a, b) => a.id - b.id));
    publish([]);
  }

  return <>
    <QuestionPrompt question={question} />
    <div className="sentence-builder" aria-label="Xếp câu">
      <div className={`sentence-built ${selected.length === 0 ? "empty" : ""}`} aria-live="polite">{selected.length > 0 ? selected.map((token) => <span key={token.id}>{token.text}</span>) : <p>Chọn từng từ để ghép câu</p>}</div>
      <div className="sentence-bank">{available.map((token) => <button type="button" key={token.id} onClick={() => choose(token)}>{token.text}</button>)}</div>
      <div className="sentence-actions"><button type="button" className="suggestion" onClick={undo} disabled={selected.length === 0}><Undo2 size={15} /> Hoàn tác</button><button type="button" className="suggestion" onClick={reset} disabled={selected.length === 0}><RotateCcw size={15} /> Làm lại</button></div>
    </div>
    <button className="button button-primary button-wide" onClick={onSubmit} disabled={busy || selected.length === 0 || available.length > 0 || seconds <= 0}>Chốt câu <ArrowRight size={17} /></button>
    <HintAction enabled={settings.allowHints} onHint={onHint} />
  </>;
}

function SpeakingQuestion({ question, settings, seconds, onSpeakingSubmitted, onHint }: Props) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordingLimit, setRecordingLimit] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const availableSeconds = Math.max(1, Math.min(seconds, Number(question.publicData?.maxSeconds ?? settings.speakingSeconds)));

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => void uploadRecording(recorder.mimeType || "audio/webm");
      startedRef.current = Date.now();
      setElapsed(0);
      setRecordingLimit(availableSeconds);
      setRecording(true);
      recorder.start(250);
      timerRef.current = window.setInterval(() => {
        const current = Math.floor((Date.now() - startedRef.current) / 1000);
        setElapsed(current);
        if (current >= availableSeconds) stopRecording();
      }, 250);
    } catch { setError("Không mở được micro. Hãy cho phép trình duyệt sử dụng micro rồi thử lại."); }
  }

  function stopRecording() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    setRecording(false);
  }

  async function uploadRecording(mimeType: string) {
    const stream = recorderRef.current?.stream;
    setProcessing(true);
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size < 1000) throw new Error("Đoạn ghi âm quá ngắn. Hãy nói rõ hơn rồi thử lại.");
      const data = new FormData();
      data.set("questionId", question.id);
      data.set("audio", blob, `answer.${mimeType.includes("ogg") ? "ogg" : "webm"}`);
      const response = await fetch("/api/ai/grade-speaking", { method: "POST", body: data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "AI chưa chấm được câu nói này");
      onSpeakingSubmitted();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Không gửi được đoạn ghi âm"); }
    finally { stream?.getTracks().forEach((track) => track.stop()); setProcessing(false); }
  }

  return <>
    <QuestionPrompt question={question} />
    {question.mode === "SHADOWING" && <AudioConsole question={question} settings={settings} />}
    {question.mode !== "SHADOWING" && typeof question.publicData?.targetText === "string" && <div className="speaking-target"><Volume2 size={17} /><span>Câu mẫu</span><strong>{question.publicData.targetText}</strong></div>}
    {typeof question.publicData?.scenario === "string" && <div className="roleplay-brief"><span>TÌNH HUỐNG</span><p>{question.publicData.scenario}</p>{typeof question.publicData?.role === "string" && <strong>Vai của bạn: {question.publicData.role}</strong>}</div>}
    <div className={`recording-console ${recording ? "recording" : ""}`}>
      <div className="recording-meter"><span /><span /><span /><span /><span /></div>
      <strong>{processing ? "Gemini đang nghe lại và chấm theo rubric" : recording ? `Đang ghi âm ${elapsed}s / ${recordingLimit}s` : "Câu trả lời được chấm từ audio thật"}</strong>
      <p>{question.mode === "SHADOWING" ? "AI so với câu mẫu và chấm độ chính xác, độ dễ hiểu, trọng âm, nhịp điệu, ngữ điệu. Audio không được lưu lâu dài." : "AI đánh giá nội dung, phát âm, độ trôi chảy, ngữ pháp và từ vựng. Audio không được lưu lâu dài."}</p>
      {processing ? <button className="button button-primary" disabled><LoaderCircle size={17} className="animate-spin" /> Đang chấm</button> : recording ? <button className="button button-danger" onClick={stopRecording}><CircleStop size={17} /> Dừng và nộp</button> : <button className="button button-primary" onClick={startRecording} disabled={seconds <= 0}><Mic size={17} /> Bắt đầu nói</button>}
    </div>
    {error && <div className="gemini-error">{error}</div>}
    <HintAction enabled={settings.allowHints} onHint={onHint} />
  </>;
}

function QuestionPrompt({ question, hidePrompt = false }: { question: PublicQuestion; hidePrompt?: boolean }) {
  return <div className="question-copy">{!hidePrompt && question.prompt && <h1>{question.prompt}</h1>}<p>{question.instruction}</p></div>;
}

function HintAction({ enabled, onHint }: { enabled: boolean; onHint?: () => Promise<string | null> }) {
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(false);
  if (!enabled || !onHint) return null;
  return <div className="hint-row">{hint ? <p><Lightbulb size={16} /> {hint}</p> : <button type="button" className="suggestion" disabled={loading} onClick={async () => { setLoading(true); try { setHint((await onHint()) ?? "AI chưa có gợi ý cho câu này."); } finally { setLoading(false); } }}>{loading ? <LoaderCircle size={15} className="animate-spin" /> : <Lightbulb size={15} />} Xin một gợi ý</button>}</div>;
}
