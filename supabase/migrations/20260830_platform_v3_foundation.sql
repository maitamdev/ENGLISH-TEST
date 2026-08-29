-- LexiDuel Platform V3 foundation
-- Durable room coordination, background jobs, shared audio, appeals, observability,
-- privacy and social data. This migration intentionally contains no seed or mock data.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Durable room sessions and server-authoritative round timing
-- ---------------------------------------------------------------------------

alter table public.rooms
  add column if not exists state_version bigint not null default 1,
  add column if not exists host_epoch bigint not null default 1,
  add column if not exists host_lease_expires_at timestamptz not null default (now() + interval '20 seconds'),
  add column if not exists last_activity_at timestamptz not null default now();

alter table public.room_members
  add column if not exists client_session_id uuid,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists last_disconnected_at timestamptz,
  add column if not exists device_state jsonb not null default '{}'::jsonb,
  add column if not exists connection_quality jsonb not null default '{}'::jsonb;

alter table public.matches
  add column if not exists round_deadline_at timestamptz,
  add column if not exists round_epoch bigint not null default 0,
  add column if not exists scoring_version text not null default 'v3';

-- The legacy trigger adjusted only round_started_at and could shorten the
-- authoritative window by one second. schedule_match_round now owns both
-- timestamps atomically.
drop trigger if exists schedule_synchronized_round_trigger on public.matches;

create index if not exists room_members_liveness_idx
  on public.room_members(room_id, last_seen_at desc);
create index if not exists rooms_host_lease_idx
  on public.rooms(host_lease_expires_at) where status <> 'MATCH_RESULT';

create or replace function private.bump_room_state_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.host_id is distinct from old.host_id then
    new.state_version := greatest(new.state_version, old.state_version + 1);
    new.last_activity_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists bump_room_state_version_trigger on public.rooms;
create trigger bump_room_state_version_trigger
before update of status, host_id on public.rooms
for each row execute function private.bump_room_state_version();

create table if not exists public.room_operations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  operation_type text not null check (char_length(operation_type) between 1 and 80),
  idempotency_key uuid not null,
  request_hash text,
  response_payload jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, operation_type, idempotency_key)
);

create index if not exists room_operations_created_idx
  on public.room_operations(room_id, created_at desc);

alter table public.room_operations enable row level security;
drop policy if exists "members read room operations" on public.room_operations;
create policy "members read room operations"
  on public.room_operations for select to authenticated
  using (private.is_room_member(room_id));
revoke all on table public.room_operations from anon;
revoke insert, update, delete on table public.room_operations from authenticated;
grant select on table public.room_operations to authenticated;

create or replace function public.heartbeat_room(
  target_room_id uuid,
  target_client_session_id uuid,
  target_device_state jsonb default '{}'::jsonb,
  target_connection_quality jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms%rowtype;
  elected_host uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if target_client_session_id is null then raise exception 'Client session is required'; end if;

  select * into target_room from public.rooms where id = target_room_id for update;
  if target_room.id is null then raise exception 'Room not found'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = target_room_id and user_id = current_user_id
  ) then raise exception 'Not a room member'; end if;

  update public.room_members
  set client_session_id = target_client_session_id,
      last_seen_at = clock_timestamp(),
      connection_state = 'connected',
      last_disconnected_at = null,
      device_state = coalesce(target_device_state, '{}'::jsonb),
      connection_quality = coalesce(target_connection_quality, '{}'::jsonb)
  where room_id = target_room_id and user_id = current_user_id;

  if target_room.host_id = current_user_id then
    update public.rooms
    set host_lease_expires_at = clock_timestamp() + interval '20 seconds',
        last_activity_at = clock_timestamp()
    where id = target_room_id;
  elsif target_room.host_lease_expires_at < clock_timestamp()
     or not exists (
       select 1 from public.room_members
       where room_id = target_room_id
         and user_id = target_room.host_id
         and last_seen_at > clock_timestamp() - interval '20 seconds'
     ) then
    select user_id into elected_host
    from public.room_members
    where room_id = target_room_id
      and last_seen_at > clock_timestamp() - interval '20 seconds'
    order by last_seen_at desc, joined_at asc, user_id asc
    limit 1;

    if elected_host is not null then
      update public.rooms
      set host_id = elected_host,
          host_epoch = host_epoch + case when host_id is distinct from elected_host then 1 else 0 end,
          state_version = state_version + case when host_id is distinct from elected_host then 1 else 0 end,
          host_lease_expires_at = clock_timestamp() + interval '20 seconds',
          last_activity_at = clock_timestamp()
      where id = target_room_id;
    end if;
  end if;

  select * into target_room from public.rooms where id = target_room_id;
  return jsonb_build_object(
    'serverNow', floor(extract(epoch from clock_timestamp()) * 1000),
    'hostId', target_room.host_id,
    'hostEpoch', target_room.host_epoch,
    'stateVersion', target_room.state_version,
    'leaseExpiresAt', target_room.host_lease_expires_at
  );
