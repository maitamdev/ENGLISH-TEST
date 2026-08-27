import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function MatchPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login");
  const { data } = await supabase.from("matches").select("rooms(code)").eq("id", matchId).single();
  const room = Array.isArray(data?.rooms) ? data.rooms[0] : data?.rooms;
  if (!room) notFound();
  redirect(`/room/${room.code}`);
}
