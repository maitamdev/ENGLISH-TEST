-- Production security control plane. This migration creates no sample or seed data.

create table if not exists public.user_security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 3 and 80),
  severity text not null default 'info' check (severity in ('info', 'warning', 'high', 'critical')),
  outcome text not null check (outcome in ('success', 'blocked', 'failed')),
  resource_type text check (resource_type is null or char_length(resource_type) <= 40),
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '180 days')
);

create index if not exists user_security_events_user_time_idx
  on public.user_security_events(user_id, occurred_at desc);
create index if not exists user_security_events_expiry_idx
  on public.user_security_events(expires_at);

alter table public.user_security_events enable row level security;
revoke all on table public.user_security_events from public, anon, authenticated;
grant select on table public.user_security_events to authenticated;

drop policy if exists "Users read their security events" on public.user_security_events;
create policy "Users read their security events"
  on public.user_security_events for select to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.api_mutation_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null check (char_length(scope) between 3 and 80),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'claimed' check (status in ('claimed', 'completed', 'failed')),
  response_status integer check (response_status is null or response_status between 100 and 599),
  response_body jsonb,
  claimed_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  primary key (user_id, scope, idempotency_key)
);

create index if not exists api_mutation_receipts_expiry_idx
  on public.api_mutation_receipts(expires_at);
alter table public.api_mutation_receipts enable row level security;
revoke all on table public.api_mutation_receipts from public, anon, authenticated;

create table if not exists public.worker_execution_leases (
  worker_key text primary key check (char_length(worker_key) between 3 and 80),
  lease_token uuid not null,
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_completed_at timestamptz,
  last_outcome text check (last_outcome is null or last_outcome in ('success', 'failed'))
);

alter table public.worker_execution_leases enable row level security;
revoke all on table public.worker_execution_leases from public, anon, authenticated;

create or replace function public.record_user_security_event(
  target_user_id uuid,
  target_event_type text,
  target_severity text,
  target_outcome text,
  target_resource_type text default null,
  target_resource_id uuid default null,
  target_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if target_event_type is null or char_length(target_event_type) not between 3 and 80 then
    raise exception 'Invalid event type';
  end if;
  if target_severity not in ('info', 'warning', 'high', 'critical') then
    raise exception 'Invalid severity';
  end if;
  if target_outcome not in ('success', 'blocked', 'failed') then
    raise exception 'Invalid outcome';
  end if;

  insert into public.user_security_events (
    user_id, event_type, severity, outcome, resource_type, resource_id, metadata
  ) values (
    target_user_id,
    target_event_type,
    target_severity,
    target_outcome,
    nullif(left(coalesce(target_resource_type, ''), 40), ''),
    target_resource_id,
    case
      when jsonb_typeof(coalesce(target_metadata, '{}'::jsonb)) = 'object'
        then coalesce(target_metadata, '{}'::jsonb)
      else '{}'::jsonb
    end
  ) returning id into event_id;

  return event_id;
end;
$$;

create or replace function public.claim_api_mutation(
  target_user_id uuid,
  target_scope text,
  target_idempotency_key uuid,
  target_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.api_mutation_receipts%rowtype;
  inserted_count integer := 0;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;

  delete from public.api_mutation_receipts
  where expires_at <= clock_timestamp();

  insert into public.api_mutation_receipts (user_id, scope, idempotency_key, request_hash)
  values (target_user_id, left(target_scope, 80), target_idempotency_key, target_request_hash)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;

  select * into receipt
  from public.api_mutation_receipts
  where user_id = target_user_id
    and scope = left(target_scope, 80)
    and idempotency_key = target_idempotency_key
  for update;

  if receipt.request_hash <> target_request_hash then
    return jsonb_build_object('state', 'conflict');
  end if;

  if inserted_count = 1 then
    return jsonb_build_object('state', 'claimed');
  end if;

  if receipt.status in ('completed', 'failed') then
    return jsonb_build_object(
      'state', 'replay',
      'responseStatus', receipt.response_status,
      'responseBody', receipt.response_body
    );
  end if;

  if receipt.claimed_at < clock_timestamp() - interval '2 minutes' then
    update public.api_mutation_receipts
    set claimed_at = clock_timestamp()
    where user_id = target_user_id and scope = receipt.scope and idempotency_key = target_idempotency_key;
    return jsonb_build_object('state', 'claimed');
  end if;

  return jsonb_build_object('state', 'processing');
end;
$$;

create or replace function public.complete_api_mutation(
  target_user_id uuid,
  target_scope text,
  target_idempotency_key uuid,
  target_status integer,
  target_body jsonb,
  target_failed boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  update public.api_mutation_receipts
  set status = case when target_failed then 'failed' else 'completed' end,
      response_status = target_status,
      response_body = target_body,
      completed_at = clock_timestamp()
  where user_id = target_user_id
    and scope = left(target_scope, 80)
    and idempotency_key = target_idempotency_key;
end;
$$;

create or replace function public.claim_worker_lease(
  target_worker_key text,
  target_lease_token uuid,
  target_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if target_lease_seconds not between 15 and 900 then
    raise exception 'Invalid lease duration';
  end if;

  insert into public.worker_execution_leases (worker_key, lease_token, expires_at)
  values (left(target_worker_key, 80), target_lease_token, clock_timestamp() + make_interval(secs => target_lease_seconds))
  on conflict (worker_key) do update
    set lease_token = excluded.lease_token,
        acquired_at = clock_timestamp(),
        expires_at = excluded.expires_at
    where public.worker_execution_leases.expires_at <= clock_timestamp();

  return exists (
    select 1 from public.worker_execution_leases
    where worker_key = left(target_worker_key, 80) and lease_token = target_lease_token
  );
end;
$$;

create or replace function public.release_worker_lease(
  target_worker_key text,
  target_lease_token uuid,
  target_outcome text default 'success'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  update public.worker_execution_leases
  set expires_at = clock_timestamp(), last_completed_at = clock_timestamp(), last_outcome = target_outcome
  where worker_key = left(target_worker_key, 80) and lease_token = target_lease_token;
end;
$$;

revoke execute on function public.record_user_security_event(uuid, text, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.claim_api_mutation(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.complete_api_mutation(uuid, text, uuid, integer, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.claim_worker_lease(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.release_worker_lease(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_user_security_event(uuid, text, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.claim_api_mutation(uuid, text, uuid, text) to service_role;
grant execute on function public.complete_api_mutation(uuid, text, uuid, integer, jsonb, boolean) to service_role;
grant execute on function public.claim_worker_lease(text, uuid, integer) to service_role;
grant execute on function public.release_worker_lease(text, uuid, text) to service_role;
