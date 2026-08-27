import { RoomExperience } from "@/components/room/room-experience";
import { ConfigRequired } from "@/components/config-required";
import { getRoomBootstrap } from "@/lib/data/room";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const normalizedCode = code.toUpperCase();
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;

  const room = await getRoomBootstrap(supabase, normalizedCode, user.id);
  if (!room) {
    return <main className="config-page"><section className="surface config-required"><h1>Room unavailable</h1><p>This room does not exist, has expired, or you have not joined it yet.</p><Link className="button button-primary" href={`/join-room?code=${encodeURIComponent(normalizedCode)}`}>Join this room</Link></section></main>;
  }

  return <RoomExperience initial={room} />;
}
