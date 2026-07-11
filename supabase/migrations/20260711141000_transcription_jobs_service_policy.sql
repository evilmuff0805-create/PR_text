create policy "Service role manages transcription jobs"
on public.transcription_jobs
for all
to service_role
using (true)
with check (true);