end;
$$;

create or replace function public.mark_room_disconnected(
  target_room_id uuid,
  target_client_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  update public.room_members
  set connection_state = 'reconnecting',
      last_disconnected_at = clock_timestamp()
  where room_id = target_room_id
    and user_id = (select auth.uid())
    and client_session_id = target_client_session_id;
end;
$$;

create or replace function public.schedule_match_round(
  target_match_id uuid,
  target_round integer,
  target_idempotency_key uuid,
  lead_time_ms integer default 3000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_match public.matches%rowtype;
  target_question public.questions%rowtype;
  existing_response jsonb;
  scheduled_start timestamptz;
  scheduled_deadline timestamptz;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if target_idempotency_key is null then raise exception 'Idempotency key is required'; end if;
  if lead_time_ms < 1500 or lead_time_ms > 10000 then raise exception 'Invalid lead time'; end if;

  select * into target_match from public.matches where id = target_match_id for update;
  if target_match.id is null then raise exception 'Match not found'; end if;
  if not private.is_room_member(target_match.room_id) then raise exception 'Not a room member'; end if;
  if not exists (select 1 from public.rooms where id = target_match.room_id and host_id = current_user_id) then
    raise exception 'Only the active room host can schedule a round';
  end if;

  select response_payload into existing_response
  from public.room_operations
  where room_id = target_match.room_id
    and operation_type = 'schedule_round'
    and idempotency_key = target_idempotency_key;
  if existing_response is not null then return existing_response; end if;

  select * into target_question
  from public.questions
  where match_id = target_match_id and round_number = target_round;
  if target_question.id is null then raise exception 'Question not found'; end if;
  if target_round < 1 or target_round > target_match.round_count then raise exception 'Round is out of range'; end if;
  if target_match.status = 'completed' or target_match.status = 'cancelled' then raise exception 'Match is closed'; end if;
  if target_round < target_match.current_round then raise exception 'Cannot rewind a match'; end if;

  scheduled_start := clock_timestamp() + make_interval(secs => lead_time_ms::numeric / 1000);
  scheduled_deadline := scheduled_start + make_interval(secs => target_question.time_limit);

  update public.matches
  set status = 'active',
      current_round = target_round,
      started_at = coalesce(started_at, scheduled_start),
      round_started_at = scheduled_start,
      round_deadline_at = scheduled_deadline,
      round_epoch = round_epoch + 1
  where id = target_match_id;

  update public.rooms
  set status = 'ROUND_ACTIVE',
      state_version = state_version + 1,
      last_activity_at = clock_timestamp()
  where id = target_match.room_id;

  existing_response := jsonb_build_object(
    'matchId', target_match_id,
    'round', target_round,
    'startsAt', scheduled_start,
    'deadlineAt', scheduled_deadline,
    'serverNow', floor(extract(epoch from clock_timestamp()) * 1000)
  );

  insert into public.room_operations(room_id, actor_id, operation_type, idempotency_key, response_payload)
  values (target_match.room_id, current_user_id, 'schedule_round', target_idempotency_key, existing_response)
  on conflict (room_id, operation_type, idempotency_key) do nothing;

  return existing_response;
end;
$$;

revoke execute on function public.heartbeat_room(uuid, uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.mark_room_disconnected(uuid, uuid) from public, anon;
revoke execute on function public.schedule_match_round(uuid, integer, uuid, integer) from public, anon;
grant execute on function public.heartbeat_room(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.mark_room_disconnected(uuid, uuid) to authenticated;
grant execute on function public.schedule_match_round(uuid, integer, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Durable background generation queue
-- ---------------------------------------------------------------------------

alter table public.generation_jobs drop constraint if exists generation_jobs_status_check;
alter table public.generation_jobs
  add column if not exists request_payload jsonb not null default '{}'::jsonb,
  add column if not exists next_round integer not null default 1,
  add column if not exists batch_size integer not null default 4,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 8,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists cancelled_at timestamptz,
  add constraint generation_jobs_status_check check (status in ('queued','generating','persisting','retrying','completed','failed','cancelled')),
  add constraint generation_jobs_batch_size_check check (batch_size between 1 and 8),
  add constraint generation_jobs_attempts_check check (attempt_count between 0 and max_attempts),
  add constraint generation_jobs_next_round_check check (next_round between 1 and 51);

create index if not exists generation_jobs_claim_idx
  on public.generation_jobs(status, next_attempt_at, created_at)
  where status in ('queued','retrying','generating','persisting');

create table if not exists public.generation_job_states (
  job_id uuid primary key references public.generation_jobs(id) on delete cascade,
  blueprint jsonb,
  mode_schedule jsonb not null default '[]'::jsonb,
  generated_questions jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  check (blueprint is null or jsonb_typeof(blueprint) = 'object'),
  check (jsonb_typeof(mode_schedule) = 'array'),
  check (jsonb_typeof(generated_questions) = 'array')
);

alter table public.generation_job_states enable row level security;
revoke all on table public.generation_job_states from public, anon, authenticated;

create or replace function public.claim_generation_job(worker_token uuid, lease_seconds integer default 45)
returns setof public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if worker_token is null then raise exception 'Worker token is required'; end if;
  if lease_seconds < 15 or lease_seconds > 120 then raise exception 'Invalid lease duration'; end if;

  select id into claimed_id
  from public.generation_jobs
  where status in ('queued','retrying','generating','persisting')
    and cancelled_at is null
    and next_attempt_at <= clock_timestamp()
    and (lease_expires_at is null or lease_expires_at < clock_timestamp())
    and attempt_count < max_attempts
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;
  return query
  update public.generation_jobs
  set status = case when status = 'persisting' then 'persisting' else 'generating' end,
      lease_token = worker_token,
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
      updated_at = clock_timestamp()
  where id = claimed_id
  returning *;
end;
$$;

create or replace function public.release_generation_job(
  target_job_id uuid,
  worker_token uuid,
  target_status text,
  target_stage text,
  target_completed_rounds integer,
  target_next_round integer,
  retry_after_seconds integer default 0,
  target_error_code text default null,
  target_error_message text default null
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  released public.generation_jobs%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if target_status not in ('queued','generating','persisting','retrying','completed','failed','cancelled') then
    raise exception 'Invalid job status';
  end if;

  update public.generation_jobs
  set status = target_status,
      stage = left(coalesce(target_stage, stage), 200),
      completed_rounds = greatest(completed_rounds, least(coalesce(target_completed_rounds, completed_rounds), coalesce(total_rounds, 50))),
      next_round = greatest(next_round, coalesce(target_next_round, next_round)),
      next_attempt_at = clock_timestamp() + make_interval(secs => greatest(0, retry_after_seconds)),
      lease_token = null,
      lease_expires_at = null,
      attempt_count = case
        when target_error_code is not null and target_status in ('retrying','failed')
          then least(max_attempts, attempt_count + 1)
        else attempt_count
      end,
      last_error_code = target_error_code,
      error_message = left(target_error_message, 2000),
      completed_at = case when target_status in ('completed','failed','cancelled') then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where id = target_job_id and lease_token = worker_token
  returning * into released;
  if released.id is null then raise exception 'Generation lease is no longer valid'; end if;
  return released;
end;
$$;

revoke execute on function public.claim_generation_job(uuid, integer) from public, anon, authenticated;
revoke execute on function public.release_generation_job(uuid, uuid, text, text, integer, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.claim_generation_job(uuid, integer) to service_role;
grant execute on function public.release_generation_job(uuid, uuid, text, text, integer, integer, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Shared private TTS cache and semantic appeals
-- ---------------------------------------------------------------------------

create table if not exists public.question_audio_assets (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  content_hash text not null,
  provider text not null,
  model text not null,
  voice text not null,
  accent text not null,
  playback_rate numeric(4,2) not null default 1,
  storage_bucket text not null default 'question-audio',
  storage_path text,
  mime_type text,
  byte_size integer check (byte_size is null or byte_size > 0),
  status text not null default 'pending' check (status in ('pending','generating','ready','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (content_hash, model, voice, accent, playback_rate)
);

create index if not exists question_audio_question_idx on public.question_audio_assets(question_id);
alter table public.question_audio_assets enable row level security;
drop policy if exists "room members read question audio metadata" on public.question_audio_assets;
create policy "room members read question audio metadata"
  on public.question_audio_assets for select to authenticated
  using (exists (
    select 1 from public.questions q
    join public.matches m on m.id = q.match_id
    where q.id = question_id and private.is_room_member(m.room_id)
  ));
revoke all on table public.question_audio_assets from anon;
revoke insert, update, delete on table public.question_audio_assets from authenticated;
grant select on table public.question_audio_assets to authenticated;

create table if not exists public.answer_appeals (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'queued' check (status in ('queued','reviewing','accepted','rejected','failed')),
  original_verdict jsonb not null,
  reviewed_verdict jsonb,
  reviewer_provider text,
  reviewer_model text,
  score_delta integer not null default 0,
  explanation_vi text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (submission_id, user_id)
);

create index if not exists answer_appeals_status_idx on public.answer_appeals(status, created_at);
alter table public.answer_appeals enable row level security;
drop policy if exists "players read own appeals" on public.answer_appeals;
create policy "players read own appeals" on public.answer_appeals for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "players create own appeals" on public.answer_appeals;
create policy "players create own appeals" on public.answer_appeals for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = (select auth.uid()))
  );
revoke all on table public.answer_appeals from anon;
grant select, insert on table public.answer_appeals to authenticated;

-- ---------------------------------------------------------------------------
-- Structured telemetry and user-controlled privacy
-- ---------------------------------------------------------------------------

create table if not exists public.telemetry_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  correlation_id uuid not null,
  event_name text not null check (char_length(event_name) between 1 and 100),
  severity text not null default 'info' check (severity in ('debug','info','warning','error','critical')),
  room_id uuid references public.rooms(id) on delete set null,
  match_id uuid references public.matches(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  provider text,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text
);

create index if not exists telemetry_events_time_idx on public.telemetry_events(occurred_at desc);
create index if not exists telemetry_events_correlation_idx on public.telemetry_events(correlation_id);
alter table public.telemetry_events enable row level security;
revoke all on table public.telemetry_events from anon, authenticated;

create table if not exists public.privacy_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  retain_voice_assessments boolean not null default false,
  allow_learning_analytics boolean not null default true,
  allow_social_discovery boolean not null default true,
  allow_authorized_content_contribution boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_type text not null check (request_type in ('export','delete')),
  status text not null default 'queued' check (status in ('queued','processing','ready','completed','failed','cancelled')),
  storage_path text,
  error_message text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz
);

create index if not exists data_requests_user_idx on public.data_requests(user_id, requested_at desc);
alter table public.privacy_preferences enable row level security;
alter table public.data_requests enable row level security;
drop policy if exists "users manage own privacy" on public.privacy_preferences;
create policy "users manage own privacy" on public.privacy_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "users read own data requests" on public.data_requests;
create policy "users read own data requests" on public.data_requests for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "users create own data requests" on public.data_requests;
create policy "users create own data requests" on public.data_requests for insert to authenticated
  with check (user_id = (select auth.uid()));
revoke all on table public.privacy_preferences, public.data_requests from anon;
grant select, insert, update on table public.privacy_preferences to authenticated;
grant select, insert on table public.data_requests to authenticated;

-- ---------------------------------------------------------------------------
-- Friends, invites and transparent ratings
-- ---------------------------------------------------------------------------

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','blocked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);

create unique index if not exists friendships_pair_idx
  on public.friendships(least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create table if not exists public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired','cancelled')),
  message text check (message is null or char_length(message) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  responded_at timestamptz,
  check (sender_id <> recipient_id)
);

create unique index if not exists room_invites_pending_idx
  on public.room_invites(room_id, recipient_id) where status = 'pending';

create table if not exists public.player_ratings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null,
  rating numeric(8,2) not null default 1000,
  deviation numeric(8,2) not null default 350,
  match_count integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, skill),
  check (char_length(skill) between 1 and 40),
  check (rating between 0 and 5000),
  check (deviation between 30 and 500)
);

alter table public.friendships enable row level security;
alter table public.room_invites enable row level security;
alter table public.player_ratings enable row level security;
drop policy if exists "participants read friendships" on public.friendships;
create policy "participants read friendships" on public.friendships for select to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));
drop policy if exists "users request friendships" on public.friendships;
create policy "users request friendships" on public.friendships for insert to authenticated
  with check (requester_id = (select auth.uid()) and status = 'pending');
drop policy if exists "participants update friendships" on public.friendships;
create policy "participants update friendships" on public.friendships for update to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()))
  with check (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));
