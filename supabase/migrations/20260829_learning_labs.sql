-- LexiDuel learning labs
-- Adds listening, shadowing, sentence-building and grammar-repair modes without seed data.

alter table public.questions drop constraint if exists questions_mode_check;
alter table public.questions add constraint questions_mode_check check (mode in (
  'VI_TO_EN','EN_TO_VI','LISTENING','SPELLING','MINIMAL_PAIRS','AUDIO_CHOICE','STORY_LISTENING','SHADOWING',
  'MULTIPLE_CHOICE','READING','SENTENCE_BUILDER','CLOZE','ERROR_CORRECTION','COLLOCATION','CONTEXT','GRAMMAR',
  'TRANSLATION','DEFINITION','PRONUNCIATION','SPEAKING','ROLEPLAY','DEBATE','WRITING','BOSS'
));

-- Rubric questions must only be persisted by the protected Gemini grading routes.
create or replace function private.enforce_rubric_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_mode text;
begin
  select mode into target_mode from public.questions where id = new.question_id;
  if target_mode in ('PRONUNCIATION','SHADOWING','SPEAKING','ROLEPLAY','DEBATE','WRITING')
    and not new.timed_out
    and new.match_type is distinct from 'rubric' then
    raise exception 'This answer must be graded through its rubric endpoint';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_rubric_submission on public.submissions;
create trigger enforce_rubric_submission
before insert on public.submissions
for each row execute function private.enforce_rubric_submission();

create or replace function public.record_spoken_assessment(target_question_id uuid, target_user_id uuid, assessment jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  q public.questions%rowtype;
  m public.matches%rowtype;
  existing public.submissions%rowtype;
  elapsed_ms integer;
  overall numeric;
  threshold integer;
  passed boolean;
  points integer;
  hint_count integer := 0;
  hint_penalty integer := 20;
  transcript text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(assessment) <> 'object' then raise exception 'Assessment is invalid'; end if;
  select * into q from public.questions where id = target_question_id;
  if q.id is null or q.mode not in ('PRONUNCIATION','SHADOWING','SPEAKING','ROLEPLAY','DEBATE') then raise exception 'Spoken question not found'; end if;
  select * into m from public.matches where id = q.match_id for update;
  if m.status <> 'active' or m.current_round <> q.round_number then raise exception 'Round is not active'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = target_user_id) then raise exception 'Not a match player'; end if;
  select * into existing from public.submissions where question_id = q.id and user_id = target_user_id;
  if existing.id is not null then return jsonb_build_object('submissionId', existing.id, 'alreadySubmitted', true); end if;

  overall := greatest(0, least(100, coalesce((assessment ->> 'overall')::numeric, 0)));
  threshold := case coalesce(m.blueprint #>> '{settings,strictness}', 'STANDARD') when 'LENIENT' then 55 when 'STRICT' then 75 else 65 end;
  passed := overall >= threshold;
  transcript := left(coalesce(assessment ->> 'transcript', ''), 2000);
  elapsed_ms := greatest(0, floor(extract(epoch from (clock_timestamp() - m.round_started_at)) * 1000)::integer);
  select count(*) into hint_count from public.match_hints where question_id = q.id and user_id = target_user_id;
  hint_penalty := coalesce((m.blueprint #>> '{settings,hintPenalty}')::integer, 20);
  points := greatest(0, round(overall * 1.5)::integer - hint_count * hint_penalty);

  insert into public.submissions (match_id, question_id, user_id, answer, normalized_answer, is_correct, timed_out, matched_answer, match_type, response_ms, points, hints_used, rubric_score, assessment)
  values (m.id, q.id, target_user_id, case when transcript = '' then '[Audio response]' else transcript end, private.normalize_game_answer(transcript), passed, false, null, 'rubric', elapsed_ms, points, hint_count, overall, assessment)
  returning * into existing;
  insert into public.speaking_assessments (submission_id, transcript, content_score, pronunciation_score, fluency_score, grammar_score, vocabulary_score, overall_score, feedback_vi, strengths, improvements)
  values (existing.id, transcript, coalesce((assessment ->> 'content')::numeric,0), coalesce((assessment ->> 'pronunciation')::numeric,0), coalesce((assessment ->> 'fluency')::numeric,0), coalesce((assessment ->> 'grammar')::numeric,0), coalesce((assessment ->> 'vocabulary')::numeric,0), overall, coalesce(assessment ->> 'feedbackVi',''), coalesce(assessment -> 'strengths','[]'::jsonb), coalesce(assessment -> 'improvements','[]'::jsonb));
  update public.match_players set score = score + points, current_streak = case when passed then current_streak + 1 else 0 end, correct_count = correct_count + case when passed then 1 else 0 end, incorrect_count = incorrect_count + case when passed then 0 else 1 end, best_streak = greatest(best_streak, case when passed then current_streak + 1 else current_streak end), avg_response_ms = round(((coalesce(avg_response_ms,0) * (correct_count + incorrect_count)) + elapsed_ms)::numeric / (correct_count + incorrect_count + 1)) where match_id = m.id and user_id = target_user_id;
  if (select count(*) from public.submissions where question_id = q.id) = (select count(*) from public.match_players where match_id = m.id) then update public.rooms set status = 'ROUND_RESULT' where id = m.room_id; end if;
  return jsonb_build_object('submissionId', existing.id, 'correct', passed, 'points', points, 'rubricScore', overall, 'alreadySubmitted', false);
end;
$$;

revoke execute on function public.record_spoken_assessment(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_spoken_assessment(uuid, uuid, jsonb) to service_role;
