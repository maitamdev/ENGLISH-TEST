-- LexiDuel learning intelligence
-- Score Engine V3, FSRS state, error notebook, adaptive plans, speaking sessions,
-- pronunciation detail and licensed source provenance. No learning rows are seeded.

-- ---------------------------------------------------------------------------
-- Licensed source provenance and imported learning content
-- ---------------------------------------------------------------------------

create table if not exists public.learning_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  display_name text not null,
  provider text not null,
  homepage_url text not null,
  data_url text,
  license_id text not null,
  license_url text not null,
  attribution_text text not null,
  source_kind text not null check (source_kind in ('open_dataset','open_source_project','authorized_facebook_page')),
  rights_holder text,
  authorization_evidence_url text,
  terms_snapshot jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    source_kind <> 'authorized_facebook_page'
    or (rights_holder is not null and authorization_evidence_url is not null)
  )
);

create table if not exists public.source_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.learning_sources(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','partial','failed','cancelled')),
  cursor_state jsonb not null default '{}'::jsonb,
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  rejected_count integer not null default 0,
  error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.learning_content (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.learning_sources(id) on delete restrict,
  source_record_id text not null,
  content_type text not null check (content_type in ('sentence_pair','pronunciation_entry','speech_sample','reading_passage','vocabulary_entry','authorized_social_post')),
  language text not null,
  translation_language text,
  cefr_level text check (cefr_level is null or cefr_level in ('A1','A2','B1','B2','C1','C2')),
  content jsonb not null,
  normalized_text text,
  topic_tags text[] not null default '{}',
  content_hash text not null,
  license_id text not null,
  attribution jsonb not null,
  moderation_status text not null default 'pending' check (moderation_status in ('pending','approved','rejected','quarantined')),
  moderation_notes text,
  moderated_at timestamptz,
  quality_score numeric(5,2) check (quality_score is null or quality_score between 0 and 100),
  imported_at timestamptz not null default now(),
  last_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  unique (source_id, content_hash),
  check (jsonb_typeof(content) = 'object'),
  check (jsonb_typeof(attribution) = 'object')
);

alter table public.learning_content
  add column if not exists moderation_notes text,
  add column if not exists moderated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists learning_content_lookup_idx
  on public.learning_content(content_type, language, translation_language, moderation_status);
create index if not exists learning_content_cefr_idx
  on public.learning_content(cefr_level, quality_score desc) where moderation_status = 'approved';
create index if not exists source_import_runs_claim_idx
  on public.source_import_runs(status, created_at) where status in ('queued','running','partial');

alter table public.learning_sources enable row level security;
alter table public.source_import_runs enable row level security;
alter table public.learning_content enable row level security;
drop policy if exists "users read enabled source attribution" on public.learning_sources;
create policy "users read enabled source attribution" on public.learning_sources for select to authenticated using (enabled);
drop policy if exists "users read approved learning content" on public.learning_content;
create policy "users read approved learning content" on public.learning_content for select to authenticated using (moderation_status = 'approved');
revoke all on table public.learning_sources, public.source_import_runs, public.learning_content from anon;
revoke insert, update, delete on table public.learning_sources, public.source_import_runs, public.learning_content from authenticated;
grant select on table public.learning_sources, public.learning_content to authenticated;

alter table public.questions
  add column if not exists learning_content_id uuid references public.learning_content(id) on delete set null;

create table if not exists public.match_learning_updates (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  applied_at timestamptz not null default now(),
  primary key (match_id, user_id)
);
alter table public.match_learning_updates enable row level security;
revoke all on table public.match_learning_updates from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Score Engine V3 and auditable rating changes
-- ---------------------------------------------------------------------------

alter table public.submissions
  add column if not exists scoring_version text not null default 'v3',
  add column if not exists score_components jsonb not null default '{}'::jsonb,
  add column if not exists original_points integer,
  add column if not exists verdict_confidence numeric(5,4) check (verdict_confidence is null or verdict_confidence between 0 and 1);

create table if not exists public.rating_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null,
  opponent_id uuid references public.profiles(id) on delete set null,
  rating_before numeric(8,2) not null,
  rating_after numeric(8,2) not null,
  expected_score numeric(7,6) not null,
  actual_score numeric(3,2) not null,
  k_factor numeric(5,2) not null,
  created_at timestamptz not null default now(),
  unique (match_id, user_id, skill)
);

alter table public.rating_events enable row level security;
drop policy if exists "players read own rating events" on public.rating_events;
create policy "players read own rating events" on public.rating_events for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.rating_events from anon;
revoke insert, update, delete on table public.rating_events from authenticated;
grant select on table public.rating_events to authenticated;