drop policy if exists "participants read room invites" on public.room_invites;
create policy "participants read room invites" on public.room_invites for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));
drop policy if exists "members send room invites" on public.room_invites;
create policy "members send room invites" on public.room_invites for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.is_room_member(room_id));
drop policy if exists "recipients update room invites" on public.room_invites;
create policy "recipients update room invites" on public.room_invites for update to authenticated
  using (recipient_id = (select auth.uid()) or sender_id = (select auth.uid()));
drop policy if exists "ratings visible to signed in users" on public.player_ratings;
create policy "ratings visible to signed in users" on public.player_ratings for select to authenticated using (true);
revoke all on table public.friendships, public.room_invites, public.player_ratings from anon;
grant select, insert, update on table public.friendships, public.room_invites to authenticated;
grant select on table public.player_ratings to authenticated;

-- Browser roles may change only response fields. Identity, room and pair columns
-- remain immutable even if a client bypasses the route handlers.
revoke update on table public.friendships, public.room_invites from authenticated;
grant update(status, responded_at) on table public.friendships, public.room_invites to authenticated;

-- Extend profile and room visibility to accepted friends and explicit invite recipients.
create or replace function private.shares_room_with(target_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select target_user_id = (select auth.uid())
    or exists (
      select 1
      from public.room_members mine
      join public.room_members theirs on theirs.room_id = mine.room_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = target_user_id
    )
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = (select auth.uid()) and f.addressee_id = target_user_id)
          or (f.addressee_id = (select auth.uid()) and f.requester_id = target_user_id))
    );
$$;

drop policy if exists "members read rooms" on public.rooms;
create policy "members and invitees read rooms" on public.rooms for select to authenticated
using (
  private.is_room_member(id)
  or exists (
    select 1 from public.room_invites invite
    where invite.room_id = id and invite.recipient_id = (select auth.uid())
      and invite.status = 'pending' and invite.expires_at > clock_timestamp()
  )
);

-- Private buckets are created here, but no user or generated content is seeded.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('question-audio', 'question-audio', false, 10485760, array['audio/mpeg','audio/wav','audio/ogg','audio/webm']),
  ('user-exports', 'user-exports', false, 52428800, array['application/json','application/zip'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "room members read cached question audio" on storage.objects;
create policy "room members read cached question audio" on storage.objects for select to authenticated
using (
  bucket_id = 'question-audio'
  and exists (
    select 1 from public.question_audio_assets asset
    join public.questions q on q.id = asset.question_id
    join public.matches m on m.id = q.match_id
    where asset.storage_path = name and private.is_room_member(m.room_id)
  )
);

drop policy if exists "users read own exports" on storage.objects;
create policy "users read own exports" on storage.objects for select to authenticated
using (bucket_id = 'user-exports' and (storage.foldername(name))[1] = (select auth.uid())::text);
