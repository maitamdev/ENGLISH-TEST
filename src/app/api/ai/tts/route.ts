import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 45;

const querySchema = z.string().uuid();

function pcm16ToWav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function audioResponse(output: Buffer, contentType: string, cacheStatus: "HIT" | "MISS" | "BYPASS") {
  return new Response(Uint8Array.from(output), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=86400",
      "Content-Length": String(output.length),
      "X-LexiDuel-Audio-Cache": cacheStatus
    }
  });
}

export async function GET(request: Request) {
  const questionId = querySchema.safeParse(new URL(request.url).searchParams.get("questionId"));
  if (!questionId.success) return NextResponse.json({ error: "Question ID không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });

  const { data: question } = await supabase.from("questions")
    .select("id, mode, prompt, public_payload")
    .eq("id", questionId.data)
    .maybeSingle();
  if (!question || !["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING"].includes(question.mode)) return NextResponse.json({ error: "Audio không tồn tại" }, { status: 404 });
  const payload = question.public_payload as Record<string, unknown> | null;
  const { data: secret } = await admin.from("question_answers").select("grading_rules").eq("question_id", question.id).maybeSingle();
  const gradingRules = secret?.grading_rules as Record<string, unknown> | null;
  const text = typeof gradingRules?.audioText === "string"
    ? gradingRules.audioText.trim()
    : typeof payload?.audioText === "string" ? payload.audioText.trim() : "";
  if (!text) return NextResponse.json({ error: "Câu nghe chưa có nội dung audio" }, { status: 422 });

  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview").replace(/^models\//, "");
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY chưa được cấu hình" }, { status: 503 });
  const accent = payload?.accent === "UK" ? "British English" : payload?.accent === "AU" ? "Australian English" : "American English";
  const voice = "Kore";
  const playbackRate = Number(payload?.speed ?? 1);
  const contentHash = createHash("sha256").update(JSON.stringify({ text, model, voice, accent, playbackRate })).digest("hex");
  const bucket = "question-audio";
  const storagePath = `${contentHash.slice(0, 2)}/${contentHash}.wav`;
  const cacheQuery = () => admin.from("question_audio_assets").select("id, storage_path, mime_type, status, lease_expires_at").eq("content_hash", contentHash).eq("model", model).eq("voice", voice).eq("accent", accent).eq("playback_rate", playbackRate).maybeSingle();
  let { data: cached } = await cacheQuery();
  if (cached?.status === "ready" && cached.storage_path) {
    const { data: file } = await admin.storage.from(bucket).download(cached.storage_path);
    if (file) return audioResponse(Buffer.from(await file.arrayBuffer()), cached.mime_type || "audio/wav", "HIT");
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  if (cached?.status === "generating" && cached.lease_expires_at && new Date(cached.lease_expires_at).getTime() > Date.now()) {
    const waitUntil = Date.now() + 25_000;
    while (Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      cached = (await cacheQuery()).data;
      if (cached?.status === "ready" && cached.storage_path) {
        const { data: file } = await admin.storage.from(bucket).download(cached.storage_path);
        if (file) return audioResponse(Buffer.from(await file.arrayBuffer()), cached.mime_type || "audio/wav", "HIT");
      }
      if (cached?.status === "failed") break;
    }
    if (cached?.status === "generating") return NextResponse.json({ error: "Audio Gemini đang được tạo, hãy thử lại sau vài giây" }, { status: 425, headers: { "Retry-After": "2" } });
  }
  if (cached?.id) {
    const { data: claimed } = await admin.from("question_audio_assets").update({ status: "generating", lease_token: leaseToken, lease_expires_at: leaseExpiresAt, error_message: null, updated_at: new Date().toISOString() }).eq("id", cached.id).or(`lease_expires_at.is.null,lease_expires_at.lt.${new Date().toISOString()},status.eq.failed`).select("id").maybeSingle();
    if (!claimed) return NextResponse.json({ error: "Audio Gemini đang được tạo" }, { status: 425, headers: { "Retry-After": "2" } });
  } else {
    const { error: insertError } = await admin.from("question_audio_assets").insert({
      question_id: question.id, content_hash: contentHash, provider: "gemini", model, voice, accent,
      playback_rate: playbackRate, storage_bucket: bucket, storage_path: storagePath,
      status: "generating", lease_token: leaseToken, lease_expires_at: leaseExpiresAt,
      updated_at: new Date().toISOString()
    });
    if (insertError) return NextResponse.json({ error: "Audio Gemini đang được tạo" }, { status: 425, headers: { "Retry-After": "2" } });
  }
  const ttsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Read the text exactly once in clear ${accent}. Do not add, remove, explain, or repeat anything. Text: ${JSON.stringify(text)}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    }),
    cache: "no-store"
  });
  const body = await ttsResponse.json().catch(() => ({})) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    error?: { message?: string };
  };
  const audio = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!ttsResponse.ok || !audio?.data) {
    const message = body.error?.message ?? "Gemini TTS không trả về audio";
    await admin.from("question_audio_assets").update({ status: "failed", error_message: message, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("content_hash", contentHash).eq("model", model).eq("voice", voice).eq("accent", accent).eq("playback_rate", playbackRate).eq("lease_token", leaseToken);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const raw = Buffer.from(audio.data, "base64");
  const rate = Number(audio.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const isPcm = audio.mimeType?.includes("L16") || audio.mimeType?.includes("pcm");
  const output = isPcm ? pcm16ToWav(raw, rate) : raw;
  const contentType = isPcm ? "audio/wav" : audio.mimeType ?? "audio/mpeg";
  const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, output, { contentType, cacheControl: "31536000", upsert: true });
  await admin.from("question_audio_assets").update(uploadError ? {
    status: "failed", error_message: uploadError.message, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString()
  } : {
    status: "ready", storage_path: storagePath, mime_type: contentType, byte_size: output.length,
    error_message: null, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString()
  }).eq("content_hash", contentHash).eq("model", model).eq("voice", voice).eq("accent", accent).eq("playback_rate", playbackRate).eq("lease_token", leaseToken);
  return audioResponse(output, contentType, uploadError ? "BYPASS" : "MISS");
}
