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
  idempotency_key: '49ff4ef0-f325-4c66-bffe-3d630e257d9f',
};
const PAYMENT = {
  paymentKey: 'payment-key-1',
  orderId: ORDER.order_id,
  totalAmount: ORDER.amount,
  status: 'DONE',
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

async function request(router, path, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('accepts matching Toss test and live key pairs and rejects mixed environments', () => {
  assert.deepEqual(
    validateTossKeyPair({ clientKey: 'test_ck_client', secretKey: 'test_sk_secret' }),
    { environment: 'test' },
  );
  assert.deepEqual(
    validateTossKeyPair({ clientKey: 'live_gck_client', secretKey: 'live_gsk_secret' }),
    { environment: 'live' },
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'test_ck_client', secretKey: 'live_sk_secret' }),
    /섞여 있습니다/,
  );
  assert.throws(
    () => validateTossKeyPair({ clientKey: 'test_sk_secret', secretKey: 'test_ck_client' }),
    /클라이언트 키/,
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

test('creates orders from the server plan catalog and ignores client-supplied prices', async () => {
  let created;
  const store = {
    async create(order) { created = order; },
  };
  const router = createPaymentRouter({
    auth,
    store,
    clientKey: () => 'test_ck_client',
  });

  const response = await request(router, '/create', {
    planId: 'basic',
    amount: 1,
    credits: 999999,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.amount, 4900);
  assert.equal(response.data.credits, 100);
  assert.equal(created.amount, 4900);
  assert.equal(created.credits, 100);
  assert.equal(created.user_id, USER.id);
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
