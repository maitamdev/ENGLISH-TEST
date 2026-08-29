import { ConfigRequired } from "@/components/config-required";
import { CommunityHub } from "@/components/community/community-hub";
import { SiteHeader } from "@/components/site-header";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function CommunityPage() {
  const { configured, user } = await requireAuthenticatedUser();
  const admin = createSupabaseAdminClient();
  if (!configured || !user || !admin) return <ConfigRequired />;
  const [profileResult, friendshipResult, inviteResult, ratingResult, membershipsResult] = await Promise.all([
    admin.from("profiles").select("display_name").eq("id", user.id).single(),
    admin.from("friendships").select("id, requester_id, addressee_id, status, created_at").or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`).neq("status", "blocked").order("created_at", { ascending: false }),
    admin.from("room_invites").select("id, room_id, sender_id, status, message, expires_at").eq("recipient_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
    admin.from("player_ratings").select("skill, rating, match_count, wins, losses, draws").eq("user_id", user.id).order("rating", { ascending: false }),
    admin.from("room_members").select("room_id, joined_at").eq("user_id", user.id).order("joined_at", { ascending: false }).limit(10)
  ]);
  const peerIds = [...new Set((friendshipResult.data ?? []).map((item) => item.requester_id === user.id ? item.addressee_id : item.requester_id).concat((inviteResult.data ?? []).map((item) => item.sender_id)))];
  const roomIds = [...new Set((inviteResult.data ?? []).map((item) => item.room_id).concat((membershipsResult.data ?? []).map((item) => item.room_id)))];
  const [peersResult, roomsResult] = await Promise.all([
    peerIds.length ? admin.from("profiles").select("id, display_name, username, avatar_url").in("id", peerIds) : Promise.resolve({ data: [] }),
    roomIds.length ? admin.from("rooms").select("id, code, status, expires_at").in("id", roomIds).gt("expires_at", new Date().toISOString()) : Promise.resolve({ data: [] })
  ]);
  const peers = peersResult.data ?? [];
  const rooms = roomsResult.data ?? [];
  const friendships = (friendshipResult.data ?? []).flatMap((item) => {
    const peerId = item.requester_id === user.id ? item.addressee_id : item.requester_id;
    const peer = peers.find((value) => value.id === peerId);
    return peer ? [{ id: item.id, status: item.status, direction: item.addressee_id === user.id ? "incoming" as const : "outgoing" as const, person: { id: peer.id, displayName: peer.display_name, username: peer.username, avatarUrl: peer.avatar_url } }] : [];
  });
  const invites = (inviteResult.data ?? []).flatMap((item) => {
    const sender = peers.find((value) => value.id === item.sender_id);
    const room = rooms.find((value) => value.id === item.room_id);
    return sender && room ? [{ id: item.id, status: item.status, message: item.message, expiresAt: item.expires_at, roomCode: room.code, sender: { id: sender.id, displayName: sender.display_name, username: sender.username, avatarUrl: sender.avatar_url } }] : [];
  });
  const openRoom = rooms.find((room) => (membershipsResult.data ?? []).some((membership) => membership.room_id === room.id) && ["ROOM_IDLE","AI_DISCUSSION"].includes(room.status));
  return <><SiteHeader app displayName={profileResult.data?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><h1 className="page-title">Học cùng đúng người.</h1><p className="page-lead">Bạn bè, lời mời và rating đều đến từ hoạt động thật trong Supabase.</p></div></header><CommunityHub friendships={friendships} invites={invites} ratings={(ratingResult.data ?? []).map((item) => ({ skill: item.skill, rating: Number(item.rating), matchCount: item.match_count, wins: item.wins, losses: item.losses, draws: item.draws }))} openRoom={openRoom ? { id: openRoom.id, code: openRoom.code } : null} /></div></main></>;
}
