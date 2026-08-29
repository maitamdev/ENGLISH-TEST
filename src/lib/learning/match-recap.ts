import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

function skillForMode(mode: string) {
  if (["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING"].includes(mode)) return "listening";
  if (["READING", "MULTIPLE_CHOICE", "CONTEXT", "DEFINITION"].includes(mode)) return "reading";
  if (["GRAMMAR", "SENTENCE_BUILDER", "CLOZE", "ERROR_CORRECTION", "COLLOCATION"].includes(mode)) return "grammar";
  if (["WRITING", "TRANSLATION"].includes(mode)) return "writing";
  if (mode === "PRONUNCIATION") return "phonology";
  if (["SPEAKING", "ROLEPLAY", "DEBATE"].includes(mode)) return "speaking";
  return "vocabulary";
}

export async function getOrCreateMatchRecap(admin: SupabaseClient, userId: string, matchId: string) {
  const { data: membership } = await admin.from("match_players").select("user_id").eq("match_id", matchId).eq("user_id", userId).maybeSingle();
  if (!membership) throw new Error("Bạn không thuộc trận này");
  const { data: existing } = await admin.from("match_recaps").select("match_id, summary_vi, strengths, needs_work, next_actions, evidence_snapshot, algorithm_version, created_at").eq("match_id", matchId).maybeSingle();
  if (existing) return existing;
  const [{ data: match }, { data: questions }, { data: submissions }, { data: players }] = await Promise.all([
    admin.from("matches").select("id, room_id, title, topic, level, round_count, status, ended_at").eq("id", matchId).maybeSingle(),
    admin.from("questions").select("id, round_number, mode, prompt, level").eq("match_id", matchId).order("round_number"),
    admin.from("submissions").select("id, question_id, user_id, is_correct, timed_out, response_ms, rubric_score, hints_used, points").eq("match_id", matchId),
    admin.from("match_players").select("user_id, score, correct_count, incorrect_count, avg_response_ms, profiles(display_name)").eq("match_id", matchId)
  ]);
  if (!match || match.status !== "completed" || !match.ended_at || !questions?.length) throw new Error("Chỉ có thể tổng kết sau khi trận đã hoàn thành");
  const grouped = new Map<string, { attempts: number; successful: number; scoreTotal: number; responseTotal: number; timeouts: number; hints: number }>();
  for (const question of questions) {
    const skill = skillForMode(question.mode);
    const bucket = grouped.get(skill) ?? { attempts: 0, successful: 0, scoreTotal: 0, responseTotal: 0, timeouts: 0, hints: 0 };
    for (const submission of submissions?.filter((row) => row.question_id === question.id) ?? []) {
      bucket.attempts += 1;
      bucket.successful += submission.is_correct && !submission.timed_out ? 1 : 0;
      bucket.scoreTotal += submission.rubric_score == null ? submission.is_correct ? 1 : 0 : Number(submission.rubric_score) / 100;
      bucket.responseTotal += submission.response_ms;
      bucket.timeouts += submission.timed_out ? 1 : 0;
      bucket.hints += submission.hints_used ?? 0;
    }
    grouped.set(skill, bucket);
  }
  const skillEvidence = [...grouped.entries()].map(([skill, value]) => ({ skill, attempts: value.attempts, accuracy: value.attempts ? value.successful / value.attempts : 0, quality: value.attempts ? value.scoreTotal / value.attempts : 0, averageResponseMs: value.attempts ? Math.round(value.responseTotal / value.attempts) : null, timeouts: value.timeouts, hints: value.hints }));
  const strengths = skillEvidence.filter((item) => item.attempts >= 2 && item.quality >= 0.75).sort((a, b) => b.quality - a.quality).map((item) => ({ skill: item.skill, evidence: `${Math.round(item.quality * 100)}% qua ${item.attempts} lượt` }));
  const needsWork = skillEvidence.filter((item) => item.quality < 0.65 || item.timeouts > 0).sort((a, b) => a.quality - b.quality).map((item) => ({ skill: item.skill, evidence: `${Math.round(item.quality * 100)}%, ${item.timeouts} hết giờ, ${item.hints} gợi ý` }));
  const nextActions = (needsWork.length ? needsWork : skillEvidence.slice().sort((a, b) => a.quality - b.quality).slice(0, 2)).slice(0, 3).map((item, index) => ({ priority: index + 1, skill: item.skill, action: item.skill === "listening" ? "Làm một Listening Sprint rồi ôn lại transcript sai" : item.skill === "speaking" || item.skill === "phonology" ? "Luyện Speaking Lab và đối chiếu rubric phát âm" : `Ôn Error Notebook và tạo trận tập trung ${item.skill}` }));
  const totalAttempts = skillEvidence.reduce((sum, item) => sum + item.attempts, 0);
  const totalSuccess = skillEvidence.reduce((sum, item) => sum + Math.round(item.accuracy * item.attempts), 0);
  const summaryVi = `Hai bạn hoàn thành ${match.round_count} vòng chủ đề ${match.topic}. Hệ thống ghi nhận ${totalSuccess}/${totalAttempts} lượt chính xác; ${strengths.length ? `điểm mạnh rõ nhất là ${strengths[0].skill}` : "cần thêm bằng chứng để xác định điểm mạnh ổn định"}${needsWork.length ? `, ưu tiên tiếp theo là ${needsWork[0].skill}` : " và chưa có kỹ năng nào dưới ngưỡng cần ôn"}.`;
  const evidenceSnapshot = { match: { id: match.id, title: match.title, topic: match.topic, level: match.level, rounds: match.round_count, endedAt: match.ended_at }, players: players ?? [], skillEvidence, generatedAt: new Date().toISOString() };
  const { data: recap, error } = await admin.from("match_recaps").upsert({ match_id: match.id, room_id: match.room_id, summary_vi: summaryVi, strengths, needs_work: needsWork, next_actions: nextActions, evidence_snapshot: evidenceSnapshot, algorithm_version: "evidence-recap-v1" }, { onConflict: "match_id", ignoreDuplicates: true }).select("match_id, summary_vi, strengths, needs_work, next_actions, evidence_snapshot, algorithm_version, created_at").maybeSingle();
  if (error) throw new Error(error.message);
  if (recap) return recap;
  const { data: winner, error: winnerError } = await admin.from("match_recaps").select("match_id, summary_vi, strengths, needs_work, next_actions, evidence_snapshot, algorithm_version, created_at").eq("match_id", match.id).single();
  if (winnerError || !winner) throw new Error(winnerError?.message ?? "Không lưu được match recap");
  return winner;
}
