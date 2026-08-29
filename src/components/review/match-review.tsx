"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock3, RotateCcw, Search, XCircle } from "lucide-react";
import styles from "./match-review.module.css";

type ReviewPlayer = { userId: string; displayName: string; score: number; correctCount: number; incorrectCount: number; avgResponseMs: number | null };
type SpeakingAssessment = { overall?: number; content?: number; pronunciation?: number; fluency?: number; grammar?: number; vocabulary?: number; task?: number; coherence?: number; feedbackVi?: string; strengths?: string[]; improvements?: string[] };
type ReviewSubmission = { userId: string; answer: string; correct: boolean; timedOut: boolean; matchedAnswer: string | null; matchType: string | null; responseMs: number; points: number; hintsUsed?: number; rubricScore?: number | null; assessment?: SpeakingAssessment | null };
type ReviewRound = { id: string; round: number; mode: string; prompt: string; instruction: string; timeLimit: number; publicData?: Record<string, unknown>; canonicalAnswer: string; acceptedAnswers: string[]; explanation: string; submissions: ReviewSubmission[] };
export type MatchReviewData = { match: { id: string; title: string; topic: string; level: string; rounds: number }; players: ReviewPlayer[]; rounds: ReviewRound[] };

type Filter = "all" | "needs-review" | "incorrect" | "timeout";

