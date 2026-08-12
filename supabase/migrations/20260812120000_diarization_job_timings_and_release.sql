-- 다화자 작업의 단계별 계측값을 DB에 보관하고, 종료 신호를 받은 worker가
-- lease를 즉시 반납할 수 있게 한다.
--
-- 계측값을 로그에만 남기던 탓에 Railway 로그 보존 기간(약 5일)이 지나면
-- 오디오 길이 대비 처리 시간을 다시 확인할 수 없었다. 상한 조정 판단에는
-- 누적된 계측이 필요하므로 작업 행에 함께 보관한다.

alter table public.transcription_jobs
  add column if not exists timings jsonb;

comment on column public.transcription_jobs.timings is
  'Worker stage timings and estimated transcription cost. Diagnostics only; never selected by user-facing queries.';

-- 컨테이너가 교체될 때 진행 중이던 작업을 즉시 대기 상태로 되돌린다.
-- 반납하지 않으면 다음 worker가 3분 만료를 기다려야 회수할 수 있다.
create or replace function public.release_diarization_job_lease(
  p_job_id uuid,
  p_worker_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.transcription_jobs
  set status = 'queued',
      worker_token = null,
      locked_at = null,
      updated_at = now()
  where id = p_job_id
    and status = 'running'
    and worker_token = p_worker_token;

  return found;
end;
$$;

revoke all on function public.release_diarization_job_lease(uuid, uuid) from public, anon, authenticated;

grant execute on function public.release_diarization_job_lease(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
