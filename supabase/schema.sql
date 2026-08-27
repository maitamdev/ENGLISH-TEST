create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create type public.room_status as enum (
  'ROOM_IDLE', 'AI_JOINING', 'AI_DISCUSSION', 'CONFIG_PROPOSED',
  'PLAYERS_CONFIRMING', 'GENERATING_GAME', 'GAME_READY', 'COUNTDOWN',
  'ROUND_ACTIVE', 'ROUND_RESOLVING', 'ROUND_RESULT', 'MATCH_RESULT', 'AI_REVIEW'
);

create type public.match_status as enum ('draft', 'generating', 'ready', 'active', 'completed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique check (username is null or username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_url text,
  cefr_estimate text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null references public.profiles(id) on delete cascade,
  status public.room_status not null default 'ROOM_IDLE',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  is_ready boolean not null default false,
  connection_state text not null default 'connected' check (connection_state in ('connected', 'reconnecting', 'disconnected')),
  primary key (room_id, user_id)
);

create table public.ai_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  coordinator_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  state jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  topic text not null check (char_length(topic) between 1 and 80),
  level text not null check (char_length(level) between 1 and 30),
  status public.match_status not null default 'draft',
  blueprint jsonb not null,
  round_count integer not null check (round_count between 1 and 50),
  current_round integer not null default 0 check (current_round >= 0),
  round_started_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  winner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null default 0 check (score >= 0),
  current_streak integer not null default 0 check (current_streak >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  incorrect_count integer not null default 0 check (incorrect_count >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  avg_response_ms integer check (avg_response_ms is null or avg_response_ms >= 0),
  primary key (match_id, user_id)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  round_number integer not null check (round_number > 0),
  mode text not null check (mode in ('VI_TO_EN','EN_TO_VI','LISTENING','SPELLING','CONTEXT','GRAMMAR','TRANSLATION','DEFINITION','BOSS')),
  prompt text not null check (char_length(prompt) between 1 and 1000),
  instruction text not null default '',
  level text not null,
  public_payload jsonb not null default '{}'::jsonb,
  difficulty integer not null check (difficulty between 1 and 10),
  time_limit integer not null check (time_limit between 3 and 180),
  created_at timestamptz not null default now(),
  unique (match_id, round_number)
);

create table public.question_answers (
  question_id uuid primary key references public.questions(id) on delete cascade,
  canonical_answer text not null,
  accepted_answers jsonb not null check (jsonb_typeof(accepted_answers) = 'array' and jsonb_array_length(accepted_answers) > 0),
  grading_rules jsonb not null default '{}'::jsonb,
  explanation text not null
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  answer text not null,
  normalized_answer text not null,
  is_correct boolean not null,
  response_ms integer not null check (response_ms >= 0),
  points integer not null default 0 check (points >= 0),
  server_received_at timestamptz not null default now(),
  unique (question_id, user_id)
);

create table public.user_learning_stats (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  vocabulary_score integer,
  grammar_score integer,
  listening_score integer,
  spelling_score integer,
  translation_score integer,
  current_streak_days integer not null default 0,
  last_practice_date date,
  updated_at timestamptz not null default now(),
  check (vocabulary_score is null or vocabulary_score between 0 and 100),
  check (grammar_score is null or grammar_score between 0 and 100),
  check (listening_score is null or listening_score between 0 and 100),
  check (spelling_score is null or spelling_score between 0 and 100),
  check (translation_score is null or translation_score between 0 and 100)
);

create table public.user_vocabulary (
  user_id uuid not null references public.profiles(id) on delete cascade,
  word text not null,
  meaning text,
  example_sentence text,
  topic text,
  correct_count integer not null default 0 check (correct_count >= 0),
  wrong_count integer not null default 0 check (wrong_count >= 0),
  mastery numeric(5,2) not null default 0 check (mastery between 0 and 100),
  last_seen timestamptz,
  next_review_at timestamptz,
  primary key (user_id, word)
);

create index rooms_code_idx on public.rooms(code);
create index room_members_user_idx on public.room_members(user_id);
create index matches_room_created_idx on public.matches(room_id, created_at desc);
create index match_players_user_idx on public.match_players(user_id, match_id);
create index questions_match_round_idx on public.questions(match_id, round_number);
create index submissions_match_user_idx on public.submissions(match_id, user_id);
create index vocabulary_review_idx on public.user_vocabulary(user_id, next_review_at);

create or replace function private.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members
    where room_id = target_room_id and user_id = (select auth.uid())
  );
$$;

create or replace function private.shares_room_with(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_user_id = (select auth.uid()) or exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = target_user_id
  );
$$;