create or replace function public.finalize_match_ratings(target_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_a uuid;
  player_b uuid;
  score_a integer;
  score_b integer;
  rating_a numeric;
  rating_b numeric;
  deviation_a numeric;
  deviation_b numeric;
  matches_a integer;
  matches_b integer;
  expected_a numeric;
  expected_b numeric;
  actual_a numeric;
  actual_b numeric;
  k_a numeric;
  k_b numeric;
  next_a numeric;
  next_b numeric;
  target_skill text;
  cooperative boolean;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  perform 1 from public.matches where id = target_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if exists (select 1 from public.rating_events where match_id = target_match_id) then
    return jsonb_build_object('applied', false, 'reason', 'already_applied');
  end if;

  select coalesce((m.blueprint #>> '{settings,experience}') = 'COOP', false)
  into cooperative from public.matches m where m.id = target_match_id;
  if cooperative then return jsonb_build_object('applied', false, 'reason', 'cooperative_match'); end if;

  select case when count(distinct q.skill) > 1 then 'Mixed' else coalesce(max(q.skill), 'Mixed') end
  into target_skill
  from (
    select case
      when mode in ('LISTENING','AUDIO_CHOICE','STORY_LISTENING','MINIMAL_PAIRS','SPELLING') then 'Listening'
      when mode in ('PRONUNCIATION','SHADOWING','SPEAKING','ROLEPLAY','DEBATE') then 'Speaking'
      when mode = 'READING' then 'Reading'
      when mode = 'WRITING' then 'Writing'
      when mode in ('GRAMMAR','ERROR_CORRECTION','CLOZE','SENTENCE_BUILDER') then 'Grammar'
      else 'Vocabulary'
    end as skill
    from public.questions where match_id = target_match_id
  ) q;

  select p.user_id, p.score into player_a, score_a
  from public.match_players p where p.match_id = target_match_id
  order by p.user_id limit 1;
  select p.user_id, p.score into player_b, score_b
  from public.match_players p where p.match_id = target_match_id and p.user_id <> player_a
  limit 1;
  if player_a is null or player_b is null then raise exception 'Exactly two players are required'; end if;

  insert into public.player_ratings(user_id, skill) values (player_a, target_skill), (player_b, target_skill)
  on conflict (user_id, skill) do nothing;
  select rating, deviation, match_count into rating_a, deviation_a, matches_a
  from public.player_ratings where user_id = player_a and skill = target_skill for update;
  select rating, deviation, match_count into rating_b, deviation_b, matches_b
  from public.player_ratings where user_id = player_b and skill = target_skill for update;

  expected_a := 1 / (1 + power(10::numeric, (rating_b - rating_a) / 400));
  expected_b := 1 - expected_a;
  actual_a := case when score_a > score_b then 1 when score_a < score_b then 0 else 0.5 end;
  actual_b := 1 - actual_a;
  k_a := case when matches_a < 10 then 40 when matches_a < 30 then 32 else 24 end;
  k_b := case when matches_b < 10 then 40 when matches_b < 30 then 32 else 24 end;
  next_a := greatest(0, least(5000, rating_a + k_a * (actual_a - expected_a)));
  next_b := greatest(0, least(5000, rating_b + k_b * (actual_b - expected_b)));

  insert into public.rating_events(match_id, user_id, skill, opponent_id, rating_before, rating_after, expected_score, actual_score, k_factor)
  values
    (target_match_id, player_a, target_skill, player_b, rating_a, next_a, expected_a, actual_a, k_a),
    (target_match_id, player_b, target_skill, player_a, rating_b, next_b, expected_b, actual_b, k_b);

  update public.player_ratings set
    rating = next_a, deviation = greatest(60, deviation_a * 0.96), match_count = match_count + 1,
    wins = wins + case when actual_a = 1 then 1 else 0 end,
    losses = losses + case when actual_a = 0 then 1 else 0 end,
    draws = draws + case when actual_a = 0.5 then 1 else 0 end,
    updated_at = clock_timestamp()
  where user_id = player_a and skill = target_skill;
  update public.player_ratings set
    rating = next_b, deviation = greatest(60, deviation_b * 0.96), match_count = match_count + 1,
    wins = wins + case when actual_b = 1 then 1 else 0 end,
    losses = losses + case when actual_b = 0 then 1 else 0 end,
    draws = draws + case when actual_b = 0.5 then 1 else 0 end,
    updated_at = clock_timestamp()
  where user_id = player_b and skill = target_skill;

  return jsonb_build_object('applied', true, 'skill', target_skill, 'players', jsonb_build_array(
    jsonb_build_object('userId', player_a, 'before', rating_a, 'after', next_a),
    jsonb_build_object('userId', player_b, 'before', rating_b, 'after', next_b)
  ));
end;
$$;

revoke execute on function public.finalize_match_ratings(uuid) from public, anon, authenticated;
grant execute on function public.finalize_match_ratings(uuid) to service_role;

create or replace function private.score_engine_v3(
  target_mode text,
  target_difficulty integer,
  target_quality integer,
  target_elapsed_ms integer,
  target_time_limit_ms integer,
  target_streak integer,
  target_hint_count integer,
  target_hint_penalty integer,
  target_speed_enabled boolean,
  target_streak_enabled boolean
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  base_points integer := 100;
  accuracy_factor numeric := case when target_quality >= 100 then 1 when target_quality >= 75 then 0.92 else 0 end;
  grace_ms integer := greatest(1000, round(target_time_limit_ms * 0.20));
  scoring_window integer := greatest(1000, target_time_limit_ms - grace_ms);
  speed_bonus integer := 0;
  streak_bonus integer := 0;
  difficulty_bonus integer := 0;
  mode_factor numeric := 1;
  hint_deduction integer := greatest(0, target_hint_count * target_hint_penalty);
  total integer := 0;
begin
  if accuracy_factor = 0 then
    return jsonb_build_object(
      'version','v3','base',0,'accuracyFactor',0,'speedBonus',0,'streakBonus',0,
      'difficultyBonus',0,'difficulty',0,'speed',0,'streak',0,'modeFactor',1,'hintDeduction',0,'total',0
    );
  end if;

  if target_speed_enabled and target_elapsed_ms > grace_ms then
    speed_bonus := round(greatest(0, 1 - ((target_elapsed_ms - grace_ms)::numeric / scoring_window)) * 20);
  elsif target_speed_enabled then
    speed_bonus := 20;
  end if;
  if target_streak_enabled then streak_bonus := least(greatest(0, target_streak) * 2, 12); end if;
  difficulty_bonus := greatest(0, least(20, (greatest(1, least(10, target_difficulty)) - 3) * 3));
  mode_factor := case
    when target_mode in ('LISTENING','STORY_LISTENING','READING') then 1.08
    when target_mode in ('PRONUNCIATION','SHADOWING','SPEAKING','ROLEPLAY','DEBATE','WRITING') then 1.12
    when target_mode = 'BOSS' then 1.35
    else 1
  end;
  total := greatest(0, round(((base_points * accuracy_factor) + speed_bonus + streak_bonus + difficulty_bonus) * mode_factor) - hint_deduction);

  return jsonb_build_object(
    'version','v3','base',base_points,'accuracyFactor',accuracy_factor,
    'speedBonus',speed_bonus,'speed',speed_bonus,'streakBonus',streak_bonus,'streak',streak_bonus,'difficultyBonus',difficulty_bonus,'difficulty',difficulty_bonus,
    'modeFactor',mode_factor,'hintDeduction',hint_deduction,'total',total
  );
end;
$$;

create or replace function public.apply_answer_appeal(target_appeal_id uuid, target_verdict jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_appeal public.answer_appeals%rowtype;
  target_submission public.submissions%rowtype;
  target_question public.questions%rowtype;
  target_match public.matches%rowtype;
  settings jsonb;
  accepted boolean;
  confidence numeric;
  new_score jsonb;
  new_points integer := 0;
  delta integer := 0;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(target_verdict) <> 'object' then raise exception 'Appeal verdict is invalid'; end if;
  select * into target_appeal from public.answer_appeals where id = target_appeal_id for update;
  if target_appeal.id is null then raise exception 'Appeal not found'; end if;
  if target_appeal.status in ('accepted','rejected') then return coalesce(target_appeal.reviewed_verdict, '{}'::jsonb); end if;
  select * into target_submission from public.submissions where id = target_appeal.submission_id for update;
  select * into target_question from public.questions where id = target_submission.question_id;
  select * into target_match from public.matches where id = target_submission.match_id for update;
  accepted := coalesce((target_verdict ->> 'equivalent')::boolean, false);
  confidence := greatest(0, least(1, coalesce((target_verdict ->> 'confidence')::numeric, 0)));
  accepted := accepted and confidence >= 0.86 and not target_submission.timed_out;

  if accepted and not target_submission.is_correct then
    settings := private.game_settings(target_match.blueprint);
    new_score := private.score_engine_v3(
      target_question.mode, target_question.difficulty, 100,
      least(target_submission.response_ms, target_question.time_limit * 1000), target_question.time_limit * 1000,
      0, target_submission.hints_used, coalesce((settings ->> 'hintPenalty')::integer, 20),
      coalesce((settings ->> 'speedScoring')::boolean, true), false
    );
    new_points := coalesce((new_score ->> 'total')::integer, 0);
    delta := new_points - target_submission.points;
    update public.submissions
    set is_correct = true, match_type = 'semantic_appeal', matched_answer = target_verdict ->> 'matchedMeaning',
        points = new_points, score_components = new_score, verdict_confidence = confidence
    where id = target_submission.id;
    update public.match_players
    set score = greatest(0, score + delta),
        correct_count = correct_count + 1,
        incorrect_count = greatest(0, incorrect_count - 1)
    where match_id = target_submission.match_id and user_id = target_submission.user_id;
    update public.learning_errors set resolved_at = clock_timestamp(), correction_note = target_verdict ->> 'explanationVi'
    where submission_id = target_submission.id;
  end if;

  update public.answer_appeals
  set status = case when accepted then 'accepted' else 'rejected' end,
      reviewed_verdict = target_verdict,
      reviewer_provider = coalesce(target_verdict ->> 'provider', 'gemini'),
      reviewer_model = target_verdict ->> 'model',
      score_delta = delta,
      explanation_vi = left(coalesce(target_verdict ->> 'explanationVi', ''), 1000),
      reviewed_at = clock_timestamp()
  where id = target_appeal.id;
  return target_verdict || jsonb_build_object('accepted', accepted, 'scoreDelta', delta, 'newPoints', new_points);
end;
$$;

revoke execute on function public.apply_answer_appeal(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_answer_appeal(uuid, jsonb) to service_role;

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
  existing public.submissions%rowtype;
  settings jsonb;
  strictness text;
  normalized text;
  correct boolean := false;
  scored_correct boolean := false;
  within_time boolean := false;
  elapsed_ms integer;
  player_streak integer := 0;
  best_quality integer := 0;
  accepted_value text;
  accepted_quality integer;
  matched_value text;
  grading_type text := 'incorrect';
  hint_count integer := 0;
  hint_penalty integer := 0;
  score jsonb := '{}'::jsonb;
  awarded_points integer := 0;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(submitted_answer), '') is null then raise exception 'Answer is required'; end if;
  if char_length(submitted_answer) > 1500 then raise exception 'Answer is too long'; end if;

  select * into q from public.questions where id = target_question_id;
  if q.id is null then raise exception 'Question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if q.mode in ('PRONUNCIATION','SHADOWING','SPEAKING','ROLEPLAY','DEBATE','WRITING') then
    raise exception 'This answer must be graded through its rubric endpoint';
  end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = current_user_id) then
    raise exception 'Not a match player';
  end if;

  select * into existing from public.submissions where question_id = q.id and user_id = current_user_id;
  if existing.id is not null then
    return jsonb_build_object('submissionId', existing.id, 'correct', existing.is_correct, 'points', existing.points, 'alreadySubmitted', true);
  end if;
  if m.round_started_at is null or clock_timestamp() < m.round_started_at then raise exception 'Round has not started yet'; end if;
  select * into secret from public.question_answers where question_id = q.id;
  if secret.question_id is null then raise exception 'Question answer is unavailable'; end if;

  settings := private.game_settings(m.blueprint);
  strictness := settings ->> 'strictness';
  normalized := private.normalize_game_answer(submitted_answer);
  for accepted_value in select jsonb_array_elements_text(secret.accepted_answers) loop
    accepted_quality := private.answer_match_quality(submitted_answer, accepted_value);
    if accepted_quality > best_quality then
      best_quality := accepted_quality;
      matched_value := accepted_value;
    end if;
  end loop;
  correct := case when strictness = 'STRICT' then best_quality = 100 else best_quality >= 75 end
    and submitted_answer <> '⏱ Hết giờ';
  grading_type := case when best_quality = 100 then 'accepted' when correct then 'minor_typo' else 'incorrect' end;

  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  within_time := clock_timestamp() <= coalesce(m.round_deadline_at, m.round_started_at + make_interval(secs => q.time_limit)) + interval '750 milliseconds'
    and submitted_answer <> '⏱ Hết giờ';
  scored_correct := correct and within_time;
  select current_streak into player_streak from public.match_players where match_id = m.id and user_id = current_user_id;
  select count(*) into hint_count from public.match_hints where question_id = q.id and user_id = current_user_id;
  hint_penalty := coalesce((settings ->> 'hintPenalty')::integer, 20);
  score := private.score_engine_v3(
    q.mode, q.difficulty, case when scored_correct then best_quality else 0 end,
    least(elapsed_ms, q.time_limit * 1000), q.time_limit * 1000,
    coalesce(player_streak, 0) + case when scored_correct then 1 else 0 end,
    hint_count, hint_penalty,
    coalesce((settings ->> 'speedScoring')::boolean, true),
    coalesce((settings ->> 'streakBonus')::boolean, true)
  );
  awarded_points := coalesce((score ->> 'total')::integer, 0);

  insert into public.submissions (
    match_id, question_id, user_id, answer, normalized_answer, is_correct, timed_out,
    matched_answer, match_type, response_ms, points, hints_used, scoring_version,
    score_components, original_points, verdict_confidence
  ) values (
    m.id, q.id, current_user_id, submitted_answer, normalized, correct, not within_time,
    matched_value, grading_type, elapsed_ms, awarded_points, hint_count, 'v3', score,
    awarded_points, case when best_quality = 100 then 1 when best_quality >= 75 then 0.9 else 0.7 end
  ) returning * into existing;

  update public.match_players set
    score = score + awarded_points,
    current_streak = case when scored_correct then current_streak + 1 else 0 end,
    correct_count = correct_count + case when scored_correct then 1 else 0 end,
    incorrect_count = incorrect_count + case when scored_correct then 0 else 1 end,
    best_streak = greatest(best_streak, case when scored_correct then current_streak + 1 else current_streak end),
    avg_response_ms = round(((coalesce(avg_response_ms, 0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1))
  where match_id = m.id and user_id = current_user_id;

  if (select count(*) from public.submissions where question_id = q.id)
     = (select count(*) from public.match_players where match_id = m.id) then
    update public.rooms set status = 'ROUND_RESULT', state_version = state_version + 1, last_activity_at = clock_timestamp()
    where id = m.room_id;
  end if;

  return jsonb_build_object(
    'submissionId', existing.id, 'correct', correct, 'timedOut', not within_time,
    'matchType', grading_type, 'matchedAnswer', matched_value, 'points', awarded_points,
    'responseMs', elapsed_ms, 'hintsUsed', hint_count, 'scoreComponents', score,
    'alreadySubmitted', false
  );
end;
$$;

revoke execute on function public.submit_answer(uuid, text) from public, anon;
grant execute on function public.submit_answer(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- FSRS cards, error notebook and adaptive study plans
-- ---------------------------------------------------------------------------

create table if not exists public.fsrs_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  algorithm_version text not null default 'FSRS-6',
  desired_retention numeric(4,3) not null default 0.90 check (desired_retention between 0.70 and 0.99),
  parameters jsonb not null,
  maximum_interval integer not null default 36500 check (maximum_interval between 30 and 36500),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(parameters) = 'array')
);

create table if not exists public.review_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null check (source_type in ('match_question','learning_content','error_notebook','manual')),
  source_id uuid,
  card_key text not null,
  skill text not null,
  front jsonb not null,
  back jsonb not null,
  due_at timestamptz not null default now(),
  stability numeric(12,6) not null default 0,
  difficulty numeric(8,6) not null default 0,
  elapsed_days integer not null default 0,
  scheduled_days integer not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  learning_steps integer not null default 0,
  state integer not null default 0 check (state between 0 and 3),
  last_review_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, card_key),
  check (jsonb_typeof(front) = 'object'),
  check (jsonb_typeof(back) = 'object')
);

create table if not exists public.review_logs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  card_id uuid not null references public.review_cards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 4),
  state integer not null check (state between 0 and 3),
  due_at timestamptz not null,
  stability numeric(12,6) not null,
  difficulty numeric(8,6) not null,
  elapsed_days integer not null,
  last_elapsed_days integer not null,
  scheduled_days integer not null,
  reviewed_at timestamptz not null default now(),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  unique (user_id, request_id)
);

create table if not exists public.learning_errors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  question_id uuid references public.questions(id) on delete set null,
  submission_id uuid references public.submissions(id) on delete set null,
  error_type text not null,
  skill text not null,
  prompt text not null,
  learner_answer text not null,
  expected_answer text not null,
  explanation text,
  correction_note text,
  occurrence_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, question_id)
);

