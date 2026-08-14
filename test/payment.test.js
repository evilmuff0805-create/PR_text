import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const {
  createPaymentRouter,
  createPaymentWebhookRouter,
} = await import('../src/routes/payment.js');
const {
  cancelOrRecoverTossPayment,
  confirmOrRecoverTossPayment,
  TossPaymentError,
  validateTossKeyPair,
} = await import('../src/services/toss-payments.js');

const USER = { id: 'user-1', email: 'buyer@example.com' };
const ORDER = {
  order_id: 'order_123456',
  user_id: USER.id,
  amount: 4900,
  credits: 100,
  status: 'pending',
  payment_key: null,
  payment_environment: 'test',
  idempotency_key: '49ff4ef0-f325-4c66-bffe-3d630e257d9f',
};
const PAYMENT = {
  paymentKey: 'payment-key-1',
  orderId: ORDER.order_id,
  totalAmount: ORDER.amount,
  status: 'DONE',
};
const CANCELED_PAYMENT = {
  ...PAYMENT,
  status: 'CANCELED',
  balanceAmount: 0,
  cancels: [{ cancelAmount: ORDER.amount }],
};

function auth(req, res, next) {
  req.user = USER;
  next();
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

async function request(router, path, body, method = 'POST') {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, data: await response.json() };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('keeps test-key compatibility but accepts only checkout keys for live payments', () => {
  assert.deepEqual(
    validateTossKeyPair({ clientKey: 'test_gck_client', secretKey: 'test_gsk_secret' }),
    { environment: 'test' },
  );
  assert.deepEqual(
    validateTossKeyPair({ clientKey: 'test_ck_client', secretKey: 'test_sk_secret' }),
    { environment: 'test' },
  );
  assert.deepEqual(
    validateTossKeyPair({ clientKey: 'live_gck_client', secretKey: 'live_gsk_secret' }),
    { environment: 'live' },
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'test_gck_client', secretKey: 'live_gsk_secret' }),
    /섞여 있습니다/,
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'test_gsk_secret', secretKey: 'test_gck_client' }),
    /클라이언트 키/,
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'live_ck_billing', secretKey: 'live_sk_billing' }),
    /gck\/gsk/,
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'test_gck_client', secretKey: 'test_sk_secret' }),
    /키가 섞여 있습니다/,
  );
});

test('confirms a payment with the stored amount and idempotency key', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, PAYMENT);
  };

  const result = await confirmOrRecoverTossPayment({
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
    idempotencyKey: ORDER.idempotency_key,
    secretKey: 'test_sk_secret',
    fetchFn,
  });

  assert.equal(result.recovered, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['Idempotency-Key'], ORDER.idempotency_key);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
  });
});

test('recovers a lost confirmation response by querying the Toss order', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse(503, { code: 'PROVIDER_ERROR', message: 'temporary' });
    return jsonResponse(200, PAYMENT);
  };

  const result = await confirmOrRecoverTossPayment({
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
    idempotencyKey: ORDER.idempotency_key,
    secretKey: 'test_sk_secret',
    fetchFn,
  });

  assert.equal(result.recovered, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /payments\/orders\/order_123456$/);
  assert.equal(calls[1].options.method, 'GET');
});

test('does not recover a payment when the authoritative Toss lookup does not match', async () => {
  const fetchFn = async (url) => {
    if (url.endsWith('/confirm')) {
      return jsonResponse(200, { ...PAYMENT, totalAmount: 1 });
    }
    return jsonResponse(200, { ...PAYMENT, paymentKey: 'different-payment-key' });
  };

  await assert.rejects(
    confirmOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn,
    }),
    (error) => error instanceof TossPaymentError
      && error.code === 'TOSS_RECONCILIATION_MISMATCH'
      && error.retryable === true,
  );
});