create or replace function private.is_realtime_room_member(target_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.rooms r
    join public.room_members rm on rm.room_id = r.id
    where rm.user_id = (select auth.uid())
      and target_topic = 'room:' || r.code
  );
$$;

grant execute on function private.is_room_member(uuid) to authenticated, service_role;
grant execute on function private.shares_room_with(uuid) to authenticated, service_role;
grant execute on function private.is_realtime_room_member(text) to authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    null,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'User'
    ), 40),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );
  insert into public.user_learning_stats (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.create_room()
returns table (id uuid, code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  generated_code text;
  created_room_id uuid;
  random_bytes bytea;
  code_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  position_index integer;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  loop
    random_bytes := gen_random_bytes(6);
    generated_code := '';
    for position_index in 0..5 loop
      generated_code := generated_code || substr(code_alphabet, (get_byte(random_bytes, position_index) % char_length(code_alphabet)) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.rooms r where r.code = generated_code);
  end loop;

  insert into public.rooms as created_room (code, host_id)
  values (generated_code, (select auth.uid()))
  returning created_room.id into created_room_id;

  insert into public.room_members (room_id, user_id)
  values (created_room_id, (select auth.uid()));

  return query select created_room_id, generated_code;
end;
$$;

create or replace function public.join_room_by_code(requested_code text)
returns table (id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room public.rooms%rowtype;
  member_count integer;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;

  select * into target_room
  from public.rooms r
  where r.code = upper(trim(requested_code)) and r.expires_at > now()
  for update;

  if target_room.id is null then raise exception 'Room not found or expired'; end if;
  if exists (select 1 from public.room_members where room_id = target_room.id and user_id = (select auth.uid())) then
    return query select target_room.id, target_room.code;
    return;
  end if;

  select count(*) into member_count from public.room_members where room_id = target_room.id;
  if member_count >= 2 then raise exception 'Room is full'; end if;

  insert into public.room_members (room_id, user_id)
  values (target_room.id, (select auth.uid()));

  return query select target_room.id, target_room.code;
end;
$$;

create or replace function public.leave_room(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.room_members where room_id = target_room_id and user_id = (select auth.uid());
  if not exists (select 1 from public.room_members where room_id = target_room_id) then
    delete from public.rooms where id = target_room_id;
  elsif exists (select 1 from public.rooms where id = target_room_id and host_id = (select auth.uid())) then
    update public.rooms
    set host_id = (select user_id from public.room_members where room_id = target_room_id order by joined_at limit 1)
    where id = target_room_id;
  end if;
end;
$$;

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
  correct boolean;
  within_time boolean;
  scored_correct boolean;
  elapsed_ms integer;
  player_streak integer;
  speed_bonus integer;
  streak_bonus integer;
  first_bonus integer;
  awarded_points integer;
  existing public.submissions%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(submitted_answer), '') is null then raise exception 'Answer is required'; end if;
  if char_length(submitted_answer) > 500 then raise exception 'Answer is too long'; end if;

  select * into q from public.questions where id = target_question_id;
  if q.id is null then raise exception 'Question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = current_user_id) then raise exception 'Not a match player'; end if;

  select * into existing from public.submissions where question_id = q.id and user_id = current_user_id;
  if existing.id is not null then
    return jsonb_build_object('submissionId', existing.id, 'correct', existing.is_correct, 'timedOut', existing.response_ms > q.time_limit * 1000, 'points', existing.points, 'responseMs', existing.response_ms, 'alreadySubmitted', true);
  end if;

  select * into secret from public.question_answers where question_id = q.id;
  if secret.question_id is null then raise exception 'Question answer is unavailable'; end if;

  normalized := lower(trim(regexp_replace(regexp_replace(normalize(submitted_answer, NFKC), '[.!?]+$', ''), '\s+', ' ', 'g')));
  select exists (
    select 1 from jsonb_array_elements_text(secret.accepted_answers) as accepted(value)
    where lower(trim(regexp_replace(regexp_replace(normalize(accepted.value, NFKC), '[.!?]+$', ''), '\s+', ' ', 'g'))) = normalized
  ) into correct;

  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - coalesce(m.round_started_at, clock_timestamp()))) * 1000)::integer);
  within_time := elapsed_ms <= q.time_limit * 1000;
  scored_correct := correct and within_time;
  select current_streak into player_streak from public.match_players where match_id = m.id and user_id = current_user_id;

  if scored_correct then
    speed_bonus := greatest(0, round((1 - least(elapsed_ms, q.time_limit * 1000)::numeric / (q.time_limit * 1000)) * 40));
    streak_bonus := least((player_streak + 1) * 4, 20);
    first_bonus := case when exists (select 1 from public.submissions where question_id = q.id and is_correct) then 0 else 10 end;
    awarded_points := 100 + speed_bonus + streak_bonus + first_bonus;
    if q.mode = 'BOSS' then awarded_points := awarded_points * 2; end if;
  else
    awarded_points := 0;
  end if;

  insert into public.submissions (match_id, question_id, user_id, answer, normalized_answer, is_correct, response_ms, points)
  values (m.id, q.id, current_user_id, submitted_answer, normalized, correct, elapsed_ms, awarded_points)
  returning * into existing;

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
    'points', awarded_points,
    'responseMs', elapsed_ms,
    'canonicalAnswer', secret.canonical_answer,
    'acceptedAnswers', secret.accepted_answers,
    'explanation', secret.explanation,
    'alreadySubmitted', false
  );
