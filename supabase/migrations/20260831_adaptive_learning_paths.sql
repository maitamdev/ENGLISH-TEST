-- LexiDuel adaptive learning paths and evidence layer.
-- Run after 20260830_production_verification.sql. This migration creates no
-- curriculum descriptors, placement fixtures, goals, notifications or sample rows.

-- ---------------------------------------------------------------------------
-- CEFR curriculum provenance. Framework data is imported and moderated through
-- the platform admin API; nothing is copied or seeded by this migration.
-- ---------------------------------------------------------------------------

create table if not exists public.curriculum_frameworks (
  id uuid primary key default gen_random_uuid(),
  framework_key text not null unique,
  display_name text not null,
  publisher text not null,
  source_url text not null,
  license_id text not null,
  license_url text not null,
  attribution_text text not null,
  version_label text,
  provenance jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(provenance) = 'object')
);

create table if not exists public.curriculum_descriptors (
  id uuid primary key default gen_random_uuid(),
  framework_id uuid not null references public.curriculum_frameworks(id) on delete cascade,
  external_id text not null,
  cefr_level text not null check (cefr_level in ('Pre-A1','A1','A2','B1','B2','C1','C2')),
  skill text not null check (skill in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction')),
  descriptor_text text not null check (char_length(descriptor_text) between 10 and 2000),
  descriptor_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  moderation_status text not null default 'pending' check (moderation_status in ('pending','approved','rejected','quarantined')),
  moderation_note text,
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(framework_id, external_id),
  unique(framework_id, descriptor_hash),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.curriculum_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  descriptor_id uuid not null references public.curriculum_descriptors(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('approve','reject','quarantine','restore')),
  previous_status text,
  next_status text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists curriculum_descriptor_lookup_idx on public.curriculum_descriptors(skill, cefr_level, moderation_status);
alter table public.curriculum_frameworks enable row level security;
alter table public.curriculum_descriptors enable row level security;
alter table public.curriculum_moderation_actions enable row level security;
drop policy if exists "learners read approved curriculum provenance" on public.curriculum_frameworks;
create policy "learners read approved curriculum provenance" on public.curriculum_frameworks for select to authenticated using (enabled);
drop policy if exists "learners read approved curriculum descriptors" on public.curriculum_descriptors;
create policy "learners read approved curriculum descriptors" on public.curriculum_descriptors for select to authenticated using (
  moderation_status = 'approved' and exists (select 1 from public.curriculum_frameworks f where f.id = framework_id and f.enabled)
);
revoke all on table public.curriculum_frameworks, public.curriculum_descriptors, public.curriculum_moderation_actions from anon;
revoke insert, update, delete on table public.curriculum_frameworks, public.curriculum_descriptors, public.curriculum_moderation_actions from authenticated;
grant select on table public.curriculum_frameworks, public.curriculum_descriptors to authenticated;

-- ---------------------------------------------------------------------------
-- Evidence graph. Alpha/beta encode a conservative Bayesian mastery estimate;
-- every update is tied to an immutable real activity id.
-- ---------------------------------------------------------------------------

create table if not exists public.skill_evidence_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null check (skill in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction')),
  cefr_level text not null,
  score numeric(6,5) not null check (score between 0 and 1),
  source_type text not null check (source_type in ('match_submission','fsrs_review','speaking_turn','placement_response','manual_verification')),
  source_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique(user_id, source_type, source_id, skill),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.learner_skill_mastery (
  user_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null check (skill in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction')),
  alpha numeric(14,6) not null default 1,
  beta numeric(14,6) not null default 1,
  mastery_score numeric(5,2) not null default 50 check (mastery_score between 0 and 100),
  confidence numeric(6,5) not null default 0 check (confidence between 0 and 1),
  evidence_count integer not null default 0,
  cefr_evidence jsonb not null default '{}'::jsonb,
  latest_score numeric(6,5),
  last_evidence_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(user_id, skill),
  check (jsonb_typeof(cefr_evidence) = 'object')
);

create index if not exists skill_evidence_user_time_idx on public.skill_evidence_events(user_id, occurred_at desc);
alter table public.skill_evidence_events enable row level security;
alter table public.learner_skill_mastery enable row level security;
drop policy if exists "users read own skill evidence" on public.skill_evidence_events;
create policy "users read own skill evidence" on public.skill_evidence_events for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users read own mastery" on public.learner_skill_mastery;
create policy "users read own mastery" on public.learner_skill_mastery for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.skill_evidence_events, public.learner_skill_mastery from anon;
revoke insert, update, delete on table public.skill_evidence_events, public.learner_skill_mastery from authenticated;
grant select on table public.skill_evidence_events, public.learner_skill_mastery to authenticated;

create or replace function public.record_skill_evidence(
  target_user_id uuid,
  target_skill text,
  target_cefr text,
  target_score numeric,
  target_source_type text,
  target_source_id uuid,
  target_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  mastery public.learner_skill_mastery%rowtype;
  safe_score numeric := greatest(0, least(1, target_score));
  level_key text := coalesce(nullif(trim(target_cefr),''), 'Mixed');
begin
  if target_skill not in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction') then raise exception 'Unsupported learning skill'; end if;
  if target_source_id is null or target_user_id is null then raise exception 'Evidence identity is required'; end if;
  if jsonb_typeof(coalesce(target_metadata, '{}'::jsonb)) <> 'object' then raise exception 'Evidence metadata must be an object'; end if;
  if coalesce((select allow_learning_analytics from public.privacy_preferences where user_id = target_user_id), true) = false then
    return jsonb_build_object('recorded', false, 'reason', 'learning_analytics_disabled');
  end if;

  insert into public.skill_evidence_events(user_id, skill, cefr_level, score, source_type, source_id, metadata)
  values(target_user_id, target_skill, level_key, safe_score, target_source_type, target_source_id, coalesce(target_metadata, '{}'::jsonb))
  on conflict (user_id, source_type, source_id, skill) do nothing
  returning id into inserted_id;
  if inserted_id is null then
    select * into mastery from public.learner_skill_mastery where user_id = target_user_id and skill = target_skill;
    return jsonb_build_object('recorded', false, 'mastery', to_jsonb(mastery));
  end if;

  insert into public.learner_skill_mastery(user_id, skill, alpha, beta, mastery_score, confidence, evidence_count, cefr_evidence, latest_score, last_evidence_at)
  values(target_user_id, target_skill, 1 + safe_score, 2 - safe_score, round(100 * (1 + safe_score) / 3, 2), 1 - exp(-1::numeric / 8), 1, jsonb_build_object(level_key, 1), safe_score, now())
  on conflict (user_id, skill) do update set
    alpha = learner_skill_mastery.alpha + safe_score,
    beta = learner_skill_mastery.beta + (1 - safe_score),
    mastery_score = round(100 * (learner_skill_mastery.alpha + safe_score) / (learner_skill_mastery.alpha + learner_skill_mastery.beta + 1), 2),
    confidence = least(0.99999, 1 - exp(-(learner_skill_mastery.evidence_count + 1)::numeric / 8)),
    evidence_count = learner_skill_mastery.evidence_count + 1,
    cefr_evidence = jsonb_set(learner_skill_mastery.cefr_evidence, array[level_key], to_jsonb(coalesce((learner_skill_mastery.cefr_evidence ->> level_key)::integer, 0) + 1), true),
    latest_score = safe_score,
    last_evidence_at = now(),
    updated_at = now()
  returning * into mastery;
  return jsonb_build_object('recorded', true, 'mastery', to_jsonb(mastery));
end;
$$;

revoke execute on function public.record_skill_evidence(uuid,text,text,numeric,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.record_skill_evidence(uuid,text,text,numeric,text,uuid,jsonb) to service_role;

create or replace function private.skill_from_question_mode(value text)
returns text language sql immutable set search_path = '' as $$
  select case
    when value in ('LISTENING','SPELLING','MINIMAL_PAIRS','AUDIO_CHOICE','STORY_LISTENING','SHADOWING') then 'listening'
    when value in ('READING','MULTIPLE_CHOICE','CONTEXT','DEFINITION') then 'reading'
    when value in ('GRAMMAR','SENTENCE_BUILDER','CLOZE','ERROR_CORRECTION','COLLOCATION') then 'grammar'
    when value in ('WRITING','TRANSLATION') then 'writing'
    when value in ('PRONUNCIATION') then 'phonology'
    when value in ('SPEAKING','ROLEPLAY','DEBATE') then 'speaking'
    else 'vocabulary'
  end;
$$;

create or replace function private.capture_mastery_after_submission()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare q public.questions%rowtype; evidence_score numeric;
begin
  select * into q from public.questions where id = new.question_id;
  evidence_score := coalesce(new.rubric_score / 100, case when new.is_correct then 1 else 0 end);
  perform public.record_skill_evidence(new.user_id, private.skill_from_question_mode(q.mode), q.level, evidence_score, 'match_submission', new.id,
    jsonb_build_object('matchId', new.match_id, 'questionId', new.question_id, 'mode', q.mode, 'responseMs', new.response_ms, 'timedOut', new.timed_out));
  return new;
end;
$$;
drop trigger if exists submissions_capture_mastery on public.submissions;
create trigger submissions_capture_mastery after insert on public.submissions for each row execute function private.capture_mastery_after_submission();

create or replace function private.capture_mastery_after_review()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare card public.review_cards%rowtype; evidence_score numeric;
begin
  select * into card from public.review_cards where id = new.card_id;
  evidence_score := case new.rating when 1 then 0 when 2 then 0.45 when 3 then 0.8 else 1 end;
  perform public.record_skill_evidence(new.user_id,
    case when card.skill in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction') then card.skill else 'vocabulary' end,
    coalesce(card.front ->> 'level','Mixed'), evidence_score, 'fsrs_review', new.id,
    jsonb_build_object('cardId', new.card_id, 'rating', new.rating, 'durationMs', new.duration_ms));
  return new;
end;
$$;
drop trigger if exists review_logs_capture_mastery on public.review_logs;
create trigger review_logs_capture_mastery after insert on public.review_logs for each row execute function private.capture_mastery_after_review();

create or replace function private.capture_mastery_after_speaking_turn()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare session_row public.speaking_sessions%rowtype; overall numeric; phonology numeric;
begin
  if new.speaker_type <> 'learner' or new.speaker_id is null or new.assessment is null or jsonb_typeof(new.assessment) <> 'object' then return new; end if;
  select * into session_row from public.speaking_sessions where id = new.session_id;
  overall := greatest(0, least(1, coalesce((new.assessment ->> 'overall')::numeric, 0) / 100));
  phonology := greatest(0, least(1, coalesce((new.assessment ->> 'pronunciation')::numeric, overall * 100) / 100));
  perform public.record_skill_evidence(new.speaker_id, 'speaking', session_row.cefr_level, overall, 'speaking_turn', new.id, jsonb_build_object('sessionId', new.session_id));
  perform public.record_skill_evidence(new.speaker_id, 'phonology', session_row.cefr_level, phonology, 'speaking_turn', new.id, jsonb_build_object('sessionId', new.session_id));
  return new;
end;
$$;
drop trigger if exists speaking_turns_capture_mastery on public.speaking_turns;
create trigger speaking_turns_capture_mastery after insert on public.speaking_turns for each row execute function private.capture_mastery_after_speaking_turn();

-- Backfill every eligible historical activity already stored by real learners.
-- These set-based inserts are idempotent and skip users who disabled analytics.
insert into public.skill_evidence_events(user_id, skill, cefr_level, score, source_type, source_id, metadata, occurred_at)
select s.user_id, private.skill_from_question_mode(q.mode), coalesce(nullif(q.level,''), 'Mixed'),
  greatest(0, least(1, coalesce(s.rubric_score / 100, case when s.is_correct then 1 else 0 end))),
  'match_submission', s.id,
  jsonb_build_object('matchId', s.match_id, 'questionId', s.question_id, 'mode', q.mode, 'responseMs', s.response_ms, 'timedOut', s.timed_out, 'backfilled', true),
  s.server_received_at
from public.submissions s
join public.questions q on q.id = s.question_id
left join public.privacy_preferences pp on pp.user_id = s.user_id
where coalesce(pp.allow_learning_analytics, true)
on conflict (user_id, source_type, source_id, skill) do nothing;

insert into public.skill_evidence_events(user_id, skill, cefr_level, score, source_type, source_id, metadata, occurred_at)
select l.user_id,
  case when c.skill in ('vocabulary','grammar','reading','listening','writing','speaking','spoken_interaction','mediation','phonology','online_interaction') then c.skill else 'vocabulary' end,
  coalesce(nullif(c.front ->> 'level',''), 'Mixed'),
  case l.rating when 1 then 0 when 2 then 0.45 when 3 then 0.8 else 1 end,
  'fsrs_review', l.id,
  jsonb_build_object('cardId', l.card_id, 'rating', l.rating, 'durationMs', l.duration_ms, 'backfilled', true),
  l.reviewed_at
from public.review_logs l
join public.review_cards c on c.id = l.card_id
left join public.privacy_preferences pp on pp.user_id = l.user_id
where coalesce(pp.allow_learning_analytics, true)
on conflict (user_id, source_type, source_id, skill) do nothing;

insert into public.skill_evidence_events(user_id, skill, cefr_level, score, source_type, source_id, metadata, occurred_at)
select t.speaker_id, derived.skill, coalesce(nullif(s.cefr_level,''), 'Mixed'), derived.score,
  'speaking_turn', t.id, jsonb_build_object('sessionId', t.session_id, 'backfilled', true), t.completed_at
from public.speaking_turns t
join public.speaking_sessions s on s.id = t.session_id
cross join lateral (values
  ('speaking'::text, greatest(0, least(1, coalesce((t.assessment ->> 'overall')::numeric, 0) / 100))),
  ('phonology'::text, greatest(0, least(1, coalesce((t.assessment ->> 'pronunciation')::numeric, coalesce((t.assessment ->> 'overall')::numeric, 0)) / 100)))
) as derived(skill, score)
left join public.privacy_preferences pp on pp.user_id = t.speaker_id
where t.speaker_type = 'learner' and t.speaker_id is not null and t.assessment is not null
  and jsonb_typeof(t.assessment) = 'object' and coalesce(pp.allow_learning_analytics, true)
on conflict (user_id, source_type, source_id, skill) do nothing;

with level_counts as (
  select user_id, skill, cefr_level, count(*)::integer as evidence_count
  from public.skill_evidence_events group by user_id, skill, cefr_level
), level_objects as (
  select user_id, skill, jsonb_object_agg(cefr_level, evidence_count) as cefr_evidence
  from level_counts group by user_id, skill
), totals as (
  select e.user_id, e.skill, 1 + sum(e.score) as alpha, 1 + sum(1 - e.score) as beta,
    count(*)::integer as evidence_count, (array_agg(e.score order by e.occurred_at desc))[1] as latest_score,
    max(e.occurred_at) as last_evidence_at
  from public.skill_evidence_events e group by e.user_id, e.skill
)
insert into public.learner_skill_mastery(user_id, skill, alpha, beta, mastery_score, confidence, evidence_count, cefr_evidence, latest_score, last_evidence_at, updated_at)
select t.user_id, t.skill, t.alpha, t.beta, round(100 * t.alpha / (t.alpha + t.beta), 2),
  least(0.99999, 1 - exp(-t.evidence_count::numeric / 8)), t.evidence_count, l.cefr_evidence,
  t.latest_score, t.last_evidence_at, now()
from totals t join level_objects l using(user_id, skill)
on conflict (user_id, skill) do update set
  alpha = excluded.alpha, beta = excluded.beta, mastery_score = excluded.mastery_score,
  confidence = excluded.confidence, evidence_count = excluded.evidence_count,
  cefr_evidence = excluded.cefr_evidence, latest_score = excluded.latest_score,
  last_evidence_at = excluded.last_evidence_at, updated_at = excluded.updated_at;

-- ---------------------------------------------------------------------------
-- Adaptive diagnostic placement. Items and answer keys are API-only; learners
-- receive public item fields from authenticated route handlers.
-- ---------------------------------------------------------------------------

create table if not exists public.placement_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active','generating','completed','abandoned','failed')),
  ability_theta numeric(8,5) not null default 0,
  information numeric(10,6) not null default 0,
  standard_error numeric(8,5),
  confidence numeric(6,5) not null default 0,
  estimated_cefr text,
  response_count integer not null default 0,
  target_count integer not null default 18 check (target_count between 12 and 30),
  skill_cycle text[] not null default array['vocabulary','grammar','reading','listening'],
  current_item_id uuid,
  generation_token uuid,
  generation_started_at timestamptz,
  result jsonb,
  provider text,
  model text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (result is null or jsonb_typeof(result) = 'object')
);

create table if not exists public.placement_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.placement_sessions(id) on delete cascade,
  position integer not null check (position > 0),
  skill text not null,
  cefr_level text not null,
  difficulty_theta numeric(8,5) not null,
  prompt text not null,
  instruction text not null,
  public_payload jsonb not null default '{}'::jsonb,
  private_payload jsonb not null default '{}'::jsonb,
  canonical_answer text not null,
  accepted_answers jsonb not null,
  explanation text not null,
  curriculum_descriptor_id uuid references public.curriculum_descriptors(id) on delete set null,
  content_fingerprint text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  unique(session_id, position),
  unique(session_id, content_fingerprint),
  check (jsonb_typeof(public_payload) = 'object'),
  check (jsonb_typeof(private_payload) = 'object'),
  check (jsonb_typeof(accepted_answers) = 'array')
);
alter table public.placement_sessions drop constraint if exists placement_sessions_current_item_id_fkey;
alter table public.placement_sessions add constraint placement_sessions_current_item_id_fkey foreign key(current_item_id) references public.placement_items(id) on delete set null;

create table if not exists public.placement_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  session_id uuid not null references public.placement_sessions(id) on delete cascade,
  item_id uuid not null references public.placement_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  answer text not null,
  normalized_answer text not null,
  correct boolean not null,
  response_ms integer not null check (response_ms between 0 and 3600000),
  probability_before numeric(8,6) not null,
  theta_before numeric(8,5) not null,
  theta_after numeric(8,5) not null,
  information_after numeric(10,6) not null,
  created_at timestamptz not null default now(),
  unique(item_id, user_id),
  unique(user_id, request_id)
);

create index if not exists placement_sessions_user_idx on public.placement_sessions(user_id, started_at desc);
alter table public.placement_sessions enable row level security;
alter table public.placement_items enable row level security;
alter table public.placement_responses enable row level security;
drop policy if exists "users read own placement sessions" on public.placement_sessions;
create policy "users read own placement sessions" on public.placement_sessions for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "users read own placement responses" on public.placement_responses;
create policy "users read own placement responses" on public.placement_responses for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.placement_sessions, public.placement_items, public.placement_responses from anon;
revoke insert, update, delete on table public.placement_sessions, public.placement_items, public.placement_responses from authenticated;
revoke select on table public.placement_items from authenticated;
grant select on table public.placement_sessions, public.placement_responses to authenticated;

create or replace function public.submit_placement_response(
  target_session_id uuid,
  target_item_id uuid,
  target_request_id uuid,
  submitted_answer text,
  target_response_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  actor uuid := (select auth.uid());
  session_row public.placement_sessions%rowtype;
  item_row public.placement_items%rowtype;
  response_row public.placement_responses%rowtype;
  normalized text;
  accepted text;
  passed boolean := false;
  probability numeric;
  next_theta numeric;
  next_information numeric;
  next_sem numeric;
  next_confidence numeric;
  next_count integer;
  next_cefr text;
  completed boolean;
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if target_request_id is null or target_response_ms is null or target_response_ms < 0 or target_response_ms > 3600000
    or nullif(trim(submitted_answer),'') is null or char_length(submitted_answer) > 2000 then raise exception 'Invalid placement response'; end if;
  select * into response_row from public.placement_responses where user_id = actor and request_id = target_request_id;
  if response_row.id is not null then
    if response_row.session_id <> target_session_id or response_row.item_id <> target_item_id then raise exception 'Request id belongs to another placement response'; end if;
    select * into session_row from public.placement_sessions where id = response_row.session_id;
    select * into item_row from public.placement_items where id = response_row.item_id;
    return jsonb_build_object(
      'alreadyRecorded', true, 'responseId', response_row.id, 'correct', response_row.correct,
      'canonicalAnswer', item_row.canonical_answer, 'explanation', item_row.explanation,
      'session', to_jsonb(session_row)
    );
  end if;

  select * into session_row from public.placement_sessions where id = target_session_id and user_id = actor for update;
  if session_row.id is null or session_row.status not in ('active','generating') then raise exception 'Active placement session not found'; end if;
  if session_row.current_item_id is distinct from target_item_id then raise exception 'Placement item is no longer active'; end if;
  select * into item_row from public.placement_items where id = target_item_id and session_id = session_row.id;
  if item_row.id is null then raise exception 'Placement item not found'; end if;

  normalized := private.normalize_game_answer(submitted_answer);
  for accepted in select jsonb_array_elements_text(item_row.accepted_answers) loop
    if normalized = private.normalize_game_answer(accepted) then passed := true; exit; end if;
  end loop;
  probability := 1 / (1 + exp(-(session_row.ability_theta - item_row.difficulty_theta)));
  next_theta := greatest(-3, least(3, session_row.ability_theta + 0.75 * ((case when passed then 1 else 0 end) - probability)));
  next_information := session_row.information + probability * (1 - probability);
  next_sem := 1 / sqrt(greatest(next_information, 0.000001));
  next_confidence := least(0.99, 1 - exp(-next_information / 2));
  next_count := session_row.response_count + 1;
  next_cefr := case when next_theta < -2 then 'A1' when next_theta < -1 then 'A2' when next_theta < 0 then 'B1' when next_theta < 1 then 'B2' when next_theta < 2 then 'C1' else 'C2' end;
  completed := next_count >= session_row.target_count;

  insert into public.placement_responses(request_id, session_id, item_id, user_id, answer, normalized_answer, correct, response_ms, probability_before, theta_before, theta_after, information_after)
  values(target_request_id, session_row.id, item_row.id, actor, left(submitted_answer, 2000), normalized, passed, greatest(0, least(target_response_ms, 3600000)), probability, session_row.ability_theta, next_theta, next_information)
  returning * into response_row;

  update public.placement_sessions set
    status = case when completed then 'completed' else 'active' end,
    ability_theta = next_theta,
    information = next_information,
    standard_error = next_sem,
    confidence = next_confidence,
    estimated_cefr = next_cefr,
    response_count = next_count,
    current_item_id = null,
    generation_token = null,
    generation_started_at = null,
    result = case when completed then jsonb_build_object(
      'estimatedCefr', next_cefr, 'theta', next_theta, 'standardError', next_sem,
      'confidence', next_confidence, 'responses', next_count,
      'classification', 'diagnostic_estimate', 'officialCertification', false
    ) else result end,
    completed_at = case when completed then now() else completed_at end,
    updated_at = now()
  where id = session_row.id returning * into session_row;

  perform public.record_skill_evidence(actor, item_row.skill, item_row.cefr_level, case when passed then 1 else 0 end, 'placement_response', response_row.id,
    jsonb_build_object('sessionId', session_row.id, 'itemId', item_row.id, 'probabilityBefore', probability, 'responseMs', target_response_ms));
  if completed and coalesce((select allow_learning_analytics from public.privacy_preferences where user_id = actor), true) then
    update public.profiles set cefr_estimate = next_cefr, updated_at = now() where id = actor;
  end if;

  return jsonb_build_object(
    'alreadyRecorded', false, 'responseId', response_row.id, 'correct', passed,
    'canonicalAnswer', item_row.canonical_answer, 'explanation', item_row.explanation,
    'session', to_jsonb(session_row)
  );
end;
$$;

revoke execute on function public.submit_placement_response(uuid,uuid,uuid,text,integer) from public, anon;
grant execute on function public.submit_placement_response(uuid,uuid,uuid,text,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Shared goals and generated pair learning paths.
-- ---------------------------------------------------------------------------

create table if not exists public.shared_learning_goals (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  partner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  target_cefr text not null,
  focus_skills text[] not null,
  status text not null default 'proposed' check (status in ('proposed','generating','generation_failed','active','paused','completed','declined','archived')),
  creator_accepted_at timestamptz not null default now(),
  partner_accepted_at timestamptz,
  schedule jsonb not null default '{}'::jsonb,
  evidence_snapshot jsonb not null,
  provider text,
  model text,
  starts_on date,
  target_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (created_by <> partner_id),
  check (cardinality(focus_skills) > 0),
  check (jsonb_typeof(schedule) = 'object'),
  check (jsonb_typeof(evidence_snapshot) = 'object')
);

create table if not exists public.shared_learning_path_items (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.shared_learning_goals(id) on delete cascade,
  sequence_number integer not null,
  skill text not null,
  activity_type text not null,
  title text not null,
  objective text not null,
  target_minutes integer not null check (target_minutes between 5 and 180),
  target_count integer,
  due_at timestamptz,
  assignment text not null default 'both' check (assignment in ('both','creator','partner')),
  source_filters jsonb not null default '{}'::jsonb,
  completed_by uuid[] not null default '{}',
  completion_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(goal_id, sequence_number),
  check (jsonb_typeof(source_filters) = 'object'),
  check (jsonb_typeof(completion_evidence) = 'object')
);

create index if not exists shared_goals_members_idx on public.shared_learning_goals(created_by, partner_id, status);
alter table public.shared_learning_goals enable row level security;
alter table public.shared_learning_path_items enable row level security;
drop policy if exists "goal members read shared goals" on public.shared_learning_goals;
create policy "goal members read shared goals" on public.shared_learning_goals for select to authenticated using (
  (select auth.uid()) in (created_by, partner_id) and not exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = created_by and b.blocked_id = partner_id) or (b.blocker_id = partner_id and b.blocked_id = created_by)
  )
);
drop policy if exists "goal members read path items" on public.shared_learning_path_items;
create policy "goal members read path items" on public.shared_learning_path_items for select to authenticated using (exists (
  select 1 from public.shared_learning_goals g
  where g.id = goal_id and (select auth.uid()) in (g.created_by, g.partner_id)
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = g.created_by and b.blocked_id = g.partner_id) or (b.blocker_id = g.partner_id and b.blocked_id = g.created_by)
    )
));
revoke all on table public.shared_learning_goals, public.shared_learning_path_items from anon;
revoke insert, update, delete on table public.shared_learning_goals, public.shared_learning_path_items from authenticated;
grant select on table public.shared_learning_goals, public.shared_learning_path_items to authenticated;

create or replace function public.update_shared_learning_goal(target_goal_id uuid, requested_action text, target_item_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  goal_row public.shared_learning_goals%rowtype;
  item_row public.shared_learning_path_items%rowtype;
  now_at timestamptz := now();
begin
  if actor is null then raise exception 'Authentication required'; end if;
  select * into goal_row from public.shared_learning_goals where id = target_goal_id for update;
  if goal_row.id is null or actor not in (goal_row.created_by, goal_row.partner_id) then raise exception 'Shared goal not found'; end if;
  if exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = goal_row.created_by and b.blocked_id = goal_row.partner_id)
       or (b.blocker_id = goal_row.partner_id and b.blocked_id = goal_row.created_by)
  ) then
    raise exception 'Shared goal is unavailable because these accounts are blocked';
  end if;

  if requested_action = 'accept' then
    if actor <> goal_row.partner_id or goal_row.status <> 'proposed' then raise exception 'Only the invited partner can accept this proposal'; end if;
    update public.shared_learning_goals set status = 'generating', partner_accepted_at = now_at, starts_on = coalesce(starts_on, current_date), updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'retry_generation' then
    if (goal_row.status <> 'generation_failed' and not (goal_row.status = 'generating' and goal_row.updated_at < now_at - interval '2 minutes')) or goal_row.partner_accepted_at is null then raise exception 'This path is not ready to retry'; end if;
    update public.shared_learning_goals set status = 'generating', schedule = schedule - 'generationError', updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'decline' then
    if actor <> goal_row.partner_id or goal_row.status <> 'proposed' then raise exception 'Only the invited partner can decline this proposal'; end if;
    update public.shared_learning_goals set status = 'declined', updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'pause' then
    if goal_row.status <> 'active' then raise exception 'Only an active goal can be paused'; end if;
    update public.shared_learning_goals set status = 'paused', updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'resume' then
    if goal_row.status <> 'paused' then raise exception 'Only a paused goal can be resumed'; end if;
    update public.shared_learning_goals set status = 'active', updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'archive' then
    update public.shared_learning_goals set status = 'archived', updated_at = now_at where id = goal_row.id;
  elsif requested_action = 'complete_item' then
    if goal_row.status <> 'active' or target_item_id is null then raise exception 'An active goal and path item are required'; end if;
    select * into item_row from public.shared_learning_path_items where id = target_item_id and goal_id = goal_row.id for update;
    if item_row.id is null then raise exception 'Path item not found'; end if;
    if (item_row.assignment = 'creator' and actor <> goal_row.created_by) or (item_row.assignment = 'partner' and actor <> goal_row.partner_id) then raise exception 'This activity is assigned to the other learner'; end if;
    update public.shared_learning_path_items set
      completed_by = case when actor = any(completed_by) then completed_by else array_append(completed_by, actor) end,
      completion_evidence = completion_evidence || jsonb_build_object(actor::text, jsonb_build_object('completedAt', now_at, 'source', 'learner_confirmation')),
      updated_at = now_at
    where id = item_row.id;
    if not exists (
      select 1 from public.shared_learning_path_items path_item
      where path_item.goal_id = goal_row.id
        and not ((case path_item.assignment when 'creator' then array[goal_row.created_by] when 'partner' then array[goal_row.partner_id] else array[goal_row.created_by, goal_row.partner_id] end) <@ path_item.completed_by)
    ) then
      update public.shared_learning_goals set status = 'completed', updated_at = now_at where id = goal_row.id;
    end if;
  else
    raise exception 'Unsupported shared goal action';
  end if;
  return (select to_jsonb(g) from public.shared_learning_goals g where g.id = goal_row.id);
