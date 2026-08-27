import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const maxDuration = 30;

const bodySchema = z.object({ questionId: z.string().uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Câu hỏi không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });

  const { data: match } = await admin.from("matches").select("id, room_id, status, current_round, blueprint").eq("id", matchId).maybeSingle();
  if (!match) return NextResponse.json({ error: "Không tìm thấy trận" }, { status: 404 });
  const { data: player } = await admin.from("match_players").select("user_id").eq("match_id", matchId).eq("user_id", authData.user.id).maybeSingle();
  if (!player) return NextResponse.json({ error: "Bạn không thuộc trận này" }, { status: 403 });
  const blueprint = match.blueprint as { settings?: { allowHints?: boolean; maxHints?: number } };
  if ((blueprint.settings?.allowHints ?? true) === false) return NextResponse.json({ error: "Trận này đã tắt gợi ý" }, { status: 409 });
  if (match.status !== "active") return NextResponse.json({ error: "Vòng hiện tại đã kết thúc" }, { status: 409 });

  const { data: question } = await admin.from("questions").select("id, round_number, mode, prompt, instruction, level, public_payload").eq("id", parsed.data.questionId).eq("match_id", matchId).maybeSingle();
  if (!question || question.round_number !== match.current_round) return NextResponse.json({ error: "Câu hỏi không còn hoạt động" }, { status: 409 });
  const { data: existing } = await admin.from("match_hints").select("hint_text, sequence").eq("question_id", question.id).eq("user_id", authData.user.id).order("sequence", { ascending: false }).limit(1).maybeSingle();
  const maxHints = Math.min(3, Math.max(1, Number(blueprint.settings?.maxHints ?? 1)));
  if (existing && existing.sequence >= maxHints) return NextResponse.json({ hint: existing.hint_text, remaining: 0 });

  const { data: secret } = await admin.from("question_answers").select("canonical_answer, accepted_answers, explanation").eq("question_id", question.id).single();
  if (!secret) return NextResponse.json({ error: "Không tìm thấy dữ liệu chấm" }, { status: 404 });
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_GRADING_MODEL || "gemini-3.7-flash").replace(/^models\//, "");
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY chưa được cấu hình" }, { status: 503 });
  const sequence = (existing?.sequence ?? 0) + 1;
  const prompt = [
    "Create one short Vietnamese learning hint for an English learner.",
    "Never state, spell, translate, rhyme with, reveal the first letter of, or include any accepted answer.",
    "The hint should guide the reasoning, relevant grammar, semantic category, listening focus, or speaking structure.",
    `Hint strength: ${sequence}/${maxHints}. Mode: ${question.mode}. CEFR: ${question.level}.`,
    `Question: ${question.prompt}. Instruction: ${question.instruction}.`,
    `Private correct answer you must not reveal: ${secret.canonical_answer}. Private aliases: ${JSON.stringify(secret.accepted_answers)}.`,
    "Return only the hint sentence, no markdown."
  ].join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 100 } }), cache: "no-store"
  });
  const result = await response.json().catch(() => ({})) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
  const hint = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!response.ok || !hint) return NextResponse.json({ error: result.error?.message ?? "AI chưa tạo được gợi ý" }, { status: 502 });
  const forbidden = [secret.canonical_answer, ...(secret.accepted_answers as string[])].some((answer) => answer.length > 2 && hint.toLocaleLowerCase("vi-VN").includes(answer.toLocaleLowerCase("vi-VN")));
  if (forbidden) return NextResponse.json({ error: "AI đã tạo gợi ý quá rõ nên hệ thống không hiển thị" }, { status: 422 });

  const { error: insertError } = await admin.from("match_hints").insert({ match_id: matchId, question_id: question.id, user_id: authData.user.id, sequence, hint_text: hint });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });
  return NextResponse.json({ hint, remaining: Math.max(0, maxHints - sequence) }, { headers: { "Cache-Control": "private, no-store" } });
}
