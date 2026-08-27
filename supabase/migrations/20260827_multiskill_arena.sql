-- LexiDuel multi-skill arena
-- Run after 20260827_game_engine_v2.sql. This migration contains no seed or mock data.

alter table public.questions drop constraint if exists questions_mode_check;
alter table public.questions add constraint questions_mode_check check (mode in (
  'VI_TO_EN','EN_TO_VI','LISTENING','SPELLING','MULTIPLE_CHOICE','READING','CONTEXT','GRAMMAR',
  'TRANSLATION','DEFINITION','PRONUNCIATION','SPEAKING','ROLEPLAY','DEBATE','WRITING','BOSS'
));

alter table public.submissions add column if not exists hints_used integer not null default 0 check (hints_used between 0 and 3);
alter table public.submissions add column if not exists rubric_score numeric(5,2) check (rubric_score is null or rubric_score between 0 and 100);
alter table public.submissions add column if not exists assessment jsonb;

alter table public.user_learning_stats add column if not exists reading_score integer check (reading_score is null or reading_score between 0 and 100);
alter table public.user_learning_stats add column if not exists speaking_score integer check (speaking_score is null or speaking_score between 0 and 100);
alter table public.user_learning_stats add column if not exists pronunciation_score integer check (pronunciation_score is null or pronunciation_score between 0 and 100);
alter table public.user_learning_stats add column if not exists writing_score integer check (writing_score is null or writing_score between 0 and 100);

