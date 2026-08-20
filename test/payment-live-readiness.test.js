import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifiedPartialCancelAmount } from '../src/services/toss-payments.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('transient auth failures are marked retryable so confirm never looks like a hard failure', async () => {
  const auth = await read('src/middleware/auth.js');
  const transient = auth.match(/status\(503\)\.json\([^)]*\)/g) || [];

  assert.ok(transient.length >= 4);
  for (const response of transient) {
    assert.match(response, /retryable: true/, `503 응답에 retryable이 없다: ${response}`);
  }
});

test('a failed confirm never offers a path that creates a second order', async () => {
  const page = await read('client/src/pages/PaymentSuccessPage.jsx');
  const errorBlock = page.slice(page.indexOf("status === 'error' &&"), page.indexOf("status === 'retry' &&"));

  // 결제 페이지로 보내면 이미 승인된 카드에 새 주문이 하나 더 생긴다.
  assert.doesNotMatch(errorBlock, /navigate\('\/payment'\)/);
  assert.match(errorBlock, /confirmRef\.current\?\.\(\)/);
  assert.match(errorBlock, /새로 결제하지 마시고/);
  assert.match(errorBlock, /주문번호/);
});

test('checkout stays gated and renders the Toss Payment Widget without card filtering', async () => {
  const [route, page, failPage, env] = await Promise.all([
    read('src/routes/payment.js'),
    read('client/src/pages/PaymentPage.jsx'),
    read('client/src/pages/PaymentFailPage.jsx'),
    read('.env.example'),
  ]);

  assert.match(route, /process\.env\.PAYMENTS_ENABLED === 'true'/);
  assert.match(route, /router\.post\('\/create'[\s\S]*if \(!paymentsEnabled\(\)\)/);
  assert.match(page, /tossPayments\.widgets\(\{ customerKey: user\.id \}\)/);
  assert.match(page, /widgets\.setAmount\(/);
  assert.match(page, /widgets\.renderPaymentMethods\(/);
  assert.match(page, /widgets\.renderAgreement\(/);
  assert.match(page, /widgetsRef\.current\.requestPayment\(/);
  assert.doesNotMatch(page, /APPROVED_CARD_COMPANIES|cardCompany:/);
  assert.doesNotMatch(page, /현재 결제 가능 카드|심사·오픈 준비 중/);
  assert.match(page, /paymentsEnabled !== true/);
  assert.doesNotMatch(failPage, /우리카드|하나카드|다른 카드사로 다시 시도/);
  assert.match(env, /PAYMENTS_ENABLED=false/);
});

test('partial cancellations are verified before any credit is reclaimed', () => {
  const expected = { paymentKey: 'pk', orderId: 'order_1', amount: 10000 };
  const partial = {
    paymentKey: 'pk',
    orderId: 'order_1',
    amount: 10000,
    totalAmount: 10000,
    balanceAmount: 6000,
    status: 'PARTIAL_CANCELED',
    cancels: [{ cancelAmount: 4000 }],
  };

  assert.equal(verifiedPartialCancelAmount(partial, expected), 4000);
  // 합이 맞지 않으면 신뢰하지 않는다.
  assert.equal(verifiedPartialCancelAmount({ ...partial, balanceAmount: 5000 }, expected), 0);
  // 전액 취소는 이 경로가 아니다.
  assert.equal(verifiedPartialCancelAmount({ ...partial, status: 'CANCELED', balanceAmount: 0 }, expected), 0);
  assert.equal(verifiedPartialCancelAmount({ ...partial, paymentKey: 'other' }, expected), 0);
});

test('the webhook handles PARTIAL_CANCELED instead of silently dropping it', async () => {
  const route = await read('src/routes/payment.js');

  assert.match(route, /'DONE', 'CANCELED', 'PARTIAL_CANCELED'/);
  assert.match(route, /verifiedPartialCancelAmount\(payment, \{/);
  assert.match(route, /store\.reconcilePartialCancellation\(\{/);
});

test('partial cancellation reclaims proportional credits and escalates when they are spent', async () => {
  const sql = await read('supabase/migrations/20260811060000_partial_cancellation_review.sql');

  assert.match(sql, /create or replace function public\.reconcile_partial_payment_cancellation/i);
  // 비율만큼 회수하되 사용자에게 불리하지 않게 내림.
  assert.match(sql, /floor\(v_order\.credits::numeric \* p_canceled_amount::numeric/);
  // 이미 써버린 경우 잔액을 건드리지 않고 검토 대상으로 남긴다.
  assert.match(sql, /if v_reclaim > v_balance then/);
  assert.match(sql, /'PARTIAL_CANCEL_CREDITS_USED'/);
  assert.doesNotMatch(sql, /grant .* (anon|authenticated)/i);
});

test('stale pending orders expire so they stop blocking account deletion', async () => {
  const [sql, store, server, deletion] = await Promise.all([
    read('supabase/migrations/20260811061000_expire_stale_pending_orders.sql'),
    read('src/services/payment-orders.js'),
    read('src/server.js'),
    read('supabase/migrations/20260716090000_account_deletion_safety.sql'),
  ]);

  assert.match(sql, /check \(status in \('pending', 'paid', 'expired'\)\)/);
  // 승인이 시작됐거나 환불 중인 주문은 만료시키지 않는다.
  assert.match(sql, /o\.payment_key is null/);
  assert.match(sql, /o\.refund_status = 'none'/);
  assert.match(store, /expireStalePendingOrders/);
  assert.match(server, /startPaymentOrderMaintenance\(\);/);
  // 탈퇴 차단은 여전히 pending만 센다 → expired는 더 이상 막지 않는다.
  assert.match(deletion, /filter \(where o\.status = 'pending'\)/);
});
