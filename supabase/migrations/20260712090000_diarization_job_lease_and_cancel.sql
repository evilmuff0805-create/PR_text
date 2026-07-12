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
         and coalesce(locked_at, '-infinity'::timestamptz) < now() - interval '3 minutes'
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

create or replace function public.renew_diarization_job_lease(
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
  set locked_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'running'
    and worker_token = p_worker_token;

  return found;
end;
$$;

create or replace function public.cancel_diarization_job(
  p_job_id uuid,
  p_user_id uuid
)
returns table (updated boolean, credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.transcription_jobs%rowtype;
  v_credits integer;
begin
  select *
  into v_job
  from public.transcription_jobs
  where id = p_job_id
    and user_id = p_user_id
    and status in ('queued', 'running')
  for update;

  if not found then
    return query select false, null::integer;
    return;
  end if;

  update public.profiles
  set credits = credits + v_job.credits_reserved,
      updated_at = now()
  where id = v_job.user_id
  returning credits into v_credits;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    audio_minutes,
    description
  ) values (
    v_job.user_id,
    'refund',
    -v_job.credits_reserved,
    round((v_job.duration_seconds / 60)::numeric, 1),
    format('%s (다화자 작업 취소 환불)', v_job.filename)
  );

  update public.transcription_jobs
  set status = 'failed',
      completed_at = now(),
      credits_refunded = true,
      error_message = '사용자가 작업을 취소했습니다.',
      updated_at = now()
  where id = v_job.id;

  return query select true, v_credits;
end;
$$;

revoke all on function public.renew_diarization_job_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_diarization_job(uuid, uuid) from public, anon, authenticated;

grant execute on function public.renew_diarization_job_lease(uuid, uuid) to service_role;
grant execute on function public.cancel_diarization_job(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
