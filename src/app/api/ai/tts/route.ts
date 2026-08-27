import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

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
  if (!question || !["LISTENING", "SPELLING"].includes(question.mode)) return NextResponse.json({ error: "Audio không tồn tại" }, { status: 404 });
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
  const ttsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Read the text exactly once in clear ${accent}. Do not add, remove, explain, or repeat anything. Text: ${JSON.stringify(text)}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
      }
    }),
    cache: "no-store"
  });
  const body = await ttsResponse.json().catch(() => ({})) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    error?: { message?: string };
  };
  const audio = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!ttsResponse.ok || !audio?.data) return NextResponse.json({ error: body.error?.message ?? "Gemini TTS không trả về audio" }, { status: 502 });

  const raw = Buffer.from(audio.data, "base64");
  const rate = Number(audio.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const isPcm = audio.mimeType?.includes("L16") || audio.mimeType?.includes("pcm");
  const output = isPcm ? pcm16ToWav(raw, rate) : raw;
  return new Response(output, {
    headers: {
      "Content-Type": isPcm ? "audio/wav" : audio.mimeType ?? "audio/mpeg",
      "Cache-Control": "private, max-age=86400",
      "Content-Length": String(output.length)
    }
  });
}