create table if not exists public.study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  cefr_start text,
  cefr_target text,
  status text not null default 'active' check (status in ('draft','active','completed','archived')),
  rationale_vi text not null,
  weekly_minutes integer not null check (weekly_minutes between 30 and 2100),
  evidence_snapshot jsonb not null,
  provider text,
  model text,
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.study_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans(id) on delete cascade,
  sequence_number integer not null,
  skill text not null,
  activity_type text not null,
  title text not null,
  objective text not null,
  target_minutes integer not null check (target_minutes between 5 and 180),
  target_count integer,
  source_filters jsonb not null default '{}'::jsonb,
  due_on date,
  completed_at timestamptz,
  unique (plan_id, sequence_number)
);

create index if not exists review_cards_due_idx on public.review_cards(user_id, due_at) where suspended_at is null;
create index if not exists review_logs_user_time_idx on public.review_logs(user_id, reviewed_at desc);
create index if not exists learning_errors_user_idx on public.learning_errors(user_id, resolved_at, last_seen_at desc);
create index if not exists study_plans_user_idx on public.study_plans(user_id, created_at desc);

alter table public.fsrs_profiles enable row level security;
alter table public.review_cards enable row level security;
alter table public.review_logs enable row level security;
alter table public.learning_errors enable row level security;
alter table public.study_plans enable row level security;
alter table public.study_plan_items enable row level security;

