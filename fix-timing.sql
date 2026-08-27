
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
