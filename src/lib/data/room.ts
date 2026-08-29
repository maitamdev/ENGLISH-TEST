import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomPhase } from "@/types/game";
import type { MatchView, RoomBootstrap, RoomMemberData, SubmissionView } from "@/types/data";

const phaseMap: Record<string, RoomPhase> = {
  ROOM_IDLE: "idle", AI_JOINING: "ai-joining", AI_DISCUSSION: "ai-discussion",
  CONFIG_PROPOSED: "config", PLAYERS_CONFIRMING: "config", GENERATING_GAME: "generating",
  GAME_READY: "config", COUNTDOWN: "countdown", ROUND_ACTIVE: "battle",
  ROUND_RESOLVING: "round-result", ROUND_RESULT: "round-result", MATCH_RESULT: "result", AI_REVIEW: "result"
};

type MemberRow = { user_id: string; is_ready: boolean; connection_state: string; joined_at: string; profiles: { display_name: string; avatar_url: string | null } | { display_name: string; avatar_url: string | null }[] | null };
type PlayerRow = { user_id: string; score: number; current_streak: number };

function one<T>(value: T | T[] | null): T | null { return Array.isArray(value) ? value[0] ?? null : value; }

export async function getRoomBootstrap(supabase: SupabaseClient, code: string, userId: string): Promise<RoomBootstrap | null> {
  const roomResult = await supabase.from("rooms").select("id, code, host_id, status").eq("code", code.toUpperCase()).maybeSingle();
  if (roomResult.error) throw roomResult.error;
  if (!roomResult.data) return null;
  const room = roomResult.data;

  const [membersResult, matchResult, generationResult, aiSessionResult] = await Promise.all([
    supabase.from("room_members").select("user_id, is_ready, connection_state, joined_at, profiles(display_name, avatar_url)").eq("room_id", room.id).order("joined_at"),
    supabase.from("matches").select("id, title, topic, level, status, blueprint, round_count, current_round, round_started_at, winner_id").eq("room_id", room.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("generation_jobs").select("status, stage, total_rounds, completed_rounds, error_message, updated_at").eq("room_id", room.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("ai_sessions").select("id, coordinator_id, heartbeat_at").eq("room_id", room.id).is("ended_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (membersResult.error || matchResult.error || generationResult.error || aiSessionResult.error) throw membersResult.error ?? matchResult.error ?? generationResult.error ?? aiSessionResult.error;

  let match: MatchView | null = null;
  let playerRows: PlayerRow[] = [];
  if (matchResult.data) {
    const currentMatch = matchResult.data;
    const [playersResult, questionResult] = await Promise.all([
      supabase.from("match_players").select("user_id, score, current_streak").eq("match_id", currentMatch.id),
      currentMatch.current_round > 0
        ? supabase.from("questions").select("id, mode, prompt, instruction, level, time_limit, public_payload").eq("match_id", currentMatch.id).eq("round_number", currentMatch.current_round).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    if (playersResult.error || questionResult.error) throw playersResult.error ?? questionResult.error;
    playerRows = (playersResult.data ?? []) as PlayerRow[];
    let submissions: SubmissionView[] = [];
    if (questionResult.data) {
      const submissionResult = await supabase.from("submissions").select("user_id, answer, is_correct, response_ms, points").eq("question_id", questionResult.data.id);
      if (submissionResult.error) throw submissionResult.error;
      submissions = (submissionResult.data ?? []).map((row) => ({ userId: row.user_id, answer: row.answer, correct: row.is_correct, responseMs: row.response_ms, points: row.points }));
    }
    match = {
      id: currentMatch.id, title: currentMatch.title, topic: currentMatch.topic, level: currentMatch.level,
      status: currentMatch.status, blueprint: currentMatch.blueprint, roundCount: currentMatch.round_count,
      currentRound: currentMatch.current_round, roundStartedAt: currentMatch.round_started_at, winnerId: currentMatch.winner_id,
      question: questionResult.data ? {
        id: questionResult.data.id, mode: questionResult.data.mode, prompt: questionResult.data.prompt,
        instruction: questionResult.data.instruction, level: questionResult.data.level,
        timeLimit: questionResult.data.time_limit, publicData: questionResult.data.public_payload
      } : null,
      submissions
    } as MatchView;
  }

  const members: RoomMemberData[] = ((membersResult.data ?? []) as unknown as MemberRow[]).map((member) => {
    const profile = one(member.profiles);
    const player = playerRows.find((item) => item.user_id === member.user_id);
    return {
      userId: member.user_id, displayName: profile?.display_name ?? "User", avatarUrl: profile?.avatar_url ?? null,
      isReady: member.is_ready, connectionState: member.connection_state, joinedAt: member.joined_at,
      score: player?.score ?? 0, streak: player?.current_streak ?? 0
    };
  });

  return {
    roomId: room.id,
    code: room.code,
    hostId: room.host_id,
    currentUserId: userId,
    phase: phaseMap[room.status] ?? "idle",
    members,
    match,
    generation: generationResult.data ? {
      status: generationResult.data.status,
      stage: generationResult.data.stage,
      totalRounds: generationResult.data.total_rounds,
      completedRounds: generationResult.data.completed_rounds,
      errorMessage: generationResult.data.error_message,
      updatedAt: generationResult.data.updated_at
    } : null,
    aiSession: aiSessionResult.data ? {
      id: aiSessionResult.data.id,
      coordinatorId: aiSessionResult.data.coordinator_id,
      heartbeatAt: aiSessionResult.data.heartbeat_at
    } : null
  } as RoomBootstrap;
}
