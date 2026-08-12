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

test('lease release can hand a job back by worker token alone', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20260812140000_diarization_release_by_worker_token.sql', import.meta.url),
    'utf8',
  );

  // Shutdown can arrive before the claim RPC returns, so the worker may not know
  // which job it just took. Keyed on the token, the job is still handed back
  // instead of sitting `running` until the stale window expires.
  assert.match(sql, /where worker_token = p_worker_token/i);
  assert.match(sql, /and \(p_job_id is null or id = p_job_id\)/i);
  assert.match(sql, /and status = 'running'/i);

  // The signature is unchanged so the previous release stays callable during the
  // window where the migration is applied but the new code is not yet deployed.
  assert.match(sql, /release_diarization_job_lease\(\s*\n?\s*p_job_id uuid,\s*\n?\s*p_worker_token uuid\s*\n?\s*\)/i);
  assert.match(
    sql,
    /revoke all on function public\.release_diarization_job_lease\(uuid, uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.release_diarization_job_lease\(uuid, uuid\) to service_role/i,
  );
});

test('timing writes are scoped to the worker that owns the job', async () => {
  const source = await readFile(new URL('../src/services/diarization-jobs.js', import.meta.url), 'utf8');

  // A superseded worker still reaches the error path. Without the token it would
  // overwrite the timings the current worker just stored, corrupting the very
  // measurement this record exists to provide.
  assert.match(source, /\.update\(\{ timings: timingLog \}\)\s*\n\s*\.eq\('id', job\.id\)\s*\n\s*\.eq\('worker_token', workerToken\)/);
});

test('shutdown registers the worker before the claim resolves', async () => {
  const source = await readFile(new URL('../src/services/diarization-jobs.js', import.meta.url), 'utf8');

  assert.match(source, /activeJobContext = \{ job: null, workerToken, abortController, claimPromise \}/);
  assert.match(source, /await context\.claimPromise/);
  assert.match(source, /p_job_id: context\.job\?\.id \?\? null/);
});
