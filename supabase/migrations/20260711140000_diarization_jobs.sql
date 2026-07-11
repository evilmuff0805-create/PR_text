create table public.transcription_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  filename text not null,
  storage_path text not null unique,
  requested_language text,
  duration_seconds numeric not null check (duration_seconds >= 0),
  credits_reserved integer not null check (credits_reserved > 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  worker_token uuid,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  credits_refunded boolean not null default false,
  error_message text,
  result_text text,
  result_segments jsonb,
  result_language text,
  transcription_log_id bigint references public.transcription_logs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transcription_jobs_status_created_at_idx
  on public.transcription_jobs (status, created_at);

create index transcription_jobs_user_created_at_idx
  on public.transcription_jobs (user_id, created_at desc);

alter table public.transcription_jobs enable row level security;

revoke all on table public.transcription_jobs from anon, authenticated;
grant select, insert, update, delete on table public.transcription_jobs to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('transcription-jobs', 'transcription-jobs', false, 157286400)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

create or replace function public.enqueue_diarization_job(
  p_user_id uuid,
  p_filename text,
  p_storage_path text,
  p_requested_language text,
  p_duration_seconds numeric,
  p_credits integer
)
returns table (job_id uuid, credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_credits integer;
begin
  if p_credits < 1 then
    raise exception '예약할 변환 시간은 1분 이상이어야 합니다.';
  end if;

  update public.profiles
  set credits = credits - p_credits,
      updated_at = now()
  where id = p_user_id
    and credits >= p_credits
  returning credits into v_credits;

  if v_credits is null then
    return;
  end if;

  insert into public.transcription_jobs (
    user_id,
    filename,
    storage_path,
    requested_language,
    duration_seconds,
    credits_reserved
  ) values (
    p_user_id,
    p_filename,
    p_storage_path,
    nullif(p_requested_language, ''),
    p_duration_seconds,
    p_credits
  ) returning id into v_job_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    audio_minutes,
    description
  ) values (
    p_user_id,
    'transcribe',
    p_credits,
    round((p_duration_seconds / 60)::numeric, 1),
    format('%s (다화자 작업 대기)', p_filename)
  );

  return query select v_job_id, v_credits;
end;
$$;

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
       or (status = 'running' and locked_at < now() - interval '45 minutes')
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

create or replace function public.complete_diarization_job(
  p_job_id uuid,
  p_worker_token uuid,
  p_result_text text,
  p_result_segments jsonb,
  p_result_language text,
  p_transcription_log_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.transcription_jobs
  set status = 'completed',
      completed_at = now(),
      result_text = p_result_text,
      result_segments = p_result_segments,
      result_language = p_result_language,
      transcription_log_id = p_transcription_log_id,
      updated_at = now()
  where id = p_job_id
    and status = 'running'
    and worker_token = p_worker_token;

  return found;
end;
$$;

create or replace function public.fail_diarization_job(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_message text
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
    and status = 'running'
    and worker_token = p_worker_token
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
    format('%s (다화자 작업 실패 환불)', v_job.filename)
  );

  update public.transcription_jobs
  set status = 'failed',
      completed_at = now(),
      credits_refunded = true,
      error_message = left(coalesce(p_error_message, '작업 처리 중 오류가 발생했습니다.'), 500),
      updated_at = now()
  where id = v_job.id;

  return query select true, v_credits;
end;
$$;

revoke all on function public.enqueue_diarization_job(uuid, text, text, text, numeric, integer) from public, anon, authenticated;
revoke all on function public.claim_diarization_job(uuid) from public, anon, authenticated;
revoke all on function public.complete_diarization_job(uuid, uuid, text, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.fail_diarization_job(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.enqueue_diarization_job(uuid, text, text, text, numeric, integer) to service_role;
grant execute on function public.claim_diarization_job(uuid) to service_role;
grant execute on function public.complete_diarization_job(uuid, uuid, text, jsonb, text, bigint) to service_role;
grant execute on function public.fail_diarization_job(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
