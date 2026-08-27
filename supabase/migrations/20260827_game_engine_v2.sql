-- LexiDuel game engine v2
-- Run once in the Supabase SQL editor before deploying this version.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

alter table public.submissions add column if not exists timed_out boolean not null default false;
alter table public.submissions add column if not exists matched_answer text;
alter table public.submissions add column if not exists match_type text;

create or replace function private.normalize_game_answer(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(extensions.unaccent(normalize(coalesce(value, ''), NFKC))),
        '^[[:space:]]*(a|an|the)[[:space:]]+',
        '',
        'i'
      ),
      '[^[:alnum:][:space:]]+',
      ' ',
      'g'
    ),
    '[[:space:]]+',
    ' ',
    'g'
  ));
$$;

create or replace function private.answer_match_quality(submitted text, accepted text)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  left_value text := private.normalize_game_answer(submitted);
  right_value text := private.normalize_game_answer(accepted);
  longest integer;
  distance integer;
  trigram_score real;
begin
  if left_value = '' or right_value = '' then return 0; end if;
  if left_value = right_value then return 100; end if;

  longest := greatest(char_length(left_value), char_length(right_value));
  if longest < 4 then return 0; end if;

  distance := extensions.levenshtein(left_value, right_value);
  trigram_score := extensions.similarity(left_value, right_value);

  -- Only tolerate a genuine small typo. Semantic aliases must be explicitly
  -- generated into question_answers.accepted_answers.
  if longest between 4 and 7 and distance <= 1 and trigram_score >= 0.72 then return 80; end if;
  if longest >= 8 and distance <= 2 and trigram_score >= 0.76 then return 75; end if;
  return 0;
end;
$$;

create or replace function private.schedule_synchronized_round()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active'
     and (old.status is distinct from new.status or new.current_round > old.current_round) then
    -- Give both subscribed clients enough time to receive the committed state.
    new.round_started_at := clock_timestamp() + interval '4 seconds';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_synchronized_round_trigger on public.matches;
create trigger schedule_synchronized_round_trigger
before update of status, current_round on public.matches
for each row execute function private.schedule_synchronized_round();

