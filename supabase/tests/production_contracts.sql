-- Read-only deployment contract checks. This file inserts no test or mock rows.
do $$
declare
  required_table text;
  required_function text;
begin
  foreach required_table in array array[
    'public.room_operations','public.generation_job_states','public.question_audio_assets',
    'public.answer_appeals','public.telemetry_events','public.privacy_preferences',
    'public.learning_sources','public.learning_content','public.review_cards',
    'public.learning_errors','public.study_plans','public.speaking_sessions',
    'public.pronunciation_feedback','public.friendships','public.player_ratings'
  ] loop
    if to_regclass(required_table) is null then raise exception 'Missing required table: %', required_table; end if;
  end loop;

  foreach required_function in array array[
    'heartbeat_room','schedule_match_round','claim_generation_job','release_generation_job',
    'submit_answer','apply_answer_appeal','record_fsrs_review','record_speaking_exchange',
    'finalize_match_ratings'
  ] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = required_function) then
      raise exception 'Missing required public function: %', required_function;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.question_answers', 'SELECT') then
    raise exception 'authenticated must not receive SELECT on question_answers';
  end if;
  if has_table_privilege('anon', 'public.telemetry_events', 'SELECT') then
    raise exception 'anon must not read telemetry_events';
  end if;
  if not exists (select 1 from storage.buckets where id = 'question-audio' and public = false) then
    raise exception 'Private question-audio bucket is missing';
  end if;
  if not exists (select 1 from storage.buckets where id = 'user-exports' and public = false) then
    raise exception 'Private user-exports bucket is missing';
  end if;
end;
$$;
