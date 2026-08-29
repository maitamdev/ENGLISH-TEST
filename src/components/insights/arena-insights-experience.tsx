"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, Gauge, LoaderCircle, Network, RotateCcw, Swords, Trophy } from "lucide-react";

type Peer = { id: string; displayName: string; avatarUrl: string | null };
type Side = { total: number; correct: number; accuracy: number; averageResponseMs: number };
type Insight = {
  partner: { id: string; displayName: string; avatarUrl: string | null };
  summary: { matches: number; duels: number; cooperative: number; wins: number; losses: number; draws: number; myAverageScore: number; partnerAverageScore: number; firstMatchAt: string | null; latestMatchAt: string | null };
  skills: { skill: string; me: Side; partner: Side }[];
  recentMatches: { matchId: string; title: string; topic: string; level: string; endedAt: string; experience: string; myScore: number; partnerScore: number; outcome: "win" | "loss" | "draw" | "coop" }[];
  reliability: { fairnessAssessments: number; voidedRounds: number; averageInputSkewMs: number; myDisconnects: number; partnerDisconnects: number; totalCompensationMs: number };
  myRemediation: { pending: number; completed: number; dismissed: number };
  algorithmVersion: string;
};

export function ArenaInsightsExperience({ peers }: { peers: Peer[] }) {
  const [partnerId, setPartnerId] = useState(peers[0]?.id ?? "");
  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(Boolean(peers.length));
  const [error, setError] = useState("");
  useEffect(() => {
    if (!partnerId) return;
    const controller = new AbortController();
    void fetch(`/api/insights/${partnerId}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Không đọc được Arena Insights");
      setInsight(body);
    }).catch((cause) => { if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [partnerId]);

  if (!peers.length) return <section className="surface insights-empty"><Swords size={34} /><h2>Chưa có bạn học đã xác nhận</h2><p>Kết bạn và hoàn thành ít nhất một trận để bắt đầu head-to-head insights.</p><Link className="button button-primary" href="/community">Mở Community</Link></section>;
  return <div className="insights-layout"><section className="surface insights-picker"><label><span>So sánh với</span><select value={partnerId} onChange={(event) => { setLoading(true); setError(""); setInsight(null); setPartnerId(event.target.value); }}>{peers.map((peer) => <option value={peer.id} key={peer.id}>{peer.displayName}</option>)}</select></label><p>Chỉ hiển thị dữ liệu của những trận cả hai cùng tham gia.</p></section>{loading ? <section className="surface insights-empty"><LoaderCircle className="animate-spin" /><h2>Đang tổng hợp evidence thật…</h2></section> : error ? <section className="surface insights-empty"><Activity /><h2>Không đọc được insights</h2><p>{error}</p></section> : insight ? <Insights insight={insight} /> : null}</div>;
}

function Insights({ insight }: { insight: Insight }) {
  const summary = insight.summary;
  return <><section className="insights-scoreboard"><article className="surface"><span><Trophy size={15} /> Thắng</span><strong>{summary.wins}</strong><small>{summary.duels ? Math.round(summary.wins / summary.duels * 100) : 0}% duel</small></article><article className="surface"><span>Hòa</span><strong>{summary.draws}</strong><small>{summary.cooperative} trận co-op</small></article><article className="surface"><span>Thua</span><strong>{summary.losses}</strong><small>{summary.matches} trận chung</small></article><article className="surface"><span><Gauge size={15} /> Điểm TB</span><strong>{summary.myAverageScore}</strong><small>{insight.partner.displayName}: {summary.partnerAverageScore}</small></article></section>
    <section className="surface insights-panel"><div className="panel-heading"><div><span className="eyebrow">SKILL COMPARISON</span><h2>Accuracy và tốc độ theo kỹ năng</h2></div></div>{insight.skills.length ? <div className="insights-skills"><header><span>Kỹ năng</span><span>Bạn</span><span>{insight.partner.displayName}</span></header>{insight.skills.map((row) => <article key={row.skill}><strong>{row.skill}</strong><Metric side={row.me} /><Metric side={row.partner} /></article>)}</div> : <div className="empty-inline">Hai người chưa có submission chung.</div>}</section>
    <div className="insights-columns"><section className="surface insights-panel"><div className="panel-heading"><div><span className="eyebrow"><Network size={14} /> RELIABILITY</span><h2>Realtime có công bằng không?</h2></div></div><dl className="insights-facts"><div><dt>Round đã đo</dt><dd>{insight.reliability.fairnessAssessments}</dd></div><div><dt>Round void</dt><dd>{insight.reliability.voidedRounds}</dd></div><div><dt>Input skew TB</dt><dd>{Math.round(insight.reliability.averageInputSkewMs)}ms</dd></div><div><dt>Reconnect</dt><dd>{insight.reliability.myDisconnects} / {insight.reliability.partnerDisconnects}</dd></div><div><dt>Thời gian đã bù</dt><dd>{(insight.reliability.totalCompensationMs / 1000).toFixed(1)}s</dd></div></dl></section><section className="surface insights-panel"><div className="panel-heading"><div><span className="eyebrow"><RotateCcw size={14} /> MY REMEDIATION</span><h2>Lỗi của riêng bạn</h2></div></div><dl className="insights-facts"><div><dt>Đang chờ</dt><dd>{insight.myRemediation.pending}</dd></div><div><dt>Đã ôn</dt><dd>{insight.myRemediation.completed}</dd></div><div><dt>Đã bỏ qua</dt><dd>{insight.myRemediation.dismissed}</dd></div></dl><Link className="button button-secondary" href="/progress">Mở remediation queue</Link></section></div>
    <section className="surface insights-panel"><div className="panel-heading"><div><span className="eyebrow">RECENT MATCHES</span><h2>Xu hướng đối đầu gần đây</h2></div><span>{insight.algorithmVersion}</span></div><div className="insights-history">{insight.recentMatches.map((match) => <article key={match.matchId}><span className={`insights-outcome ${match.outcome}`}>{match.outcome}</span><div><strong>{match.title}</strong><small>{match.topic} · {match.level} · {new Intl.DateTimeFormat("vi", { dateStyle: "short" }).format(new Date(match.endedAt))}</small></div><b>{match.myScore} – {match.partnerScore}</b><Link href={`/review/${match.matchId}`} aria-label={`Ôn lại ${match.title}`}><ArrowRight size={15} /></Link></article>)}</div></section></>;
}

function Metric({ side }: { side: Side }) {
  return <div className="insights-metric"><span><b style={{ width: `${Math.max(0, Math.min(100, Number(side.accuracy)))}%` }} /></span><strong>{Number(side.accuracy).toFixed(1)}%</strong><small>{side.correct}/{side.total} · {(Number(side.averageResponseMs) / 1000).toFixed(1)}s</small></div>;
}
