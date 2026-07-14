import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260714194500_harden_transcription_logs_rls.sql',
  import.meta.url,
);

test('transcription history writes are restricted to the server role', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /drop policy if exists "Service role can insert transcription logs"/i);
  assert.match(
    sql,
    /revoke insert, update, delete, truncate, references, trigger\s+on table public\.transcription_logs\s+from anon, authenticated/i,
  );
  assert.match(sql, /revoke select on table public\.transcription_logs from anon/i);
  assert.doesNotMatch(sql, /with check\s*\(true\)/i);
});

test('authenticated users retain read-only access to their own history', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /grant select on table public\.transcription_logs to authenticated/i);
  assert.match(
    sql,
    /create policy "Users can view own transcription logs"[\s\S]*?to authenticated[\s\S]*?using \(\(select auth\.uid\(\)\) = user_id\)/i,
  );
});

test('user-scoped policies and history lookup use the optimized form', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /using \(\(select auth\.uid\(\)\) = id\)/i);
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(
    sql,
    /create index if not exists transcription_logs_user_created_at_idx\s+on public\.transcription_logs \(user_id, created_at desc\)/i,
  );
});
