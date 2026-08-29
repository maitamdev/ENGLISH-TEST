-- Read-only database contracts. This file creates no test or learning rows.
do $$
declare
  target text;
begin
  foreach target in array array[
    'public.user_arena_presets','public.match_adaptive_contexts',
    'public.room_readiness_events','public.match_remediation_items',
    'public.match_connectivity_incidents'
  ] loop
    if to_regclass(target) is null then raise exception 'Missing arena orchestration table: %', target; end if;
  end loop;
  if has_table_privilege('anon', 'public.user_arena_presets', 'SELECT') then raise exception 'anon must not read arena presets'; end if;
  if has_table_privilege('authenticated', 'public.match_adaptive_contexts', 'INSERT') then raise exception 'clients must not forge adaptive context'; end if;
  if has_table_privilege('authenticated', 'public.match_remediation_items', 'UPDATE') then raise exception 'remediation updates must use the guarded RPC'; end if;
  if has_table_privilege('authenticated', 'public.room_readiness_events', 'INSERT') then raise exception 'clients must not forge readiness evidence'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'update_match_remediation') then raise exception 'Missing remediation RPC'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_match_connectivity') then raise exception 'Missing connectivity RPC'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'capture_match_remediation' and not tgisinternal) then raise exception 'Missing remediation trigger'; end if;
end;
$$;
