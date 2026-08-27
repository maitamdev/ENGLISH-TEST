import { BookOpenCheck, RotateCcw } from "lucide-react";
import Link from "next/link";
import { ConfigRequired } from "@/components/config-required";
import { SiteHeader } from "@/components/site-header";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";
import type { VocabularyRecord } from "@/types/data";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const [profileResult, wordsResult] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).single(),
    supabase.from("user_vocabulary").select("word, meaning, example_sentence, topic, mastery, correct_count, wrong_count, next_review_at").eq("user_id", user.id).order("next_review_at", { ascending: true, nullsFirst: false })
  ]);
  if (profileResult.error || wordsResult.error) throw profileResult.error ?? wordsResult.error;
  const words = (wordsResult.data ?? []) as VocabularyRecord[];

  return <><SiteHeader app displayName={profileResult.data.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><h1 className="page-title">Turn mistakes into wins.</h1><p className="page-lead">Words appear here only after your real match submissions update learning history.</p></div>{words.length > 0 && <Link className="button button-primary" href="/create-room"><RotateCcw size={18} /> Start revenge</Link>}</header>{words.length ? <div className="review-layout"><aside className="surface review-sidebar"><span className="review-filter active">All review words</span><span className="review-filter">{words.filter((word) => word.next_review_at && new Date(word.next_review_at) <= new Date()).length} due now</span><span className="review-filter">{words.filter((word) => word.mastery >= 80).length} mastered</span></aside><section className="word-grid">{words.map((item) => <article className="surface word-card" key={item.word}><BookOpenCheck className="text-accent" size={21} /><div><h3>{item.word}</h3><p>{item.meaning ?? "Meaning will be added by the match review pipeline."}</p></div>{item.example_sentence && <p>{item.example_sentence}</p>}<div className="word-meta"><span>{item.mastery}% mastery</span><span>{item.topic ?? "Uncategorized"}</span></div></article>)}</section></div> : <section className="surface empty-state large"><BookOpenCheck size={30} /><h2>No review words yet</h2><p>Complete a match. Vocabulary encounters from your real answers will appear here.</p><Link className="button button-primary" href="/create-room">Create a room</Link></section>}</div></main></>;
}
