-- LexiDuel production hardening
-- Adds shared generation progress and keeps listening transcripts private until review.

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'generating', 'persisting', 'completed', 'failed')),
  stage text not null default 'Đang chuẩn bị',
  total_rounds integer check (total_rounds between 5 and 50),
  completed_rounds integer not null default 0 check (completed_rounds between 0 and 50),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists generation_jobs_room_created_idx
on public.generation_jobs(room_id, created_at desc);

alter table public.generation_jobs enable row level security;
drop policy if exists "room members can view generation progress" on public.generation_jobs;
create policy "room members can view generation progress"
on public.generation_jobs for select to authenticated
using (private.is_room_member(room_id));

revoke all on table public.generation_jobs from anon;
revoke insert, update, delete on table public.generation_jobs from authenticated;
grant select on table public.generation_jobs to authenticated;

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
  elsif tg_table_name = 'room_members' or tg_table_name = 'matches' or tg_table_name = 'generation_jobs' then
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

drop trigger if exists broadcast_generation_job_change on public.generation_jobs;
create trigger broadcast_generation_job_change
after insert or update or delete on public.generation_jobs
for each row execute function private.broadcast_room_state();

-- Remove secrets from legacy public payloads after copying them to protected grading rules.
update public.question_answers qa
set grading_rules = coalesce(qa.grading_rules, '{}'::jsonb)
  || jsonb_build_object('audioText', q.public_payload ->> 'audioText')
from public.questions q
where q.id = qa.question_id
  and q.mode in ('LISTENING', 'SPELLING')
  and q.public_payload ? 'audioText'
  and not (coalesce(qa.grading_rules, '{}'::jsonb) ? 'audioText');

update public.questions
set public_payload = public_payload - 'audioText'
where mode in ('LISTENING', 'SPELLING')
  and public_payload ? 'audioText';