end;
$$;

revoke execute on function public.update_shared_learning_goal(uuid,text,uuid) from public, anon;
grant execute on function public.update_shared_learning_goal(uuid,text,uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Evidence-driven interventions, recaps and notification orchestration.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_intervention_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number integer not null,
  policy_code text not null,
  priority integer not null default 50,
  instruction_vi text not null,
  ui_message_vi text not null,
  evidence jsonb not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(match_id, round_number, policy_code),
  check (jsonb_typeof(evidence) = 'object')
);

create table if not exists public.match_recaps (
  match_id uuid primary key references public.matches(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  summary_vi text not null,
  strengths jsonb not null,
  needs_work jsonb not null,
  next_actions jsonb not null,
  evidence_snapshot jsonb not null,
  algorithm_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(strengths) = 'array'),
  check (jsonb_typeof(needs_work) = 'array'),
  check (jsonb_typeof(next_actions) = 'array'),
  check (jsonb_typeof(evidence_snapshot) = 'object')
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  review_due boolean not null default true,
  shared_goal_reminders boolean not null default true,
  room_invites boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text not null default 'Asia/Bangkok',
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null check (notification_type in ('review_due','shared_goal_invite','shared_goal_due','room_invite','placement_reminder')),
  dedupe_key text not null unique,
  title text not null,
  body text not null,
  destination_url text not null,
  payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempt_count integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists intervention_match_round_idx on public.ai_intervention_events(match_id, round_number);
create index if not exists notification_outbox_due_idx on public.notification_outbox(status, scheduled_for);
alter table public.ai_intervention_events enable row level security;
alter table public.match_recaps enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;
drop policy if exists "room members read interventions" on public.ai_intervention_events;
create policy "room members read interventions" on public.ai_intervention_events for select to authenticated using (exists (
  select 1 from public.match_players mp where mp.match_id = ai_intervention_events.match_id and mp.user_id = (select auth.uid())
));
drop policy if exists "match members read recaps" on public.match_recaps;
create policy "match members read recaps" on public.match_recaps for select to authenticated using (exists (
  select 1 from public.match_players mp where mp.match_id = match_recaps.match_id and mp.user_id = (select auth.uid())
));
drop policy if exists "users manage notification preferences" on public.notification_preferences;
create policy "users manage notification preferences" on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on table public.ai_intervention_events, public.match_recaps, public.notification_preferences, public.notification_outbox from anon;
revoke insert, update, delete on table public.ai_intervention_events, public.match_recaps, public.notification_outbox from authenticated;
revoke select on table public.notification_outbox from authenticated;
grant select on table public.ai_intervention_events, public.match_recaps to authenticated;
grant select, insert, update on table public.notification_preferences to authenticated;

notify pgrst, 'reload schema';
