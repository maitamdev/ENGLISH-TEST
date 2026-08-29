-- LexiDuel arena orchestration
-- User-owned arena presets, privacy-safe adaptive schedules, auditable readiness
-- and evidence-derived remediation. This migration inserts no seed or mock rows.

create table if not exists public.user_arena_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text check (description is null or char_length(description) <= 300),
  configuration jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name),
  check (jsonb_typeof(configuration) = 'object')
);

create unique index if not exists user_arena_presets_one_default_idx
  on public.user_arena_presets(user_id) where is_default;
alter table public.user_arena_presets enable row level security;
drop policy if exists "users read own arena presets" on public.user_arena_presets;
create policy "users read own arena presets" on public.user_arena_presets for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "users create own arena presets" on public.user_arena_presets;
create policy "users create own arena presets" on public.user_arena_presets for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "users update own arena presets" on public.user_arena_presets;
create policy "users update own arena presets" on public.user_arena_presets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "users delete own arena presets" on public.user_arena_presets;
create policy "users delete own arena presets" on public.user_arena_presets for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.user_arena_presets from anon;
grant select, insert, update, delete on table public.user_arena_presets to authenticated;

create or replace function public.set_default_arena_preset(target_preset_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.user_arena_presets where id = target_preset_id and user_id = actor) then
    raise exception 'Arena preset not found';
  end if;
  update public.user_arena_presets set is_default = false, updated_at = clock_timestamp()
  where user_id = actor and is_default;
  update public.user_arena_presets set is_default = true, updated_at = clock_timestamp()
  where id = target_preset_id and user_id = actor;
end;
$$;
revoke execute on function public.set_default_arena_preset(uuid) from public, anon;
grant execute on function public.set_default_arena_preset(uuid) to authenticated;

create table if not exists public.match_adaptive_contexts (
  match_id uuid primary key references public.matches(id) on delete cascade,
  policy text not null check (policy in ('balanced','weakness_first','spaced_retrieval')),
  evidence_snapshot jsonb not null default '{}'::jsonb,
  mode_schedule jsonb not null,
  difficulty_schedule jsonb not null,
  algorithm_version text not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(evidence_snapshot) = 'object'),
  check (jsonb_typeof(mode_schedule) = 'array'),
  check (jsonb_typeof(difficulty_schedule) = 'array')
);
alter table public.match_adaptive_contexts enable row level security;
drop policy if exists "match players read adaptive context" on public.match_adaptive_contexts;
create policy "match players read adaptive context" on public.match_adaptive_contexts for select to authenticated using (exists (
  select 1 from public.match_players player
  where player.match_id = match_adaptive_contexts.match_id and player.user_id = (select auth.uid())
));
revoke all on table public.match_adaptive_contexts from anon;
revoke insert, update, delete on table public.match_adaptive_contexts from authenticated;
grant select on table public.match_adaptive_contexts to authenticated;

alter table public.generation_job_states
  add column if not exists difficulty_schedule jsonb not null default '[]'::jsonb;

alter table public.room_members
  add column if not exists readiness_checked_at timestamptz,
  add column if not exists readiness_version text;

alter table public.matches
  add column if not exists round_extension_ms integer not null default 0 check (round_extension_ms between 0 and 30000);

create table if not exists public.match_connectivity_incidents (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  round_number integer not null,
  client_session_id uuid,
  disconnected_at timestamptz not null default now(),
  reconnected_at timestamptz,
  downtime_ms integer check (downtime_ms is null or downtime_ms >= 0),
  deadline_extension_ms integer not null default 0 check (deadline_extension_ms between 0 and 15000),
  created_at timestamptz not null default now()
);
create unique index if not exists match_connectivity_one_open_idx
  on public.match_connectivity_incidents(match_id, user_id) where reconnected_at is null;
create index if not exists match_connectivity_timeline_idx
  on public.match_connectivity_incidents(match_id, round_number, disconnected_at);
alter table public.match_connectivity_incidents enable row level security;
drop policy if exists "match players read connectivity incidents" on public.match_connectivity_incidents;
create policy "match players read connectivity incidents" on public.match_connectivity_incidents for select to authenticated using (exists (
  select 1 from public.match_players player
  where player.match_id = match_connectivity_incidents.match_id and player.user_id = (select auth.uid())
));
revoke all on table public.match_connectivity_incidents from anon;
revoke insert, update, delete on table public.match_connectivity_incidents from authenticated;
grant select on table public.match_connectivity_incidents to authenticated;

create or replace function private.reset_round_extension()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.current_round is distinct from new.current_round then new.round_extension_ms := 0; end if;
  return new;
end;
$$;
drop trigger if exists reset_round_extension on public.matches;
create trigger reset_round_extension before update of current_round on public.matches
for each row execute function private.reset_round_extension();

