import { redirect } from "next/navigation";
import { SharedPathsExperience } from "@/components/paths/shared-paths-experience";
import { SiteHeader } from "@/components/site-header";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PathsPage() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login");
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const [{ data: profile }, { data: friendships }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", data.user.id).maybeSingle(),
    supabase.from("friendships").select("requester_id, addressee_id").eq("status", "accepted").or(`requester_id.eq.${data.user.id},addressee_id.eq.${data.user.id}`)
  ]);
  const friendIds = [...new Set((friendships ?? []).map((friend) => friend.requester_id === data.user.id ? friend.addressee_id : friend.requester_id))];
  const { data: friends } = friendIds.length ? await supabase.from("profiles").select("id, display_name").in("id", friendIds).order("display_name") : { data: [] };
  return <><SiteHeader app displayName={profile?.display_name} /><main id="main-content" className="page-shell"><div className="app-container"><SharedPathsExperience userId={data.user.id} friends={friends ?? []} /></div></main></>;
}