end;
$$;

revoke execute on function public.create_room() from public, anon;
revoke execute on function public.join_room_by_code(text) from public, anon;
revoke execute on function public.leave_room(uuid) from public, anon;
revoke execute on function public.submit_answer(uuid, text) from public, anon;
grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room_by_code(text) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
grant execute on function public.submit_answer(uuid, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.questions enable row level security;
alter table public.question_answers enable row level security;
alter table public.submissions enable row level security;
alter table public.user_learning_stats enable row level security;
alter table public.user_vocabulary enable row level security;

revoke all on public.profiles, public.rooms, public.room_members, public.ai_sessions, public.matches, public.match_players, public.questions, public.question_answers, public.submissions, public.user_learning_stats, public.user_vocabulary from anon, authenticated;
grant select on public.profiles, public.rooms, public.room_members, public.ai_sessions, public.matches, public.match_players, public.questions, public.submissions, public.user_learning_stats, public.user_vocabulary to authenticated;
grant update (display_name, username, avatar_url, updated_at) on public.profiles to authenticated;
grant update (is_ready, connection_state) on public.room_members to authenticated;

create policy "profiles visible to self and room peers" on public.profiles for select to authenticated using ((select private.shares_room_with(id)));
create policy "users update own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "members read rooms" on public.rooms for select to authenticated using ((select private.is_room_member(id)));
create policy "members read room membership" on public.room_members for select to authenticated using ((select private.is_room_member(room_id)));
create policy "members update own membership" on public.room_members for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "members read ai sessions" on public.ai_sessions for select to authenticated using ((select private.is_room_member(room_id)));
create policy "members read matches" on public.matches for select to authenticated using ((select private.is_room_member(room_id)));
create policy "members read match players" on public.match_players for select to authenticated using (exists (select 1 from public.matches m where m.id = match_id and (select private.is_room_member(m.room_id))));
create policy "members read public questions" on public.questions for select to authenticated using (exists (select 1 from public.matches m where m.id = match_id and (select private.is_room_member(m.room_id))));
create policy "players read submissions after round reveal" on public.submissions for select to authenticated using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.matches m
    join public.rooms r on r.id = m.room_id
    where m.id = match_id
      and (m.status = 'completed' or r.status in ('ROUND_RESULT', 'MATCH_RESULT', 'AI_REVIEW'))
      and (select private.is_room_member(m.room_id))
  )
);
create policy "users read own learning stats" on public.user_learning_stats for select to authenticated using (user_id = (select auth.uid()));
create policy "users read own vocabulary" on public.user_vocabulary for select to authenticated using (user_id = (select auth.uid()));

create policy "room members receive realtime" on realtime.messages
for select to authenticated
using (extension in ('broadcast', 'presence') and (select private.is_realtime_room_member(realtime.topic())));

create policy "room members send realtime" on realtime.messages
for insert to authenticated
with check (extension in ('broadcast', 'presence') and (select private.is_realtime_room_member(realtime.topic())));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "avatar images are public" on storage.objects for select using (bucket_id = 'avatars');
create policy "users upload own avatar" on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users update own avatar" on storage.objects for update to authenticated using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text) with check (bucket_id = 'avatars' and owner_id = (select auth.uid())::text);
create policy "users delete own avatar" on storage.objects for delete to authenticated using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text);

alter publication supabase_realtime add table public.rooms, public.room_members, public.matches, public.match_players, public.questions, public.submissions;

create or replace function public.start_match(target_match_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.matches
  set status = 'active', current_round = 1, started_at = clock_timestamp(), round_started_at = clock_timestamp()
  where id = target_match_id;
end;
$$;

create or replace function public.advance_match(target_match_id uuid, next_round integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.matches
  set current_round = next_round, round_started_at = clock_timestamp()
  where id = target_match_id;
end;
$$;

