"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { 
  ArrowRight, AudioLines, Bot, CheckCircle2, Copy, Crown, 
  Headphones, LoaderCircle, LockKeyhole, LogOut, Mic, MicOff, 
  Play, RotateCcw, Settings, Sparkles, Volume2, VolumeX, X, XCircle 
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { Brand } from "@/components/brand";
import { MatchStudio } from "@/components/room/match-studio";
import { QuestionPlayer } from "@/components/room/question-player";
import { Waveform } from "@/components/waveform";
import { DEFAULT_MATCH_SETTINGS, MATCH_PRESETS, resolveMatchSettings } from "@/lib/game/match-presets";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useGeminiLive } from "@/hooks/use-gemini-live";
import { useRoomControlsStore } from "@/stores/room-store";
import type { RoomBootstrap, RoomMemberData, RoundResolutionData } from "@/types/data";
import type { GameGenerationPreferences } from "@/types/game";

type Signal = { from: string; to: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type AudioPreflight = {
  status: "idle" | "running" | "ready" | "warning";
  microphone: boolean;
  inputLevel: number;
  outputDevice: boolean;
  relayCandidate: boolean;
  turnConfigured: boolean;
  message: string;
};
type AiIntervention = { id: string; policy_code: string; priority: number; instruction_vi: string; ui_message_vi: string; evidence: Record<string, unknown>; delivered_at: string | null };

export function RoomExperience({ initial }: { initial: RoomBootstrap }) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const room = initial;
  const isHost = room.currentUserId === room.hostId;
  const activeQuestion = room.match?.question;
  const activeRoundStartedAt = room.match?.roundStartedAt;
  const activeRoundDeadlineAt = room.match?.roundDeadlineAt;
  const activePhase = room.phase;
  const activeMatchId = room.match?.id;
  const activeRound = room.match?.currentRound;
  const hasSubmittedCurrent = Boolean(room.match?.submissions.some((item) => item.userId === room.currentUserId));
  const currentMember = room.members.find((member) => member.userId === room.currentUserId);
  const readyCount = room.members.filter((member) => member.isReady).length;
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const connectedIds = useMemo(() => room.members
    .filter((member) => onlineIds.includes(member.userId) || member.connectionState === "connected")
    .map((member) => member.userId), [onlineIds, room.members]);
  const [request, setRequest] = useState("");
  const [preferences, setPreferences] = useState<GameGenerationPreferences>(() => ({
    presetId: MATCH_PRESETS[0].id,
    rounds: MATCH_PRESETS[0].rounds,
    timePerQuestion: MATCH_PRESETS[0].timePerQuestion,
    level: "Mixed",
    difficulty: "Medium",
    modes: MATCH_PRESETS[0].modes,
    settings: { ...DEFAULT_MATCH_SETTINGS, ...MATCH_PRESETS[0].settings }
  }));
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [seconds, setSeconds] = useState(0);
  const [roundBeginsIn, setRoundBeginsIn] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [resolutionState, setResolutionState] = useState<{ key: string; data: RoundResolutionData } | null>(null);
  const [interventionState, setInterventionState] = useState<{ key: string; events: AiIntervention[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [realtimeState, setRealtimeState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [preflight, setPreflight] = useState<AudioPreflight>({ status: "idle", microphone: false, inputLevel: 0, outputDevice: false, relayCandidate: false, turnConfigured: false, message: "Chưa kiểm tra thiết bị" });
  const [remoteAiActive, setRemoteAiActive] = useState(() => Boolean(initial.aiSession && initial.aiSession.coordinatorId !== initial.currentUserId));
  const channelRef = useRef<RealtimeChannel | null>(null);
  const geminiDataChannelRef = useRef<RTCDataChannel | null>(null);

  const { muted, deafened, toggleMute, toggleDeafen } = useRoomControlsStore();
  const gemini = useGeminiLive(room.roomId, {
    onGenerateMatch: room.phase === "ai-discussion" ? generateFromGemini : undefined,
    onRequestHint: room.phase === "battle" ? requestHintFromGemini : undefined,
    onAudioChunk: (audio) => {
      const dataChannel = geminiDataChannelRef.current;
      if (dataChannel?.readyState === "open" && dataChannel.bufferedAmount < 750_000) {
        try {
          dataChannel.send(JSON.stringify({ type: "gemini_audio", audio }));
          return;
        } catch { /* Supabase Broadcast remains the recovery path. */ }
      }
      void channelRef.current?.send({ type: "broadcast", event: "gemini_audio", payload: { from: room.currentUserId, audio } });
    },
    sessionMode: room.phase === "battle" || room.phase === "round-result" ? "coach" : "setup",
    sessionContext: activeQuestion ? `Mode hiện tại: ${activeQuestion.mode}. Câu hiện tại: ${activeQuestion.prompt}. Hướng dẫn: ${activeQuestion.instruction}. Không được đoán hoặc tiết lộ đáp án trước khi lượt chơi kết thúc.` : undefined
  });
  const playRemoteGeminiAudio = gemini.playRemoteAudio;
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const peerUserRef = useRef<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const geminiMixContextRef = useRef<AudioContext | null>(null);
  const geminiMixDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const geminiMixedStreamIdsRef = useRef(new Set<string>());
  const localAiActiveRef = useRef(false);
  const startOfferRef = useRef<(() => Promise<void>) | null>(null);
  const timeoutSubmissionRef = useRef("");
  const advanceTriggeredRef = useRef("");
  const clockOffsetRef = useRef(0);
  const clockRttRef = useRef(0);
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.l.google.com:19302" }]);
  const clientSessionIdRef = useRef("");
  const refreshTimerRef = useRef<number | null>(null);
  const startOperationRef = useRef("");
  const advanceOperationRef = useRef("");
  const geminiQuestionRef = useRef("");
  const geminiEvaluationRef = useRef("");
  const geminiNudgesRef = useRef(new Set<string>());
  const onlineRef = useRef<string[]>([]);
  const realtimeStateRef = useRef(realtimeState);
  const membersRef = useRef<RoomMemberData[]>(initial.members);
  const deliveredPhasesRef = useRef(new Set<string>());
  const [fairness, setFairness] = useState<{ questionId: string; decision: string; participantCount: number; inputSkewMs: number | null } | null>(null);

  const acknowledgeDelivery = useCallback(async (phase: "received" | "rendered" | "input_enabled" | "audio_ready" | "answer_sent") => {
    if (!activeMatchId || !activeQuestion || !clientSessionIdRef.current) return;
    const key = `${activeQuestion.id}:${phase}`;
    if (deliveredPhasesRef.current.has(key)) return;
    const network = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
    try {
      const response = await fetch(`/api/matches/${activeMatchId}/delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: activeQuestion.id,
          clientSessionId: clientSessionIdRef.current,
          phase,
          clientReportedAt: new Date().toISOString(),
          metrics: {
            clockOffsetMs: Math.round(clockOffsetRef.current * 1000) / 1000,
            clockRttMs: Math.round(clockRttRef.current * 1000) / 1000,
            realtimeState: realtimeStateRef.current,
            webrtcState: peerRef.current?.connectionState ?? "new",
            visibility: document.visibilityState,
            effectiveType: network?.effectiveType
          }
        }),
        cache: "no-store",
        keepalive: phase === "answer_sent"
      });
      const body = await response.json().catch(() => ({})) as { decision?: string; participantCount?: number; inputSkewMs?: number | null };
      if (!response.ok) return;
      deliveredPhasesRef.current.add(key);
      if (body.decision) setFairness({ questionId: activeQuestion.id, decision: body.decision, participantCount: body.participantCount ?? 0, inputSkewMs: body.inputSkewMs ?? null });
    } catch { /* Fairness telemetry must never block answering. */ }
  }, [activeMatchId, activeQuestion]);

  useEffect(() => { onlineRef.current = onlineIds; }, [onlineIds]);
  useEffect(() => { realtimeStateRef.current = realtimeState; }, [realtimeState]);
  useEffect(() => { membersRef.current = room.members; }, [room.members]);
  useEffect(() => { streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !muted && !currentMember?.moderationMuted; }); }, [currentMember?.moderationMuted, muted]);
  useEffect(() => {
    const stored = window.sessionStorage.getItem(`lexiduel:session:${room.roomId}`);
    const sessionId = stored && /^[0-9a-f-]{36}$/iu.test(stored) ? stored : crypto.randomUUID();
    window.sessionStorage.setItem(`lexiduel:session:${room.roomId}`, sessionId);
    clientSessionIdRef.current = sessionId;
  }, [room.roomId]);

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion) return;
    void acknowledgeDelivery("received");
    const frame = window.requestAnimationFrame(() => void acknowledgeDelivery("rendered"));
    return () => window.cancelAnimationFrame(frame);
  }, [acknowledgeDelivery, activePhase, activeQuestion]);

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion || !activeMatchId || fairness?.questionId === activeQuestion.id && fairness.participantCount === 2) return;
    let active = true;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/matches/${activeMatchId}/delivery?questionId=${activeQuestion.id}`, { cache: "no-store" });
        const body = await response.json() as { assessment?: { question_id?: string; decision?: string; participant_count?: number; input_skew_ms?: number | null } | null };
        if (active && response.ok && body.assessment?.decision) setFairness({ questionId: body.assessment.question_id ?? activeQuestion.id, decision: body.assessment.decision, participantCount: body.assessment.participant_count ?? 0, inputSkewMs: body.assessment.input_skew_ms ?? null });
      } catch { /* The receipt POST remains the primary signal. */ }
      if (attempts >= 12) window.clearInterval(timer);
    };
    const timer = window.setInterval(() => void poll(), 750);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [activeMatchId, activePhase, activeQuestion, fairness?.participantCount, fairness?.questionId]);

  useEffect(() => {
    if (activePhase === "battle" && activeQuestion && roundBeginsIn === 0 && seconds > 0) void acknowledgeDelivery("input_enabled");
  }, [acknowledgeDelivery, activePhase, activeQuestion, roundBeginsIn, seconds]);

  useEffect(() => {
    let active = true;
    fetch("/api/webrtc/ice-servers", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { iceServers?: RTCIceServer[] };
        if (active && response.ok && Array.isArray(body.iceServers) && body.iceServers.length > 0) iceServersRef.current = body.iceServers;
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const resume = () => { setRealtimeState("reconnecting"); router.refresh(); };
    window.addEventListener("lexiduel:app-resume", resume);
    return () => window.removeEventListener("lexiduel:app-resume", resume);
  }, [router]);

  useEffect(() => {
    if (activePhase !== "battle" || !("wakeLock" in navigator)) return;
    let released = false;
    let lock: { release: () => Promise<void> } | null = null;
    void (navigator as Navigator & { wakeLock: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen").then((value) => { if (released) void value.release(); else lock = value; }).catch(() => undefined);
    return () => { released = true; if (lock) void lock.release(); };
  }, [activePhase]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const sendHeartbeat = async () => {
      if (!clientSessionIdRef.current || stopped || !navigator.onLine) return;
      try {
        const response = await fetch(`/api/rooms/${room.roomId}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientSessionId: clientSessionIdRef.current,
            action: "heartbeat",
            deviceState: { microphone: micEnabled, muted, deafened, preflight: preflight.status },
            connectionQuality: { realtime: realtimeStateRef.current, webrtc: peerRef.current?.connectionState ?? "new", clockRttMs: Math.round(clockRttRef.current) }
          }),
          cache: "no-store"
        });
        const body = await response.json().catch(() => ({})) as { hostEpoch?: number; stateVersion?: number };
        if (!response.ok) throw new Error("heartbeat failed");
        if (body.hostEpoch !== room.hostEpoch || body.stateVersion !== room.stateVersion) router.refresh();
      } catch {
        if (!stopped) setRealtimeState("reconnecting");
      } finally {
        if (!stopped) timer = window.setTimeout(sendHeartbeat, 5000);
      }
    };
    const online = () => { setRealtimeState("reconnecting"); void sendHeartbeat(); };
    const offline = () => setRealtimeState("reconnecting");
    const disconnect = () => {
      if (!clientSessionIdRef.current) return;
      void fetch(`/api/rooms/${room.roomId}/heartbeat`, {
        method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSessionId: clientSessionIdRef.current, action: "disconnect" })
      });
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", disconnect);
    void sendHeartbeat();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pagehide", disconnect);
    };
  }, [deafened, micEnabled, muted, preflight.status, room.hostEpoch, room.roomId, room.stateVersion, router]);
  useEffect(() => {
    const remoteLease = room.aiSession?.coordinatorId !== room.currentUserId ? room.aiSession : null;
    const remaining = remoteLease ? Math.max(0, 75_000 - (Date.now() - new Date(remoteLease.heartbeatAt).getTime())) : 0;
    const synchronize = window.setTimeout(() => setRemoteAiActive(Boolean(remoteLease) && remaining > 0), 0);
    const expiry = remoteLease && remaining > 0 ? window.setTimeout(() => setRemoteAiActive(false), remaining) : undefined;
    return () => { window.clearTimeout(synchronize); if (expiry) window.clearTimeout(expiry); };
  }, [room.aiSession, room.currentUserId]);
  useEffect(() => {
    const active = ["connecting", "listening", "speaking"].includes(gemini.status);
    if (localAiActiveRef.current === active) return;
    localAiActiveRef.current = active;
    void channelRef.current?.send({ type: "broadcast", event: "gemini_state", payload: { from: room.currentUserId, active } });
  }, [gemini.status, room.currentUserId]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const synchronize = async () => {
      const samples: { rtt: number; offset: number }[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        try {
          const response = await fetch(`/api/clock?sample=${attempt}`, { cache: "no-store" });
          const body = await response.json() as { serverNow?: number };
          const ended = performance.now();
          if (response.ok && typeof body.serverNow === "number") {
            const midpoint = performance.timeOrigin + ((started + ended) / 2);
            samples.push({ rtt: ended - started, offset: body.serverNow - midpoint });
          }
        } catch { /* A later sample retries automatically. */ }
      }
      if (!active || samples.length === 0) return;
      samples.sort((left, right) => left.rtt - right.rtt);
      clockOffsetRef.current = samples[0].offset;
      clockRttRef.current = samples[0].rtt;
      timer = window.setTimeout(synchronize, 30_000);
    };
    void synchronize();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion || !activeRoundStartedAt) return;
    const startedAt = new Date(activeRoundStartedAt).getTime();
    const deadlineAt = activeRoundDeadlineAt ? new Date(activeRoundDeadlineAt).getTime() : startedAt + activeQuestion.timeLimit * 1000;
    const updateSynchronizedClock = () => {
      const serverNow = performance.timeOrigin + performance.now() + clockOffsetRef.current;
      const untilStart = startedAt - serverNow;
      setRoundBeginsIn(Math.max(0, Math.ceil(untilStart / 1000)));
      setSeconds(untilStart > 0
        ? activeQuestion.timeLimit
        : Math.max(0, Math.ceil((deadlineAt - serverNow) / 1000))
      );
    };
    updateSynchronizedClock();
    const timer = window.setInterval(updateSynchronizedClock, 100);
    return () => window.clearInterval(timer);
  }, [activePhase, activeQuestion, activeRoundDeadlineAt, activeRoundStartedAt]);

  useEffect(() => {
    if (room.phase !== "countdown") return;
    const reset = window.setTimeout(() => setCountdown(3), 0);
    const interval = window.setInterval(() => setCountdown((value) => Math.max(1, value - 1)), 1000);
    const operationKey = startOperationRef.current || crypto.randomUUID();
    startOperationRef.current = operationKey;
    const timer = isHost && room.match ? window.setTimeout(() => void run(() => api(`/api/matches/${room.match!.id}/start`, { method: "POST", headers: { "Idempotency-Key": operationKey } })), 3000) : undefined;
    return () => { window.clearTimeout(reset); window.clearInterval(interval); if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.phase, room.match?.id, isHost]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.realtime.setAuth();
    const channel = supabase.channel(`room:${room.code}`, { config: { private: true, presence: { key: room.currentUserId } } });
    channelRef.current = channel;

    const signal = (payload: Omit<Signal, "from">) => channel.send({ type: "broadcast", event: "webrtc", payload: { ...payload, from: room.currentUserId } });
    const attachGeminiDataChannel = (dataChannel: RTCDataChannel) => {
      dataChannel.bufferedAmountLowThreshold = 128_000;
      dataChannel.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data.length > 500_000) return;
        try {
          const payload = JSON.parse(event.data) as { type?: string; audio?: string };
          if (payload.type === "gemini_audio" && typeof payload.audio === "string") void playRemoteGeminiAudio(payload.audio);
        } catch { /* Ignore malformed peer messages. */ }
      };
      dataChannel.onclose = () => {
        if (geminiDataChannelRef.current === dataChannel) geminiDataChannelRef.current = null;
      };
      geminiDataChannelRef.current = dataChannel;
    };
    const peerFor = (otherId: string) => {
      if (peerRef.current && peerUserRef.current === otherId) return peerRef.current;
      peerRef.current?.close();
      const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
      peerUserRef.current = otherId;
      if (isHost) attachGeminiDataChannel(peer.createDataChannel("gemini-audio", { ordered: true }));
      else peer.ondatachannel = (event) => { if (event.channel.label === "gemini-audio") attachGeminiDataChannel(event.channel); };
      streamRef.current?.getTracks().forEach((track) => peer.addTrack(track, streamRef.current!));
      peer.onicecandidate = (event) => { if (event.candidate) void signal({ to: otherId, candidate: event.candidate.toJSON() }); };
      peer.ontrack = (event) => {
        remoteStreamRef.current = event.streams[0];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = event.streams[0];
        connectStreamToGeminiMix(event.streams[0]);
      };
      peer.onconnectionstatechange = () => {
        setVoiceConnected(peer.connectionState === "connected");
        if (["failed", "disconnected"].includes(peer.connectionState) && isHost) window.setTimeout(() => void startOfferRef.current?.(), 1200);
      };
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
      .on("broadcast", { event: "refresh" }, refreshSoon)
      .on("broadcast", { event: "game_state_changed" }, refreshSoon)
      .on("broadcast", { event: "gemini_audio" }, ({ payload }: { payload: { from?: string; audio?: string } }) => {
        if (payload.from !== room.currentUserId && typeof payload.audio === "string" && payload.audio.length < 500_000) void playRemoteGeminiAudio(payload.audio);
      })
      .on("broadcast", { event: "gemini_state" }, ({ payload }: { payload: { from?: string; active?: boolean } }) => {
        if (payload.from !== room.currentUserId) setRemoteAiActive(Boolean(payload.active));
      })
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
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.roomId}` }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${room.roomId}` }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `room_id=eq.${room.roomId}` }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions", ...(activeMatchId ? { filter: `match_id=eq.${activeMatchId}` } : {}) }, refreshSoon)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeState("connected");
          await channel.track({ userId: room.currentUserId, onlineAt: new Date().toISOString(), sessionId: clientSessionIdRef.current });
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) setRealtimeState("reconnecting");
      });

    function refreshSoon() {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        router.refresh();
      }, 80);
    }

    return () => {
      startOfferRef.current = null;
      if (channelRef.current === channel) channelRef.current = null;
      void supabase.removeChannel(channel);
      geminiDataChannelRef.current?.close();
      geminiDataChannelRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [activeMatchId, isHost, playRemoteGeminiAudio, supabase, room.code, room.currentUserId, room.roomId, router]);

  useEffect(() => { if (isHost && micEnabled && onlineIds.some((id) => id !== room.currentUserId)) void startOfferRef.current?.(); }, [isHost, micEnabled, onlineIds, room.currentUserId]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void geminiMixContextRef.current?.close();
  }, []);
  useEffect(() => {
    const synchronization = window.setInterval(() => router.refresh(), 10_000);
    return () => window.clearInterval(synchronization);
  }, [router, room.roomId]);
  useEffect(() => {
    if (room.phase !== "round-result" || !activeMatchId || !activeRound) return;
    const matchId = activeMatchId;
    const round = activeRound;
    let active = true;
    const controller = new AbortController();
    fetch(`/api/matches/${matchId}/resolution?round=${round}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
      return body as RoundResolutionData;
    }).then((body) => {
      if (!active) return;
      setResolutionState({ key: `${matchId}:${round}`, data: body });
      void fetch(`/api/matches/${matchId}/interventions?round=${round}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
        const interventionBody = await response.json() as { events?: AiIntervention[]; error?: string };
        if (!response.ok) throw Object.assign(new Error(interventionBody.error), { status: response.status });
        if (active) setInterventionState({ key: `${matchId}:${round}`, events: interventionBody.events ?? [] });
      }).catch((error: Error & { status?: number }) => { if (active && error.name !== "AbortError") { setInterventionState({ key: `${matchId}:${round}`, events: [] }); if (error.status !== 409) showError(error); } });
    }).catch((error: Error & { status?: number }) => {
      if (active && error.name !== "AbortError" && error.status !== 409) showError(error);
    });
    return () => { active = false; controller.abort(); };
  }, [room.phase, activeMatchId, activeRound]);

  useEffect(() => {
    if (room.phase !== "battle" || !room.match?.question || !["listening", "speaking"].includes(gemini.status)) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (geminiQuestionRef.current === key) return;
    const sent = gemini.sendText([
      "HỆ_THỐNG_CÂU_MỚI",
      `Vòng ${room.match.currentRound}/${room.match.roundCount}.`,
      `Dạng bài: ${room.match.question.mode}.`,
      `Câu hỏi: ${room.match.question.prompt}`,
      `Hướng dẫn: ${room.match.question.instruction}`,
      `Thời gian: ${room.match.question.timeLimit} giây.`,
      "Hãy ghi nhớ câu hiện tại, tiếp tục lắng nghe hai người chơi và không tiết lộ đáp án trước khi cả hai nộp bài. Không cần đọc lại toàn bộ thông báo này."
    ].join("\n"));
    if (sent) geminiQuestionRef.current = key;
  }, [gemini, gemini.sendText, gemini.status, room.match?.currentRound, room.match?.id, room.match?.question, room.match?.roundCount, room.phase]);

  useEffect(() => {
    if (room.phase !== "battle" || !room.match?.question || !["listening", "speaking"].includes(gemini.status)) return;
    const settings = resolveMatchSettings(room.match.blueprint);
    if (settings.aiPresence === "QUIET" || seconds <= 0 || roundBeginsIn > 0) return;
    const base = `${room.match.id}:${room.match.currentRound}`;
    const halfTime = Math.ceil(room.match.question.timeLimit / 2);
    let event = "";
    let instruction = "";
    if (room.match.submissions.length === 1) {
      event = `${base}:one-finished`;
      instruction = "Một người đã nộp bài. Hãy động viên người còn lại thật ngắn bằng tiếng Việt, không nói ai đã nộp và tuyệt đối không gợi ý đáp án.";
    } else if (settings.aiPresence === "ACTIVE" && seconds <= 10) {
      event = `${base}:ten-seconds`;
      instruction = "Còn khoảng 10 giây. Nhắc thời gian bằng một câu tiếng Việt bình tĩnh, không tiết lộ hay ám chỉ đáp án.";
    } else if (settings.aiPresence === "ACTIVE" && seconds <= halfTime) {
      event = `${base}:half-time`;
      instruction = "Đã qua nửa thời gian. Nói một câu động viên ngắn bằng tiếng Việt, không tiết lộ hay ám chỉ đáp án.";
    }
    if (!event || geminiNudgesRef.current.has(event)) return;
    if (gemini.sendText(`HỆ_THỐNG_AI_CHỦ_ĐỘNG\n${instruction}`)) geminiNudgesRef.current.add(event);
  }, [gemini, gemini.sendText, gemini.status, room.match, room.phase, roundBeginsIn, seconds]);

  useEffect(() => {
    if (room.phase !== "round-result" || !room.match || !["listening", "speaking"].includes(gemini.status)) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (geminiEvaluationRef.current === key || resolutionState?.key !== key || interventionState?.key !== key) return;
    const result = resolutionState.data;
    const feedbackStyle = resolveMatchSettings(room.match.blueprint).feedbackStyle;
    const interventions = interventionState?.key === key ? interventionState.events : [];
    const playerResults = room.members.map((member) => {
      const submission = result.submissions.find((item) => item.userId === member.userId);
      if (!submission) return `${member.displayName}: không có câu trả lời.`;
      const verdict = submission.correct && submission.timedOut ? "đúng nhưng hết giờ" : submission.correct ? "đúng" : submission.timedOut ? "hết giờ" : "sai";
      const rubric = submission.rubricScore != null ? `, điểm rubric ${Math.round(submission.rubricScore)}/100${submission.assessment?.feedbackVi ? `, nhận xét: ${submission.assessment.feedbackVi}` : ""}` : "";
      return `${member.displayName}: trả lời “${submission.answer}”, ${verdict}, ${submission.points} điểm${rubric}, ${(submission.responseMs / 1000).toFixed(2)} giây.`;
    });
    const sent = gemini.sendText([
      "HỆ_THỐNG_KẾT_QUẢ_VÒNG",
      `Vòng ${room.match.currentRound}/${room.match.roundCount} đã kết thúc vì cả hai người chơi đã trả lời.`,
      ...playerResults,
      `Đáp án đúng: ${result.canonicalAnswer}.`,
      `Các đáp án chấp nhận: ${result.acceptedAnswers.join(", ")}.`,
      `Giải thích: ${result.explanation}`,
      ...interventions.map((event) => `CAN THIỆP ${event.policy_code}: ${event.instruction_vi}`),
      `Dạng bài vừa chấm: ${room.match.question?.mode ?? "UNKNOWN"}. Với bài nghe hãy nhắc một chi tiết cần nghe; với SHADOWING hoặc phát âm hãy ưu tiên độ dễ hiểu, trọng âm, nhịp và ngữ điệu; với xếp/sửa câu hãy chỉ ra quy tắc ngữ pháp ngắn gọn.`,
      feedbackStyle === "CONCISE"
        ? "Hãy đánh giá ngay bằng tiếng Việt trong tối đa hai câu. Sau đó chờ hai người xác nhận NEXT ROUND."
        : feedbackStyle === "DETAILED"
          ? "Hãy đánh giá ngay bằng tiếng Việt trong tối đa năm câu: kết quả, lý do, lỗi cần sửa và một ví dụ ngắn. Sau đó chờ hai người xác nhận NEXT ROUND."
          : "Hãy đánh giá ngay bằng tiếng Việt trong tối đa ba câu như một giáo viên thân thiện. Sau đó chờ hai người xác nhận NEXT ROUND."
    ].join("\n"));
    if (sent) {
      geminiEvaluationRef.current = key;
      if (interventions.length) void fetch(`/api/matches/${room.match.id}/interventions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventIds: interventions.map((event) => event.id) }), keepalive: true }).catch(() => undefined);
    }
  }, [gemini, gemini.sendText, gemini.status, interventionState, resolutionState, room.match, room.members, room.phase]);

  useEffect(() => {
    if (room.phase !== "round-result" || !room.match || !isHost || readyCount !== 2) return;
    const key = `${room.match.id}:${room.match.currentRound}`;
    if (advanceTriggeredRef.current === key) return;
    advanceTriggeredRef.current = key;
    if (!advanceOperationRef.current.startsWith(`${key}:`)) advanceOperationRef.current = `${key}:${crypto.randomUUID()}`;
    const operationKey = advanceOperationRef.current.slice(key.length + 1);
    setBusy(true);
    void api(`/api/matches/${room.match.id}/advance`, { method: "POST", headers: { "Idempotency-Key": operationKey } })
      .catch((error) => { advanceTriggeredRef.current = ""; showError(error); })
      .finally(() => setBusy(false));
    // The host advances only after the latest server-synchronized 2/2 ready state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, readyCount, room.match?.currentRound, room.match?.id, room.phase]);

  const autoSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmitQuestionRef = useRef("");
  const forceResTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceResQuestionRef = useRef("");

  useEffect(() => {
    if (activePhase !== "battle" || !activeQuestion || !activeRoundStartedAt) return;
    const questionKey = activeQuestion.id;
    const serverNow = performance.timeOrigin + performance.now() + clockOffsetRef.current;
    const deadline = activeRoundDeadlineAt
      ? new Date(activeRoundDeadlineAt).getTime()
      : new Date(activeRoundStartedAt).getTime() + activeQuestion.timeLimit * 1000;
    const remainingUntilDeadline = Math.max(0, deadline - serverNow);

    // Auto-submit "⏱ Hết giờ" when timer expires (only if user hasn't submitted)
    const rubricQuestion = ["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE", "WRITING"].includes(activeQuestion.mode);
    if (!rubricQuestion && !hasSubmittedCurrent && autoSubmitQuestionRef.current !== questionKey) {
      if (autoSubmitTimerRef.current) clearTimeout(autoSubmitTimerRef.current);
      autoSubmitQuestionRef.current = questionKey;
      autoSubmitTimerRef.current = setTimeout(() => {
        if (timeoutSubmissionRef.current === questionKey) return;
        timeoutSubmissionRef.current = questionKey;
        void acknowledgeDelivery("answer_sent");
        void fetch("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId: questionKey, answer: "⏱ Hết giờ" }) })
          .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Submit failed"); router.refresh(); })
          .catch((error) => { timeoutSubmissionRef.current = ""; showError(error); });
      }, remainingUntilDeadline);
    }
    if (hasSubmittedCurrent && autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }

    // Host force-resolves the round if it's still active after timeLimit + 3s
    if (isHost && forceResQuestionRef.current !== questionKey && room.match) {
      if (forceResTimerRef.current) clearTimeout(forceResTimerRef.current);
      forceResQuestionRef.current = questionKey;
      const matchId = room.match.id;
      forceResTimerRef.current = setTimeout(() => {
        void fetch(`/api/matches/${matchId}/force-resolution`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(console.error);
        router.refresh();
      }, remainingUntilDeadline + (rubricQuestion ? 16_000 : 3000));
    }
  }, [acknowledgeDelivery, activePhase, activeQuestion, activeRoundDeadlineAt, activeRoundStartedAt, hasSubmittedCurrent, isHost, room.match, router]);

  // Clean up timers when leaving battle phase
  useEffect(() => {
    if (activePhase !== "battle") {
      if (autoSubmitTimerRef.current) { clearTimeout(autoSubmitTimerRef.current); autoSubmitTimerRef.current = null; }
      if (forceResTimerRef.current) { clearTimeout(forceResTimerRef.current); forceResTimerRef.current = null; }
      autoSubmitQuestionRef.current = "";
      forceResQuestionRef.current = "";
    }
  }, [activePhase]);

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
    stream.getAudioTracks().forEach((track) => { track.enabled = !currentMember?.moderationMuted; });
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = stream;
    setMicEnabled(true);
    if (isHost) window.setTimeout(() => void startOfferRef.current?.(), 100);
    return stream;
  }

  async function enableMic() {
    try {
      await getMicrophoneStream();
      toast.success("Microphone enabled.");
    }
    catch { toast.error("Microphone permission was not granted."); }
  }

  async function runAudioPreflight() {
    if (preflight.status === "running") return;
    setPreflight((value) => ({ ...value, status: "running", message: "Đang kiểm tra micro, loa và đường truyền" }));
    let probe: RTCPeerConnection | null = null;
    try {
      const stream = await getMicrophoneStream();
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      await context.resume();
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length);
      await context.close();

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputDevice = devices.some((device) => device.kind === "audiooutput");
      probe = new RTCPeerConnection({ iceServers: iceServersRef.current });
      probe.createDataChannel("preflight");
      let relayCandidate = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, 3500);
        probe!.onicecandidate = (event) => {
          if (event.candidate?.candidate.includes(" typ relay ")) relayCandidate = true;
          if (!event.candidate) { window.clearTimeout(timeout); resolve(); }
        };
        void probe!.createOffer().then((offer) => probe!.setLocalDescription(offer)).catch((error) => { window.clearTimeout(timeout); reject(error); });
      });
      const turnConfigured = iceServersRef.current.length > 1;
      const audible = rms >= 0.003;
      const warning = !audible || (turnConfigured && !relayCandidate);
      setPreflight({
        status: warning ? "warning" : "ready",
        microphone: true,
        inputLevel: Math.min(100, Math.round(rms * 1000)),
        outputDevice,
        relayCandidate,
        turnConfigured,
        message: !audible
          ? "Micro đã mở nhưng tín hiệu quá nhỏ. Hãy nói thử và kiểm tra đúng thiết bị đầu vào."
          : turnConfigured && !relayCandidate
            ? "Micro tốt nhưng chưa lấy được TURN relay. Mạng chặn peer-to-peer có thể không gọi được."
            : "Thiết bị và đường truyền thoại đã sẵn sàng."
      });
    } catch (error) {
      setPreflight({ status: "warning", microphone: false, inputLevel: 0, outputDevice: false, relayCandidate: false, turnConfigured: iceServersRef.current.length > 1, message: error instanceof Error ? error.message : "Không kiểm tra được thiết bị audio" });
    } finally {
      probe?.close();
    }
  }

  async function startGemini() {
    try {
      if (remoteAiActive) return toast.info("Gemini đã được người còn lại bật trong phòng.");
      const stream = await getMicrophoneStream();
      await gemini.start(await prepareGeminiInput(stream));
    } catch { toast.error("Microphone permission was not granted."); }
  }

  function connectStreamToGeminiMix(stream: MediaStream) {
    const context = geminiMixContextRef.current;
    const destination = geminiMixDestinationRef.current;
    if (!context || !destination || geminiMixedStreamIdsRef.current.has(stream.id)) return;
    context.createMediaStreamSource(stream).connect(destination);
    geminiMixedStreamIdsRef.current.add(stream.id);
  }

  async function prepareGeminiInput(localStream: MediaStream) {
    if (!geminiMixContextRef.current || geminiMixContextRef.current.state === "closed") {
      const context = new AudioContext();
      geminiMixContextRef.current = context;
      geminiMixDestinationRef.current = context.createMediaStreamDestination();
      geminiMixedStreamIdsRef.current.clear();
    }
    await geminiMixContextRef.current.resume();
    connectStreamToGeminiMix(localStream);
    if (remoteStreamRef.current) connectStreamToGeminiMix(remoteStreamRef.current);
    return geminiMixDestinationRef.current!.stream;
  }

  function stopGemini() {
    gemini.stop();
    void geminiMixContextRef.current?.close();
    geminiMixContextRef.current = null;
    geminiMixDestinationRef.current = null;
    geminiMixedStreamIdsRef.current.clear();
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
      return await api("/api/ai/generate-game", { method: "POST", body: JSON.stringify({ roomId: room.roomId, request: brief, preferences }) }) as { jobId: string; queued: true; message: string };
    } finally {
      setBusy(false);
    }
  }

  async function generateFromGemini(brief: string) {
    setRequest(brief);
    try {
      const generated = await createMatch(brief);
      toast.success("Đã xếp hàng tạo trận. Hai bạn có thể theo dõi từng batch ngay trong phòng.");
      return { ok: true, message: generated.message, data: { jobId: generated.jobId } };
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

  async function submit() {
    const answer = room.match?.question ? answerDrafts[room.match.question.id] ?? "" : "";
    if (!room.match?.question || !answer.trim()) return;
    await run(async () => { await acknowledgeDelivery("answer_sent"); await api("/api/answers", { method: "POST", body: JSON.stringify({ questionId: room.match!.question!.id, answer }) }); toast.success("Answer submitted. Waiting for the other player."); });
  }

  async function moderateMember(userId: string, action: "mute" | "unmute" | "kick") {
    await run(async () => {
      await api(`/api/rooms/${room.roomId}/moderate`, { method: "POST", body: JSON.stringify({ userId, action, reason: "Room host moderation" }) });
      toast.success(action === "kick" ? "Đã đưa thành viên khỏi phòng." : action === "mute" ? "Đã tắt micro thành viên." : "Đã cho phép thành viên bật micro.");
    });
  }

  async function fetchHint() {
    if (!room.match?.question) return null;
    const response = await fetch(`/api/matches/${room.match.id}/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: room.match.question.id })
    });
    const body = await response.json().catch(() => ({})) as { hint?: string; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Không lấy được gợi ý");
    return body.hint ?? null;
  }

  async function requestHint() {
    const hint = await fetchHint();
    if (hint) gemini.sendText(`HỆ_THỐNG_GỢI_Ý_AN_TOÀN\nHãy đọc lại gợi ý này bằng tiếng Việt, không bổ sung đáp án: ${hint}`);
    return hint;
  }

  async function requestHintFromGemini() {
    try {
      const hint = await fetchHint();
      return hint ? { ok: true, message: hint, data: { hint } } : { ok: false, message: "Không có gợi ý cho câu này." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Không lấy được gợi ý." };
    }
  }

  const submitted = hasSubmittedCurrent;
  const questionId = room.match?.question?.id;
  const answer = questionId ? answerDrafts[questionId] ?? "" : "";
  const roundExpired = Boolean(activeQuestion && activeRoundStartedAt && roundBeginsIn === 0 && seconds <= 0);
  const resolutionKey = room.match ? `${room.match.id}:${room.match.currentRound}` : "";
  const resolution = resolutionState?.key === resolutionKey ? resolutionState.data : null;
  const interventions = interventionState?.key === resolutionKey ? interventionState.events : [];
  const moderationTarget = isHost ? room.members.find((member) => member.userId !== room.currentUserId) : null;

  return <main className="room-page" suppressHydrationWarning>
    {currentMember?.moderationMuted && <div className="moderation-notice"><MicOff size={15} /> Host đã tắt micro của bạn trong phòng này.</div>}
    {moderationTarget && <div className="room-host-controls" aria-label="Host moderation"><span>Host controls · {moderationTarget.displayName}</span><button type="button" onClick={() => void moderateMember(moderationTarget.userId, moderationTarget.moderationMuted ? "unmute" : "mute")}><MicOff size={13} /> {moderationTarget.moderationMuted ? "Cho bật mic" : "Tắt mic"}</button><button type="button" className="danger" onClick={() => void moderateMember(moderationTarget.userId, "kick")}><LogOut size={13} /> Mời ra</button></div>}
    <audio ref={remoteAudioRef} autoPlay muted={deafened} />
    <header className="room-header"><div className="app-container room-header-inner"><div className="room-id"><Brand /><div className="room-code"><span>Room code</span><button onClick={() => { void navigator.clipboard.writeText(room.code); toast.success("Room code copied."); }}>{room.code}<Copy size={13} /></button></div></div><div className="room-actions"><button className="button button-secondary" onClick={() => setAudioOpen(true)}><Settings size={16} /><span>Settings</span></button><button className="button button-danger" onClick={leave} disabled={busy}><LogOut size={16} /><span>Leave</span></button></div></div></header>
    <section className="room-main"><div className="app-container room-content"><div className="room-status-line"><div className="status"><span className={`status-dot ${realtimeState === "reconnecting" ? "warning" : ""}`} /> {connectedIds.length} online <span className="room-status-copy">{realtimeState === "connected" ? `Realtime · host epoch ${room.hostEpoch}` : "Đang nối lại Realtime"}</span></div><div className="room-status-copy" suppressHydrationWarning>{gemini.status === "listening" ? voiceConnected ? "Gemini đang nghe cả hai bạn" : "Gemini đang nghe người bật AI" : gemini.status === "speaking" ? "Gemini đang nói" : remoteAiActive ? "Gemini đang chạy trên máy người còn lại" : voiceConnected ? "Đàm thoại trực tiếp đã kết nối" : micEnabled ? "Đang chờ kết nối thoại" : "Micro đang tắt"}</div></div>{renderPhase()}</div></section>
    <footer className="room-footer"><div className="app-container room-footer-inner"><div className="footer-meta"><LockKeyhole size={14} /> Private room</div><div className="voice-controls"><button className={`icon-button ${muted ? "danger" : ""}`} onClick={() => { if (!micEnabled) { void enableMic(); return; } toggleMute(); streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = muted; }); }} aria-label={micEnabled ? "Toggle microphone" : "Enable microphone"}>{muted ? <MicOff size={19} /> : <Mic size={19} />}</button><button className={`icon-button ${deafened ? "danger" : ""}`} onClick={toggleDeafen} aria-label="Toggle audio">{deafened ? <VolumeX size={19} /> : <Headphones size={19} />}</button><button className="icon-button" onClick={() => setAudioOpen(true)} aria-label="Audio settings"><AudioLines size={19} /></button></div><div className="footer-meta end"><Volume2 size={14} /> WebRTC & Gemini Live</div></div></footer>
    {audioOpen && <div className="audio-popover" onMouseDown={(event) => { if (event.currentTarget === event.target) setAudioOpen(false); }}><section className="surface audio-dialog" role="dialog" aria-modal="true"><div className="panel-heading"><h2>Kiểm tra thoại</h2><button className="icon-button" onClick={() => setAudioOpen(false)} aria-label="Đóng"><X size={18} /></button></div><div className="audio-grid"><p className="text-muted">Kiểm tra micro, thiết bị phát, STUN và TURN trước khi thi nghe nói.</p><div className={`preflight-result ${preflight.status}`}><strong>{preflight.status === "running" ? "Đang kiểm tra" : preflight.status === "ready" ? "Sẵn sàng" : preflight.status === "warning" ? "Cần kiểm tra lại" : "Chưa kiểm tra"}</strong><p>{preflight.message}</p>{preflight.status !== "idle" && preflight.status !== "running" && <div className="preflight-metrics"><span>Micro {preflight.microphone ? "OK" : "Lỗi"}</span><span>Tín hiệu {preflight.inputLevel}%</span><span>Loa {preflight.outputDevice ? "OK" : "Không phát hiện"}</span><span>TURN {preflight.turnConfigured ? preflight.relayCandidate ? "OK" : "Chưa relay" : "Chưa cấu hình"}</span></div>}</div><button className="button button-primary" onClick={() => void runAudioPreflight()} disabled={preflight.status === "running"}>{preflight.status === "running" ? <LoaderCircle size={17} className="animate-spin" /> : <AudioLines size={17} />} {preflight.status === "idle" ? "Chạy kiểm tra" : "Kiểm tra lại"}</button></div></section></div>}
  </main>;

  function renderPhase() {
    const phase = room.phase;
    const roundFairness = fairness?.questionId === room.match?.question?.id ? fairness : null;
    if (phase === "idle") return <RoomGrid members={room.members} online={connectedIds}><Bot size={32} className="text-accent" /><h1>Phòng đã sẵn sàng.</h1><p>Hai bạn có thể nói chuyện bình thường. Khi đủ hai người, một trong hai có thể bật Gemini để chọn nội dung học hoặc thi.</p>{room.members.length === 2 ? <button className="button button-primary" onClick={() => run(() => status("AI_DISCUSSION"))} disabled={busy}><Play size={18} /> Bật Gemini và setup trận</button> : <p className="waiting-copy">Gửi mã phòng cho bạn của bạn để bắt đầu.</p>}</RoomGrid>;
    if (phase === "ai-joining") return <Loading title="Connecting to Gemini Live" detail="Establishing low-latency voice connection with Lexi AI Host..." />;
    if (phase === "ai-discussion") return <RoomGrid members={room.members} online={connectedIds}>
      <div className="ai-badge"><Sparkles size={15} /> Gemini Live teacher</div>
      <div className={`ai-avatar ${gemini.status === "speaking" ? "speaking" : ""}`}><Image src="/images/lexi-host.png" alt="Lexi AI host" fill sizes="126px" /></div>
      <Waveform active={gemini.status === "listening" || gemini.status === "speaking"} bars={19} />
      <h1>{gemini.status === "listening" ? "Gemini is listening." : gemini.status === "speaking" ? "Gemini is speaking." : "Start a Gemini voice session."}</h1>
      <p>Micro của người bật AI chỉ được stream trong phiên Gemini Live này và có thể tắt bất cứ lúc nào.</p>
      <div className="gemini-controls">
        {gemini.status === "off" || gemini.status === "error" ? <button className="button button-primary" onClick={startGemini} disabled={remoteAiActive}><Mic size={17} /> {remoteAiActive ? "Gemini đã được bật" : "Bật Gemini nghe cả hai"}</button> : <button className="button button-danger" onClick={stopGemini}><MicOff size={17} /> Stop Gemini</button>}
        <span className={`gemini-status ${gemini.status}`}>{gemini.status}</span>
      </div>
      {gemini.error && <div className="gemini-error">{gemini.error}</div>}
      {gemini.inputTranscript && <div className="gemini-transcript"><span>You said</span><p>{gemini.inputTranscript}</p><button type="button" className="suggestion" onClick={() => setRequest(gemini.inputTranscript)}>Use as match brief</button></div>}
      {gemini.outputTranscript && <div className="ai-transcript">{gemini.outputTranscript}</div>}
      {room.generation?.status === "failed" && <div className="gemini-error"><strong>Không tạo được trận trước đó.</strong><p>{room.generation.errorMessage ?? "Worker đã dừng sau các lần retry. Bạn có thể chỉnh yêu cầu và tạo lại."}</p></div>}
      <MatchStudio value={preferences} onChange={setPreferences} disabled={busy} />
      <form className="practice-request" onSubmit={generate}>
        <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Or type exactly what both players want to practise…" maxLength={1000} />
        <button className="button button-primary" disabled={busy || room.members.length !== 2}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />} Generate match</button>
        {room.members.length !== 2 && <small>Invite your friend first. Gemini will create the match as soon as both players are in the room.</small>}
      </form>
    </RoomGrid>;

    if (phase === "generating") return <Loading title="Đang tạo nội dung trận đấu" detail="Groq đang tạo từng nhóm nhỏ và kiểm tra chất lượng trước khi lưu. Cả hai cứ ở trong phòng; hệ thống sẽ tự chuyển màn hình khi hoàn tất." progress={room.generation} onRecover={() => run(async () => { await api("/api/ai/generation-recover", { method: "POST", body: JSON.stringify({ roomId: room.roomId }) }); toast.success("Đã khôi phục phòng. Bạn có thể tạo lại trận."); })} />;
    if (phase === "config") {
      if (!room.match) return <Loading title="No generated match yet" detail="Waiting for match data from Supabase." />;
      const plan = room.match.blueprint;
      const planSettings = resolveMatchSettings(plan);
      return <section className="surface center-stage"><div className="config-card"><div className="config-card-head"><div className="ai-badge"><Sparkles size={15} /> Cấu hình đã lưu trên Supabase</div><h1>{plan.title}</h1></div><div className="config-fields"><div className="config-field"><span>Chủ đề</span><strong>{plan.topic}</strong></div><div className="config-field"><span>Số vòng</span><strong>{plan.rounds}</strong></div><div className="config-field"><span>Thời gian</span><strong>{plan.timePerQuestion}s</strong></div><div className="config-field"><span>Độ khó</span><strong>{plan.difficulty}</strong></div></div><div className="mode-list">{plan.modes.map((mode) => <span className="mode-chip" key={mode.type}>{mode.type.replaceAll("_", " ")} · {mode.count}</span>)}</div><div className="config-rule-strip"><span>{planSettings.experience === "DUEL" ? "Đối kháng" : planSettings.experience === "COOP" ? "Cùng đội" : "Luyện tập"}</span><span>AI {planSettings.aiPresence === "ACTIVE" ? "chủ động" : planSettings.aiPresence === "BALANCED" ? "cân bằng" : "yên lặng"}</span><span>Chấm {planSettings.strictness.toLocaleLowerCase()}</span>{planSettings.allowHints && <span>Tối đa {planSettings.maxHints} gợi ý</span>}</div><div className="ready-summary"><strong>{readyCount}/2 người đã sẵn sàng</strong><span>{readyCount === 0 ? "Cả hai hãy kiểm tra cấu hình rồi bấm START." : readyCount === 1 ? "Đang chờ người còn lại bấm START." : "Đủ hai người, đang vào trận."}</span></div><div className="config-actions"><button className={currentMember?.isReady ? "button button-secondary" : "button button-primary"} onClick={() => run(() => api(`/api/rooms/${room.roomId}/ready`, { method: "PATCH", body: JSON.stringify({ ready: !currentMember?.isReady }) }))} disabled={busy}>{currentMember?.isReady ? <><RotateCcw size={17} /> Hủy START</> : <><Play size={17} /> START, tôi sẵn sàng</>}</button><button className="button button-secondary" onClick={() => run(() => status("AI_DISCUSSION"))} disabled={busy || readyCount > 0}>Tạo trận khác</button></div>{readyCount > 0 && <p className="waiting-copy">Muốn tạo lại nội dung, người đã START cần bấm Hủy START trước.</p>}</div></section>;
    }
    if (phase === "countdown") return <section className="surface center-stage"><div className="countdown">{countdown}</div><p>Máy chủ đang đồng bộ thời điểm mở câu cho cả hai người.</p></section>;
    if (phase === "battle" && room.match?.question && roundBeginsIn > 0) return <div className="battle-shell"><Scorebar members={room.members} title={room.match.title} round={room.match.currentRound} rounds={room.match.roundCount} seconds={room.match.question.timeLimit} /><section className="surface question-stage"><span className="mode-label">SYNCHRONIZING</span><div className="countdown">{roundBeginsIn}</div><h2>Cả hai sẽ bắt đầu cùng lúc</h2><p>Đề và ô trả lời sẽ mở theo đồng hồ máy chủ, không phụ thuộc máy nào nhận Realtime trước.</p></section></div>;
    if (phase === "battle" && room.match?.question) return <div className="battle-shell">
      <Scorebar members={room.members} title={room.match.title} round={room.match.currentRound} rounds={room.match.roundCount} seconds={seconds} />
      <section className="surface question-stage">
        <div className="question-stage-meta">
          <span className="mode-label">{room.match.question.mode.replaceAll("_", " ")}</span>
          <span className={`fairness-badge fairness-${roundFairness?.decision ?? "pending"}`}>{roundFairness?.participantCount === 2 ? roundFairness.decision === "fair" ? "Hai bên đã đồng bộ" : roundFairness.decision === "compromised" ? "Đường truyền lệch lớn" : "Đang kiểm tra độ trễ" : `${roundFairness?.participantCount ?? 0}/2 đã nhận câu`}</span>
        </div>
        {submitted ? <div className="answer-submitted"><CheckCircle2 size={28} className="text-accent" /><h2>Đã nộp đáp án</h2><p>Gemini vẫn đang hoạt động. Đang chờ người còn lại.</p></div> : roundExpired ? <div className="answer-submitted"><XCircle size={28} className="review-wrong" /><h2>Hết giờ</h2><p>Đang ghi nhận lượt này và chờ người còn lại.</p></div> : <QuestionPlayer key={room.match.question.id} question={room.match.question} value={answer} settings={resolveMatchSettings(room.match.blueprint)} seconds={seconds} busy={busy} onChange={(value) => setAnswerDrafts((drafts) => ({ ...drafts, [room.match!.question!.id]: value }))} onSubmit={() => void submit()} onSpeakingSubmitted={() => { void acknowledgeDelivery("answer_sent"); toast.success("Gemini đã chấm phần nói. Đang chờ người còn lại."); router.refresh(); }} onWritingSubmitted={() => { void acknowledgeDelivery("answer_sent"); toast.success("Gemini đã chấm bài viết. Đang chờ người còn lại."); router.refresh(); }} onAudioReady={() => void acknowledgeDelivery("audio_ready")} onHint={requestHint} />}
        <div className="answer-help">Điểm được tính theo từng kỹ năng. Câu nói và viết ưu tiên chất lượng; câu nhanh ưu tiên độ chính xác trước tốc độ.{roundFairness?.inputSkewMs != null ? ` Độ lệch mở input: ${roundFairness.inputSkewMs}ms.` : ""}</div>
        <div className="battle-coach"><div className="gemini-controls">{gemini.status === "off" || gemini.status === "error" ? <button type="button" className="button button-secondary" onClick={startGemini} disabled={remoteAiActive}><Bot size={17} /> {remoteAiActive ? "Gemini đang hoạt động" : "Bật Gemini trợ giảng"}</button> : <button type="button" className="button button-danger" onClick={stopGemini}><MicOff size={17} /> Tắt Gemini</button>}<span className={`gemini-status ${remoteAiActive ? "listening" : gemini.status}`}>{remoteAiActive ? "shared" : gemini.status}</span></div>{gemini.error && <div className="gemini-error">{gemini.error}</div>}{gemini.outputTranscript && <div className="ai-transcript">{gemini.outputTranscript}</div>}</div>
      </section>
    </div>;
    if (phase === "round-result" && room.match) return <RoundResult room={room} data={resolution} interventions={interventions} currentReady={Boolean(currentMember?.isReady)} readyCount={readyCount} busy={busy} toggleReady={() => run(() => api(`/api/matches/${room.match!.id}/ready-next`, { method: "PATCH", body: JSON.stringify({ ready: !currentMember?.isReady }) }))} />;
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

function Loading({ title, detail, progress, onRecover }: { title: string; detail: string; progress?: RoomBootstrap["generation"]; onRecover?: () => void }) {
  const [recoverable, setRecoverable] = useState(false);
  useEffect(() => {
    if (!progress?.updatedAt || !onRecover || !["queued", "generating", "persisting", "retrying"].includes(progress.status)) return;
    const remaining = Math.max(0, 330_000 - (Date.now() - new Date(progress.updatedAt).getTime()));
    const timer = window.setTimeout(() => setRecoverable(true), remaining);
    return () => window.clearTimeout(timer);
  }, [onRecover, progress]);
  const percentage = progress?.totalRounds ? Math.min(100, Math.round((progress.completedRounds / progress.totalRounds) * 100)) : null;
  return <section className="surface center-stage"><div className="ai-avatar"><Image src="/images/lexi-host.png" alt="Lexi AI host" fill sizes="126px" /></div><h1>{title}</h1><p>{detail}</p>{progress && <div className="generation-progress"><div><strong>{progress.stage}</strong><span>{progress.totalRounds ? `${progress.completedRounds}/${progress.totalRounds} câu` : "Đang chuẩn bị"}</span></div><div className="generation-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}><span style={{ width: `${percentage ?? 8}%` }} /></div></div>}{recoverable && onRecover ? <div className="generation-recovery"><p>Tiến trình không cập nhật quá 5 phút và có thể đã bị Vercel ngắt.</p><button type="button" className="button button-secondary" onClick={onRecover}><RotateCcw size={16} /> Khôi phục phòng</button></div> : <LoaderCircle size={24} className="animate-spin text-accent" />}</section>;
}

function Scorebar({ members, title, round, rounds, seconds }: { members: RoomMemberData[]; title: string; round: number; rounds: number; seconds: number }) {
  return <section className="surface battle-scorebar">{members.slice(0, 1).map((member) => <div className="battle-player" key={member.userId}><Avatar name={member.displayName} src={member.avatarUrl ?? undefined} size={52} /><div><strong>{member.displayName}</strong><span>{member.streak} streak</span></div><span className="score">{member.score}</span></div>)}<div className="round-meta"><strong>{title}</strong><span>Round {round} / {rounds}</span><div className="timer-ring">{seconds}</div></div>{members.slice(1, 2).map((member) => <div className="battle-player right" key={member.userId}><Avatar name={member.displayName} src={member.avatarUrl ?? undefined} size={52} /><div><strong>{member.displayName}</strong><span>{member.streak} streak</span></div><span className="score">{member.score}</span></div>)}</section>;
}

function RoundResult({ room, data, interventions, currentReady, readyCount, busy, toggleReady }: { room: RoomBootstrap; data: RoundResolutionData | null; interventions: AiIntervention[]; currentReady: boolean; readyCount: number; busy: boolean; toggleReady: () => void }) {
  if (!data) return <Loading title="Revealing the round" detail="Loading the protected answer and both real submissions." />;
  const isFinalRound = Boolean(room.match && room.match.currentRound >= room.match.roundCount);
  return <section className="surface center-stage"><div className="round-result-card"><div className="round-result-head"><CheckCircle2 size={30} className="text-accent" /><h1>{data.canonicalAnswer}</h1><p className="text-muted">{data.explanation}</p></div><div className="resolution-grid">{room.members.map((member) => {
    const submission = data.submissions.find((item) => item.userId === member.userId);
    const timedOut = Boolean(submission?.timedOut);
    const correct = Boolean(submission?.correct);
    const verdict = !submission ? "Không có đáp án" : submission.rubricScore != null ? `${Math.round(submission.rubricScore)}/100 · +${submission.points}` : correct && timedOut ? "Đúng nhưng hết giờ · +0" : correct && submission.matchType === "semantic_appeal" ? `Đúng nghĩa tương đương · +${submission.points}` : correct && submission.matchType === "minor_typo" ? `Chấp nhận lỗi gõ nhỏ · +${submission.points}` : correct ? `Đúng · +${submission.points}` : timedOut ? "Hết giờ · +0" : "Sai · +0";
    return <article className="resolution" key={member.userId}><strong>{member.displayName}</strong><div className="resolution-answer">{submission?.answer === "⏱ Hết giờ" ? "Hết giờ" : submission?.answer ?? "Chưa trả lời"}</div>{submission?.matchedAnswer && ["minor_typo", "semantic_appeal"].includes(submission.matchType ?? "") && <small>Khớp với: {submission.matchedAnswer}</small>}{submission?.hintsUsed ? <small>Đã dùng {submission.hintsUsed} gợi ý</small> : null}{submission?.scoreComponents && submission.rubricScore == null ? <div className="score-breakdown"><span>Nền +{submission.scoreComponents.base ?? 0}</span><span>Độ khó +{submission.scoreComponents.difficulty ?? 0}</span><span>Tốc độ +{submission.scoreComponents.speed ?? 0}</span><span>Chuỗi +{submission.scoreComponents.streak ?? 0}</span>{(submission.scoreComponents.hintDeduction ?? 0) > 0 ? <span>Gợi ý -{submission.scoreComponents.hintDeduction}</span> : null}</div> : null}{submission?.assessment && <div className="round-rubric">{submission.assessment.task != null ? <><span>Yêu cầu {Math.round(submission.assessment.task)}</span><span>Mạch lạc {Math.round(submission.assessment.coherence ?? 0)}</span></> : <><span>Nội dung {Math.round(submission.assessment.content ?? 0)}</span><span>Phát âm {Math.round(submission.assessment.pronunciation ?? 0)}</span><span>Trôi chảy {Math.round(submission.assessment.fluency ?? 0)}</span></>}<span>Ngữ pháp {Math.round(submission.assessment.grammar ?? 0)}</span><span>Từ vựng {Math.round(submission.assessment.vocabulary ?? 0)}</span><p>{submission.assessment.feedbackVi}</p></div>}<div className="resolution-meta"><span>{submission ? `${(submission.responseMs / 1000).toFixed(2)}s` : "-"}</span><span className={correct ? "text-accent" : "review-wrong"}>{verdict}</span></div>{submission && member.userId === room.currentUserId && !correct && !timedOut && submission.matchType !== "rubric" && <AppealButton submissionId={submission.id} />}</article>;
  })}</div><div className="ai-transcript">Đáp án được chấp nhận: {data.acceptedAnswers.join(", ")}</div>{interventions.length > 0 && <div className="intervention-panel"><span className="eyebrow"><Sparkles size={13} /> AI TEACHING POLICY</span>{interventions.map((event) => <p key={event.id}>{event.ui_message_vi}</p>)}</div>}<div className="ready-summary"><strong>{readyCount}/2 người đã xác nhận</strong><span>{readyCount === 0 ? `Cả hai bấm ${isFinalRound ? "FINISH" : "NEXT ROUND"} khi đã xem xong kết quả.` : readyCount === 1 ? "Đang chờ người còn lại xác nhận." : isFinalRound ? "Đang chốt kết quả trận." : "Đang chuyển sang câu tiếp theo."}</span></div><button className={currentReady ? "button button-secondary button-wide" : "button button-primary button-wide"} disabled={busy || readyCount === 2} onClick={toggleReady}>{currentReady ? <><RotateCcw size={17} /> Hủy xác nhận</> : <>{isFinalRound ? "FINISH — Tôi đồng ý" : "NEXT ROUND — Tôi sẵn sàng"}<ArrowRight size={17} /></>}</button></div></section>;
}

function AppealButton({ submissionId }: { submissionId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [checking, setChecking] = useState(false);
  async function appeal() {
    if (reason.trim().length < 3 || checking) return;
    setChecking(true);
    try {
      const response = await fetch("/api/answers/appeal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionId, reason }) });
      const body = await response.json().catch(() => ({})) as { error?: string; verdict?: { accepted?: boolean; explanationVi?: string } };
      if (!response.ok) throw new Error(body.error ?? "Không phúc khảo được đáp án");
      toast.success(body.verdict?.accepted ? "Phúc khảo được chấp nhận và điểm đã cập nhật." : body.verdict?.explanationVi ?? "Phúc khảo không được chấp nhận.");
      window.location.reload();
    } catch (error) { showError(error); }
    finally { setChecking(false); }
  }
  if (!open) return <button type="button" className="suggestion appeal-trigger" onClick={() => setOpen(true)}>Đáp án này đồng nghĩa?</button>;
  return <div className="appeal-form"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Giải thích ngắn vì sao đáp án của bạn tương đương" /><div><button type="button" className="suggestion" onClick={() => setOpen(false)} disabled={checking}>Hủy</button><button type="button" className="suggestion" onClick={() => void appeal()} disabled={checking || reason.trim().length < 3}>{checking ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />} Phúc khảo bằng AI</button></div></div>;
}

function Result({ room, isHost, busy, rematch }: { room: RoomBootstrap; isHost: boolean; busy: boolean; rematch: () => void }) {
  const winner = room.members.find((member) => member.userId === room.match?.winnerId); const scores = [...room.members].sort((a, b) => b.score - a.score);
  const cooperative = resolveMatchSettings(room.match?.blueprint).experience === "COOP";
  return <div className="result-stage"><section className="surface winner-panel"><Crown size={34} className="text-accent" />{cooperative ? <div className="coop-finish"><Bot size={44} /><span>{scores.reduce((total, member) => total + member.score, 0)}</span><small>điểm đội</small></div> : winner ? <Avatar name={winner.displayName} src={winner.avatarUrl ?? undefined} size={110} speaking /> : <div className="empty-avatar large" />}<h1>{cooperative ? "Hoàn thành cùng nhau" : winner ? "Winner" : "Draw"}</h1><h2>{cooperative ? "Hai bạn đã chinh phục trận học nhóm" : winner?.displayName ?? "Equal score"}</h2><div className="final-score">{scores.map((member) => member.score).join(" - ")}</div><div className="winner-actions">{isHost && <button className="button button-primary" disabled={busy} onClick={rematch}><RotateCcw size={17} /> Trận mới</button>}<Link className="button button-secondary" href="/dashboard">Dashboard</Link></div></section><section className="surface review-panel"><div><span className="ai-badge"><Sparkles size={15} /> Đã lưu trận</span><h2>Toàn bộ từ, đáp án và kết quả của hai người đã sẵn sàng để ôn lại.</h2></div><div className="review-items">{scores.map((member) => <div className="review-item" key={member.userId}>{cooperative || member.userId === room.match?.winnerId ? <CheckCircle2 size={18} className="review-correct" /> : <XCircle size={18} className="text-muted" />}<div><strong>{member.displayName}</strong><p>{member.streak} streak hiện tại</p></div><span>{member.score}</span></div>)}</div>{room.match && <><Link className="button button-primary button-wide" href={`/review/${room.match.id}`}>Ôn lại trận này <ArrowRight size={17} /></Link><Link className="button button-secondary button-wide" href={`/progress?matchId=${room.match.id}`}>Tổng kết &amp; mastery <Sparkles size={17} /></Link></>}</section></div>;
}