create or replace function public.submit_answer(target_question_id uuid, submitted_answer text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  q public.questions%rowtype;
  m public.matches%rowtype;
  secret public.question_answers%rowtype;
  normalized text;
  correct boolean := false;
  within_time boolean;
  scored_correct boolean;
  elapsed_ms integer;
  scoring_elapsed_ms integer;
  player_streak integer;
  speed_bonus integer := 0;
  streak_bonus integer := 0;
  awarded_points integer := 0;
  best_quality integer := 0;
  accepted_value text;
  accepted_quality integer;
  matched_value text;
  grading_type text := 'incorrect';
  existing public.submissions%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(submitted_answer), '') is null then raise exception 'Answer is required'; end if;
  if char_length(submitted_answer) > 500 then raise exception 'Answer is too long'; end if;

  select * into q from public.questions where id = target_question_id;
  if q.id is null then raise exception 'Question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = current_user_id) then
    raise exception 'Not a match player';
  end if;

  select * into existing from public.submissions where question_id = q.id and user_id = current_user_id;
  if existing.id is not null then
    return jsonb_build_object(
      'submissionId', existing.id,
      'correct', existing.is_correct,
      'timedOut', existing.timed_out,
      'matchType', existing.match_type,
      'matchedAnswer', existing.matched_answer,
      'points', existing.points,
      'responseMs', existing.response_ms,
      'alreadySubmitted', true
    );
  end if;

  if m.round_started_at is null then raise exception 'Round clock is unavailable'; end if;
  if clock_timestamp() < m.round_started_at then raise exception 'Round has not started yet'; end if;

  select * into secret from public.question_answers where question_id = q.id;
  if secret.question_id is null then raise exception 'Question answer is unavailable'; end if;

  normalized := private.normalize_game_answer(submitted_answer);
  for accepted_value in select jsonb_array_elements_text(secret.accepted_answers)
  loop
    accepted_quality := private.answer_match_quality(submitted_answer, accepted_value);
    if accepted_quality > best_quality then
      best_quality := accepted_quality;
      matched_value := accepted_value;
    end if;
  end loop;

  correct := best_quality >= 75 and submitted_answer <> '⏱ Hết giờ';
  grading_type := case
    when best_quality = 100 then 'accepted'
    when best_quality >= 75 then 'minor_typo'
    else 'incorrect'
  end;

  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  -- 750ms only protects a request sent at the deadline from normal network transit.
  within_time := elapsed_ms <= (q.time_limit * 1000) + 750 and submitted_answer <> '⏱ Hết giờ';
  scored_correct := correct and within_time;
  scoring_elapsed_ms := least(elapsed_ms, q.time_limit * 1000);

  select current_streak into player_streak
  from public.match_players
  where match_id = m.id and user_id = current_user_id;

  if scored_correct then
    -- Quantize speed to 250ms buckets so tiny network differences do not alter points.
    scoring_elapsed_ms := ceil(scoring_elapsed_ms / 250.0)::integer * 250;
    speed_bonus := greatest(0, round((1 - scoring_elapsed_ms::numeric / (q.time_limit * 1000)) * 40));
    streak_bonus := least((coalesce(player_streak, 0) + 1) * 4, 20);
    awarded_points := 100 + speed_bonus + streak_bonus;
    if q.mode = 'BOSS' then awarded_points := awarded_points * 2; end if;
  end if;

  insert into public.submissions (
    match_id, question_id, user_id, answer, normalized_answer, is_correct,
    timed_out, matched_answer, match_type, response_ms, points
  ) values (
    m.id, q.id, current_user_id, submitted_answer, normalized, correct,
    not within_time, matched_value, grading_type, elapsed_ms, awarded_points
  ) returning * into existing;

  update public.match_players
  set score = score + awarded_points,
      current_streak = case when scored_correct then current_streak + 1 else 0 end,
      correct_count = correct_count + case when correct then 1 else 0 end,
      incorrect_count = incorrect_count + case when correct then 0 else 1 end,
      best_streak = greatest(best_streak, case when scored_correct then current_streak + 1 else current_streak end),
      avg_response_ms = round(((coalesce(avg_response_ms, 0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1))
  where match_id = m.id and user_id = current_user_id;

  if (select count(*) from public.submissions where question_id = q.id)
     = (select count(*) from public.match_players where match_id = m.id) then
    update public.rooms set status = 'ROUND_RESULT' where id = m.room_id;
  end if;

  return jsonb_build_object(
    'submissionId', existing.id,
    'correct', correct,
    'timedOut', not within_time,
    'matchType', grading_type,
    'matchedAnswer', matched_value,
    'points', awarded_points,
    'responseMs', elapsed_ms,
    'canonicalAnswer', secret.canonical_answer,
    'acceptedAnswers', secret.accepted_answers,
    'explanation', secret.explanation,
    'alreadySubmitted', false
  );
end;
$$;

revoke execute on function public.submit_answer(uuid, text) from public, anon;
grant execute on function public.submit_answer(uuid, text) to authenticated;

-- Existing rows remain reviewable with an explicit timeout classification.
update public.submissions s
set timed_out = s.response_ms > q.time_limit * 1000
from public.questions q
where q.id = s.question_id
  and s.timed_out is distinct from (s.response_ms > q.time_limit * 1000);

-- Database-originated room events are the authoritative low-latency signal.
-- Clients still refetch the protected state, so no answer is exposed here.
create or replace function private.broadcast_room_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room_id uuid;
  target_room_code text;
begin
  if tg_table_name = 'rooms' then
    target_room_id := coalesce(new.id, old.id);
    target_room_code := coalesce(new.code, old.code);
  elsif tg_table_name = 'room_members' or tg_table_name = 'matches' then
    target_room_id := coalesce(new.room_id, old.room_id);
    select code into target_room_code from public.rooms where id = target_room_id;
  elsif tg_table_name = 'submissions' then
    select m.room_id, r.code into target_room_id, target_room_code
    from public.matches m join public.rooms r on r.id = m.room_id
    where m.id = coalesce(new.match_id, old.match_id);
  end if;

  if target_room_code is not null then
    perform realtime.send(
      jsonb_build_object('table', tg_table_name, 'operation', tg_op, 'roomId', target_room_id),
      'game_state_changed',
      'room:' || target_room_code,
      true
    );
  end if;
  return null;
end;
$$;

drop trigger if exists broadcast_room_change on public.rooms;
create trigger broadcast_room_change after insert or update or delete on public.rooms
for each row execute function private.broadcast_room_state();
drop trigger if exists broadcast_room_member_change on public.room_members;
create trigger broadcast_room_member_change after insert or update or delete on public.room_members
for each row execute function private.broadcast_room_state();
drop trigger if exists broadcast_match_change on public.matches;
create trigger broadcast_match_change after insert or update or delete on public.matches
for each row execute function private.broadcast_room_state();
drop trigger if exists broadcast_submission_change on public.submissions;
create trigger broadcast_submission_change after insert or update or delete on public.submissions
for each row execute function private.broadcast_room_state();

alter table realtime.messages enable row level security;
drop policy if exists "room members receive game broadcasts" on realtime.messages;
create policy "room members receive game broadcasts"
on realtime.messages for select to authenticated
using (
  topic like 'room:%'
  and exists (
    select 1 from public.rooms r
    where r.code = split_part(topic, ':', 2)
      and private.is_room_member(r.id)
  )
);
drop policy if exists "room members send game broadcasts" on realtime.messages;
create policy "room members send game broadcasts"
on realtime.messages for insert to authenticated
with check (
  topic like 'room:%'
  and exists (
    select 1 from public.rooms r
    where r.code = split_part(topic, ':', 2)
      and private.is_room_member(r.id)
  )
);
