import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260812120000_diarization_job_timings_and_release.sql',
  import.meta.url,
);

test('stores worker stage timings on the job row', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /alter table public\.transcription_jobs\s+add column if not exists timings jsonb/i);
});

test('lease release only applies to the worker that still holds the job', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.release_diarization_job_lease/i);
  assert.match(sql, /set status = 'queued'/i);
  assert.match(sql, /worker_token = null/i);
  assert.match(sql, /locked_at = null/i);
  assert.match(sql, /and status = 'running'/i);
  assert.match(sql, /and worker_token = p_worker_token/i);
});

test('lease release stays a service-role only routine', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(
    sql,
    /revoke all on function public\.release_diarization_job_lease\(uuid, uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.release_diarization_job_lease\(uuid, uuid\) to service_role/i,
  );
  assert.doesNotMatch(sql, /grant execute on function public\.release_diarization_job_lease\(uuid, uuid\) to (anon|authenticated)/i);
});
