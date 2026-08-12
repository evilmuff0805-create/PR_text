-- 다화자 상한이 20분에서 30분으로 늘어나면서 작업 하나가 도는 시간도 약 9.6분에서
-- 약 14.5분으로 길어진다. heartbeat는 30초 간격이라 작업이 길수록 갱신 기회가 늘고,
-- 그만큼 일시적인 DB·네트워크 지연이 3분 창을 넘길 확률도 함께 커진다. 창을 넘기면
-- 다른 worker가 같은 작업을 중복 claim해 OpenAI 전사 비용을 두 번 내게 된다.
--
-- 배포로 인한 컨테이너 교체는 이제 SIGTERM에서 lease를 즉시 반납하므로 이 창에
-- 의존하지 않는다. 남은 용도는 worker가 반납할 틈도 없이 죽는 경우의 회수뿐이라
-- 창을 넉넉히 잡아도 사용자 대기 시간에는 영향이 없다.

create or replace function public.claim_diarization_job(p_worker_token uuid)
returns setof public.transcription_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select id
    from public.transcription_jobs
    where status = 'queued'
       or (
         status = 'running'
         and coalesce(locked_at, '-infinity'::timestamptz) < now() - interval '10 minutes'
       )
    order by created_at
    for update skip locked
    limit 1
  )
  update public.transcription_jobs as jobs
  set status = 'running',
      worker_token = p_worker_token,
      locked_at = now(),
      started_at = coalesce(jobs.started_at, now()),
      attempt_count = jobs.attempt_count + 1,
      error_message = null,
      updated_at = now()
  from candidate
  where jobs.id = candidate.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_diarization_job(uuid) from public, anon, authenticated;

grant execute on function public.claim_diarization_job(uuid) to service_role;

notify pgrst, 'reload schema';
