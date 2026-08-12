-- 종료 신호가 claim 응답보다 먼저 도착하면 worker는 자기가 방금 무슨 작업을
-- 잡았는지 모른 채 죽는다. 그 작업은 running으로 남아 stale 창(10분)이 지나야
-- 회수된다. 회수 창을 3분에서 10분으로 넓히면서 이 경우의 대기 시간도 함께
-- 늘어났으므로, 작업 ID를 몰라도 worker 토큰만으로 반납할 수 있게 한다.
--
-- 시그니처는 그대로 두고 p_job_id를 선택 인자로 바꾼다. 배포 순서상 잠시
-- 구버전 코드가 두 인자를 그대로 넘기는 구간이 생기는데, 그 호출도 계속
-- 동작해야 하기 때문이다.

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
  where worker_token = p_worker_token
    and status = 'running'
    and (p_job_id is null or id = p_job_id);

  return found;
end;
$$;

revoke all on function public.release_diarization_job_lease(uuid, uuid) from public, anon, authenticated;

grant execute on function public.release_diarization_job_lease(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