drop policy if exists "users manage own fsrs profile" on public.fsrs_profiles;
create policy "users manage own fsrs profile" on public.fsrs_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "users read own review cards" on public.review_cards;
create policy "users read own review cards" on public.review_cards for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users update own review cards" on public.review_cards;
create policy "users update own review cards" on public.review_cards for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "users read own review logs" on public.review_logs;
create policy "users read own review logs" on public.review_logs for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users create own review logs" on public.review_logs;
create policy "users create own review logs" on public.review_logs for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "users read own errors" on public.learning_errors;
create policy "users read own errors" on public.learning_errors for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users update own errors" on public.learning_errors;
create policy "users update own errors" on public.learning_errors for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "users read own plans" on public.study_plans;
create policy "users read own plans" on public.study_plans for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users read own plan items" on public.study_plan_items;
create policy "users read own plan items" on public.study_plan_items for select to authenticated
  using (exists (select 1 from public.study_plans p where p.id = plan_id and p.user_id = (select auth.uid())));
drop policy if exists "users update own plan items" on public.study_plan_items;
create policy "users update own plan items" on public.study_plan_items for update to authenticated
  using (exists (select 1 from public.study_plans p where p.id = plan_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.study_plans p where p.id = plan_id and p.user_id = (select auth.uid())));