test('keeps the user on the safe retry path when reconciliation is temporarily unavailable', async () => {
  const fetchFn = async (url) => {
    if (url.endsWith('/confirm')) {
      return jsonResponse(400, { code: 'ALREADY_PROCESSED_PAYMENT', message: 'already processed' });
    }
    throw new Error('network unavailable');
  };

  await assert.rejects(
    confirmOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn,
    }),
    (error) => error instanceof TossPaymentError
      && error.code === 'TOSS_NETWORK_ERROR'
      && error.retryable === true
      && /새로 결제하지 말고/.test(error.message),
  );
});

test('keeps a non-retryable provider rejection when no approved payment exists', async () => {
  const fetchFn = async (url) => (
    url.endsWith('/confirm')
      ? jsonResponse(400, { code: 'INVALID_CARD', message: 'card rejected' })
      : jsonResponse(404, { code: 'NOT_FOUND_PAYMENT', message: 'not found' })
  );

  await assert.rejects(
    confirmOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn,
    }),
    (error) => error instanceof TossPaymentError
      && error.code === 'INVALID_CARD'
      && error.retryable === false,
  );
});

test('cancels the full payment with the stored idempotency key', async () => {
  const calls = [];
  const result = await cancelOrRecoverTossPayment({
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
    cancelReason: '고객 요청',
    idempotencyKey: ORDER.idempotency_key,
    secretKey: 'test_sk_secret',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, CANCELED_PAYMENT);
    },
  });

  assert.equal(result.recovered, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /payments\/payment-key-1\/cancel$/);
  assert.equal(calls[0].options.headers['Idempotency-Key'], ORDER.idempotency_key);
  assert.deepEqual(JSON.parse(calls[0].options.body), { cancelReason: '고객 요청' });
});

test('recovers a lost cancellation response from the authoritative Toss lookup', async () => {
  let calls = 0;
  const result = await cancelOrRecoverTossPayment({
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
    cancelReason: '고객 요청',
    idempotencyKey: ORDER.idempotency_key,
    secretKey: 'test_sk_secret',
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('response lost');
      return jsonResponse(200, CANCELED_PAYMENT);
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(calls, 2);
});

test('does not accept a mismatched full cancellation response', async () => {
  await assert.rejects(
    cancelOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      cancelReason: '고객 요청',
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn: async () => jsonResponse(200, {
        ...CANCELED_PAYMENT,
        cancels: [{ cancelAmount: 1000 }],
      }),
    }),
    (error) => error instanceof TossPaymentError
      && error.code === 'TOSS_CANCELLATION_MISMATCH'
      && error.retryable === true,
  );
});

test('marks a provider cancellation rejection as definite only after lookup proves DONE', async () => {
  let calls = 0;
  await assert.rejects(
    cancelOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      cancelReason: '고객 요청',
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(400, { code: 'NOT_CANCELABLE_AMOUNT', message: 'cannot cancel' })
          : jsonResponse(200, PAYMENT);
      },
    }),
    (error) => error instanceof TossPaymentError
      && error.code === 'NOT_CANCELABLE_AMOUNT'
      && error.retryable === false
      && error.definitivelyNotCanceled === true,
  );
});

test('keeps credits held when the cancellation outcome cannot be proven', async () => {
  await assert.rejects(
    cancelOrRecoverTossPayment({
      paymentKey: PAYMENT.paymentKey,
      orderId: ORDER.order_id,
      amount: ORDER.amount,
      cancelReason: '고객 요청',
      idempotencyKey: ORDER.idempotency_key,
      secretKey: 'test_sk_secret',
      fetchFn: async () => { throw new Error('network unavailable'); },
    }),
    (error) => error instanceof TossPaymentError
      && error.retryable === true
      && error.definitivelyNotCanceled === false,
  );
});

