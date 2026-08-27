import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DashboardData, DashboardMatch, LearningStatsRecord, ProfileRecord } from "@/types/data";

type MatchRow = {
  id: string; room_id: string; title: string; level: string; round_count: number;
  winner_id: string | null; created_at: string; rooms: { code: string } | { code: string }[] | null;
};
type PlayerRow = { match_id: string; user_id: string; score: number; profiles: { display_name: string; avatar_url: string | null } | { display_name: string; avatar_url: string | null }[] | null };

function one<T>(value: T | T[] | null): T | null { return Array.isArray(value) ? value[0] ?? null : value; }

export async function getDashboardData(supabase: SupabaseClient, userId: string): Promise<DashboardData> {
  const [profileResult, statsResult, membershipsResult, vocabularyResult] = await Promise.all([
    supabase.from("profiles").select("id, display_name, username, avatar_url, cefr_estimate").eq("id", userId).single(),
    supabase.from("user_learning_stats").select("vocabulary_score, grammar_score, listening_score, spelling_score, translation_score, current_streak_days, last_practice_date").eq("user_id", userId).maybeSingle(),
    supabase.from("room_members").select("room_id").eq("user_id", userId),
    supabase.from("user_vocabulary").select("word", { count: "exact", head: true }).eq("user_id", userId).gte("mastery", 80)
  ]);

  if (profileResult.error || !profileResult.data) throw new Error(profileResult.error?.message || "Profile not found");
  const roomIds = (membershipsResult.data ?? []).map((row) => row.room_id);
  let matches: MatchRow[] = [];
  let totalMatches = 0;
  let winCount = 0;
  if (roomIds.length) {
    const [recentResult, totalResult, winsResult] = await Promise.all([
      supabase.from("matches").select("id, room_id, title, level, round_count, winner_id, created_at, rooms(code)").in("room_id", roomIds).order("created_at", { ascending: false }).limit(10),
      supabase.from("matches").select("id", { count: "exact", head: true }).in("room_id", roomIds),
      supabase.from("matches").select("id", { count: "exact", head: true }).in("room_id", roomIds).eq("winner_id", userId)
    ]);
    if (recentResult.error || totalResult.error || winsResult.error) throw recentResult.error ?? totalResult.error ?? winsResult.error;
    matches = (recentResult.data ?? []) as unknown as MatchRow[];
    totalMatches = totalResult.count ?? 0;
    winCount = winsResult.count ?? 0;
  }

  const matchIds = matches.map((match) => match.id);
  let players: PlayerRow[] = [];
  if (matchIds.length) {
    const result = await supabase.from("match_players").select("match_id, user_id, score, profiles(display_name, avatar_url)").in("match_id", matchIds);
    if (result.error) throw result.error;
    players = (result.data ?? []) as unknown as PlayerRow[];
  }

  const dashboardMatches: DashboardMatch[] = matches.map((match) => {
    const mine = players.find((player) => player.match_id === match.id && player.user_id === userId);
    const opponent = players.find((player) => player.match_id === match.id && player.user_id !== userId);
    const opponentProfile = opponent ? one(opponent.profiles) : null;
    return {
      id: match.id,
      roomCode: one(match.rooms)?.code ?? "",
      title: match.title,
      level: match.level,
      roundCount: match.round_count,
      score: mine?.score ?? 0,
      opponentScore: opponent?.score ?? null,
      opponentName: opponentProfile?.display_name ?? null,
      opponentAvatar: opponentProfile?.avatar_url ?? null,
      winnerId: match.winner_id,
      createdAt: match.created_at
    };
  });

  return {
    profile: profileResult.data as ProfileRecord,
    stats: (statsResult.data as LearningStatsRecord | null) ?? null,
    matches: dashboardMatches,
    totalMatches,
    masteredWords: vocabularyResult.count ?? 0,
    winCount
  };
}
