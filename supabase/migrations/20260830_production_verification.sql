-- LexiDuel production verification, AI quality, moderation and safety.
-- Run after 20260830_learning_intelligence.sql. This migration contains no
-- seed users, learning records, evaluation fixtures or operational samples.

create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','moderator','observer')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
revoke all on table public.platform_admins from anon, authenticated;

create or replace function public.is_platform_admin(required_roles text[] default array['owner','admin','moderator','observer'])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = (select auth.uid()) and role = any(required_roles)
  );
$$;

revoke execute on function public.is_platform_admin(text[]) from public, anon;
grant execute on function public.is_platform_admin(text[]) to authenticated, service_role;

-- Exact client delivery lifecycle used to audit whether both learners saw and
-- could answer a question at comparable server-relative times.
create table if not exists public.round_delivery_receipts (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_session_id uuid not null,
  received_at timestamptz,
  rendered_at timestamptz,
  input_enabled_at timestamptz,
  audio_ready_at timestamptz,
  answer_sent_at timestamptz,
  client_reported_at timestamptz,
  clock_offset_ms numeric(10,3),
  clock_rtt_ms numeric(10,3),
  realtime_state text,
  webrtc_state text,
  document_visibility text,
  network_effective_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(question_id, user_id, client_session_id),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists round_delivery_question_idx
  on public.round_delivery_receipts(question_id, user_id, input_enabled_at);
create index if not exists round_delivery_room_idx
  on public.round_delivery_receipts(room_id, created_at desc);
alter table public.round_delivery_receipts enable row level security;

drop policy if exists "room members read delivery fairness" on public.round_delivery_receipts;
create policy "room members read delivery fairness" on public.round_delivery_receipts
  for select to authenticated using (private.is_room_member(room_id));
revoke insert, update, delete on table public.round_delivery_receipts from authenticated, anon;
grant select on table public.round_delivery_receipts to authenticated;

create table if not exists public.question_fairness_assessments (
  question_id uuid primary key references public.questions(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_count integer not null default 0 check (participant_count between 0 and 2),
  render_skew_ms integer,
  input_skew_ms integer,
  max_clock_rtt_ms integer,
  hidden_participant_count integer not null default 0,
  decision text not null default 'pending' check (decision in ('pending','fair','review','compromised','voided')),
  reasons jsonb not null default '[]'::jsonb,
  assessed_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  check (jsonb_typeof(reasons) = 'array')
);

alter table public.question_fairness_assessments enable row level security;
drop policy if exists "room members read fairness assessment" on public.question_fairness_assessments;
create policy "room members read fairness assessment" on public.question_fairness_assessments
  for select to authenticated using (private.is_room_member(room_id));
revoke insert, update, delete on table public.question_fairness_assessments from authenticated, anon;
grant select on table public.question_fairness_assessments to authenticated;

create or replace function private.refresh_question_fairness(target_question_id uuid)
returns public.question_fairness_assessments
language plpgsql
security definer
set search_path = public, private
as $$
declare
  q record;
  result public.question_fairness_assessments%rowtype;
  participants integer;
  render_skew integer;
  input_skew integer;
  max_rtt integer;
  hidden_count integer;
  reasons jsonb := '[]'::jsonb;
  verdict text := 'pending';
begin
  select questions.match_id, matches.room_id into q
  from public.questions join public.matches on matches.id = questions.match_id
  where questions.id = target_question_id;
  if not found then raise exception 'Question not found'; end if;

  with latest as (
    select distinct on (user_id) user_id, rendered_at, input_enabled_at,
      clock_rtt_ms, document_visibility
    from public.round_delivery_receipts
    where question_id = target_question_id
    order by user_id, updated_at desc
  )
  select count(*),
    extract(epoch from (max(rendered_at) - min(rendered_at))) * 1000,
    extract(epoch from (max(input_enabled_at) - min(input_enabled_at))) * 1000,
    max(clock_rtt_ms),
    count(*) filter (where document_visibility is distinct from 'visible')
  into participants, render_skew, input_skew, max_rtt, hidden_count
  from latest;

  if participants < 2 then
    reasons := reasons || jsonb_build_array('waiting_for_both_participants');
  elsif input_skew is null then
    verdict := 'review'; reasons := reasons || jsonb_build_array('missing_input_receipt');
  elsif input_skew > 2500 then
    verdict := 'compromised'; reasons := reasons || jsonb_build_array('input_delivery_skew_over_2500ms');
  elsif input_skew > 750 then
    verdict := 'review'; reasons := reasons || jsonb_build_array('input_delivery_skew_over_750ms');
  else
    verdict := 'fair';
  end if;
  if coalesce(max_rtt, 0) > 1200 then reasons := reasons || jsonb_build_array('high_clock_rtt'); end if;
  if hidden_count > 0 then reasons := reasons || jsonb_build_array('participant_tab_hidden'); end if;

  insert into public.question_fairness_assessments (
    question_id, match_id, room_id, participant_count, render_skew_ms,
    input_skew_ms, max_clock_rtt_ms, hidden_participant_count, decision,
    reasons, assessed_at
  ) values (
    target_question_id, q.match_id, q.room_id, participants, render_skew,
    input_skew, max_rtt, hidden_count, verdict, reasons, now()
  )
  on conflict (question_id) do update set
    participant_count = excluded.participant_count,
    render_skew_ms = excluded.render_skew_ms,
    input_skew_ms = excluded.input_skew_ms,
    max_clock_rtt_ms = excluded.max_clock_rtt_ms,
    hidden_participant_count = excluded.hidden_participant_count,
    decision = case when question_fairness_assessments.decision = 'voided' then 'voided' else excluded.decision end,
    reasons = excluded.reasons,
    assessed_at = excluded.assessed_at
  returning * into result;
  return result;
end;
$$;

create or replace function public.acknowledge_question_delivery(
  target_question_id uuid,
  target_client_session_id uuid,
  target_phase text,
  target_client_reported_at timestamptz default null,
  target_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  actor uuid := (select auth.uid());
  q record;
  receipt public.round_delivery_receipts%rowtype;
  assessment public.question_fairness_assessments%rowtype;
  stamped_at timestamptz := clock_timestamp();
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if target_phase not in ('received','rendered','input_enabled','audio_ready','answer_sent') then
    raise exception 'Unsupported delivery phase';
  end if;
  if jsonb_typeof(coalesce(target_metrics, '{}'::jsonb)) <> 'object' then raise exception 'Metrics must be an object'; end if;

  select questions.match_id, matches.room_id into q
  from public.questions join public.matches on matches.id = questions.match_id
  where questions.id = target_question_id;
  if not found or not private.is_room_member(q.room_id) then raise exception 'Room membership required'; end if;

  insert into public.round_delivery_receipts (
    question_id, match_id, room_id, user_id, client_session_id,
    client_reported_at, clock_offset_ms, clock_rtt_ms, realtime_state,
    webrtc_state, document_visibility, network_effective_type, metadata
  ) values (
    target_question_id, q.match_id, q.room_id, actor, target_client_session_id,
    target_client_reported_at,
    nullif(target_metrics ->> 'clockOffsetMs','')::numeric,
    nullif(target_metrics ->> 'clockRttMs','')::numeric,
    left(target_metrics ->> 'realtimeState', 40),
    left(target_metrics ->> 'webrtcState', 40),
    left(target_metrics ->> 'visibility', 20),
    left(target_metrics ->> 'effectiveType', 20),
    coalesce(target_metrics - array['clockOffsetMs','clockRttMs','realtimeState','webrtcState','visibility','effectiveType'], '{}'::jsonb)
  )
  on conflict (question_id, user_id, client_session_id) do update set
    client_reported_at = coalesce(excluded.client_reported_at, round_delivery_receipts.client_reported_at),
    clock_offset_ms = coalesce(excluded.clock_offset_ms, round_delivery_receipts.clock_offset_ms),
    clock_rtt_ms = coalesce(excluded.clock_rtt_ms, round_delivery_receipts.clock_rtt_ms),
    realtime_state = coalesce(excluded.realtime_state, round_delivery_receipts.realtime_state),
    webrtc_state = coalesce(excluded.webrtc_state, round_delivery_receipts.webrtc_state),
    document_visibility = coalesce(excluded.document_visibility, round_delivery_receipts.document_visibility),
    network_effective_type = coalesce(excluded.network_effective_type, round_delivery_receipts.network_effective_type),
    metadata = round_delivery_receipts.metadata || excluded.metadata,
    updated_at = stamped_at
  returning * into receipt;

  update public.round_delivery_receipts set
    received_at = case when target_phase = 'received' then coalesce(received_at, stamped_at) else received_at end,
    rendered_at = case when target_phase = 'rendered' then coalesce(rendered_at, stamped_at) else rendered_at end,
    input_enabled_at = case when target_phase = 'input_enabled' then coalesce(input_enabled_at, stamped_at) else input_enabled_at end,
    audio_ready_at = case when target_phase = 'audio_ready' then coalesce(audio_ready_at, stamped_at) else audio_ready_at end,
    answer_sent_at = case when target_phase = 'answer_sent' then coalesce(answer_sent_at, stamped_at) else answer_sent_at end,
    updated_at = stamped_at
  where id = receipt.id returning * into receipt;

  assessment := private.refresh_question_fairness(target_question_id);
  return jsonb_build_object(
    'receiptId', receipt.id,
    'serverReceivedAt', stamped_at,
    'decision', assessment.decision,
    'inputSkewMs', assessment.input_skew_ms,
    'participantCount', assessment.participant_count
  );
end;
$$;

revoke execute on function public.acknowledge_question_delivery(uuid, uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.acknowledge_question_delivery(uuid, uuid, text, timestamptz, jsonb) to authenticated;

-- Prompt and model behavior is versioned independently from deployments.
create table if not exists public.ai_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_key text not null,
  version integer not null check (version > 0),
  provider text not null,
  model text not null,
  template text not null,
  schema_version text not null,
  policy_version text not null,
  status text not null default 'draft' check (status in ('draft','active','retired')),
  checksum text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique(prompt_key, version),
  unique(prompt_key, checksum)
);

alter table public.generation_jobs
  add column if not exists prompt_version text not null default 'generation-v2',
  add column if not exists quality_policy_version text not null default 'quality-2026-08-30';

create unique index if not exists ai_prompt_one_active_idx
  on public.ai_prompt_versions(prompt_key) where status = 'active';

create table if not exists public.ai_evaluation_cases (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  suite text not null,
  case_type text not null check (case_type in ('blueprint','question_batch','semantic_answer','speaking','writing')),
  input jsonb not null,
  expectations jsonb not null,
  tags text[] not null default '{}',
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(input) = 'object'),
  check (jsonb_typeof(expectations) = 'object')
);

create table if not exists public.ai_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  suite text not null,
  prompt_version_id uuid references public.ai_prompt_versions(id) on delete set null,
  provider text not null,
  model text not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  total_cases integer not null default 0,
  passed_cases integer not null default 0,
  failed_cases integer not null default 0,
  aggregate_score numeric(7,4),
  started_at timestamptz,
  completed_at timestamptz,
  requested_by uuid references public.profiles(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_evaluation_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_evaluation_runs(id) on delete cascade,
  case_id uuid not null references public.ai_evaluation_cases(id) on delete cascade,
  passed boolean not null,
  score numeric(7,4) not null check (score between 0 and 1),
  checks jsonb not null,
  output jsonb,
  latency_ms integer,
  error_message text,
  created_at timestamptz not null default now(),
  unique(run_id, case_id),
  check (jsonb_typeof(checks) = 'array')
);

create table if not exists public.question_quality_audits (
  id uuid primary key default gen_random_uuid(),
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  question_id uuid references public.questions(id) on delete cascade,
  batch_round_start integer,
  prompt_version text not null,
  policy_version text not null,
  passed boolean not null,
  score numeric(7,4) not null check (score between 0 and 1),
  checks jsonb not null,
  content_fingerprint text,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(checks) = 'array')
);

create index if not exists question_quality_job_idx on public.question_quality_audits(generation_job_id, created_at);
create unique index if not exists question_quality_batch_unique_idx
  on public.question_quality_audits(generation_job_id, batch_round_start, prompt_version)
  where generation_job_id is not null and batch_round_start is not null;

alter table public.ai_prompt_versions enable row level security;
alter table public.ai_evaluation_cases enable row level security;
alter table public.ai_evaluation_runs enable row level security;
alter table public.ai_evaluation_results enable row level security;
alter table public.question_quality_audits enable row level security;
revoke all on table public.ai_prompt_versions, public.ai_evaluation_cases,
  public.ai_evaluation_runs, public.ai_evaluation_results,
  public.question_quality_audits from anon, authenticated;

-- Every moderation decision is append-only and attributable.
create table if not exists public.content_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.learning_content(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('approve','reject','quarantine','restore','edit_attribution')),
  previous_status text,
  next_status text,
  note text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(evidence) = 'object')
);

