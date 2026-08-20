import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { createCreditLedgerStore } = await import('../src/services/credit-ledger.js');

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('existing balances are preserved while only new paid lots expire after one year', async () => {
  const sql = await read('supabase/migrations/20260820090000_credit_lots_and_one_year_expiry.sql');

  assert.match(sql, /where coalesce\(p\.credits, 0\) > 0/);
  assert.match(sql, /select\s+p\.id,\s+'legacy',\s+p\.credits,\s+p\.credits/is);
  assert.match(sql, /source = 'payment'.*payment_order_id is not null.*expires_at is not null/is);
  assert.match(sql, /v_approved_at \+ interval '1 year'/);
  assert.match(sql, /2026-08-20|Legacy credit backfill mismatch/);
});

test('credit consumption is serialized, expires first, and uses earliest-expiring lots', async () => {
  const sql = await read('supabase/migrations/20260820090000_credit_lots_and_one_year_expiry.sql');

  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('credit-user:'/);
  assert.match(sql, /perform public\.expire_credit_lots_for_user\(p_user_id\)/);
  assert.match(sql, /order by \(l\.expires_at is null\), l\.expires_at, l\.created_at, l\.id/);
  assert.match(sql, /if v_balance <> v_ledger_balance then/);
  assert.match(sql, /unique \(operation_type, operation_id, lot_id\)/);
  assert.match(sql, /create index credit_allocations_lot_id_idx\s+on public\.credit_allocations \(lot_id\)/);
});

test('refunds and diarization restore the exact allocated lots without reviving expired credit', async () => {
  const sql = await read('supabase/migrations/20260820090000_credit_lots_and_one_year_expiry.sql');

  assert.match(sql, /where l\.payment_order_id = v_order\.order_id\s+for update/);
  assert.match(sql, /v_lot\.available <> v_order\.credits\s+or v_lot\.reserved <> 0/);
  assert.match(sql, /if v_lot\.expires_at is null or v_lot\.expires_at > now\(\) then/);
  assert.match(sql, /set available = 0,\s+reserved = l\.reserved - v_allocation\.amount/);
  assert.match(sql, /credits = coalesce\(p\.credits, 0\) \+ v_restored - v_expired_available/);
  assert.match(sql, /set state = 'expired',\s+restored_amount = 0/);
  assert.match(sql, /credits_refunded = \(v_restored = v_job\.credits_reserved\)/);
  assert.doesNotMatch(sql, /v_credits := v_credits \+ v_restored/);
  assert.match(sql, /canceled_credits_reclaimed/);
});

test('migration refuses ambiguous live state and keeps ledger RPCs server-only', async () => {
  const sql = await read('supabase/migrations/20260820090000_credit_lots_and_one_year_expiry.sql');

  assert.match(sql, /o\.status = 'pending'/);
  assert.match(sql, /Open payment orders must be reconciled/);
  assert.match(sql, /Active diarization jobs must finish/);
  assert.match(sql, /payment_integration in \('individual', 'checkout'\)/);
  assert.doesNotMatch(sql, /grant execute on function[^;]+to (anon|authenticated)/i);
  assert.match(sql, /grant execute on function public\.expire_due_credit_lots\(integer\) to service_role/);
  assert.match(sql, /when sqlstate 'CR003' then/);
});

test('credit ledger service returns the authoritative post-expiry balance', async () => {
  const calls = [];
  const database = {
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: [{ expired: 7, credits_remaining: 93, discrepancy: false }],
        error: null,
      };
    },
  };
  const store = createCreditLedgerStore(database);

  const result = await store.expireForUser('user-1');

  assert.deepEqual(result, { expired: 7, credits_remaining: 93, discrepancy: false });
  assert.deepEqual(calls, [{
    name: 'expire_credit_lots_for_user',
    args: { p_user_id: 'user-1' },
  }]);
});

test('payment UI uses the widget and discloses the one-year rule exactly', async () => {
  const [page, route, terms] = await Promise.all([
    read('client/src/pages/PaymentPage.jsx'),
    read('src/routes/payment.js'),
    read('client/src/pages/TermsPage.jsx'),
  ]);

  assert.match(page, /충전 시간은 최대 1년입니다/);
  assert.match(page, /renderPaymentMethods/);
  assert.match(page, /renderAgreement/);
  assert.match(page, /setAmount/);
  assert.match(route, /requiredIntegration: 'checkout'/);
  assert.match(route, /payment_integration: configuration\.integration/);
  assert.match(terms, /시행일 전에 보유한 변환 시간에는 소급 적용하지 않습니다/);
});
