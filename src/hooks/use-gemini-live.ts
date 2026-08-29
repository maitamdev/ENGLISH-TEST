"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GeminiLiveStatus = "off" | "connecting" | "listening" | "speaking" | "error";

type LiveMessage = {
  setupComplete?: Record<string, never>;
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  toolCall?: {
    functionCalls?: {
      id?: string;
      name?: string;
      args?: Record<string, unknown>;
    }[];
  };
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
  };
};

type GeminiLiveToolResult = {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
};

type GeminiLiveOptions = {
  onGenerateMatch?: (brief: string) => Promise<GeminiLiveToolResult>;
  onRequestHint?: () => Promise<GeminiLiveToolResult>;
  onAudioChunk?: (base64: string) => void;
  sessionMode?: "setup" | "coach";
  sessionContext?: string;
};

function pcmToBase64(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function resamplePcm(samples: Float32Array, sourceRate: number, targetRate = 16_000) {
  if (sourceRate === targetRate) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function base64ToPcm(base64: string) {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) view.setUint8(index, binary.charCodeAt(index));
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 0x8000;
  return samples;
}

export function useGeminiLive(roomId: string, options: GeminiLiveOptions = {}) {
  const sessionMode = options.sessionMode ?? "setup";
  const sessionContext = options.sessionContext?.slice(0, 1500) ?? "";
  const [status, setStatus] = useState<GeminiLiveStatus>("off");
  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlaybackTimeRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const handledToolCallsRef = useRef(new Set<string>());
  const resumptionHandleRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const restartRef = useRef<((stream: MediaStream, reconnect?: boolean) => Promise<void>) | null>(null);
  const onGenerateMatchRef = useRef(options.onGenerateMatch);
  const onRequestHintRef = useRef(options.onRequestHint);
  const onAudioChunkRef = useRef(options.onAudioChunk);

  useEffect(() => { onGenerateMatchRef.current = options.onGenerateMatch; }, [options.onGenerateMatch]);
  useEffect(() => { onRequestHintRef.current = options.onRequestHint; }, [options.onRequestHint]);
  useEffect(() => { onAudioChunkRef.current = options.onAudioChunk; }, [options.onAudioChunk]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) window.clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
  }, []);

  const releaseLease = useCallback(() => {
    stopHeartbeat();
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (!sessionId) return;
    void fetch("/api/ai/gemini-session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, sessionId }),
      keepalive: true
    }).catch(() => undefined);
  }, [roomId, stopHeartbeat]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    const heartbeat = async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const response = await fetch("/api/ai/gemini-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, sessionId }),
          cache: "no-store"
        });
        if (response.status === 409) {
          sessionIdRef.current = null;
          stopHeartbeat();
          intentionalCloseRef.current = true;
          socketRef.current?.close(4001, "AI coordinator lease expired");
          setError("Phiên Gemini đã chuyển sang máy khác. Bạn có thể bật lại AI.");
          setStatus("error");
        }
      } catch { /* A later heartbeat retries; the server owns lease expiry. */ }
    };
    void heartbeat();
    heartbeatTimerRef.current = window.setInterval(() => void heartbeat(), 20_000);
  }, [roomId, stopHeartbeat]);

  const stopPlayback = useCallback(() => {
    playbackSourcesRef.current.forEach((source) => { try { source.stop(); } catch { /* already stopped */ } });
    playbackSourcesRef.current.clear();
    nextPlaybackTimeRef.current = 0;
  }, []);

  const releaseAudio = useCallback(() => {
    processorRef.current?.disconnect();
    captureSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    processorRef.current = null;
    captureSourceRef.current = null;
    silentGainRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    stopPlayback();
    void outputContextRef.current?.close();
    outputContextRef.current = null;
  }, [stopPlayback]);

  const playAudio = useCallback(async (base64: string, relay = false) => {
    const context = outputContextRef.current ?? new AudioContext({ sampleRate: 24_000 });
    outputContextRef.current = context;
    if (context.state === "suspended") await context.resume();
    const samples = base64ToPcm(base64);
    const buffer = context.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, nextPlaybackTimeRef.current);
    source.start(startAt);
    nextPlaybackTimeRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.add(source);
    source.onended = () => playbackSourcesRef.current.delete(source);
    if (relay) onAudioChunkRef.current?.(base64);
  }, []);

  const playRemoteAudio = useCallback((base64: string) => playAudio(base64, false), [playAudio]);

  const stop = useCallback(() => {
    intentionalCloseRef.current = true;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      socket.close(1000, "AI stopped by host");
    } else socket?.close();
    socketRef.current = null;
    releaseLease();
    releaseAudio();
    setStatus("off");
  }, [releaseAudio, releaseLease]);

  const sendText = useCallback((text: string) => {
    const socket = socketRef.current;
    const message = text.trim();
    if (!message || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ realtimeInput: { text: message.slice(0, 4000) } }));
    return true;
  }, []);

  const startCapture = useCallback(async (stream: MediaStream, socket: WebSocket) => {
    const context = captureContextRef.current ?? new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const resampled = resamplePcm(samples, context.sampleRate);
      socket.send(JSON.stringify({
        realtimeInput: {
          audio: { data: pcmToBase64(resampled), mimeType: "audio/pcm;rate=16000" }
        }
      }));
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    captureContextRef.current = context;
    captureSourceRef.current = source;
    processorRef.current = processor;
    silentGainRef.current = silentGain;
  }, []);

  const start = useCallback(async (stream: MediaStream, reconnect = false) => {
    if (!reconnect && (status === "connecting" || status === "listening" || status === "speaking")) return;
    intentionalCloseRef.current = false;
    setError(null);
    if (!reconnect) {
      reconnectAttemptsRef.current = 0;
      resumptionHandleRef.current = null;
      sessionIdRef.current = null;
      setInputTranscript("");
      setOutputTranscript("");
      handledToolCallsRef.current.clear();
    }
    setStatus("connecting");

    try {
      if (!outputContextRef.current) outputContextRef.current = new AudioContext({ sampleRate: 24_000 });
      if (!captureContextRef.current) captureContextRef.current = new AudioContext();
      await Promise.all([outputContextRef.current.resume(), captureContextRef.current.resume()]);
      const tokenResponse = await fetch("/api/ai/gemini-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, sessionId: sessionIdRef.current ?? undefined })
      });
      const tokenBody = await tokenResponse.json() as { token?: string; model?: string; sessionId?: string; error?: string };
      if (!tokenResponse.ok || !tokenBody.token || !tokenBody.model || !tokenBody.sessionId) throw new Error(tokenBody.error ?? "Could not start Gemini Live");
      sessionIdRef.current = tokenBody.sessionId;
      const resumedConnection = reconnect;

      const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenBody.token)}`;
      const socket = new WebSocket(endpoint);
      socketRef.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({
          setup: {
            model: `models/${tokenBody.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }
              }
            },
            sessionResumption: resumptionHandleRef.current ? { handle: resumptionHandleRef.current } : {},
            contextWindowCompression: { slidingWindow: {} },
            tools: [{
              functionDeclarations: [{
                name: "generate_match",
                description: "Tạo và lưu một trận đấu luyện tiếng Anh khi một trong hai thành viên yêu cầu tạo, sinh, bắt đầu hoặc làm một chủ đề, bài kiểm tra, trò chơi, cuộc thi hay trận đấu. Phải gọi hàm này thay vì tự giả vờ bắt đầu cuộc thi bằng lời.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    brief: {
                      type: "STRING",
                      description: "Mô tả bằng tiếng Việt, phải giữ chính xác chủ đề, số lượng câu hoặc từ, hướng dịch, trình độ, dạng câu hỏi và mọi yêu cầu người dùng đã nói."
                    }
                  },
                  required: ["brief"]
                }
              }, {
                name: "request_hint",
                description: "Xin một gợi ý an toàn từ server cho câu đang thi khi người chơi nói rằng họ cần gợi ý. Công cụ tự giới hạn số lần và trừ điểm theo luật. Không tự bịa gợi ý hoặc nói đáp án.",
                parameters: { type: "OBJECT", properties: {} }
              }]
            }],
            systemInstruction: {
              parts: [{ text: [
                "Bạn là Lexi, giáo viên tiếng Anh bằng giọng nói trong phòng học riêng của hai người bạn.",
                "QUY TẮC NGÔN NGỮ BẮT BUỘC: luôn trả lời bằng tiếng Việt tự nhiên, trừ khi người dùng yêu cầu rõ ràng rằng bạn phải trả lời bằng một ngôn ngữ khác.",
                "Khi người dùng nói tiếng Việt, hoặc trộn tiếng Việt với tiếng Anh, câu giải thích và hội thoại của bạn vẫn phải chủ yếu bằng tiếng Việt.",
                "Chỉ dùng tiếng Anh cho từ, câu ví dụ, phần phát âm hoặc nội dung luyện tập đang được hỏi. Không tự chuyển toàn bộ câu trả lời sang tiếng Anh chỉ vì đây là ứng dụng học tiếng Anh.",
                "Phiên Live này phải hoạt động liên tục từ lúc tạo trận cho đến khi trận kết thúc; không yêu cầu người dùng bật lại ở mỗi câu.",
                "Ở giai đoạn chuẩn bị, khi một thành viên yêu cầu tạo chủ đề, bài, game, cuộc thi hoặc trận đấu, BẮT BUỘC gọi generate_match đúng một lần. Khi hệ thống thông báo trận đã bắt đầu thì không gọi generate_match nữa.",
                "Trong lúc thi, bạn là trợ giảng giọng nói: động viên hoặc nhắc luật nhưng tuyệt đối không tiết lộ đáp án của câu hiện tại trước khi cả hai đã trả lời.",
                "Nếu người chơi đang thi và nói xin gợi ý, BẮT BUỘC gọi request_hint. Chỉ đọc đúng gợi ý server trả về, không thêm thông tin có thể lộ đáp án.",
                "Khi hệ thống gửi HỆ_THỐNG_AI_CHỦ_ĐỘNG, hãy nói ngay đúng một câu ngắn theo chỉ dẫn rồi tiếp tục lắng nghe.",
                "Khi nhận thông báo HỆ THỐNG_KẾT_QUẢ_VÒNG, hãy lập tức nhận xét bằng tiếng Việt trong tối đa ba câu: ai đúng/sai hoặc hết giờ, đáp án đúng, và một mẹo tiếng Anh ngắn. Không gọi công cụ.",
                "Không cần hỏi lại nếu người dùng đã nêu một chủ đề rõ ràng. Sau khi gọi công cụ, chỉ thông báo kết quả thật nhận được từ công cụ.",
                sessionMode === "setup" ? "Trả lời ngắn gọn, thân thiện bằng giọng Kore của Gemini Live; hỏi hai người muốn luyện chủ đề và trình độ nào." : "Trả lời ngắn gọn, thân thiện bằng giọng Kore của Gemini Live; tập trung hỗ trợ trận hiện tại.",
                "Không được tuyên bố đã nghe thấy nội dung không xuất hiện trong audio hoặc transcript đầu vào.",
                sessionContext
              ].join("\n") }]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        }));
      };
      socket.onmessage = async (event) => {
        const raw = typeof event.data === "string" ? event.data : event.data instanceof Blob ? await event.data.text() : String(event.data);
        const message = JSON.parse(raw) as LiveMessage;
        if (message.sessionResumptionUpdate?.newHandle) resumptionHandleRef.current = message.sessionResumptionUpdate.newHandle;
        if (message.goAway) setOutputTranscript((current) => `${current}\nLexi đang duy trì phiên trợ giảng…`);
        if (message.setupComplete) {
          reconnectAttemptsRef.current = 0;
          setStatus("listening");
          startHeartbeat();
          if (!resumedConnection) {
            socket.send(JSON.stringify({ realtimeInput: { text: sessionMode === "setup"
              ? "Hãy chào hai bạn bằng tiếng Việt và hỏi: hôm nay hai bạn muốn học hay thi với nhau chủ đề gì? Chỉ hỏi ngắn gọn rồi chờ câu trả lời."
              : "Hãy chào ngắn gọn bằng tiếng Việt rằng Lexi đã vào làm trợ giảng và sẵn sàng tương tác trong lúc hai bạn thi."
            } }));
          }
          void startCapture(stream, socket);
        }
        const functionCalls = message.toolCall?.functionCalls ?? [];
        if (functionCalls.length > 0) {
          const functionResponses = await Promise.all(functionCalls.map(async (functionCall) => {
            const name = functionCall.name ?? "unknown_tool";
            const id = functionCall.id ?? `${name}-${crypto.randomUUID()}`;
            if (handledToolCallsRef.current.has(id)) {
              return { id, name, response: { result: { status: "already_processed" } } };
            }
            handledToolCallsRef.current.add(id);
            if (name === "request_hint") {
              const hintHandler = onRequestHintRef.current;
              if (!hintHandler) return { id, name, response: { error: "Gợi ý chỉ khả dụng khi một vòng đang diễn ra." } };
              try {
                const result = await hintHandler();
                return result.ok
                  ? { id, name, response: { result: { status: "success", message: result.message, ...result.data } } }
                  : { id, name, response: { error: result.message } };
              } catch (caught) {
                return { id, name, response: { error: caught instanceof Error ? caught.message : "Không lấy được gợi ý." } };
              }
            }
            if (name !== "generate_match") return { id, name, response: { error: `Unsupported tool: ${name}` } };

            const brief = typeof functionCall.args?.brief === "string" ? functionCall.args.brief.trim().slice(0, 1000) : "";
            if (!brief) return { id, name, response: { error: "Gemini did not provide a match brief." } };
            const handler = onGenerateMatchRef.current;
            if (!handler) return { id, name, response: { error: "Match generation is not available in this room." } };

            try {
              const result = await handler(brief);
              return result.ok
                ? { id, name, response: { result: { status: "success", message: result.message, ...result.data } } }
                : { id, name, response: { error: result.message } };
            } catch (caught) {
              return { id, name, response: { error: caught instanceof Error ? caught.message : "Could not generate the match." } };
            }
          }));
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
          }
        }
        const content = message.serverContent;
        if (!content) return;
        if (content.interrupted) { stopPlayback(); setStatus("listening"); }
        const heard = content.inputTranscription?.text;
        if (heard) setInputTranscript((current) => `${current}${heard}`);
        const spoken = content.outputTranscription?.text;
        if (spoken) setOutputTranscript((current) => `${current}${spoken}`);
        const parts = content.modelTurn?.parts ?? [];
        for (const part of parts) {
          const audio = part.inlineData;
          if (audio?.data) { setStatus("speaking"); void playAudio(audio.data, true); }
        }
        if (content.turnComplete) setStatus("listening");
      };
      socket.onerror = () => { setError("Gemini Live WebSocket failed"); setStatus("error"); };
      socket.onclose = (event) => {
        socketRef.current = null;
        releaseAudio();
        if (!intentionalCloseRef.current) {
          const attempt = reconnectAttemptsRef.current + 1;
          reconnectAttemptsRef.current = attempt;
          if (stream.active && attempt <= 5) {
            setStatus("connecting");
            window.setTimeout(() => void restartRef.current?.(stream, true), Math.min(5000, 500 * (2 ** (attempt - 1))));
          } else {
            releaseLease();
            setError(event.reason || `Gemini Live closed (${event.code})`);
            setStatus("error");
          }
        }
      };
    } catch (caught) {
      releaseAudio();
      const message = caught instanceof Error ? caught.message : "Could not start Gemini Live";
      if (reconnect && stream.active && reconnectAttemptsRef.current < 5) {
        const attempt = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = attempt;
        setStatus("connecting");
        window.setTimeout(() => void restartRef.current?.(stream, true), Math.min(5000, 500 * (2 ** (attempt - 1))));
      } else {
        releaseLease();
        setError(message);
        setStatus("error");
      }
    }
  }, [playAudio, releaseAudio, releaseLease, roomId, sessionContext, sessionMode, startCapture, startHeartbeat, status, stopPlayback]);

  useEffect(() => { restartRef.current = start; }, [start]);
  useEffect(() => stop, [stop]);

  return { status, inputTranscript, outputTranscript, error, start, stop, sendText, playRemoteAudio };
}
