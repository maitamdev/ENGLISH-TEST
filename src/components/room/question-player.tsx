"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, BookOpenText, Check, CircleStop, Headphones, Lightbulb,
  LoaderCircle, Mic, Play, RotateCcw, Volume2
} from "lucide-react";
import type { MatchSettings, PublicQuestion } from "@/types/game";

const spokenModes = new Set(["PRONUNCIATION", "SPEAKING", "ROLEPLAY", "DEBATE"]);

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
  if (question.mode === "LISTENING" || question.mode === "SPELLING") return <ListeningQuestion {...props} />;
  if (question.mode === "READING") return <ReadingQuestion {...props} />;
  if (question.mode === "MULTIPLE_CHOICE") return <MultipleChoiceQuestion {...props} />;
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
  const { question, settings } = props;
  const [plays, setPlays] = useState(0);
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const limit = Number(question.publicData?.replayLimit ?? settings.replayLimit);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  async function playAudio() {
    if (plays >= limit || loading) return;
    setLoading(true);
    try {
      let url = audioUrl;
      if (!url) {
        const response = await fetch(`/api/ai/tts?questionId=${encodeURIComponent(question.id)}`, { cache: "force-cache" });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Không tạo được audio");
        url = URL.createObjectURL(await response.blob());
        setAudioUrl(url);
      }
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.playbackRate = settings.listeningSpeed;
      await audio.play();
      setPlays((count) => count + 1);
    } catch {
      const fallback = typeof question.publicData?.audioText === "string" ? question.publicData.audioText : "";
      if ("speechSynthesis" in window && fallback) {
        const utterance = new SpeechSynthesisUtterance(fallback);
        utterance.lang = settings.listeningAccent === "UK" ? "en-GB" : settings.listeningAccent === "AU" ? "en-AU" : "en-US";
        utterance.rate = settings.listeningSpeed;
        window.speechSynthesis.speak(utterance);
        setPlays((count) => count + 1);
      }
    } finally { setLoading(false); }
  }

  return <>
    <QuestionPrompt question={question} />
    <div className="listening-console">
      <div className="listening-orb"><Headphones size={30} /></div>
      <div><strong>Nghe kỹ trước khi trả lời</strong><span>{plays}/{limit} lượt nghe đã dùng · {settings.listeningAccent} · {settings.listeningSpeed}x</span></div>
      <button type="button" className="button button-secondary" onClick={playAudio} disabled={plays >= limit || loading}>{loading ? <LoaderCircle size={17} className="animate-spin" /> : plays === 0 ? <Play size={17} /> : <RotateCcw size={17} />}{plays === 0 ? "Phát audio" : plays < limit ? "Nghe lại" : "Đã hết lượt"}</button>
    </div>
    {strings(question.publicData?.options).length > 1
      ? <MultipleChoiceQuestion {...props} question={{ ...question, prompt: "", instruction: "" }} />
      : <TextQuestion {...props} question={{ ...question, prompt: "", instruction: "" }} />}
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
    {typeof question.publicData?.targetText === "string" && <div className="speaking-target"><Volume2 size={17} /><span>Câu mẫu</span><strong>{question.publicData.targetText}</strong></div>}
    {typeof question.publicData?.scenario === "string" && <div className="roleplay-brief"><span>TÌNH HUỐNG</span><p>{question.publicData.scenario}</p>{typeof question.publicData?.role === "string" && <strong>Vai của bạn: {question.publicData.role}</strong>}</div>}
    <div className={`recording-console ${recording ? "recording" : ""}`}>
      <div className="recording-meter"><span /><span /><span /><span /><span /></div>
      <strong>{processing ? "Gemini đang nghe lại và chấm theo rubric" : recording ? `Đang ghi âm ${elapsed}s / ${recordingLimit}s` : "Câu trả lời được chấm từ audio thật"}</strong>
      <p>AI đánh giá nội dung, phát âm, độ trôi chảy, ngữ pháp và từ vựng. Audio không được lưu lâu dài.</p>
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
