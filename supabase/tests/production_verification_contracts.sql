-- Read-only contracts for production verification. No test rows are created.
do $$
declare
  required_table text;
  required_function text;
begin
  foreach required_table in array array[
    'public.platform_admins','public.round_delivery_receipts',
    'public.question_fairness_assessments','public.ai_prompt_versions',
    'public.ai_evaluation_cases','public.ai_evaluation_runs',
    'public.ai_evaluation_results','public.question_quality_audits',
    'public.content_moderation_actions','public.operational_alert_rules',
    'public.operational_alerts','public.user_blocks','public.user_reports',
    'public.room_moderation_actions','public.push_subscriptions',
    'public.push_delivery_events'
  ] loop
    if to_regclass(required_table) is null then raise exception 'Missing required table: %', required_table; end if;
  end loop;

  foreach required_function in array array[
    'is_platform_admin','acknowledge_question_delivery','moderate_room_member'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = required_function
    ) then raise exception 'Missing required public function: %', required_function; end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ai_evaluation_results', 'SELECT') then
    raise exception 'authenticated must not directly read AI evaluation results';
  end if;
  if has_table_privilege('authenticated', 'public.operational_alerts', 'SELECT') then
    raise exception 'authenticated must not directly read operational alerts';
  end if;
  if has_table_privilege('anon', 'public.round_delivery_receipts', 'SELECT') then
    raise exception 'anon must not read delivery receipts';
  end if;
  if has_table_privilege('authenticated', 'public.round_delivery_receipts', 'INSERT') then
    raise exception 'delivery receipts must only be written through the RPC';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'room_members'
      and column_name = 'moderation_muted'
  ) then raise exception 'room_members.moderation_muted is missing'; end if;
end;
$$;
