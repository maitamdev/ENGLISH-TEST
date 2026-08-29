-- Read-only production contract for audit, replay protection and worker leases.
do $$
declare
  table_name text;
  function_signature text;
begin
  foreach table_name in array array['user_security_events', 'api_mutation_receipts', 'worker_execution_leases'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = table_name and c.relkind = 'r') then
      raise exception 'Missing security table: %', table_name;
    end if;
    if not (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = table_name) then
      raise exception 'RLS must be enabled on %', table_name;
    end if;
  end loop;

  if has_table_privilege('anon', 'public.user_security_events', 'SELECT') then
    raise exception 'anon must not read security events';
  end if;
  if not has_table_privilege('authenticated', 'public.user_security_events', 'SELECT') then
    raise exception 'authenticated users need RLS-filtered security-event SELECT';
  end if;
  if has_table_privilege('authenticated', 'public.user_security_events', 'INSERT,UPDATE,DELETE') then
    raise exception 'browser roles must not mutate security events';
  end if;
  if has_table_privilege('authenticated', 'public.api_mutation_receipts', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'mutation receipts are server-only';
  end if;
  if has_table_privilege('authenticated', 'public.worker_execution_leases', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'worker leases are server-only';
  end if;

  foreach function_signature in array array[
    'public.record_user_security_event(uuid,text,text,text,text,uuid,jsonb)',
    'public.claim_api_mutation(uuid,text,uuid,text)',
    'public.complete_api_mutation(uuid,text,uuid,integer,jsonb,boolean)',
    'public.claim_worker_lease(text,uuid,integer)',
    'public.release_worker_lease(text,uuid,text)'
  ] loop
    if has_function_privilege('anon', function_signature, 'EXECUTE') or has_function_privilege('authenticated', function_signature, 'EXECUTE') then
      raise exception 'security RPC leaked to browser role: %', function_signature;
    end if;
    if not has_function_privilege('service_role', function_signature, 'EXECUTE') then
      raise exception 'service role cannot execute security RPC: %', function_signature;
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_user_security_event', 'claim_api_mutation', 'complete_api_mutation', 'claim_worker_lease', 'release_worker_lease')
      and not ('search_path=""' = any(coalesce(p.proconfig, array[]::text[])))
  ) then raise exception 'Every security-definer RPC must pin an empty search_path'; end if;
end;
$$;
