"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { 
  ArrowRight, AudioLines, Bot, CheckCircle2, Copy, Crown, 
  Headphones, LoaderCircle, LockKeyhole, LogOut, Mic, MicOff, 
  Play, RotateCcw, Settings, Sparkles, Volume2, VolumeX, X, XCircle 
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { Brand } from "@/components/brand";
import { Waveform } from "@/components/waveform";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useGeminiLive } from "@/hooks/use-gemini-live";
import { useRoomControlsStore } from "@/stores/room-store";
import type { RoomBootstrap, RoomMemberData, RoundResolutionData } from "@/types/data";

type Signal = { from: string; to: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export function RoomExperience({ initial }: { initial: RoomBootstrap }) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const room = initial;
  const isHost = room.currentUserId === room.hostId;
  const activeQuestion = room.match?.question;
  const activeRoundStartedAt = room.match?.roundStartedAt;
  const activePhase = room.phase;
  const hasSubmittedCurrent = Boolean(room.match?.submissions.some((item) => item.userId === room.currentUserId));
  const currentMember = room.members.find((member) => member.userId === room.currentUserId);
  const readyCount = room.members.filter((member) => member.isReady).length;
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [request, setRequest] = useState("");
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [resolutionState, setResolutionState] = useState<{ key: string; data: RoundResolutionData } | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [voiceConnected, setVoiceConnected] = useState(false);

  const { muted, deafened, toggleMute, toggleDeafen } = useRoomControlsStore();
  const gemini = useGeminiLive(room.roomId, {
    onGenerateMatch: room.phase === "ai-discussion" ? generateFromGemini : undefined,
    sessionMode: room.phase === "battle" || room.phase === "round-result" ? "coach" : "setup",
    sessionContext: activeQuestion ? `Câu hiện tại: ${activeQuestion.prompt}. Hướng dẫn: ${activeQuestion.instruction}. Không được đoán hoặc tiết lộ đáp án trước khi lượt chơi kết thúc.` : undefined
  });
  const channelRef = useRef<RealtimeChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const peerUserRef = useRef<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const startOfferRef = useRef<(() => Promise<void>) | null>(null);
  const timeoutSubmissionRef = useRef("");
  const advanceTriggeredRef = useRef("");
  const geminiQuestionRef = useRef("");
  const geminiEvaluationRef = useRef("");
  const onlineRef = useRef<string[]>([]);
  const membersRef = useRef<RoomMemberData[]>(initial.members);

  useEffect(() => { onlineRef.current = onlineIds; }, [onlineIds]);
  useEffect(() => { membersRef.current = room.members; }, [room.members]);

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion) return;
    const questionTimeLimit = activeQuestion.timeLimit;
    const update = () => {
      const began = activeRoundStartedAt ? new Date(activeRoundStartedAt).getTime() : Date.now();
      setSeconds(Math.max(0, questionTimeLimit - Math.floor((Date.now() - began) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [activePhase, activeQuestion, activeRoundStartedAt]);

  useEffect(() => {
    if (room.phase !== "countdown") return;
    const reset = window.setTimeout(() => setCountdown(3), 0);
    const interval = window.setInterval(() => setCountdown((value) => Math.max(1, value - 1)), 1000);
    const timer = isHost && room.match ? window.setTimeout(() => void run(() => api(`/api/matches/${room.match!.id}/start`, { method: "POST" })), 3000) : undefined;
    return () => { window.clearTimeout(reset); window.clearInterval(interval); if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.phase, room.match?.id, isHost]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.realtime.setAuth();
    const channel = supabase.channel(`room:${room.code}`, { config: { private: true, presence: { key: room.currentUserId } } });
    channelRef.current = channel;

    const signal = (payload: Omit<Signal, "from">) => channel.send({ type: "broadcast", event: "webrtc", payload: { ...payload, from: room.currentUserId } });
    const peerFor = (otherId: string) => {
      if (peerRef.current && peerUserRef.current === otherId) return peerRef.current;
      peerRef.current?.close();
      const servers: RTCIceServer[] = [];
      if (process.env.NEXT_PUBLIC_STUN_URL) servers.push({ urls: process.env.NEXT_PUBLIC_STUN_URL });
      if (process.env.NEXT_PUBLIC_TURN_URL && process.env.NEXT_PUBLIC_TURN_USERNAME && process.env.NEXT_PUBLIC_TURN_CREDENTIAL) {
        servers.push({ urls: process.env.NEXT_PUBLIC_TURN_URL, username: process.env.NEXT_PUBLIC_TURN_USERNAME, credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL });
      }
      const peer = new RTCPeerConnection({ iceServers: servers });
      peerUserRef.current = otherId;
      streamRef.current?.getTracks().forEach((track) => peer.addTrack(track, streamRef.current!));
      peer.onicecandidate = (event) => { if (event.candidate) void signal({ to: otherId, candidate: event.candidate.toJSON() }); };
      peer.ontrack = (event) => { if (remoteAudioRef.current) remoteAudioRef.current.srcObject = event.streams[0]; };
      peer.onconnectionstatechange = () => setVoiceConnected(peer.connectionState === "connected");
      peerRef.current = peer;
      return peer;
    };
    startOfferRef.current = async () => {
      const otherId = onlineRef.current.find((id) => id !== room.currentUserId) ?? membersRef.current.find((member) => member.userId !== room.currentUserId)?.userId;
      if (!otherId || !streamRef.current) return;
      const peer = peerFor(otherId);
      if (peer.signalingState !== "stable") return;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await signal({ to: otherId, description: offer });
    };

    channel
      .on("presence", { event: "sync" }, () => setOnlineIds(Object.keys(channel.presenceState())))
      .on("broadcast", { event: "refresh" }, () => router.refresh())
      .on("broadcast", { event: "webrtc" }, async ({ payload }: { payload: Signal }) => {
        if (payload.to !== room.currentUserId || payload.from === room.currentUserId) return;
        try {
          const peer = peerFor(payload.from);
          if (payload.description?.type === "offer") {
            await peer.setRemoteDescription(payload.description);
            const response = await peer.createAnswer();
            await peer.setLocalDescription(response);
            await signal({ to: payload.from, description: response });
          } else if (payload.description?.type === "answer") await peer.setRemoteDescription(payload.description);
          else if (payload.candidate) await peer.addIceCandidate(payload.candidate);
        } catch { toast.error("Could not negotiate the voice connection."); }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.roomId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${room.roomId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `room_id=eq.${room.roomId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => router.refresh())
      .subscribe(async (status) => { if (status === "SUBSCRIBED") await channel.track({ userId: room.currentUserId, onlineAt: new Date().toISOString() }); });

    return () => {
      startOfferRef.current = null;
      if (channelRef.current === channel) channelRef.current = null;
      void supabase.removeChannel(channel);
      peerRef.current?.close();
      peerRef.current = null;
    };
  }, [supabase, room.code, room.currentUserId, room.roomId, router]);

  useEffect(() => { if (isHost && micEnabled && onlineIds.some((id) => id !== room.currentUserId)) void startOfferRef.current?.(); }, [isHost, micEnabled, onlineIds, room.currentUserId]);
  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);
  useEffect(() => {
    const synchronization = window.setInterval(() => router.refresh(), 2000);
    return () => window.clearInterval(synchronization);
  }, [router, room.roomId]);
  useEffect(() => {
    if (room.phase !== "round-result" || !room.match) return;
    const matchId = room.match.id;
    const round = room.match.currentRound;
    let active = true;
    const controller = new AbortController();
    fetch(`/api/matches/${matchId}/resolution?round=${round}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
      return body as RoundResolutionData;
    }).then((body) => {
      if (active) setResolutionState({ key: `${matchId}:${round}`, data: body });
    }).catch((error: Error & { status?: number }) => {
      if (active && error.name !== "AbortError" && error.status !== 409) showError(error);
    });
    return () => { active = false; controller.abort(); };
  }, [room.phase, room.match?.id, room.match?.currentRound]);

  useEffect(() => {
    if (room.phase !== "battle" || !room.match?.question || !["listening", "speaking"].includes(gemini.status)) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (geminiQuestionRef.current === key) return;
    const sent = gemini.sendText([
      "HỆ_THỐNG_CÂU_MỚI",
      `Vòng ${room.match.currentRound}/${room.match.roundCount}.`,
      `Câu hỏi: ${room.match.question.prompt}`,
      `Hướng dẫn: ${room.match.question.instruction}`,
      `Thời gian: ${room.match.question.timeLimit} giây.`,
      "Hãy ghi nhớ câu hiện tại, tiếp tục lắng nghe hai người chơi và không tiết lộ đáp án trước khi cả hai nộp bài. Không cần đọc lại toàn bộ thông báo này."
    ].join("\n"));
    if (sent) geminiQuestionRef.current = key;
  }, [gemini.sendText, gemini.status, room.match?.currentRound, room.match?.id, room.match?.question, room.match?.roundCount, room.phase]);

  useEffect(() => {
    if (room.phase !== "round-result" || !room.match || !["listening", "speaking"].includes(gemini.status)) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (geminiEvaluationRef.current === key || resolutionState?.key !== key) return;
    const result = resolutionState.data;
    const playerResults = room.members.map((member) => {
      const submission = result.submissions.find((item) => item.userId === member.userId);
      if (!submission) return `${member.displayName}: không có câu trả lời.`;
      const verdict = submission.correct && submission.timedOut ? "đúng nhưng hết giờ" : submission.correct ? "đúng" : submission.timedOut ? "hết giờ" : "sai";
      return `${member.displayName}: trả lời “${submission.answer}”, ${verdict}, ${submission.points} điểm, ${(submission.responseMs / 1000).toFixed(2)} giây.`;
    });
    const sent = gemini.sendText([
      "HỆ_THỐNG_KẾT_QUẢ_VÒNG",
      `Vòng ${room.match.currentRound}/${room.match.roundCount} đã kết thúc vì cả hai người chơi đã trả lời.`,
      ...playerResults,
      `Đáp án đúng: ${result.canonicalAnswer}.`,
      `Các đáp án chấp nhận: ${result.acceptedAnswers.join(", ")}.`,
      `Giải thích: ${result.explanation}`,
      "Hãy đánh giá ngay bằng giọng nói tiếng Việt, thật ngắn gọn và thân thiện. Sau đó chờ hai người xác nhận NEXT ROUND."
    ].join("\n"));
    if (sent) geminiEvaluationRef.current = key;
  }, [gemini.sendText, gemini.status, resolutionState, room.match, room.members, room.phase]);

  useEffect(() => {
    if (room.phase !== "round-result" || !room.match || !isHost || readyCount !== 2) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (advanceTriggeredRef.current === key) return;
    advanceTriggeredRef.current = key;
    setBusy(true);
    void api(`/api/matches/${room.match.id}/advance`, { method: "POST" })
      .catch((error) => { advanceTriggeredRef.current = ""; showError(error); })
      .finally(() => setBusy(false));
    // The host advances only after the latest server-synchronized 2/2 ready state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, readyCount, room.match?.currentRound, room.match?.id, room.phase]);

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion || !activeRoundStartedAt || hasSubmittedCurrent) return;
    const questionKey = activeQuestion.id;
    const deadline = new Date(activeRoundStartedAt).getTime() + activeQuestion.timeLimit * 1000;
    const timer = window.setTimeout(() => {
      if (timeoutSubmissionRef.current === questionKey) return;
      timeoutSubmissionRef.current = questionKey;
      void api("/api/answers", { method: "POST", body: JSON.stringify({ questionId: questionKey, answer: "⏱ Hết giờ" }) })
        .catch((error) => { timeoutSubmissionRef.current = ""; showError(error); });
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
    // api is a component helper whose current room/channel state is intentionally used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhase, activeQuestion, activeRoundStartedAt, hasSubmittedCurrent]);

  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Request failed");
    await channelRef.current?.send({ type: "broadcast", event: "refresh", payload: { at: Date.now() } });
    router.refresh();
    return body;
  }

  async function run(task: () => Promise<unknown>) { setBusy(true); try { await task(); } catch (error) { showError(error); } finally { setBusy(false); } }
  const status = (value: string) => api(`/api/rooms/${room.roomId}/status`, { method: "PATCH", body: JSON.stringify({ status: value }) });

  async function getMicrophoneStream() {
    if (streamRef.current?.active) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = stream;
    setMicEnabled(true);
    if (isHost) window.setTimeout(() => void startOfferRef.current?.(), 100);
    return stream;
  }

  async function enableMic() {
    try {
      const stream = await getMicrophoneStream();
      toast.success("Microphone enabled.");
      if (room.phase === "ai-discussion" && (gemini.status === "off" || gemini.status === "error")) await gemini.start(stream);
    }
    catch { toast.error("Microphone permission was not granted."); }
  }

  async function startGemini() {
    try {
      const stream = await getMicrophoneStream();
      await gemini.start(stream);
    } catch { toast.error("Microphone permission was not granted."); }
  }

  async function leave() {
    await run(async () => {
      if (!supabase) throw new Error("Supabase is not configured");
      const { error } = await supabase.rpc("leave_room", { target_room_id: room.roomId });
      if (error) throw error;
      router.push("/dashboard");
    });
  }

  async function createMatch(matchRequest: string) {
    const brief = matchRequest.trim();
    if (!brief) throw new Error("Hãy nói hoặc nhập nội dung hai bạn muốn luyện.");
    if (room.members.length !== 2) throw new Error("Bạn của bạn phải vào phòng trước khi Gemini tạo trận.");
    setBusy(true);
    try {
      return await api("/api/ai/generate-game", { method: "POST", body: JSON.stringify({ roomId: room.roomId, request: brief }) }) as { matchId: string; blueprint: { title: string } };
    } finally {
      setBusy(false);
    }
  }

  async function generateFromGemini(brief: string) {
    setRequest(brief);
    try {
      const generated = await createMatch(brief);
      toast.success(`Match created: ${generated.blueprint.title}`);
      return { ok: true, message: `Đã tạo trận “${generated.blueprint.title}” và lưu vào phòng.`, data: { matchId: generated.matchId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate the match.";
      showError(error);
      return { ok: false, message };
    }
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!request.trim()) return toast.error("Describe what both players want to practice.");
    try { await createMatch(request); }
    catch (error) { showError(error); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const answer = room.match?.question ? answerDrafts[room.match.question.id] ?? "" : "";
    if (!room.match?.question || !answer.trim()) return;
    await run(async () => { await api("/api/answers", { method: "POST", body: JSON.stringify({ questionId: room.match!.question!.id, answer }) }); toast.success("Answer submitted. Waiting for the other player."); });
  }

  const submitted = hasSubmittedCurrent;
  const questionId = room.match?.question?.id;
  const answer = questionId ? answerDrafts[questionId] ?? "" : "";
  const roundExpired = Boolean(activeQuestion && activeRoundStartedAt && Date.now() >= new Date(activeRoundStartedAt).getTime() + activeQuestion.timeLimit * 1000);
  const resolutionKey = room.match ? `${room.match.id}:${room.match.currentRound}` : "";
  const resolution = resolutionState?.key === resolutionKey ? resolutionState.data : null;

  return <main className="room-page" suppressHydrationWarning>
    <audio ref={remoteAudioRef} autoPlay muted={deafened} />
    <header className="room-header"><div className="app-container room-header-inner"><div className="room-id"><Brand /><div className="room-code"><span>Room code</span><button onClick={() => { void navigator.clipboard.writeText(room.code); toast.success("Room code copied."); }}>{room.code}<Copy size={13} /></button></div></div><div className="room-actions"><button className="button button-secondary" onClick={() => setAudioOpen(true)}><Settings size={16} /><span>Settings</span></button><button className="button button-danger" onClick={leave} disabled={busy}><LogOut size={16} /><span>Leave</span></button></div></div></header>
    <section className="room-main"><div className="app-container room-content"><div className="room-status-line"><div className="status"><span className="status-dot" /> {onlineIds.length} online <span className="room-status-copy">Supabase Realtime</span></div><div className="room-status-copy" suppressHydrationWarning>{gemini.status === "listening" ? "Gemini is listening" : gemini.status === "speaking" ? "Gemini is speaking" : voiceConnected ? "Direct voice connected" : micEnabled ? "Waiting for voice peer" : "Microphone off"}</div></div>{renderPhase()}</div></section>
    <footer className="room-footer"><div className="app-container room-footer-inner"><div className="footer-meta"><LockKeyhole size={14} /> Private room</div><div className="voice-controls"><button className={`icon-button ${muted ? "danger" : ""}`} onClick={() => { toggleMute(); streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = muted; }); }} aria-label="Toggle microphone">{muted ? <MicOff size={19} /> : <Mic size={19} />}</button><button className={`icon-button ${deafened ? "danger" : ""}`} onClick={toggleDeafen} aria-label="Toggle audio">{deafened ? <VolumeX size={19} /> : <Headphones size={19} />}</button><button className="icon-button" onClick={() => setAudioOpen(true)} aria-label="Audio settings"><AudioLines size={19} /></button></div><div className="footer-meta end"><Volume2 size={14} /> WebRTC & Gemini Live</div></div></footer>
    {audioOpen && <div className="audio-popover" onMouseDown={(event) => { if (event.currentTarget === event.target) setAudioOpen(false); }}><section className="surface audio-dialog" role="dialog" aria-modal="true"><div className="panel-heading"><h2>Voice settings</h2><button className="icon-button" onClick={() => setAudioOpen(false)} aria-label="Close"><X size={18} /></button></div><div className="audio-grid"><p className="text-muted">Supabase carries private signaling; WebRTC and Gemini Live handle voice streaming.</p><button className="button button-primary" onClick={enableMic} disabled={micEnabled}>{micEnabled ? "Microphone enabled" : "Enable microphone"}</button></div></section></div>}
  </main>;

  function renderPhase() {
    const phase = room.phase;
    if (phase === "idle") return <RoomGrid members={room.members} online={onlineIds}><Bot size={32} className="text-accent" /><h1>Phòng đã sẵn sàng.</h1><p>Hai bạn có thể nói chuyện bình thường. Khi đủ hai người, một trong hai có thể bật Gemini để chọn nội dung học hoặc thi.</p>{room.members.length === 2 ? <button className="button button-primary" onClick={() => run(() => status("AI_DISCUSSION"))} disabled={busy}><Play size={18} /> Bật Gemini và setup trận</button> : <p className="waiting-copy">Gửi mã phòng cho bạn của bạn để bắt đầu.</p>}</RoomGrid>;
    if (phase === "ai-joining") return <Loading title="Connecting to Gemini Live" detail="Establishing low-latency voice connection with Lexi AI Host..." />;
    if (phase === "ai-discussion") return <RoomGrid members={room.members} online={onlineIds}>
      <div className="ai-badge"><Sparkles size={15} /> Gemini Live teacher</div>
      <div className={`ai-avatar ${gemini.status === "speaking" ? "speaking" : ""}`}><Image src="/images/lexi-host.png" alt="Lexi AI host" fill sizes="126px" /></div>
      <Waveform active={gemini.status === "listening" || gemini.status === "speaking"} bars={19} />
      <h1>{gemini.status === "listening" ? "Gemini is listening." : gemini.status === "speaking" ? "Gemini is speaking." : "Start a Gemini voice session."}</h1>
      <p>Micro của người bật AI chỉ được stream trong phiên Gemini Live này và có thể tắt bất cứ lúc nào.</p>
      <div className="gemini-controls">
        {gemini.status === "off" || gemini.status === "error" ? <button className="button button-primary" onClick={startGemini}><Mic size={17} /> Start Gemini listening</button> : <button className="button button-danger" onClick={gemini.stop}><MicOff size={17} /> Stop Gemini</button>}
        <span className={`gemini-status ${gemini.status}`}>{gemini.status}</span>
      </div>
      {gemini.error && <div className="gemini-error">{gemini.error}</div>}
      {gemini.inputTranscript && <div className="gemini-transcript"><span>You said</span><p>{gemini.inputTranscript}</p><button type="button" className="suggestion" onClick={() => setRequest(gemini.inputTranscript)}>Use as match brief</button></div>}
      {gemini.outputTranscript && <div className="ai-transcript">{gemini.outputTranscript}</div>}
      <form className="practice-request" onSubmit={generate}>
        <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Or type exactly what both players want to practise…" maxLength={1000} />
        <button className="button button-primary" disabled={busy || room.members.length !== 2}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />} Generate match</button>
        {room.members.length !== 2 && <small>Invite your friend first. Gemini will create the match as soon as both players are in the room.</small>}
      </form>
    </RoomGrid>;

    if (phase === "generating") return <Loading title="Đang tạo nội dung trận đấu" detail="Groq đang tạo từng nhóm tối đa 10 câu và nghỉ giữa các nhóm để không vượt giới hạn token. Cả hai cứ ở trong phòng; tạo đủ và kiểm tra xong hệ thống sẽ tự chuyển sang màn hình cấu hình." />;
    if (phase === "config") {
      if (!room.match) return <Loading title="No generated match yet" detail="Waiting for match data from Supabase." />;
      const plan = room.match.blueprint;
      return <section className="surface center-stage"><div className="config-card"><div className="config-card-head"><div className="ai-badge"><Sparkles size={15} /> Stored match blueprint</div><h1>{plan.title}</h1></div><div className="config-fields"><div className="config-field"><span>Topic</span><strong>{plan.topic}</strong></div><div className="config-field"><span>Rounds</span><strong>{plan.rounds}</strong></div><div className="config-field"><span>Timer</span><strong>{plan.timePerQuestion}s</strong></div><div className="config-field"><span>Difficulty</span><strong>{plan.difficulty}</strong></div></div><div className="mode-list">{plan.modes.map((mode) => <span className="mode-chip" key={mode.type}>{mode.type.replaceAll("_", " ")} · {mode.count}</span>)}</div><div className="ready-summary"><strong>{readyCount}/2 người đã sẵn sàng</strong><span>{readyCount === 0 ? "Cả hai hãy kiểm tra cấu hình rồi bấm START." : readyCount === 1 ? "Đang chờ người còn lại bấm START." : "Đủ hai người — đang vào trận."}</span></div><div className="config-actions"><button className={currentMember?.isReady ? "button button-secondary" : "button button-primary"} onClick={() => run(() => api(`/api/rooms/${room.roomId}/ready`, { method: "PATCH", body: JSON.stringify({ ready: !currentMember?.isReady }) }))} disabled={busy}>{currentMember?.isReady ? <><RotateCcw size={17} /> Hủy START</> : <><Play size={17} /> START — Tôi sẵn sàng</>}</button><button className="button button-secondary" onClick={() => run(() => status("AI_DISCUSSION"))} disabled={busy || readyCount > 0}>Generate another</button></div>{readyCount > 0 && <p className="waiting-copy">Muốn tạo lại nội dung, người đã START cần bấm Hủy START trước.</p>}</div></section>;
    }
    if (phase === "countdown") return <section className="surface center-stage"><div className="countdown">{countdown}</div><p>The server will open round one.</p></section>;
    if (phase === "battle" && room.match?.question) return <div className="battle-shell"><Scorebar members={room.members} title={room.match.title} round={room.match.currentRound} rounds={room.match.roundCount} seconds={seconds} /><section className="surface question-stage"><span className="mode-label">{room.match.question.mode.replaceAll("_", " ")}</span><h1>{room.match.question.prompt}</h1><p>{room.match.question.instruction}</p>{submitted ? <div className="answer-submitted"><CheckCircle2 size={28} className="text-accent" /><h2>Answer submitted</h2><p>Waiting for the other player.</p></div> : roundExpired ? <div className="answer-submitted"><XCircle size={28} className="review-wrong" /><h2>Hết giờ</h2><p>Đang ghi nhận lượt này và chờ người còn lại.</p></div> : <form className="answer-form" onSubmit={submit}><input className="input" value={answer} onChange={(event) => setAnswerDrafts((drafts) => ({ ...drafts, [room.match!.question!.id]: event.target.value }))} placeholder="Type your answer" autoFocus maxLength={500} /><button className="button button-primary" disabled={busy || !answer.trim() || seconds <= 0}>Submit <ArrowRight size={17} /></button></form>}<div className="answer-help">Đúng + nhanh hơn sẽ được nhiều điểm hơn. Người đúng đầu tiên nhận thêm điểm.</div><div className="battle-coach"><div className="gemini-controls">{gemini.status === "off" || gemini.status === "error" ? <button type="button" className="button button-secondary" onClick={startGemini}><Bot size={17} /> Bật Gemini trợ giảng</button> : <button type="button" className="button button-danger" onClick={gemini.stop}><MicOff size={17} /> Tắt Gemini</button>}<span className={`gemini-status ${gemini.status}`}>{gemini.status}</span></div>{gemini.error && <div className="gemini-error">{gemini.error}</div>}{gemini.outputTranscript && <div className="ai-transcript">{gemini.outputTranscript}</div>}</div></section></div>;
    if (phase === "round-result" && room.match) return <RoundResult room={room} data={resolution} currentReady={Boolean(currentMember?.isReady)} readyCount={readyCount} busy={busy} toggleReady={() => run(() => api(`/api/matches/${room.match!.id}/ready-next`, { method: "PATCH", body: JSON.stringify({ ready: !currentMember?.isReady }) }))} />;
    return <Result room={room} isHost={isHost} busy={busy} rematch={() => run(() => status("AI_DISCUSSION"))} />;
  }
}

function showError(error: unknown) { toast.error(error instanceof Error ? error.message : "Something went wrong"); }

function RoomGrid({ members, online, children }: { members: RoomMemberData[]; online: string[]; children: React.ReactNode }) {
  return <div className="room-grid"><Player member={members[0]} online={Boolean(members[0] && online.includes(members[0].userId))} /><section className="surface center-stage">{children}</section><Player member={members[1]} online={Boolean(members[1] && online.includes(members[1].userId))} /></div>;
}

function Player({ member, online }: { member?: RoomMemberData; online: boolean }) {
  if (!member) return <article className="surface player-panel empty-player"><div className="empty-avatar" /><h2>Open seat</h2><p>Waiting for a member to join.</p></article>;
  return <article className="surface player-panel"><Avatar name={member.displayName} src={member.avatarUrl ?? undefined} size={104} /><h2>{member.displayName}</h2><p>{online ? "Online" : "Offline"}</p><Waveform active={false} bars={11} />{member.score > 0 && <span className="player-score-small">{member.score}</span>}</article>;
}

function Loading({ title, detail }: { title: string; detail: string }) { return <section className="surface center-stage"><div className="ai-avatar"><Image src="/images/lexi-host.png" alt="Lexi AI host" fill sizes="126px" /></div><h1>{title}</h1><p>{detail}</p><LoaderCircle size={24} className="animate-spin text-accent" /></section>; }

function Scorebar({ members, title, round, rounds, seconds }: { members: RoomMemberData[]; title: string; round: number; rounds: number; seconds: number }) {
  return <section className="surface battle-scorebar">{members.slice(0, 1).map((member) => <div className="battle-player" key={member.userId}><Avatar name={member.displayName} src={member.avatarUrl ?? undefined} size={52} /><div><strong>{member.displayName}</strong><span>{member.streak} streak</span></div><span className="score">{member.score}</span></div>)}<div className="round-meta"><strong>{title}</strong><span>Round {round} / {rounds}</span><div className="timer-ring">{seconds}</div></div>{members.slice(1, 2).map((member) => <div className="battle-player right" key={member.userId}><Avatar name={member.displayName} src={member.avatarUrl ?? undefined} size={52} /><div><strong>{member.displayName}</strong><span>{member.streak} streak</span></div><span className="score">{member.score}</span></div>)}</section>;
}

function RoundResult({ room, data, currentReady, readyCount, busy, toggleReady }: { room: RoomBootstrap; data: RoundResolutionData | null; currentReady: boolean; readyCount: number; busy: boolean; toggleReady: () => void }) {
  if (!data) return <Loading title="Revealing the round" detail="Loading the protected answer and both real submissions." />;
  const isFinalRound = Boolean(room.match && room.match.currentRound >= room.match.roundCount);
  return <section className="surface center-stage"><div className="round-result-card"><div className="round-result-head"><CheckCircle2 size={30} className="text-accent" /><h1>{data.canonicalAnswer}</h1><p className="text-muted">{data.explanation}</p></div><div className="resolution-grid">{room.members.map((member) => { const submission = data.submissions.find((item) => item.userId === member.userId); const timedOut = Boolean(submission?.timedOut); const correct = Boolean(submission?.correct); return <article className="resolution" key={member.userId}><strong>{member.displayName}</strong><div className="resolution-answer">{submission?.answer === "⏱ Hết giờ" ? "Hết giờ" : submission?.answer ?? "Chưa trả lời"}</div><div className="resolution-meta"><span>{submission ? `${(submission.responseMs / 1000).toFixed(2)}s` : "—"}</span><span className={correct ? "text-accent" : "review-wrong"}>{!submission ? "Không có đáp án" : correct && timedOut ? "Đúng nhưng hết giờ · +0" : correct ? `Đúng · +${submission.points}` : timedOut ? "Hết giờ · +0" : "Sai · +0"}</span></div></article>; })}</div><div className="ai-transcript">Đáp án được chấp nhận: {data.acceptedAnswers.join(", ")}</div><div className="ready-summary"><strong>{readyCount}/2 người đã xác nhận</strong><span>{readyCount === 0 ? `Cả hai bấm ${isFinalRound ? "FINISH" : "NEXT ROUND"} khi đã xem xong kết quả.` : readyCount === 1 ? "Đang chờ người còn lại xác nhận." : isFinalRound ? "Đang chốt kết quả trận." : "Đang chuyển sang câu tiếp theo."}</span></div><button className={currentReady ? "button button-secondary button-wide" : "button button-primary button-wide"} disabled={busy || readyCount === 2} onClick={toggleReady}>{currentReady ? <><RotateCcw size={17} /> Hủy xác nhận</> : <>{isFinalRound ? "FINISH — Tôi đồng ý" : "NEXT ROUND — Tôi sẵn sàng"}<ArrowRight size={17} /></>}</button></div></section>;
}

function Result({ room, isHost, busy, rematch }: { room: RoomBootstrap; isHost: boolean; busy: boolean; rematch: () => void }) {
  const winner = room.members.find((member) => member.userId === room.match?.winnerId); const scores = [...room.members].sort((a, b) => b.score - a.score);
  return <div className="result-stage"><section className="surface winner-panel"><Crown size={34} className="text-accent" />{winner ? <Avatar name={winner.displayName} src={winner.avatarUrl ?? undefined} size={110} speaking /> : <div className="empty-avatar large" />}<h1>{winner ? "Winner" : "Draw"}</h1><h2>{winner?.displayName ?? "Equal score"}</h2><div className="final-score">{scores.map((member) => member.score).join(" – ")}</div><div className="winner-actions">{isHost && <button className="button button-primary" disabled={busy} onClick={rematch}><RotateCcw size={17} /> New match</button>}<Link className="button button-secondary" href="/dashboard">Dashboard</Link></div></section><section className="surface review-panel"><div><span className="ai-badge"><Sparkles size={15} /> Match saved</span><h2>Scores and submissions are now in your Supabase history.</h2></div><div className="review-items">{scores.map((member) => <div className="review-item" key={member.userId}>{member.userId === room.match?.winnerId ? <CheckCircle2 size={18} className="review-correct" /> : <XCircle size={18} className="text-muted" />}<div><strong>{member.displayName}</strong><p>{member.streak} current streak</p></div><span>{member.score}</span></div>)}</div><Link className="button button-secondary button-wide" href="/review">View review <ArrowRight size={17} /></Link></section></div>;
}