create index if not exists moderation_actions_content_idx
  on public.content_moderation_actions(content_id, created_at desc);
alter table public.content_moderation_actions enable row level security;
revoke all on table public.content_moderation_actions from anon, authenticated;

-- Operational alerts are durable acknowledgable records rather than transient
-- UI toasts. Rules are created by administrators; none are seeded here.
create table if not exists public.operational_alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  metric text not null,
  comparator text not null check (comparator in ('gt','gte','lt','lte','eq')),
  threshold numeric not null,
  window_minutes integer not null check (window_minutes between 1 and 10080),
  severity text not null check (severity in ('info','warning','error','critical')),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid references public.operational_alert_rules(id) on delete set null,
  fingerprint text not null,
  metric text not null,
  observed_value numeric,
  threshold numeric,
  severity text not null check (severity in ('info','warning','error','critical')),
  title text not null,
  detail text,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  unique(fingerprint)
);

alter table public.operational_alert_rules enable row level security;
alter table public.operational_alerts enable row level security;
revoke all on table public.operational_alert_rules, public.operational_alerts from anon, authenticated;

-- Safety primitives. Blocking is user controlled; reports and moderation
-- actions cannot be read by ordinary users after submission.
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  primary key(blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.room_members
  add column if not exists moderation_muted boolean not null default false;

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  category text not null check (category in ('harassment','spam','cheating','unsafe_content','privacy','other')),
  detail text not null check (char_length(detail) between 5 and 2000),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  assigned_to uuid references public.profiles(id) on delete set null,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reporter_id <> reported_user_id),
  check (jsonb_typeof(evidence) = 'object')
);

