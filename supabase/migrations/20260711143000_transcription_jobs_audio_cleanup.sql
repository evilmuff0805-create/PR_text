alter table public.transcription_jobs
  add column audio_deleted_at timestamptz;

create index transcription_jobs_pending_audio_cleanup_idx
  on public.transcription_jobs (status)
  where audio_deleted_at is null;
