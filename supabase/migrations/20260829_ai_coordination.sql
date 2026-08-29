-- LexiDuel AI coordination and recovery
-- Run after 20260827_production_hardening.sql.

alter table public.ai_sessions
  add column if not exists heartbeat_at timestamptz not null default now();

-- Historical rows predate coordinator leases and must not block a new session.
update public.ai_sessions
set ended_at = now(),
    state = coalesce(state, '{}'::jsonb) || jsonb_build_object('status', 'migrated_closed')
where ended_at is null;

create unique index if not exists ai_sessions_one_active_per_room_idx
on public.ai_sessions(room_id)
where ended_at is null;

create index if not exists ai_sessions_active_heartbeat_idx
on public.ai_sessions(room_id, heartbeat_at desc)
where ended_at is null;

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
  elsif tg_table_name in ('room_members', 'matches', 'generation_jobs', 'ai_sessions') then
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

drop trigger if exists broadcast_ai_session_insert on public.ai_sessions;
create trigger broadcast_ai_session_insert
after insert on public.ai_sessions
for each row execute function private.broadcast_room_state();

drop trigger if exists broadcast_ai_session_end on public.ai_sessions;
create trigger broadcast_ai_session_end
after update of ended_at, state on public.ai_sessions
for each row
when (old.ended_at is distinct from new.ended_at or old.state is distinct from new.state)
execute function private.broadcast_room_state();
