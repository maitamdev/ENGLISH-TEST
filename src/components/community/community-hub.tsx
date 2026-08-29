"use client";

import { useState } from "react";
import { Check, LoaderCircle, Send, ShieldCheck, Swords, UserPlus, Users2, X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";

type Person = { id: string; displayName: string; username: string | null; avatarUrl: string | null };
type Friendship = { id: string; status: string; direction: "incoming" | "outgoing"; person: Person };
type Invite = { id: string; status: string; message: string | null; expiresAt: string; roomCode: string; sender: Person };
type Rating = { skill: string; rating: number; matchCount: number; wins: number; losses: number; draws: number };

export function CommunityHub({ friendships, invites, ratings, openRoom }: { friendships: Friendship[]; invites: Invite[]; ratings: Rating[]; openRoom: { id: string; code: string } | null }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState("");
  const friends = friendships.filter((item) => item.status === "accepted");
  const pending = friendships.filter((item) => item.status === "pending");

  async function action(path: string, method: "POST" | "PATCH", payload: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({})) as { error?: string; room?: { code?: string } };
      if (!response.ok) throw new Error(body.error ?? "Thao tác thất bại");
      toast.success("Đã cập nhật.");
      if (body.room?.code) router.push(`/room/${body.room.code}`); else router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Thao tác thất bại"); }
    finally { setBusy(""); }
  }

  return <div className="community-grid">
    <section className="surface community-panel">
      <div className="panel-heading"><div><span className="eyebrow"><Users2 size={14} /> FRIENDS</span><h2>Bạn học</h2></div><span className="due-badge">{friends.length} người</span></div>
      <form className="friend-search" onSubmit={(event) => { event.preventDefault(); if (username.trim()) void action("/api/social/friends", "POST", { username }, "add"); }}><input className="input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Nhập đúng username" maxLength={24} /><button className="button button-primary" disabled={busy === "add" || !username.trim()}>{busy === "add" ? <LoaderCircle size={17} className="animate-spin" /> : <UserPlus size={17} />} Kết bạn</button></form>
      {pending.length > 0 && <div className="pending-list"><h3>Lời mời kết bạn</h3>{pending.map((item) => <article key={item.id}><Avatar name={item.person.displayName} src={item.person.avatarUrl ?? undefined} size={42} /><div><strong>{item.person.displayName}</strong><span>@{item.person.username ?? "không có username"}</span></div>{item.direction === "incoming" ? <div><button aria-label="Chấp nhận" onClick={() => void action("/api/social/friends", "PATCH", { friendshipId: item.id, action: "accept" }, item.id)}><Check size={16} /></button><button aria-label="Từ chối" onClick={() => void action("/api/social/friends", "PATCH", { friendshipId: item.id, action: "decline" }, item.id)}><X size={16} /></button></div> : <span>Đang chờ</span>}</article>)}</div>}
      <div className="friend-list">{friends.length ? friends.map((item) => <article key={item.id}><Avatar name={item.person.displayName} src={item.person.avatarUrl ?? undefined} size={48} /><div><strong>{item.person.displayName}</strong><span>@{item.person.username ?? "chưa đặt username"}</span></div>{openRoom ? <button className="suggestion" disabled={busy === `invite:${item.person.id}`} onClick={() => void action("/api/social/invites", "POST", { roomId: openRoom.id, recipientId: item.person.id, message: "Vào LexiDuel học cùng mình nhé" }, `invite:${item.person.id}`)}><Send size={14} /> Mời vào {openRoom.code}</button> : <span className="text-muted">Tạo phòng để mời</span>}</article>) : <div className="empty-inline">Chưa có bạn học. Tìm bằng username chính xác để gửi lời mời.</div>}</div>
    </section>

    <aside className="community-side">
      <section className="surface community-panel"><div className="panel-heading"><div><span className="eyebrow"><Swords size={14} /> RATING</span><h2>Xếp hạng kỹ năng</h2></div></div>{ratings.length ? <div className="rating-list">{ratings.map((item) => <article key={item.skill}><div><strong>{item.skill}</strong><span>{item.matchCount} trận · {item.wins}W {item.draws}D {item.losses}L</span></div><b>{Math.round(item.rating)}</b></article>)}</div> : <div className="empty-inline">Rating chỉ xuất hiện sau trận đối kháng thật.</div>}</section>
      <section className="surface community-panel"><div className="panel-heading"><div><span className="eyebrow"><ShieldCheck size={14} /> INVITES</span><h2>Lời mời vào phòng</h2></div></div>{invites.length ? <div className="invite-list">{invites.map((invite) => <article key={invite.id}><div><strong>{invite.sender.displayName} mời vào {invite.roomCode}</strong><p>{invite.message ?? "Cùng học tiếng Anh"}</p><small>Hết hạn {new Intl.DateTimeFormat("vi", { timeStyle: "short" }).format(new Date(invite.expiresAt))}</small></div><div><button className="button button-primary" onClick={() => void action("/api/social/invites", "PATCH", { inviteId: invite.id, action: "accept" }, invite.id)}>Vào phòng</button><button className="suggestion" onClick={() => void action("/api/social/invites", "PATCH", { inviteId: invite.id, action: "decline" }, invite.id)}>Từ chối</button></div></article>)}</div> : <div className="empty-inline">Không có lời mời đang chờ.</div>}</section>
    </aside>
  </div>;
}
