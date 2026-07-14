import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260714153927_payment_refund_safety.sql',
  import.meta.url,
);
const lookupIndexMigrationUrl = new URL(
  '../supabase/migrations/20260714155918_payment_refund_lookup_index.sql',
  import.meta.url,
);
const environmentMigrationUrl = new URL(
  '../supabase/migrations/20260714160501_payment_environment_guard.sql',
  import.meta.url,
);

test('refund migration defines the guarded refund state machine', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /refund_status in \('none', 'pending', 'refunded', 'failed', 'review_required'\)/);
  assert.match(sql, /create or replace function public\.prepare_payment_refund/);
  assert.match(sql, /create or replace function public\.complete_payment_refund/);
  assert.match(sql, /create or replace function public\.fail_payment_refund/);
  assert.match(sql, /create or replace function public\.reconcile_canceled_payment_refund/);
  assert.match(sql, /for update/);
  assert.match(sql, /set credits = p\.credits - v_order\.credits/);
  assert.doesNotMatch(sql, /set credits = credits\s*[+-]/);
});

test('refund migration makes credit ledger writes idempotent per order', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /drop index public\.usage_logs_order_id_unique/);
  assert.match(sql, /create unique index usage_logs_order_action_unique/);
  assert.match(sql, /on public\.usage_logs \(order_id, action\)/);
  assert.match(sql, /where order_id is not null/);
});

test('refund RPC functions are restricted to the server service role', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functions = [
    'prepare_payment_refund\\(text, uuid, text\\)',
    'complete_payment_refund\\(text, uuid, text\\)',
    'fail_payment_refund\\(text, uuid, text\\)',
    'reconcile_canceled_payment_refund\\(text, text\\)',
    'list_payment_orders_for_refund\\(uuid, integer\\)',
  ];

  for (const signature of functions) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature} to service_role`));
  }
});

test('refund eligibility lookup has a user and time index', async () => {
  const sql = await readFile(lookupIndexMigrationUrl, 'utf8');

  assert.match(sql, /create index usage_logs_user_created_at_idx/);
  assert.match(sql, /on public\.usage_logs \(user_id, created_at desc\)/);
});

test('payment environment migration prevents test and live refund crossover', async () => {
  const sql = await readFile(environmentMigrationUrl, 'utf8');

  assert.match(sql, /add column payment_environment text not null default 'test'/);
  assert.match(sql, /payment_environment in \('test', 'live'\)/);
  assert.match(sql, /o\.payment_environment/);
  assert.match(sql, /revoke all on function public\.list_payment_orders_for_refund/);
  assert.match(sql, /grant execute on function public\.list_payment_orders_for_refund/);
});