create table if not exists public.match_hints (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  sequence integer not null check (sequence between 1 and 3),
  hint_text text not null check (char_length(hint_text) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (question_id, user_id, sequence)
);

create table if not exists public.speaking_assessments (
  submission_id uuid primary key references public.submissions(id) on delete cascade,
  transcript text not null default '',
  content_score numeric(5,2) not null check (content_score between 0 and 100),
  pronunciation_score numeric(5,2) not null check (pronunciation_score between 0 and 100),
  fluency_score numeric(5,2) not null check (fluency_score between 0 and 100),
  grammar_score numeric(5,2) not null check (grammar_score between 0 and 100),
  vocabulary_score numeric(5,2) not null check (vocabulary_score between 0 and 100),
  overall_score numeric(5,2) not null check (overall_score between 0 and 100),
  feedback_vi text not null,
  strengths jsonb not null default '[]'::jsonb,
  improvements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists match_hints_question_user_idx on public.match_hints(question_id, user_id);
alter table public.match_hints enable row level security;
alter table public.speaking_assessments enable row level security;

revoke all on public.match_hints, public.speaking_assessments from anon, authenticated;
grant select on public.match_hints, public.speaking_assessments to authenticated;

drop policy if exists "players read own hints" on public.match_hints;
create policy "players read own hints" on public.match_hints for select to authenticated
using (user_id = (select auth.uid()) and exists (
  select 1 from public.matches m where m.id = match_id and private.is_room_member(m.room_id)
));

drop policy if exists "players read revealed speaking assessments" on public.speaking_assessments;
create policy "players read revealed speaking assessments" on public.speaking_assessments for select to authenticated
using (exists (
  select 1 from public.submissions s
  join public.matches m on m.id = s.match_id
  join public.questions q on q.id = s.question_id
  where s.id = submission_id
    and private.is_room_member(m.room_id)
    and (m.status = 'completed' or q.round_number < m.current_round)
));

create or replace function private.game_settings(target_blueprint jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'strictness', coalesce(target_blueprint #>> '{settings,strictness}', 'STANDARD'),
    'hintPenalty', coalesce((target_blueprint #>> '{settings,hintPenalty}')::integer, 20),
    'speedScoring', coalesce((target_blueprint ->> 'speedScoring')::boolean, true),
    'streakBonus', coalesce((target_blueprint ->> 'streakBonus')::boolean, true)
  );
$$;

create or replace function public.submit_answer(target_question_id uuid, submitted_answer text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  q public.questions%rowtype;
  m public.matches%rowtype;
  secret public.question_answers%rowtype;
  existing public.submissions%rowtype;
  settings jsonb;
  strictness text;
  normalized text;
  exact_match boolean := false;
  correct boolean := false;
  within_time boolean;
  elapsed_ms integer;
  scoring_elapsed_ms integer;
  player_streak integer := 0;
  speed_bonus integer := 0;
  streak_bonus integer := 0;
  mode_bonus numeric := 1;
  awarded_points integer := 0;
  best_quality integer := 0;
  accepted_value text;
  accepted_quality integer;
  matched_value text;
  grading_type text := 'incorrect';
  hint_count integer := 0;
  hint_penalty integer := 0;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(submitted_answer), '') is null then raise exception 'Answer is required'; end if;
  if char_length(submitted_answer) > 1500 then raise exception 'Answer is too long'; end if;

  select * into q from public.questions where id = target_question_id;
  if q.id is null then raise exception 'Question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if q.mode in ('PRONUNCIATION','SPEAKING','ROLEPLAY','DEBATE','WRITING') then raise exception 'This answer must be graded through its rubric endpoint'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = current_user_id) then raise exception 'Not a match player'; end if;
  select * into existing from public.submissions where question_id = q.id and user_id = current_user_id;
  if existing.id is not null then return jsonb_build_object('submissionId', existing.id, 'correct', existing.is_correct, 'points', existing.points, 'alreadySubmitted', true); end if;
  if m.round_started_at is null or clock_timestamp() < m.round_started_at then raise exception 'Round has not started yet'; end if;
  select * into secret from public.question_answers where question_id = q.id;
  if secret.question_id is null then raise exception 'Question answer is unavailable'; end if;

  settings := private.game_settings(m.blueprint);
  strictness := settings ->> 'strictness';
  normalized := private.normalize_game_answer(submitted_answer);
  for accepted_value in select jsonb_array_elements_text(secret.accepted_answers) loop
    accepted_quality := private.answer_match_quality(submitted_answer, accepted_value);
    if accepted_quality > best_quality then best_quality := accepted_quality; matched_value := accepted_value; end if;
  end loop;
  exact_match := best_quality = 100;
  correct := case when strictness = 'STRICT' then exact_match else best_quality >= 75 end and submitted_answer <> '⏱ Hết giờ';
  grading_type := case when exact_match then 'accepted' when correct then 'minor_typo' else 'incorrect' end;

  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  within_time := elapsed_ms <= (q.time_limit * 1000) + 1000 and submitted_answer <> '⏱ Hết giờ';
  scoring_elapsed_ms := least(elapsed_ms, q.time_limit * 1000);
  select current_streak into player_streak from public.match_players where match_id = m.id and user_id = current_user_id;
  select count(*) into hint_count from public.match_hints where question_id = q.id and user_id = current_user_id;
  hint_penalty := hint_count * coalesce((settings ->> 'hintPenalty')::integer, 20);

  if correct and within_time then
    scoring_elapsed_ms := ceil(scoring_elapsed_ms / 500.0)::integer * 500;
    if coalesce((settings ->> 'speedScoring')::boolean, true) then speed_bonus := greatest(0, round((1 - scoring_elapsed_ms::numeric / (q.time_limit * 1000)) * 30)); end if;
    if coalesce((settings ->> 'streakBonus')::boolean, true) then streak_bonus := least((coalesce(player_streak, 0) + 1) * 3, 15); end if;
    mode_bonus := case when q.mode in ('LISTENING','READING') then 1.10 when q.mode = 'BOSS' then 2 else 1 end;
    awarded_points := greatest(10, round((100 + speed_bonus + streak_bonus) * mode_bonus) - hint_penalty);
  end if;

  insert into public.submissions (match_id, question_id, user_id, answer, normalized_answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used)
  values (m.id, q.id, current_user_id, submitted_answer, normalized, correct, not within_time, matched_value, grading_type, elapsed_ms, awarded_points, hint_count)
  returning * into existing;
  update public.match_players set
    score = score + awarded_points,
    current_streak = case when correct and within_time then current_streak + 1 else 0 end,
    correct_count = correct_count + case when correct then 1 else 0 end,
    incorrect_count = incorrect_count + case when correct then 0 else 1 end,
    best_streak = greatest(best_streak, case when correct and within_time then current_streak + 1 else current_streak end),
    avg_response_ms = round(((coalesce(avg_response_ms, 0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1))
  where match_id = m.id and user_id = current_user_id;
  if (select count(*) from public.submissions where question_id = q.id) = (select count(*) from public.match_players where match_id = m.id) then update public.rooms set status = 'ROUND_RESULT' where id = m.room_id; end if;
  return jsonb_build_object('submissionId', existing.id, 'correct', correct, 'timedOut', not within_time, 'matchType', grading_type, 'matchedAnswer', matched_value, 'points', awarded_points, 'responseMs', elapsed_ms, 'hintsUsed', hint_count, 'alreadySubmitted', false);
end;
$$;

revoke execute on function public.submit_answer(uuid, text) from public, anon;
grant execute on function public.submit_answer(uuid, text) to authenticated;

create or replace function public.record_spoken_assessment(target_question_id uuid, target_user_id uuid, assessment jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  q public.questions%rowtype;
  m public.matches%rowtype;
  existing public.submissions%rowtype;
  elapsed_ms integer;
  overall numeric;
  threshold integer;
  passed boolean;
  points integer;
  hint_count integer := 0;
  hint_penalty integer := 20;
  transcript text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(assessment) <> 'object' then raise exception 'Assessment is invalid'; end if;
  select * into q from public.questions where id = target_question_id;
  if q.id is null or q.mode not in ('PRONUNCIATION','SPEAKING','ROLEPLAY','DEBATE') then raise exception 'Spoken question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = target_user_id) then raise exception 'Not a match player'; end if;
  select * into existing from public.submissions where question_id = q.id and user_id = target_user_id;
  if existing.id is not null then return jsonb_build_object('submissionId', existing.id, 'alreadySubmitted', true); end if;

  overall := greatest(0, least(100, coalesce((assessment ->> 'overall')::numeric, 0)));
  threshold := case coalesce(m.blueprint #>> '{settings,strictness}', 'STANDARD') when 'LENIENT' then 55 when 'STRICT' then 75 else 65 end;
  passed := overall >= threshold;
  transcript := left(coalesce(assessment ->> 'transcript', ''), 2000);
  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  select count(*) into hint_count from public.match_hints where question_id = q.id and user_id = target_user_id;
  hint_penalty := coalesce((m.blueprint #>> '{settings,hintPenalty}')::integer, 20);
  points := greatest(0, round(overall * 1.5)::integer - hint_count * hint_penalty);

  insert into public.submissions (match_id, question_id, user_id, answer, normalized_answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used, rubric_score, assessment)
  values (m.id, q.id, target_user_id, case when transcript = '' then '[Audio response]' else transcript end, private.normalize_game_answer(transcript), passed, false, null, 'rubric', elapsed_ms, points, hint_count, overall, assessment)
  returning * into existing;
  insert into public.speaking_assessments (submission_id, transcript, content_score, pronunciation_score, fluency_score, grammar_score, vocabulary_score, overall_score, feedback_vi, strengths, improvements)
  values (existing.id, transcript, coalesce((assessment ->> 'content')::numeric,0), coalesce((assessment ->> 'pronunciation')::numeric,0), coalesce((assessment ->> 'fluency')::numeric,0), coalesce((assessment ->> 'grammar')::numeric,0), coalesce((assessment ->> 'vocabulary')::numeric,0), overall, coalesce(assessment ->> 'feedbackVi',''), coalesce(assessment -> 'strengths','[]'::jsonb), coalesce(assessment -> 'improvements','[]'::jsonb));
  update public.match_players set score = score + points, current_streak = case when passed then current_streak + 1 else 0 end, correct_count = correct_count + case when passed then 1 else 0 end, incorrect_count = incorrect_count + case when passed then 0 else 1 end, best_streak = greatest(best_streak, case when passed then current_streak + 1 else current_streak end), avg_response_ms = round(((coalesce(avg_response_ms,0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1)) where match_id = m.id and user_id = target_user_id;
  if (select count(*) from public.submissions where question_id = q.id) = (select count(*) from public.match_players where match_id = m.id) then update public.rooms set status = 'ROUND_RESULT' where id = m.room_id; end if;
  return jsonb_build_object('submissionId', existing.id, 'correct', passed, 'points', points, 'rubricScore', overall, 'alreadySubmitted', false);
end;
$$;

revoke execute on function public.record_spoken_assessment(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_spoken_assessment(uuid, uuid, jsonb) to service_role;

create or replace function public.record_written_assessment(target_question_id uuid, target_user_id uuid, submitted_answer text, assessment jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  q public.questions%rowtype;
  m public.matches%rowtype;
  existing public.submissions%rowtype;
  elapsed_ms integer;
  overall numeric;
  threshold integer;
  passed boolean;
  points integer;
  hint_count integer := 0;
  hint_penalty integer := 20;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(assessment) <> 'object' or nullif(trim(submitted_answer), '') is null then raise exception 'Written assessment is invalid'; end if;
  if char_length(submitted_answer) > 1500 then raise exception 'Answer is too long'; end if;
  select * into q from public.questions where id = target_question_id;
  if q.id is null or q.mode <> 'WRITING' then raise exception 'Writing question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = target_user_id) then raise exception 'Not a match player'; end if;
  select * into existing from public.submissions where question_id = q.id and user_id = target_user_id;
  if existing.id is not null then return jsonb_build_object('submissionId', existing.id, 'alreadySubmitted', true); end if;

  overall := greatest(0, least(100, coalesce((assessment ->> 'overall')::numeric, 0)));
  threshold := case coalesce(m.blueprint #>> '{settings,strictness}', 'STANDARD') when 'LENIENT' then 55 when 'STRICT' then 75 else 65 end;
  passed := overall >= threshold;
  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  select count(*) into hint_count from public.match_hints where question_id = q.id and user_id = target_user_id;
  hint_penalty := coalesce((m.blueprint #>> '{settings,hintPenalty}')::integer, 20);
  points := greatest(0, round(overall * 1.5)::integer - hint_count * hint_penalty);

  insert into public.submissions (match_id, question_id, user_id, answer, normalized_answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used, rubric_score, assessment)
  values (m.id, q.id, target_user_id, submitted_answer, private.normalize_game_answer(submitted_answer), passed, false, null, 'rubric', elapsed_ms, points, hint_count, overall, assessment)
  returning * into existing;
  update public.match_players set score = score + points, current_streak = case when passed then current_streak + 1 else 0 end, correct_count = correct_count + case when passed then 1 else 0 end, incorrect_count = incorrect_count + case when passed then 0 else 1 end, best_streak = greatest(best_streak, case when passed then current_streak + 1 else current_streak end), avg_response_ms = round(((coalesce(avg_response_ms,0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1)) where match_id = m.id and user_id = target_user_id;
  if (select count(*) from public.submissions where question_id = q.id) = (select count(*) from public.match_players where match_id = m.id) then update public.rooms set status = 'ROUND_RESULT' where id = m.room_id; end if;
  return jsonb_build_object('submissionId', existing.id, 'correct', passed, 'points', points, 'rubricScore', overall, 'alreadySubmitted', false);
end;
$$;

revoke execute on function public.record_written_assessment(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_written_assessment(uuid, uuid, text, jsonb) to service_role;