create or replace function public.record_match_connectivity(
  target_room_id uuid,
  target_user_id uuid,
  target_client_session_id uuid,
  target_connected boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  match_row public.matches%rowtype;
  incident public.match_connectivity_incidents%rowtype;
  now_at timestamptz := clock_timestamp();
  downtime integer;
  extension integer;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if not exists (select 1 from public.room_members where room_id = target_room_id and user_id = target_user_id) then return jsonb_build_object('tracked', false, 'reason', 'not_a_member'); end if;
  select * into match_row from public.matches
  where room_id = target_room_id and status = 'active' and current_round > 0
  order by created_at desc limit 1 for update;
  if match_row.id is null then return jsonb_build_object('tracked', false, 'reason', 'no_active_round'); end if;
  if not exists (select 1 from public.rooms where id = target_room_id and status = 'ROUND_ACTIVE') then
    return jsonb_build_object('tracked', false, 'reason', 'round_not_accepting_answers');
  end if;

  if not target_connected then
    insert into public.match_connectivity_incidents(match_id, room_id, user_id, round_number, client_session_id, disconnected_at)
    values (match_row.id, target_room_id, target_user_id, match_row.current_round, target_client_session_id, now_at)
    on conflict do nothing;
    return jsonb_build_object('tracked', true, 'state', 'disconnected', 'matchId', match_row.id);
  end if;

  select * into incident from public.match_connectivity_incidents
  where match_id = match_row.id and user_id = target_user_id and reconnected_at is null
  order by disconnected_at desc limit 1 for update;
  if incident.id is null then return jsonb_build_object('tracked', false, 'reason', 'no_open_incident'); end if;
  downtime := greatest(0, floor(extract(epoch from (now_at - incident.disconnected_at)) * 1000));
  extension := least(15000, downtime, greatest(0, 30000 - match_row.round_extension_ms));
  update public.match_connectivity_incidents set
    reconnected_at = now_at, downtime_ms = downtime, deadline_extension_ms = extension
  where id = incident.id;
  if extension > 0 and match_row.current_round = incident.round_number and match_row.round_deadline_at is not null then
    update public.matches set
      round_deadline_at = round_deadline_at + make_interval(secs => extension::double precision / 1000),
      round_extension_ms = round_extension_ms + extension
    where id = match_row.id;
  end if;
  return jsonb_build_object('tracked', true, 'state', 'reconnected', 'matchId', match_row.id, 'downtimeMs', downtime, 'extensionMs', extension);
end;
$$;
revoke execute on function public.record_match_connectivity(uuid,uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.record_match_connectivity(uuid,uuid,uuid,boolean) to service_role;
revoke execute on function private.reset_round_extension() from public, anon, authenticated;

create table if not exists public.room_readiness_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id uuid references public.matches(id) on delete cascade,
  passed boolean not null,
  blockers text[] not null default '{}',
  metrics jsonb not null default '{}'::jsonb,
  readiness_version text not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metrics) = 'object')
);
create index if not exists room_readiness_events_lookup_idx
  on public.room_readiness_events(room_id, created_at desc);
alter table public.room_readiness_events enable row level security;
drop policy if exists "room members read readiness events" on public.room_readiness_events;
create policy "room members read readiness events" on public.room_readiness_events for select to authenticated using (exists (
  select 1 from public.room_members member
  where member.room_id = room_readiness_events.room_id and member.user_id = (select auth.uid())
));
revoke all on table public.room_readiness_events from anon;
revoke insert, update, delete on table public.room_readiness_events from authenticated;
grant select on table public.room_readiness_events to authenticated;

create table if not exists public.match_remediation_items (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  submission_id uuid not null references public.submissions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null,
  reason text not null check (reason in ('incorrect','timeout','hint_dependency','low_rubric','slow_recall')),
  priority integer not null check (priority between 1 and 100),
  action_type text not null check (action_type in ('fsrs_review','retry_question','speaking_drill','writing_revision')),
  status text not null default 'pending' check (status in ('pending','in_progress','completed','dismissed')),
  due_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submission_id),
  check (jsonb_typeof(evidence) = 'object')
);
create index if not exists match_remediation_user_due_idx
  on public.match_remediation_items(user_id, status, due_at, priority desc);
alter table public.match_remediation_items enable row level security;
drop policy if exists "users read own remediation" on public.match_remediation_items;
create policy "users read own remediation" on public.match_remediation_items for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.match_remediation_items from anon;
revoke insert, update, delete on table public.match_remediation_items from authenticated;
grant select on table public.match_remediation_items to authenticated;

create or replace function private.arena_skill_for_mode(target_mode text)
returns text language sql immutable set search_path = '' as $$
  select case
    when target_mode in ('LISTENING','SPELLING','MINIMAL_PAIRS','AUDIO_CHOICE','STORY_LISTENING') then 'listening'
    when target_mode in ('PRONUNCIATION','SHADOWING') then 'phonology'
    when target_mode in ('SPEAKING','ROLEPLAY','DEBATE') then 'speaking'
    when target_mode in ('READING','MULTIPLE_CHOICE','DEFINITION','CONTEXT') then 'reading'
    when target_mode in ('GRAMMAR','SENTENCE_BUILDER','CLOZE','ERROR_CORRECTION','COLLOCATION') then 'grammar'
    when target_mode in ('WRITING','TRANSLATION') then 'writing'
    else 'vocabulary'
  end