revoke all on table public.fsrs_profiles, public.review_cards, public.review_logs, public.learning_errors, public.study_plans, public.study_plan_items from anon;
grant select, insert, update on table public.fsrs_profiles to authenticated;
grant select, update on table public.review_cards to authenticated;
grant select, insert on table public.review_logs to authenticated;
grant select, update on table public.learning_errors to authenticated;
grant select on table public.study_plans to authenticated;
grant select, update on table public.study_plan_items to authenticated;

create or replace function public.record_fsrs_review(
  target_card_id uuid,
  target_request_id uuid,
  target_rating integer,
  target_card jsonb,
  target_log jsonb,
  target_duration_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_log public.review_logs%rowtype;
  current_card public.review_cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if target_request_id is null or target_rating not between 1 and 4 then raise exception 'Invalid review request'; end if;
  select * into existing_log from public.review_logs where user_id = current_user_id and request_id = target_request_id;
  if existing_log.id is not null then return jsonb_build_object('reviewLogId', existing_log.id, 'alreadyRecorded', true); end if;
  select * into current_card from public.review_cards where id = target_card_id and user_id = current_user_id for update;
  if current_card.id is null then raise exception 'Review card not found'; end if;

  update public.review_cards set
    due_at = (target_card ->> 'due')::timestamptz,
    stability = (target_card ->> 'stability')::numeric,
    difficulty = (target_card ->> 'difficulty')::numeric,
    elapsed_days = (target_card ->> 'elapsed_days')::integer,
    scheduled_days = (target_card ->> 'scheduled_days')::integer,
    reps = (target_card ->> 'reps')::integer,
    lapses = (target_card ->> 'lapses')::integer,
    learning_steps = (target_card ->> 'learning_steps')::integer,
    state = (target_card ->> 'state')::integer,
    last_review_at = nullif(target_card ->> 'last_review', '')::timestamptz,
    updated_at = clock_timestamp()
  where id = current_card.id;

  insert into public.review_logs(
    request_id, card_id, user_id, rating, state, due_at, stability, difficulty,
    elapsed_days, last_elapsed_days, scheduled_days, reviewed_at, duration_ms
  ) values (
    target_request_id, current_card.id, current_user_id, target_rating,
    (target_log ->> 'state')::integer, (target_log ->> 'due')::timestamptz,
    (target_log ->> 'stability')::numeric, (target_log ->> 'difficulty')::numeric,
    (target_log ->> 'elapsed_days')::integer, (target_log ->> 'last_elapsed_days')::integer,
    (target_log ->> 'scheduled_days')::integer, (target_log ->> 'review')::timestamptz,
    target_duration_ms
  ) returning * into existing_log;
  return jsonb_build_object('reviewLogId', existing_log.id, 'alreadyRecorded', false, 'dueAt', target_card ->> 'due');
end;
$$;

revoke execute on function public.record_fsrs_review(uuid, uuid, integer, jsonb, jsonb, integer) from public, anon;
grant execute on function public.record_fsrs_review(uuid, uuid, integer, jsonb, jsonb, integer) to authenticated;

create or replace function private.capture_learning_after_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_question public.questions%rowtype;
  target_answer public.question_answers%rowtype;
  target_skill text;
  target_key text;
begin
  if coalesce((select allow_learning_analytics from public.privacy_preferences where user_id = new.user_id), true) = false then
    return new;
  end if;
  select * into target_question from public.questions where id = new.question_id;
  select * into target_answer from public.question_answers where question_id = new.question_id;
  if target_question.id is null or target_answer.question_id is null then return new; end if;

  target_skill := case
    when target_question.mode in ('LISTENING','SPELLING','MINIMAL_PAIRS','AUDIO_CHOICE','STORY_LISTENING','SHADOWING') then 'listening'
    when target_question.mode in ('PRONUNCIATION','SPEAKING','ROLEPLAY','DEBATE') then 'speaking'
    when target_question.mode in ('READING','CLOZE') then 'reading'
    when target_question.mode in ('WRITING','ERROR_CORRECTION','SENTENCE_BUILDER','GRAMMAR') then 'writing'
    else 'vocabulary'
  end;
  target_key := encode(digest(target_question.id::text || ':' || target_skill, 'sha256'), 'hex');

  insert into public.review_cards(user_id, source_type, source_id, card_key, skill, front, back, due_at)
  values (
    new.user_id, 'match_question', target_question.id, target_key, target_skill,
    jsonb_build_object('prompt', target_question.prompt, 'instruction', target_question.instruction, 'mode', target_question.mode),
    jsonb_build_object('answer', target_answer.canonical_answer, 'acceptedAnswers', target_answer.accepted_answers, 'explanation', target_answer.explanation),
    case when new.is_correct and not new.timed_out then clock_timestamp() + interval '1 day' else clock_timestamp() end
  )
  on conflict (user_id, card_key) do update
  set front = excluded.front, back = excluded.back,
      due_at = least(public.review_cards.due_at, excluded.due_at), updated_at = clock_timestamp();

  if not new.is_correct or new.timed_out then
    insert into public.learning_errors(
      user_id, match_id, question_id, submission_id, error_type, skill,
      prompt, learner_answer, expected_answer, explanation
    ) values (
      new.user_id, new.match_id, new.question_id, new.id,
      case when new.timed_out then 'timeout' when new.match_type = 'incorrect' then 'incorrect_answer' else coalesce(new.match_type, 'incorrect_answer') end,
      target_skill, target_question.prompt, new.answer, target_answer.canonical_answer, target_answer.explanation
    )
    on conflict (user_id, question_id) do update
    set submission_id = excluded.submission_id,
        learner_answer = excluded.learner_answer,
        expected_answer = excluded.expected_answer,
        explanation = excluded.explanation,
        occurrence_count = public.learning_errors.occurrence_count + 1,
        last_seen_at = clock_timestamp(),
        resolved_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists capture_learning_after_submission on public.submissions;
create trigger capture_learning_after_submission
after insert on public.submissions
for each row execute function private.capture_learning_after_submission();

-- ---------------------------------------------------------------------------
-- Multi-turn speaking and detailed pronunciation evidence
-- ---------------------------------------------------------------------------

create table if not exists public.speaking_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete set null,
  match_id uuid references public.matches(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  scenario_type text not null check (scenario_type in ('roleplay','interview','debate','storytelling','problem_solving','free_conversation')),
  title text not null,
  scenario jsonb not null,
  cefr_level text not null,
  status text not null default 'ready' check (status in ('draft','ready','active','completed','cancelled')),
  max_turns integer not null default 8 check (max_turns between 2 and 30),
  current_turn integer not null default 0,
  provider text,
  model text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.speaking_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.speaking_sessions(id) on delete cascade,
  turn_number integer not null,
  speaker_type text not null check (speaker_type in ('learner','peer','ai')),
  speaker_id uuid references public.profiles(id) on delete set null,
  transcript text not null,
  prompt_context jsonb not null default '{}'::jsonb,
  assessment jsonb,
  request_id uuid,
  started_at timestamptz,
  completed_at timestamptz not null default now(),
  unique (session_id, turn_number)
);

alter table public.speaking_turns add column if not exists request_id uuid;

create unique index if not exists speaking_turns_request_idx
  on public.speaking_turns(session_id, request_id)
  where request_id is not null;

create table if not exists public.speaking_turn_audio_assets (
  turn_id uuid primary key references public.speaking_turns(id) on delete cascade,
  content_hash text not null,
  provider text not null,
  model text not null,
  voice text not null,
  storage_bucket text not null default 'question-audio',
  storage_path text,
  mime_type text,
  byte_size integer,
  status text not null default 'generating' check (status in ('generating','ready','failed')),
  error_message text,
  updated_at timestamptz not null default now()
);

create table if not exists public.pronunciation_feedback (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  transcript text not null,
  target_text text,
  intelligibility_score numeric(5,2) not null check (intelligibility_score between 0 and 100),
  segmental_score numeric(5,2) not null check (segmental_score between 0 and 100),
  word_stress_score numeric(5,2) not null check (word_stress_score between 0 and 100),
  rhythm_score numeric(5,2) not null check (rhythm_score between 0 and 100),
  intonation_score numeric(5,2) not null check (intonation_score between 0 and 100),
  fluency_score numeric(5,2) not null check (fluency_score between 0 and 100),
  word_feedback jsonb not null default '[]'::jsonb,
  phoneme_feedback jsonb not null default '[]'::jsonb,
  practice_drills jsonb not null default '[]'::jsonb,
  provider text not null,
  model text not null,
  created_at timestamptz not null default now(),
  unique (submission_id),
  check (jsonb_typeof(word_feedback) = 'array'),
  check (jsonb_typeof(phoneme_feedback) = 'array'),
  check (jsonb_typeof(practice_drills) = 'array')
);

create index if not exists speaking_sessions_room_idx on public.speaking_sessions(room_id, created_at desc);
create index if not exists speaking_turns_session_idx on public.speaking_turns(session_id, turn_number);
create index if not exists pronunciation_feedback_user_idx on public.pronunciation_feedback(user_id, created_at desc);

alter table public.speaking_sessions enable row level security;
alter table public.speaking_turns enable row level security;
alter table public.pronunciation_feedback enable row level security;
alter table public.speaking_turn_audio_assets enable row level security;
drop policy if exists "room members read speaking sessions" on public.speaking_sessions;
create policy "room members read speaking sessions" on public.speaking_sessions for select to authenticated
  using (created_by = (select auth.uid()) or (room_id is not null and private.is_room_member(room_id)));
drop policy if exists "room members read speaking turns" on public.speaking_turns;
create policy "room members read speaking turns" on public.speaking_turns for select to authenticated
  using (exists (
    select 1 from public.speaking_sessions s
    where s.id = session_id and (s.created_by = (select auth.uid()) or (s.room_id is not null and private.is_room_member(s.room_id)))
  ));
drop policy if exists "users read own pronunciation feedback" on public.pronunciation_feedback;
create policy "users read own pronunciation feedback" on public.pronunciation_feedback for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "session members read speaking audio metadata" on public.speaking_turn_audio_assets;
create policy "session members read speaking audio metadata" on public.speaking_turn_audio_assets for select to authenticated
  using (exists (
    select 1 from public.speaking_turns t
    join public.speaking_sessions s on s.id = t.session_id
    where t.id = turn_id and (s.created_by = (select auth.uid()) or (s.room_id is not null and private.is_room_member(s.room_id)))
  ));
revoke all on table public.speaking_sessions, public.speaking_turns, public.pronunciation_feedback from anon;
revoke all on table public.speaking_turn_audio_assets from anon;
revoke insert, update, delete on table public.speaking_sessions, public.speaking_turns, public.pronunciation_feedback from authenticated;
revoke insert, update, delete on table public.speaking_turn_audio_assets from authenticated;
grant select on table public.speaking_sessions, public.speaking_turns, public.pronunciation_feedback to authenticated;
grant select on table public.speaking_turn_audio_assets to authenticated;

create or replace function public.record_speaking_exchange(
  target_session_id uuid,
  target_user_id uuid,
  target_request_id uuid,
  learner_transcript text,
  learner_assessment jsonb,
  ai_transcript text,
  ai_context jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.speaking_sessions%rowtype;
  learner_row public.speaking_turns%rowtype;
  ai_row public.speaking_turns%rowtype;
  next_status text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into session_row from public.speaking_sessions where id = target_session_id for update;
  if session_row.id is null then raise exception 'Speaking session not found'; end if;
  if session_row.created_by <> target_user_id and not exists (
    select 1 from public.room_members where room_id = session_row.room_id and user_id = target_user_id
  ) then raise exception 'Not a speaking session member'; end if;

  select * into learner_row from public.speaking_turns
  where session_id = target_session_id and request_id = target_request_id;
  if learner_row.id is not null then
    select * into ai_row from public.speaking_turns
    where session_id = target_session_id and turn_number = learner_row.turn_number + 1;
    return jsonb_build_object('replayed', true, 'learnerTurn', to_jsonb(learner_row), 'aiTurn', to_jsonb(ai_row), 'status', session_row.status);
  end if;

  if session_row.status not in ('ready','active') then raise exception 'Speaking session is not active'; end if;
  if session_row.current_turn + 2 > session_row.max_turns then raise exception 'Speaking session has reached its turn limit'; end if;
  if char_length(trim(learner_transcript)) = 0 or char_length(trim(ai_transcript)) = 0 then raise exception 'Transcripts cannot be empty'; end if;

  insert into public.speaking_turns(session_id, turn_number, speaker_type, speaker_id, transcript, assessment, request_id)
  values (target_session_id, session_row.current_turn + 1, 'learner', target_user_id, learner_transcript, learner_assessment, target_request_id)
  returning * into learner_row;
  insert into public.speaking_turns(session_id, turn_number, speaker_type, transcript, prompt_context)
  values (target_session_id, session_row.current_turn + 2, 'ai', ai_transcript, coalesce(ai_context, '{}'::jsonb))
  returning * into ai_row;

  next_status := case when session_row.current_turn + 2 >= session_row.max_turns then 'completed' else 'active' end;
  update public.speaking_sessions set
    status = next_status,
    current_turn = session_row.current_turn + 2,
    started_at = coalesce(started_at, clock_timestamp()),
    completed_at = case when next_status = 'completed' then clock_timestamp() else null end
  where id = target_session_id;
  return jsonb_build_object('replayed', false, 'learnerTurn', to_jsonb(learner_row), 'aiTurn', to_jsonb(ai_row), 'status', next_status);
end;
$$;

revoke execute on function public.record_speaking_exchange(uuid, uuid, uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_speaking_exchange(uuid, uuid, uuid, text, jsonb, text, jsonb) to service_role;
