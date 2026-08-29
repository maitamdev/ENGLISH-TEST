-- Privacy-safe head-to-head insights from completed activity only.
-- No snapshots, sample opponents or seed rows are created.

create or replace function public.get_head_to_head_insights(target_partner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  shared_ids uuid[] := '{}';
  partner_info jsonb := '{}'::jsonb;
  summary jsonb := '{}'::jsonb;
  skills jsonb := '[]'::jsonb;
  recent jsonb := '[]'::jsonb;
  reliability jsonb := '{}'::jsonb;
  remediation jsonb := '{}'::jsonb;
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if target_partner_id is null or target_partner_id = actor then raise exception 'A different partner is required'; end if;
  if not exists (
    select 1 from public.friendships friendship
    where friendship.status = 'accepted' and
      ((friendship.requester_id = actor and friendship.addressee_id = target_partner_id) or
       (friendship.requester_id = target_partner_id and friendship.addressee_id = actor))
  ) then raise exception 'Accepted friendship required'; end if;
  if exists (
    select 1 from public.user_blocks block
    where (block.blocker_id = actor and block.blocked_id = target_partner_id) or
          (block.blocker_id = target_partner_id and block.blocked_id = actor)
  ) then raise exception 'Insights are unavailable between blocked accounts'; end if;

  select jsonb_build_object('id', profile.id, 'displayName', profile.display_name, 'avatarUrl', profile.avatar_url)
  into partner_info from public.profiles profile where profile.id = target_partner_id;

  select coalesce(array_agg(mine.match_id order by match.ended_at), '{}') into shared_ids
  from public.match_players mine
  join public.match_players theirs on theirs.match_id = mine.match_id and theirs.user_id = target_partner_id
  join public.matches match on match.id = mine.match_id and match.status = 'completed' and match.ended_at is not null
  where mine.user_id = actor;

  select jsonb_build_object(
    'matches', count(*),
    'duels', count(*) filter (where coalesce(match.blueprint #>> '{settings,experience}', 'DUEL') <> 'COOP'),
    'cooperative', count(*) filter (where match.blueprint #>> '{settings,experience}' = 'COOP'),
    'wins', count(*) filter (where match.winner_id = actor),
    'losses', count(*) filter (where match.winner_id = target_partner_id),
    'draws', count(*) filter (where match.winner_id is null and coalesce(match.blueprint #>> '{settings,experience}', 'DUEL') <> 'COOP'),
    'myAverageScore', coalesce(round(avg(mine.score), 1), 0),
    'partnerAverageScore', coalesce(round(avg(theirs.score), 1), 0),
    'firstMatchAt', min(match.ended_at),
    'latestMatchAt', max(match.ended_at)
  ) into summary
  from public.matches match
  join public.match_players mine on mine.match_id = match.id and mine.user_id = actor
  join public.match_players theirs on theirs.match_id = match.id and theirs.user_id = target_partner_id
  where match.id = any(shared_ids);

  with evidence as (
    select private.arena_skill_for_mode(question.mode) as skill, submission.user_id,
      submission.is_correct, submission.response_ms, submission.timed_out
    from public.submissions submission
    join public.questions question on question.id = submission.question_id
    where submission.match_id = any(shared_ids) and submission.user_id in (actor, target_partner_id)
  ), totals as (
    select skill,
      count(*) filter (where user_id = actor) as my_total,
      count(*) filter (where user_id = actor and is_correct and not timed_out) as my_correct,
      avg(response_ms) filter (where user_id = actor and not timed_out) as my_response,
      count(*) filter (where user_id = target_partner_id) as partner_total,
      count(*) filter (where user_id = target_partner_id and is_correct and not timed_out) as partner_correct,
      avg(response_ms) filter (where user_id = target_partner_id and not timed_out) as partner_response
    from evidence group by skill
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'skill', skill,
    'me', jsonb_build_object('total', my_total, 'correct', my_correct, 'accuracy', case when my_total > 0 then round(my_correct::numeric / my_total * 100, 1) else 0 end, 'averageResponseMs', coalesce(round(my_response), 0)),
    'partner', jsonb_build_object('total', partner_total, 'correct', partner_correct, 'accuracy', case when partner_total > 0 then round(partner_correct::numeric / partner_total * 100, 1) else 0 end, 'averageResponseMs', coalesce(round(partner_response), 0))
  ) order by skill), '[]'::jsonb) into skills from totals;

  with timeline as (
    select match.id, match.title, match.topic, match.level, match.ended_at, match.winner_id,
      coalesce(match.blueprint #>> '{settings,experience}', 'DUEL') as experience,
      mine.score as my_score, theirs.score as partner_score
    from public.matches match
    join public.match_players mine on mine.match_id = match.id and mine.user_id = actor
    join public.match_players theirs on theirs.match_id = match.id and theirs.user_id = target_partner_id
    where match.id = any(shared_ids)
    order by match.ended_at desc limit 30
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'matchId', id, 'title', title, 'topic', topic, 'level', level, 'endedAt', ended_at,
    'experience', experience, 'myScore', my_score, 'partnerScore', partner_score,
    'outcome', case when experience = 'COOP' then 'coop' when winner_id = actor then 'win' when winner_id = target_partner_id then 'loss' else 'draw' end
  ) order by ended_at desc), '[]'::jsonb) into recent from timeline;

  select jsonb_build_object(
    'fairnessAssessments', (select count(*) from public.question_fairness_assessments assessment join public.questions question on question.id = assessment.question_id where question.match_id = any(shared_ids)),
    'voidedRounds', (select count(*) from public.question_fairness_assessments assessment join public.questions question on question.id = assessment.question_id where question.match_id = any(shared_ids) and assessment.decision = 'voided'),
    'averageInputSkewMs', coalesce((select round(avg(assessment.input_skew_ms)) from public.question_fairness_assessments assessment join public.questions question on question.id = assessment.question_id where question.match_id = any(shared_ids) and assessment.input_skew_ms is not null), 0),
    'myDisconnects', (select count(*) from public.match_connectivity_incidents incident where incident.match_id = any(shared_ids) and incident.user_id = actor),
    'partnerDisconnects', (select count(*) from public.match_connectivity_incidents incident where incident.match_id = any(shared_ids) and incident.user_id = target_partner_id),
    'totalCompensationMs', coalesce((select sum(incident.deadline_extension_ms) from public.match_connectivity_incidents incident where incident.match_id = any(shared_ids)), 0)
  ) into reliability;

  select jsonb_build_object(
    'pending', count(*) filter (where item.status in ('pending','in_progress')),
    'completed', count(*) filter (where item.status = 'completed'),
    'dismissed', count(*) filter (where item.status = 'dismissed')
  ) into remediation
  from public.match_remediation_items item
  where item.user_id = actor and item.match_id = any(shared_ids);

  return jsonb_build_object(
    'partner', partner_info,
    'summary', summary,
    'skills', skills,
    'recentMatches', recent,
    'reliability', reliability,
    'myRemediation', remediation,
    'generatedAt', clock_timestamp(),
    'algorithmVersion', 'head-to-head-v1'
  );
end;
$$;

revoke execute on function public.get_head_to_head_insights(uuid) from public, anon;
grant execute on function public.get_head_to_head_insights(uuid) to authenticated;