test('creates orders from the server plan catalog and ignores client-supplied prices', async () => {
  let created;
  const store = {
    async create(order) { created = order; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    clientKey: () => 'test_gck_client',
    secretKey: () => 'test_gsk_secret',
    paymentsEnabled: () => true,
  });

  const response = await request(router, '/create', {
    planId: 'basic',
    amount: 1,
    credits: 999999,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.amount, 5900);
  assert.equal(response.data.credits, 100);
  assert.equal(created.amount, 5900);
  assert.equal(created.credits, 100);
  assert.equal(created.user_id, USER.id);
  assert.equal(created.payment_environment, 'test');
});

test('blocks new orders before any mutation when live payments are disabled', async () => {
  let createCalls = 0;
  const router = createPaymentRouter({
    auth,
    store: { async create() { createCalls += 1; } },
    paymentsEnabled: () => false,
  });

  const response = await request(router, '/create', { planId: 'basic' });

  assert.equal(response.status, 503);
  assert.equal(createCalls, 0);
  assert.match(response.data.error, /결제 오픈을 준비/);
});

test('rejects an altered confirmation amount before contacting Toss', async () => {
  let confirmCalls = 0;
  const store = {
    async find() { return ORDER; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    confirmPayment: async () => { confirmCalls += 1; },
  });

  const response = await request(router, '/confirm', {
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: 1,
  });

  assert.equal(response.status, 400);
  assert.equal(confirmCalls, 0);
  assert.match(response.data.error, /금액/);
});

test('does not reveal or confirm an order owned by another user', async () => {
  let confirmCalls = 0;
  const store = {
    async find() { return { ...ORDER, user_id: 'another-user' }; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    confirmPayment: async () => { confirmCalls += 1; },
  });

  const response = await request(router, '/confirm', {
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
  });

  assert.equal(response.status, 404);
  assert.equal(confirmCalls, 0);
});

test('replays an already completed payment without a second Toss confirmation', async () => {
  let confirmCalls = 0;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async getCurrentCredits() { return 310; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    confirmPayment: async () => { confirmCalls += 1; },
  });

  const response = await request(router, '/confirm', {
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.alreadyPaid, true);
  assert.equal(response.data.credits, 310);
  assert.equal(confirmCalls, 0);
});

test('completes credits only after a verified Toss confirmation', async () => {
  let completed;
  const store = {
    async find() { return ORDER; },
    async complete(input) {
      completed = input;
      return { credits: 110, charged: 100, already_paid: false };
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    confirmPayment: async () => ({ payment: PAYMENT, recovered: false }),
    secretKey: () => 'test_sk_secret',
  });

  const response = await request(router, '/confirm', {
    paymentKey: PAYMENT.paymentKey,
    orderId: ORDER.order_id,
    amount: ORDER.amount,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.charged, 100);
  assert.deepEqual(completed, {
    orderId: ORDER.order_id,
    userId: USER.id,
    paymentKey: PAYMENT.paymentKey,
  });
});

test('lists the authenticated user payment orders and refund gate state', async () => {
  const orders = [{
    order_id: ORDER.order_id,
    payment_status: 'paid',
    payment_environment: 'test',
  }];
  const store = {
    async listForRefund(userId, limit) {
      assert.equal(userId, USER.id);
      assert.equal(limit, 10);
      return orders;
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    paymentsEnabled: () => true,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
  });

  const response = await request(router, '/orders', undefined, 'GET');

  assert.equal(response.status, 200);
  assert.deepEqual(response.data.orders, orders);
  assert.equal(response.data.paymentsEnabled, true);
  assert.equal(response.data.refundsEnabled, true);
});

test('marks payment orders from another Toss environment as non-refundable', async () => {
  const store = {
    async listForRefund() {
      return [{
        order_id: ORDER.order_id,
        payment_status: 'paid',
        payment_environment: 'test',
        can_refund: true,
        can_retry: false,
      }];
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'live',
  });

  const response = await request(router, '/orders', undefined, 'GET');

  assert.equal(response.status, 200);
  assert.equal(response.data.orders[0].can_refund, false);
  assert.equal(response.data.orders[0].can_retry, false);
  assert.equal(response.data.orders[0].eligibility_reason, 'environment_mismatch');
});

test('blocks refunds before any order or provider mutation when the gate is disabled', async () => {
  let findCalls = 0;
  let cancelCalls = 0;
  const router = createPaymentRouter({
    auth,
    store: { async find() { findCalls += 1; } },
    cancelPayment: async () => { cancelCalls += 1; },
    refundsEnabled: () => false,
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 503);
  assert.equal(findCalls, 0);
  assert.equal(cancelCalls, 0);
});

test('holds credits before Toss cancellation and completes the verified refund', async () => {
  const calls = [];
  const paidOrder = { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey };
  const prepared = {
    order_id: ORDER.order_id,
    payment_key: PAYMENT.paymentKey,
    amount: ORDER.amount,
    credits: ORDER.credits,
    refund_idempotency_key: ORDER.idempotency_key,
    credits_remaining: 210,
    already_refunded: false,
  };
  const store = {
    async find() { return paidOrder; },
    async prepareRefund() { calls.push('prepare'); return prepared; },
    async completeRefund() {
      calls.push('complete');
      return { credits_remaining: 210, refunded: 100, already_refunded: false };
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
    cancelPayment: async (input) => {
      calls.push('cancel');
      assert.equal(input.idempotencyKey, ORDER.idempotency_key);
      return { payment: CANCELED_PAYMENT, recovered: false };
    },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 200);
  assert.equal(response.data.credits, 210);
  assert.deepEqual(calls, ['prepare', 'cancel', 'complete']);
});

test('replays an already refunded order without a second Toss cancellation', async () => {
  let cancelCalls = 0;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async prepareRefund() {
      return {
        credits_remaining: 210,
        credits: 100,
        already_refunded: true,
      };
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
    cancelPayment: async () => { cancelCalls += 1; },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 200);
  assert.equal(response.data.alreadyRefunded, true);
  assert.equal(cancelCalls, 0);
});

test('restores held credits only when Toss definitively rejected cancellation', async () => {
  let failed = false;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async prepareRefund() {
      return {
        order_id: ORDER.order_id,
        payment_key: PAYMENT.paymentKey,
        amount: ORDER.amount,
        refund_idempotency_key: ORDER.idempotency_key,
        already_refunded: false,
      };
    },
    async failRefund() {
      failed = true;
      return { credits_remaining: 310 };
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
    cancelPayment: async () => {
      throw new TossPaymentError('cannot cancel', {
        code: 'NOT_CANCELABLE_AMOUNT',
        retryable: false,
        definitivelyNotCanceled: true,
      });
    },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 409);
  assert.equal(response.data.credits, 310);
  assert.equal(failed, true);
});

test('does not restore held credits while the Toss cancellation result is uncertain', async () => {
  let failCalls = 0;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async prepareRefund() {
      return {
        order_id: ORDER.order_id,
        payment_key: PAYMENT.paymentKey,
        amount: ORDER.amount,
        refund_idempotency_key: ORDER.idempotency_key,
        already_refunded: false,
      };
    },
    async failRefund() { failCalls += 1; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
    cancelPayment: async () => {
      throw new TossPaymentError('unknown', { retryable: true });
    },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 502);
  assert.equal(response.data.retryable, true);
  assert.equal(failCalls, 0);
});

test('returns a safe conflict when purchased credits were already used', async () => {
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async prepareRefund() {
      throw Object.assign(new Error('결제 이후 변환 시간을 사용했습니다.'), { code: 'PR003' });
    },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 409);
  assert.equal(response.data.retryable, false);
});

test('blocks refund mutation when an old order belongs to a different Toss environment', async () => {
  let prepareCalls = 0;
  let cancelCalls = 0;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_environment: 'test' }; },
    async prepareRefund() { prepareCalls += 1; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'live',
    cancelPayment: async () => { cancelCalls += 1; },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 409);
  assert.equal(response.data.retryable, false);
  assert.equal(prepareCalls, 0);
  assert.equal(cancelCalls, 0);
});

test('returns success when a cancellation webhook wins the credit-restore race', async () => {
  let findCalls = 0;
  const store = {
    async find() {
      findCalls += 1;
      return findCalls === 1
        ? { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }
        : { ...ORDER, status: 'paid', refund_status: 'refunded', credits: 100 };
    },
    async prepareRefund() {
      return {
        order_id: ORDER.order_id,
        payment_key: PAYMENT.paymentKey,
        amount: ORDER.amount,
        refund_idempotency_key: ORDER.idempotency_key,
        already_refunded: false,
      };
    },
    async failRefund() { throw new Error('state already changed'); },
    async getCurrentCredits() { return 210; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    refundsEnabled: () => true,
    paymentEnvironment: () => 'test',
    cancelPayment: async () => {
      throw new TossPaymentError('cannot cancel', {
        retryable: false,
        definitivelyNotCanceled: true,
      });
    },
  });

  const response = await request(router, '/refund', { orderId: ORDER.order_id });

  assert.equal(response.status, 200);
  assert.equal(response.data.alreadyRefunded, true);
  assert.equal(response.data.credits, 210);
});

test('webhook re-queries Toss before completing a pending order', async () => {
  let queryCalls = 0;
  let completed;
  const store = {
    async find() { return ORDER; },
    async complete(input) {
      completed = input;
      return { credits: 110, charged: 100, already_paid: false };
    },
  };
  const router = createPaymentWebhookRouter({
    store,
    getPayment: async () => {
      queryCalls += 1;
      return PAYMENT;
    },
    secretKey: () => 'test_sk_secret',
  });

  const response = await request(router, '/', {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: PAYMENT,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.completed, true);
  assert.equal(queryCalls, 1);
  assert.equal(completed.userId, USER.id);
});

test('webhook ignores an unverified DONE payload without changing credits', async () => {
  let completeCalls = 0;
  const store = {
    async find() { return ORDER; },
    async complete() { completeCalls += 1; },
  };
  const router = createPaymentWebhookRouter({
    store,
    getPayment: async () => ({ ...PAYMENT, totalAmount: 1 }),
  });

  const response = await request(router, '/', {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: PAYMENT,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.ignored, true);
  assert.equal(completeCalls, 0);
});

test('webhook re-queries Toss and reconciles a verified full cancellation', async () => {
  let reconciled;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async reconcileCanceledRefund(input) {
      reconciled = input;
      return { refunded: 100, manual_review: false, already_refunded: false };
    },
  };
  const router = createPaymentWebhookRouter({
    store,
    getPayment: async () => CANCELED_PAYMENT,
  });

  const response = await request(router, '/', {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: CANCELED_PAYMENT,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.refunded, true);
  assert.deepEqual(reconciled, {
    orderId: ORDER.order_id,
    paymentKey: PAYMENT.paymentKey,
  });
});

test('webhook records a verified cancellation for an already deleted account', async () => {
  let recorded;
  const store = {
    async find() {
      return {
        ...ORDER,
        user_id: null,
        status: 'paid',
        payment_key: PAYMENT.paymentKey,
        account_deleted_at: '2026-07-16T03:00:00.000Z',
      };
    },
    async recordDeletedAccountCancellation(input) {
      recorded = input;
      return { manual_review: true, already_refunded: false };
    },
  };
  const router = createPaymentWebhookRouter({
    store,
    getPayment: async () => CANCELED_PAYMENT,
  });

  const response = await request(router, '/', {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: CANCELED_PAYMENT,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.manualReview, true);
  assert.deepEqual(recorded, {
    orderId: ORDER.order_id,
    paymentKey: PAYMENT.paymentKey,
  });
});

test('webhook does not reclaim credits for an unverified cancellation', async () => {
  let reconcileCalls = 0;
  const store = {
    async find() { return { ...ORDER, status: 'paid', payment_key: PAYMENT.paymentKey }; },
    async reconcileCanceledRefund() { reconcileCalls += 1; },
  };
  const router = createPaymentWebhookRouter({
    store,
    getPayment: async () => ({ ...CANCELED_PAYMENT, balanceAmount: 100 }),
  });

  const response = await request(router, '/', {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: CANCELED_PAYMENT,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.ignored, true);
  assert.equal(reconcileCalls, 0);
});
