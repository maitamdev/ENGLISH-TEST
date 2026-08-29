export type InterventionSubmission = { is_correct: boolean; timed_out: boolean; rubric_score: number | null; hints_used: number | null };
export type InterventionCandidate = { policy_code: string; priority: number; instruction_vi: string; ui_message_vi: string };

export function skillForQuestionMode(mode: string) {
  if (["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING", "SHADOWING"].includes(mode)) return "listening";
  if (["READING", "MULTIPLE_CHOICE", "CONTEXT", "DEFINITION"].includes(mode)) return "reading";
  if (["GRAMMAR", "SENTENCE_BUILDER", "CLOZE", "ERROR_CORRECTION", "COLLOCATION"].includes(mode)) return "grammar";
  if (["WRITING", "TRANSLATION"].includes(mode)) return "writing";
  if (mode === "PRONUNCIATION") return "phonology";
  if (["SPEAKING", "ROLEPLAY", "DEBATE"].includes(mode)) return "speaking";
  return "vocabulary";
}

export function buildRoundInterventionCandidates(mode: string, round: number, submissions: InterventionSubmission[]) {
  if (!submissions.length) return [];
  const skill = skillForQuestionMode(mode);
  const correctCount = submissions.filter((row) => row.is_correct && !row.timed_out).length;
  const timeoutCount = submissions.filter((row) => row.timed_out).length;
  const hintCount = submissions.reduce((sum, row) => sum + (row.hints_used ?? 0), 0);
  const lowRubric = submissions.filter((row) => row.rubric_score != null && Number(row.rubric_score) < 65).length;
  const candidates: InterventionCandidate[] = [];
  if (timeoutCount === submissions.length) candidates.push({ policy_code: "both_timed_out", priority: 100, instruction_vi: "Cả hai đều hết giờ. Hãy chỉ ra một chiến lược xử lý dạng bài này nhanh hơn bằng tiếng Việt, không trách người học và không tạo điểm hay dữ liệu mới.", ui_message_vi: "Cả hai đều hết giờ. Lexi sẽ hướng dẫn một chiến lược xử lý nhanh hơn." });
  else if (correctCount === 0) candidates.push({ policy_code: "both_missed", priority: 95, instruction_vi: `Cả hai đều chưa đạt ở kỹ năng ${skill}. Hãy dạy lại đúng một điểm mấu chốt dựa trên đáp án và giải thích đã được hệ thống mở, rồi cho một ví dụ mới rất ngắn.`, ui_message_vi: `Cả hai cùng vướng ở ${skill}. Lexi sẽ dạy lại một điểm mấu chốt.` });
  else if (correctCount === 1) candidates.push({ policy_code: "split_outcome", priority: 75, instruction_vi: `Kết quả hai người khác nhau ở kỹ năng ${skill}. Hãy so sánh cách suy luận đúng và lỗi dễ mắc mà không nêu người nào yếu hơn.`, ui_message_vi: "Hai cách trả lời khác nhau. Lexi sẽ so sánh cách suy luận và lỗi dễ mắc." });
  if (lowRubric > 0) candidates.push({ policy_code: "rubric_gap", priority: 85, instruction_vi: `Có bằng chứng rubric dưới 65/100 ở kỹ năng ${skill}. Hãy ưu tiên một hành động sửa cụ thể từ nhận xét rubric, không tự bịa thêm lỗi.`, ui_message_vi: "Rubric cho thấy một điểm cần sửa cụ thể. Lexi sẽ tập trung vào điểm đó." });
  if (hintCount > 1) candidates.push({ policy_code: "hint_dependence", priority: 65, instruction_vi: "Hai người đã dùng nhiều gợi ý. Hãy dạy một kỹ thuật tự gợi nhớ ngắn để vòng sau giảm phụ thuộc vào hint.", ui_message_vi: "Vòng này dùng nhiều gợi ý. Lexi sẽ chỉ một kỹ thuật tự gợi nhớ." });
  if (!candidates.length && round % 3 === 0) candidates.push({ policy_code: "retrieval_reflection", priority: 45, instruction_vi: "Đã đủ ba vòng bằng chứng. Hãy yêu cầu hai người nói lại một quy tắc hoặc từ khóa vừa học bằng lời của họ trong một câu ngắn.", ui_message_vi: "Đã đủ ba vòng. Hai bạn sẽ có một nhịp nhớ lại ngắn trước khi đi tiếp." });
  return candidates.sort((a, b) => b.priority - a.priority).slice(0, 2);
}

export function summarizeInterventionEvidence(mode: string, submissions: InterventionSubmission[]) {
  return {
    skill: skillForQuestionMode(mode),
    mode,
    correctCount: submissions.filter((row) => row.is_correct && !row.timed_out).length,
    timeoutCount: submissions.filter((row) => row.timed_out).length,
    hintCount: submissions.reduce((sum, row) => sum + (row.hints_used ?? 0), 0),
    lowRubric: submissions.filter((row) => row.rubric_score != null && Number(row.rubric_score) < 65).length
  };
}
