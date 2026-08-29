-- Read-only contracts for the adaptive learning layer. No rows are inserted.
do $$
declare
  required_table text;
  required_function text;
begin
  foreach required_table in array array[
    'public.curriculum_frameworks','public.curriculum_descriptors',
    'public.curriculum_moderation_actions','public.skill_evidence_events',
    'public.learner_skill_mastery','public.placement_sessions',
    'public.placement_items','public.placement_responses',
    'public.shared_learning_goals','public.shared_learning_path_items',
    'public.ai_intervention_events','public.match_recaps',
    'public.notification_preferences','public.notification_outbox'
  ] loop
    if to_regclass(required_table) is null then raise exception 'Missing adaptive learning table: %', required_table; end if;
  end loop;

  foreach required_function in array array[
    'record_skill_evidence','submit_placement_response','update_shared_learning_goal'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = required_function
    ) then raise exception 'Missing adaptive learning function: %', required_function; end if;
  end loop;

  if has_table_privilege('anon', 'public.curriculum_descriptors', 'SELECT') then
    raise exception 'anon must not read curriculum descriptors';
  end if;
  if has_table_privilege('authenticated', 'public.curriculum_descriptors', 'INSERT') then
    raise exception 'authenticated must not insert curriculum descriptors directly';
  end if;
  if has_table_privilege('authenticated', 'public.placement_items', 'SELECT') then
    raise exception 'authenticated must not directly read private placement items';
  end if;
  if has_table_privilege('authenticated', 'public.skill_evidence_events', 'INSERT') then
    raise exception 'authenticated must not forge mastery evidence';
  end if;
  if has_table_privilege('authenticated', 'public.shared_learning_goals', 'UPDATE') then
    raise exception 'shared goals must only be updated through the guarded RPC';
  end if;
  if has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT') then
    raise exception 'authenticated must not inspect notification outbox rows';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'placement_sessions' and column_name = 'generation_token'
  ) then raise exception 'placement generation lease token is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'placement_sessions' and column_name = 'generation_started_at'
  ) then raise exception 'placement generation lease timestamp is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_intervention_events' and column_name = 'ui_message_vi'
  ) then raise exception 'intervention UI message boundary is missing'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'shared_learning_goals'
      and qual ilike '%user_blocks%'
  ) then raise exception 'shared goal read policy must enforce the block boundary'; end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'placement_sessions' and c.relrowsecurity
  ) then raise exception 'placement_sessions RLS is not enabled'; end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'shared_learning_goals' and c.relrowsecurity
  ) then raise exception 'shared_learning_goals RLS is not enabled'; end if;
end;
$$;
