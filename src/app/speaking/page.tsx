import { Mic2 } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { SiteHeader } from "@/components/site-header";
import { SpeakingLab } from "@/components/speaking/speaking-lab";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function SpeakingPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const [profileResult, sessionResult] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).single(),
    supabase.from("speaking_sessions").select("id, title, scenario, cefr_level, status, max_turns, current_turn").order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  const session = sessionResult.data;
  const turnsResult = session ? await supabase.from("speaking_turns").select("id, turn_number, speaker_type, transcript, prompt_context, assessment, completed_at").eq("session_id", session.id).order("turn_number") : { data: [] };
  return <><SiteHeader app displayName={profileResult.data?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><span className="eyebrow"><Mic2 size={15} /> MULTI-TURN SPEAKING</span><h1 className="page-title">Nói thật. Được sửa đúng chỗ.</h1><p className="page-lead">Gemini nghe từng lượt, tiếp tục hội thoại bằng giọng nói và lưu rubric chi tiết. Audio micro không được lưu.</p></div></header><SpeakingLab initialSession={session ?? null} initialTurns={(turnsResult.data ?? []) as never[]} /></div></main></>;
}
