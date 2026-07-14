drop policy if exists "Service role can insert transcription logs"
  on public.transcription_logs;

revoke insert, update, delete, truncate, references, trigger
  on table public.transcription_logs
  from anon, authenticated;
revoke select on table public.transcription_logs from anon;
grant select on table public.transcription_logs to authenticated;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can view own usage" on public.usage_logs;
create policy "Users can view own usage"
  on public.usage_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can view own transcription logs"
  on public.transcription_logs;
create policy "Users can view own transcription logs"
  on public.transcription_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create index if not exists transcription_logs_user_created_at_idx
  on public.transcription_logs (user_id, created_at desc);

notify pgrst, 'reload schema';