export function MatchReviewLoader({ matchId }: { matchId: string }) {
  const [data, setData] = useState<MatchReviewData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/matches/${matchId}/review`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Không thể tải dữ liệu ôn tập");
        return body as MatchReviewData;
      })
      .then(setData)
      .catch((caught: Error) => { if (caught.name !== "AbortError") setError(caught.message); });
    return () => controller.abort();
  }, [matchId]);
  if (error) return <main className="app-shell"><div className="app-container review-empty"><h1>Không thể mở phần ôn tập</h1><p>{error}</p><Link className="button button-secondary" href="/dashboard">Về Dashboard</Link></div></main>;
  if (!data) return <main className="app-shell"><div className="app-container review-empty"><h1>Đang tổng hợp trận đấu…</h1><p>Đang tải câu hỏi và câu trả lời của cả hai người.</p></div></main>;
  return <MatchReview data={data} />;
}

export function MatchReview({ data }: { data: MatchReviewData }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("vi-VN");
  const visibleRounds = useMemo(() => data.rounds.filter((round) => {
    const hasIncorrect = round.submissions.some((submission) => !submission.correct);
    const hasTimeout = round.submissions.some((submission) => submission.timedOut);
    const filterMatches = filter === "all" || (filter === "needs-review" && (hasIncorrect || hasTimeout)) || (filter === "incorrect" && hasIncorrect) || (filter === "timeout" && hasTimeout);
    const textMatches = !normalizedQuery || [round.prompt, round.canonicalAnswer, round.explanation, ...round.acceptedAnswers].join(" ").toLocaleLowerCase("vi-VN").includes(normalizedQuery);
    return filterMatches && textMatches;
  }), [data.rounds, filter, normalizedQuery]);
  const skillSummary = useMemo(() => {
    const grouped = new Map<string, { total: number; correct: number }>();
    data.rounds.forEach((round) => {
      const skill = skillForMode(round.mode);
      const current = grouped.get(skill) ?? { total: 0, correct: 0 };
      current.total += data.players.length;
      current.correct += round.submissions.filter((submission) => submission.correct && !submission.timedOut).length;
      grouped.set(skill, current);
    });
    return [...grouped.entries()].map(([skill, values]) => ({ skill, percent: values.total ? Math.round(values.correct / values.total * 100) : 0 }));
  }, [data.players.length, data.rounds]);

  return <main className={`${styles.root} app-shell`}><div className="app-container review-match-page">
    <header className="review-match-header"><div><Link className="back-link" href="/dashboard"><ArrowLeft size={16} /> Dashboard</Link><span className="eyebrow">ÔN TẬP SAU TRẬN</span><h1>{data.match.title}</h1><p>{data.match.topic} · {data.match.level} · {data.match.rounds} vòng</p></div><div className="review-scoreboard">{[...data.players].sort((a, b) => b.score - a.score).map((player) => <div key={player.userId}><strong>{player.displayName}</strong><span>{player.score} điểm</span><small>{player.correctCount} đúng · {player.incorrectCount} cần ôn</small></div>)}</div></header>

    <section className="surface review-skill-summary"><div><span className="eyebrow">BẢN ĐỒ KỸ NĂNG</span><h2>Nhìn nhanh phần hai bạn cần luyện lại</h2></div><div className="review-skill-bars">{skillSummary.map((item) => <div key={item.skill}><span>{item.skill}</span><i><b style={{ width: `${item.percent}%` }} /></i><strong>{item.percent}%</strong></div>)}</div></section>

    <section className="surface review-toolbar"><label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm từ, câu hỏi hoặc đáp án…" /></label><div>{([['all','Tất cả'],['needs-review','Cần ôn'],['incorrect','Trả lời sai'],['timeout','Hết giờ']] as [Filter, string][]).map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div></section>

    <section className="review-round-list">{visibleRounds.map((round) => <article className="surface review-round-card" key={round.id}><div className="review-round-number"><span>Vòng {round.round}</span><small>{round.mode.replaceAll("_", " ")}</small></div><div className="review-round-content"><h2>{round.prompt}</h2><p>{round.instruction}</p>{typeof round.publicData?.passage === "string" && <details className="review-source"><summary>Xem lại đoạn đọc</summary><p>{round.publicData.passage}</p></details>}{typeof round.publicData?.audioText === "string" && <details className="review-source"><summary>Xem transcript bài nghe</summary><p>{round.publicData.audioText}</p></details>}<div className="review-canonical"><span>Đáp án chuẩn</span><strong>{round.canonicalAnswer}</strong><small>Chấp nhận: {round.acceptedAnswers.join(", ")}</small></div><div className="review-player-answers">{data.players.map((player) => { const submission = round.submissions.find((item) => item.userId === player.userId); const successful = Boolean(submission?.correct && !submission?.timedOut); return <div key={player.userId} className={successful ? "correct" : "needs-review"}>{successful ? <CheckCircle2 size={19} /> : <XCircle size={19} />}<div><strong>{player.displayName}</strong><span>{submission?.answer === "⏱ Hết giờ" ? "Không trả lời" : submission?.answer ?? "Không có đáp án"}</span>{submission?.matchType === "minor_typo" && <small>Được chấp nhận như lỗi gõ nhỏ → {submission.matchedAnswer}</small>}{submission?.hintsUsed ? <small>Đã dùng {submission.hintsUsed} gợi ý</small> : null}</div><div><span>{submission?.rubricScore != null ? `${Math.round(submission.rubricScore)}/100` : `${submission?.points ?? 0} điểm`}</span><small><Clock3 size={13} /> {submission ? `${(submission.responseMs / 1000).toFixed(2)}s` : "—"}</small></div>{submission?.assessment && <SpeakingRubric assessment={submission.assessment} />}</div>; })}</div><div className="review-explanation"><RotateCcw size={17} /><p>{round.explanation}</p></div></div></article>)}</section>
    {visibleRounds.length === 0 && <section className="surface review-empty"><h2>Không có câu phù hợp</h2><p>Thử đổi bộ lọc hoặc từ khóa tìm kiếm.</p></section>}
  </div></main>;
}

function skillForMode(mode: string) {
  if (["LISTENING", "SPELLING", "MINIMAL_PAIRS", "AUDIO_CHOICE", "STORY_LISTENING"].includes(mode)) return "Nghe";
  if (["READING", "DEFINITION", "CONTEXT"].includes(mode)) return "Đọc và từ vựng";
  if (["PRONUNCIATION", "SHADOWING", "SPEAKING", "ROLEPLAY", "DEBATE"].includes(mode)) return "Nói";
  if (["GRAMMAR", "SENTENCE_BUILDER", "CLOZE", "ERROR_CORRECTION", "WRITING"].includes(mode)) return "Ngữ pháp và viết";
  if (mode === "COLLOCATION") return "Cụm từ tự nhiên";
  return "Từ vựng và dịch";
}

function SpeakingRubric({ assessment }: { assessment: SpeakingAssessment }) {
  const scores: [string, number | undefined][] = assessment.task != null
    ? [["Yêu cầu", assessment.task], ["Mạch lạc", assessment.coherence], ["Ngữ pháp", assessment.grammar], ["Từ vựng", assessment.vocabulary]]
    : [["Nội dung", assessment.content], ["Phát âm", assessment.pronunciation], ["Trôi chảy", assessment.fluency], ["Ngữ pháp", assessment.grammar], ["Từ vựng", assessment.vocabulary]];
  return <div className="review-rubric"><div>{scores.map(([label, score]) => <span key={label}><small>{label}</small><strong>{Math.round(score ?? 0)}</strong></span>)}</div>{assessment.feedbackVi && <p>{assessment.feedbackVi}</p>}</div>;
}