create table if not exists public.room_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  target_user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('mute','unmute','kick')),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (actor_id <> target_user_id)
);

alter table public.user_blocks enable row level security;
alter table public.user_reports enable row level security;
alter table public.room_moderation_actions enable row level security;

drop policy if exists "users manage own blocks" on public.user_blocks;
create policy "users manage own blocks" on public.user_blocks
  for all to authenticated using (blocker_id = (select auth.uid()))
  with check (blocker_id = (select auth.uid()));
drop policy if exists "users submit reports" on public.user_reports;
create policy "users submit reports" on public.user_reports
  for insert to authenticated with check (reporter_id = (select auth.uid()));
drop policy if exists "users read own reports" on public.user_reports;
create policy "users read own reports" on public.user_reports
  for select to authenticated using (reporter_id = (select auth.uid()));
drop policy if exists "room members read room moderation" on public.room_moderation_actions;
create policy "room members read room moderation" on public.room_moderation_actions
  for select to authenticated using (private.is_room_member(room_id));

grant select, insert, delete on table public.user_blocks to authenticated;
grant select, insert on table public.user_reports to authenticated;
grant select on table public.room_moderation_actions to authenticated;

create or replace function public.moderate_room_member(
  target_room_id uuid,
  target_user_id uuid,
  target_action text,
  target_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  actor uuid := (select auth.uid());
  room_row public.rooms%rowtype;
begin
  if target_action not in ('mute','unmute','kick') then raise exception 'Unsupported moderation action'; end if;
  select * into room_row from public.rooms where id = target_room_id for update;
  if room_row.id is null then raise exception 'Room not found'; end if;
  if actor <> room_row.host_id and not public.is_platform_admin(array['owner','admin','moderator']) then
    raise exception 'Only the room host can moderate this room';
  end if;
  if target_user_id = actor then raise exception 'Cannot moderate yourself'; end if;
  if not exists (select 1 from public.room_members where room_id = target_room_id and user_id = target_user_id) then
    raise exception 'Target is not a room member';
  end if;

  insert into public.room_moderation_actions(room_id, actor_id, target_user_id, action, reason)
  values(target_room_id, actor, target_user_id, target_action, nullif(trim(target_reason),''));
  if target_action = 'mute' then
    update public.room_members set moderation_muted = true where room_id = target_room_id and user_id = target_user_id;
  elsif target_action = 'unmute' then
    update public.room_members set moderation_muted = false where room_id = target_room_id and user_id = target_user_id;
  elsif target_action = 'kick' then
    delete from public.room_members where room_id = target_room_id and user_id = target_user_id;
  end if;
  return jsonb_build_object('ok', true, 'action', target_action, 'targetUserId', target_user_id);
end;
$$;

revoke execute on function public.moderate_room_member(uuid, uuid, text, text) from public, anon;
grant execute on function public.moderate_room_member(uuid, uuid, text, text) to authenticated;

-- Blocked users cannot create new social relationships or invite each other.
drop policy if exists "users create friendships" on public.friendships;
create policy "users create friendships" on public.friendships for insert to authenticated
with check (
  requester_id = (select auth.uid())
  and requester_id <> addressee_id
  and not exists (
    select 1 from public.user_blocks
    where (blocker_id = requester_id and blocked_id = addressee_id)
       or (blocker_id = addressee_id and blocked_id = requester_id)
  )
);

drop policy if exists "room members send invites" on public.room_invites;
create policy "room members send invites" on public.room_invites for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and private.is_room_member(room_id)
  and sender_id <> recipient_id
  and not exists (
    select 1 from public.user_blocks
    where (blocker_id = sender_id and blocked_id = recipient_id)
       or (blocker_id = recipient_id and blocked_id = sender_id)
  )
);

-- Optional Web Push registrations; no notification or sample is created.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  enabled boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
create policy "users manage own push subscriptions" on public.push_subscriptions
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

create table if not exists public.push_delivery_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid references public.push_subscriptions(id) on delete set null,
  notification_type text not null,
  status text not null check (status in ('sent','expired','failed','skipped')),
  provider_status integer,
  error_code text,
  created_at timestamptz not null default now()
);
create index if not exists push_delivery_events_user_created_idx on public.push_delivery_events(user_id, created_at desc);
alter table public.push_delivery_events enable row level security;
revoke all on table public.push_delivery_events from anon, authenticated;

notify pgrst, 'reload schema';
