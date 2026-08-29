import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { pcm16ToWav } from "@/lib/ai/audio";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

function audioResponse(output: Buffer, contentType: string, cache: "HIT" | "MISS" | "BYPASS") {
  return new Response(Uint8Array.from(output), { headers: { "Content-Type": contentType, "Content-Length": String(output.length), "Cache-Control": "private, max-age=86400", "X-LexiDuel-Audio-Cache": cache } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ turnId: string }> }) {
  const { turnId } = await params;
  if (!z.string().uuid().safeParse(turnId).success) return NextResponse.json({ error: "Lượt nói không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: turn } = await supabase.from("speaking_turns").select("id, speaker_type, transcript").eq("id", turnId).maybeSingle();
  if (!turn || turn.speaker_type !== "ai") return NextResponse.json({ error: "Không tìm thấy audio AI" }, { status: 404 });
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview").replace(/^models\//, "");
  const voice = process.env.GEMINI_SPEAKING_VOICE || "Kore";
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY chưa được cấu hình" }, { status: 503 });
  const hash = createHash("sha256").update(JSON.stringify({ text: turn.transcript, model, voice })).digest("hex");
  const path = `speaking/${hash.slice(0, 2)}/${hash}.wav`;
  const bucket = "question-audio";
  const { data: cached } = await admin.from("speaking_turn_audio_assets").select("storage_path, mime_type, status").eq("turn_id", turn.id).maybeSingle();
  if (cached?.status === "ready" && cached.storage_path) {
    const { data: file } = await admin.storage.from(bucket).download(cached.storage_path);
    if (file) return audioResponse(Buffer.from(await file.arrayBuffer()), cached.mime_type || "audio/wav", "HIT");
  }
  await admin.from("speaking_turn_audio_assets").upsert({ turn_id: turn.id, content_hash: hash, provider: "gemini", model, voice, storage_bucket: bucket, storage_path: path, status: "generating", updated_at: new Date().toISOString() });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Speak exactly this English dialogue line once, naturally and clearly. Do not add anything: ${JSON.stringify(turn.transcript)}` }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }), cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]; error?: { message?: string } };
  const inline = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!response.ok || !inline?.data) {
    await admin.from("speaking_turn_audio_assets").update({ status: "failed", error_message: body.error?.message ?? "No audio", updated_at: new Date().toISOString() }).eq("turn_id", turn.id);
    return NextResponse.json({ error: body.error?.message ?? "Gemini TTS không trả về audio" }, { status: 502 });
  }
  const raw = Buffer.from(inline.data, "base64");
  const rate = Number(inline.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const isPcm = inline.mimeType?.includes("L16") || inline.mimeType?.includes("pcm");
  const output = isPcm ? pcm16ToWav(raw, rate) : raw;
  const contentType = isPcm ? "audio/wav" : inline.mimeType ?? "audio/mpeg";
  const { error: uploadError } = await admin.storage.from(bucket).upload(path, output, { contentType, cacheControl: "31536000", upsert: true });
  await admin.from("speaking_turn_audio_assets").update(uploadError ? { status: "failed", error_message: uploadError.message, updated_at: new Date().toISOString() } : { status: "ready", storage_path: path, mime_type: contentType, byte_size: output.length, error_message: null, updated_at: new Date().toISOString() }).eq("turn_id", turn.id);
  return audioResponse(output, contentType, uploadError ? "BYPASS" : "MISS");
}
