import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260716090000_account_deletion_safety.sql',
  import.meta.url,
);

test('preserves payment orders and protects the deletion tombstone', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /alter column user_id drop not null/i);
  assert.match(sql, /references public\.profiles\(id\) on delete set null/i);
  assert.match(sql, /create table public\.account_deletions/i);
  assert.match(sql, /alter table public\.account_deletions enable row level security/i);
  assert.match(sql, /revoke all on table public\.account_deletions from public, anon, authenticated/i);
});

test('rechecks jobs and payment states inside the deletion transaction', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.begin_account_deletion/i);
  assert.match(sql, /status in \('queued', 'running'\)/i);
  assert.match(sql, /refund_status in \('pending', 'failed', 'review_required'\)/i);
  assert.match(sql, /v_credits > 0 and v_open_paid_orders > 0/i);
  assert.match(sql, /update public\.payment_orders[\s\S]*user_id = null/i);
  assert.match(sql, /delete from public\.profiles where id = p_user_id/i);
});

test('keeps privileged deletion functions unavailable to browser roles', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /revoke all on function public\.preview_account_deletion\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.begin_account_deletion\(uuid, text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.begin_account_deletion\(uuid, text\) to service_role/i);
  assert.match(sql, /record_deleted_account_payment_cancellation/i);
  assert.match(sql, /PROVIDER_CANCELED_AFTER_ACCOUNT_DELETION/i);
});
