import Image from "next/image";
import Link from "next/link";
import { ArrowRight, BrainCircuit, CalendarDays, Flame, Plus, Sparkles, Swords, Users2 } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ConfigRequired } from "@/components/config-required";
import { SiteHeader } from "@/components/site-header";
import { getDashboardData } from "@/lib/data/dashboard";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const data = await getDashboardData(supabase, user.id);
  const latest = data.matches[0] ?? null;
  const skills: [string, number | null | undefined][] = [
    ["Vocabulary", data.stats?.vocabulary_score], ["Grammar", data.stats?.grammar_score],
    ["Listening", data.stats?.listening_score], ["Reading", data.stats?.reading_score],
    ["Speaking", data.stats?.speaking_score], ["Pronunciation", data.stats?.pronunciation_score]
  ];
  const scoredSkills = skills.filter((skill): skill is [string, number] => typeof skill[1] === "number");
  const focusSkill = scoredSkills.length ? [...scoredSkills].sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0))[0] : null;


  return (
    <>
      <SiteHeader app displayName={data.profile.display_name} />
      <main className="page-shell"><div className="app-container">
        <header className="page-header reveal"><div><h1 className="page-title">Welcome back, {data.profile.display_name}.</h1><p className="page-lead">Your rooms, matches, and learning progress come directly from Supabase.</p></div><Link className="button button-primary" href="/create-room"><Plus size={18} /> New room</Link></header>
        <div className="dashboard-grid"><div className="dash-main">
          <section className="surface dash-panel"><div className="panel-heading"><h2>Continue together</h2>{latest?.roomCode && <Link href={`/room/${latest.roomCode}`}>Open room <ArrowRight size={15} /></Link>}</div>
            {latest ? <Link href={latest.roomCode ? `/room/${latest.roomCode}` : `/match/${latest.id}`} className="recent-match"><Avatar name={latest.opponentName ?? "Opponent"} src={latest.opponentAvatar ?? undefined} size={48} /><div><h3>{latest.title}{latest.opponentName ? ` with ${latest.opponentName}` : ""}</h3><p>{latest.roundCount} rounds, {latest.level}</p></div><strong className="score-pair">{latest.score} - {latest.opponentScore ?? "-"}</strong><span className="outcome">{latest.status === "completed" ? latest.winnerId === user.id ? "Won" : latest.winnerId ? "Finished" : "Completed" : "In progress"}</span></Link>
              : <div className="empty-state"><Swords size={24} /><h3>No matches yet</h3><p>Create a private room and invite your friend to start your first match.</p><Link className="button button-secondary" href="/create-room">Create room</Link></div>}
          </section>
          <section className="surface dash-panel"><div className="panel-heading"><h2>Your English skills</h2><Link href="/review">View review <ArrowRight size={15} /></Link></div><div className="skill-grid">{skills.map(([label, value]) => <article className={`skill-card ${focusSkill?.[0] === label ? "focus" : ""}`} key={label}><span>{label}</span><strong>{value ?? "-"}{value == null ? "" : "%"}</strong><small>{value == null ? "No data yet" : focusSkill?.[0] === label ? "Focus next" : "Measured from matches"}</small></article>)}</div></section>
          <section className="surface dash-panel"><div className="panel-heading"><h2>Recent matches</h2></div>{data.matches.length ? <div className="match-list">{data.matches.map((match) => <div className="match-row" key={match.id}><div><strong>{match.title}</strong><p>{match.opponentName ? `vs ${match.opponentName}, ` : ""}{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(match.createdAt))}</p></div><strong className="mono">{match.score} - {match.opponentScore ?? "-"}</strong><span className="outcome">{match.status === "completed" ? match.winnerId === user.id ? "Won" : match.winnerId ? "Finished" : "Completed" : "Active"}</span></div>)}</div> : <div className="empty-inline">Completed matches will appear here.</div>}</section>
        </div><aside className="dash-side">
          <section className="surface dash-panel"><div className="panel-heading"><h2>Start learning</h2><Swords size={19} className="text-accent" /></div><div className="quick-actions"><Link className="button button-primary" href="/create-room"><Users2 size={17} /> Create</Link><Link className="button button-secondary" href="/join-room">Join</Link><Link className="button button-secondary" href="/study" style={{ gridColumn: "1 / -1" }}><BrainCircuit size={17} /> FSRS và Error Notebook</Link></div></section>
          <section className="surface dash-panel streak-panel"><div className="panel-heading"><h2>Current streak</h2><Flame size={20} className="text-accent" /></div><div className="streak-number">{data.stats?.current_streak_days ?? 0} <span>days</span></div><p className="text-muted">{data.stats?.last_practice_date ? `Last practice: ${data.stats.last_practice_date}` : "Complete a match to start your streak."}</p></section>
          <section className="surface dash-panel ai-suggestion"><div className="avatar" style={{ width: 64, height: 64 }}><Image src="/images/lexi-host.png" alt="Lexi AI host" width={64} height={64} /></div><div><h3>Lexi suggests</h3><p>{focusSkill ? `Your lowest measured skill is ${focusSkill[0].toLowerCase()}. Create a room to focus the next battle on it.` : "Complete a match before Lexi can recommend a focus area."}</p></div><Link className="button button-secondary" href="/create-room" style={{ gridColumn: "1 / -1" }}><Sparkles size={17} /> Create room</Link></section>
          <section className="surface dash-panel"><div className="panel-heading"><h2>All time</h2><CalendarDays size={19} /></div><div className="profile-stats"><div className="profile-stat"><strong>{data.totalMatches}</strong><span>Matches</span></div><div className="profile-stat"><strong>{data.masteredWords}</strong><span>Words</span></div><div className="profile-stat"><strong>{data.winCount}</strong><span>Wins</span></div></div></section>
        </aside></div>
      </div></main>
    </>
  );
}