$$;

create or replace function private.capture_match_remediation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  question_row public.questions%rowtype;
  match_row public.matches%rowtype;
  policy text;
  target_reason text;
  target_priority integer;
  target_action text;
begin
  if coalesce((select allow_learning_analytics from public.privacy_preferences where user_id = new.user_id), true) = false then return new; end if;
  select * into question_row from public.questions where id = new.question_id;
  select * into match_row from public.matches where id = new.match_id;
  if question_row.id is null or match_row.id is null then return new; end if;
  policy := coalesce(match_row.blueprint #>> '{settings,remediationPolicy}', 'AUTO');
  if policy = 'OFF' then return new; end if;

  if new.timed_out then target_reason := 'timeout'; target_priority := 100;
  elsif not new.is_correct then target_reason := 'incorrect'; target_priority := 95;
  elsif policy = 'AUTO' and new.rubric_score is not null and new.rubric_score < 75 then target_reason := 'low_rubric'; target_priority := 85;
  elsif policy = 'AUTO' and new.hints_used > 0 then target_reason := 'hint_dependency'; target_priority := 72;
  elsif policy = 'AUTO' and new.response_ms >= question_row.time_limit * 800 then target_reason := 'slow_recall'; target_priority := 55;
  else return new;
  end if;

  target_action := case
    when question_row.mode in ('SPEAKING','ROLEPLAY','DEBATE','PRONUNCIATION','SHADOWING') then 'speaking_drill'
    when question_row.mode = 'WRITING' then 'writing_revision'
    when target_reason in ('incorrect','timeout') then 'retry_question'
    else 'fsrs_review'
  end;
  insert into public.match_remediation_items(
    match_id, question_id, submission_id, user_id, skill, reason, priority, action_type, due_at, evidence
  ) values (
    new.match_id, new.question_id, new.id, new.user_id, private.arena_skill_for_mode(question_row.mode),
    target_reason, target_priority, target_action,
    case when target_reason in ('incorrect','timeout') then clock_timestamp() else clock_timestamp() + interval '12 hours' end,
    jsonb_build_object('mode', question_row.mode, 'responseMs', new.response_ms, 'timeLimitMs', question_row.time_limit * 1000,
      'hintsUsed', new.hints_used, 'rubricScore', new.rubric_score, 'isCorrect', new.is_correct, 'timedOut', new.timed_out)
  ) on conflict (submission_id) do nothing;
  return new;
end;
$$;

revoke execute on function private.arena_skill_for_mode(text) from public, anon, authenticated;
revoke execute on function private.capture_match_remediation() from public, anon, authenticated;

drop trigger if exists capture_match_remediation on public.submissions;
create trigger capture_match_remediation after insert on public.submissions
for each row execute function private.capture_match_remediation();

create or replace function public.update_match_remediation(target_item_id uuid, target_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  result public.match_remediation_items%rowtype;
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if target_status not in ('pending','in_progress','completed','dismissed') then raise exception 'Invalid remediation status'; end if;
  update public.match_remediation_items set
    status = target_status,
    completed_at = case when target_status = 'completed' then clock_timestamp() else null end,
    updated_at = clock_timestamp()
  where id = target_item_id and user_id = actor
  returning * into result;
  if result.id is null then raise exception 'Remediation item not found'; end if;
  return to_jsonb(result);
end;
$$;
revoke execute on function public.update_match_remediation(uuid,text) from public, anon;
grant execute on function public.update_match_remediation(uuid,text) to authenticated;

-- Backfill only from real existing submissions. No synthetic learning activity is created.
insert into public.match_remediation_items(
  match_id, question_id, submission_id, user_id, skill, reason, priority, action_type, due_at, evidence
)
select s.match_id, s.question_id, s.id, s.user_id, private.arena_skill_for_mode(q.mode),
  case when s.timed_out then 'timeout' else 'incorrect' end,
  case when s.timed_out then 100 else 95 end,
  case when q.mode in ('SPEAKING','ROLEPLAY','DEBATE','PRONUNCIATION','SHADOWING') then 'speaking_drill'
       when q.mode = 'WRITING' then 'writing_revision' else 'retry_question' end,
  coalesce(s.server_received_at, now()),
  jsonb_build_object('mode', q.mode, 'responseMs', s.response_ms, 'timeLimitMs', q.time_limit * 1000,
    'hintsUsed', s.hints_used, 'rubricScore', s.rubric_score, 'isCorrect', s.is_correct, 'timedOut', s.timed_out, 'backfilled', true)
from public.submissions s
join public.questions q on q.id = s.question_id
left join public.privacy_preferences privacy on privacy.user_id = s.user_id
join public.matches m on m.id = s.match_id
where (s.timed_out or not s.is_correct)
  and coalesce(privacy.allow_learning_analytics, true)
  and coalesce(m.blueprint #>> '{settings,remediationPolicy}', 'AUTO') <> 'OFF'
on conflict (submission_id) do nothing;
