-- Read-only contract for the head-to-head aggregate boundary.
do $$
begin
  if not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'get_head_to_head_insights'
  ) then raise exception 'Missing head-to-head insights RPC'; end if;
  if has_function_privilege('anon', 'public.get_head_to_head_insights(uuid)', 'EXECUTE') then
    raise exception 'anon must not execute head-to-head insights';
  end if;
  if not has_function_privilege('authenticated', 'public.get_head_to_head_insights(uuid)', 'EXECUTE') then
    raise exception 'authenticated users need the guarded insights RPC';
  end if;
end;
$$;
