import "server-only";

function pcm16ToWav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function synthesizeExactEnglish(text: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview").replace(/^models\//u, "");
  if (!apiKey) throw new Error("GEMINI_API_KEY chưa được cấu hình");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Read this English text exactly once, clearly and naturally. Do not add, explain, translate, or repeat: ${JSON.stringify(text)}` }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]; error?: { message?: string } };
  const audio = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!response.ok || !audio?.data) throw new Error(body.error?.message ?? "Gemini TTS không trả audio");
  const raw = Buffer.from(audio.data, "base64");
  const sampleRate = Number(audio.mimeType?.match(/rate=(\d+)/u)?.[1] ?? 24000);
  const isPcm = Boolean(audio.mimeType?.includes("L16") || audio.mimeType?.includes("pcm"));
  return { data: isPcm ? pcm16ToWav(raw, sampleRate) : raw, contentType: isPcm ? "audio/wav" : audio.mimeType ?? "audio/mpeg" };
}
