import { EntryForm } from "@/components/entry-form";
import { EntryLayout } from "@/components/entry-layout";
import { ConfigRequired } from "@/components/config-required";
import { getSupabaseServerConfig } from "@/lib/supabase/server";

export default async function JoinRoomPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  return getSupabaseServerConfig() ? <EntryLayout><EntryForm mode="join" initialCode={code} /></EntryLayout> : <ConfigRequired />;
}
