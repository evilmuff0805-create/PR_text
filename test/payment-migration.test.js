import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260714151247_fix_payment_order_credit_ambiguity.sql',
  import.meta.url,
);

test('payment completion migration qualifies the credits column', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /update public\.profiles as p/i);
  assert.match(sql, /set credits = p\.credits \+ v_order\.credits/i);
  assert.match(sql, /returning p\.credits into v_credits/i);
  assert.doesNotMatch(sql, /set credits = credits \+/i);
});

test('payment completion migration preserves RPC access restrictions', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /security invoker/i);
  assert.match(
    sql,
    /revoke all on function public\.complete_payment_order\(text, uuid, text\) from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.complete_payment_order\(text, uuid, text\) to service_role/i,
  );
});
