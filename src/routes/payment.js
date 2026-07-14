import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authMiddleware } from '../middleware/auth.js';
import { paymentOrderStore } from '../services/payment-orders.js';
import {
  confirmOrRecoverTossPayment,
  getTossPaymentByOrderId,
  isVerifiedTossPayment,
  TossPaymentError,
} from '../services/toss-payments.js';

export const PLANS = {
  basic: { credits: 100, price: 4900, name: '베이직 100분' },
  pro: { credits: 300, price: 12900, name: '프로 300분' },
  creator: { credits: 1000, price: 34900, name: '크리에이터 1000분' },
};

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidPaymentKey(paymentKey) {
  return typeof paymentKey === 'string' && paymentKey.length > 0 && paymentKey.length <= 200;
}

export function isValidOrderId(orderId) {
  return typeof orderId === 'string' && ORDER_ID_PATTERN.test(orderId);
}

function sendCompletedPayment(res, result, message) {
  return res.json({
    success: true,
    credits: result.credits,
    charged: result.charged,
    alreadyPaid: result.already_paid,
    message,
  });
}

export function createPaymentRouter({
  auth = authMiddleware,
  store = paymentOrderStore,
  confirmPayment = confirmOrRecoverTossPayment,
  clientKey = () => process.env.TOSS_CLIENT_KEY,
  secretKey = () => process.env.TOSS_SECRET_KEY,
} = {}) {
  const router = Router();

  router.post('/create', auth, async (req, res) => {
    const { planId } = req.body;
    const plan = PLANS[planId];

    if (!plan) {
      return res.status(400).json({ error: '유효하지 않은 플랜입니다.' });
    }

    const orderId = `order_${randomUUID()}`;

    try {
      await store.create({
        order_id: orderId,
        user_id: req.user.id,
        plan_id: planId,
        plan_name: plan.name,
        amount: plan.price,
        credits: plan.credits,
      });
    } catch (error) {
      console.error('[payment.create]', JSON.stringify({
        requestId: req.requestId,
        error: error.message,
      }));
      return res.status(500).json({ error: '결제 주문을 준비하지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }

    return res.json({
      orderId,
      amount: plan.price,
      orderName: plan.name,
      credits: plan.credits,
      customerEmail: req.user.email,
      clientKey: clientKey(),
    });
  });

  router.post('/confirm', auth, async (req, res) => {
    const { paymentKey, orderId, amount } = req.body;

    try {
      if (!isValidPaymentKey(paymentKey) || !isValidOrderId(orderId) || !Number.isInteger(amount)) {
        return res.status(400).json({ error: '결제 정보가 올바르지 않습니다.' });
      }

      const order = await store.find(orderId);
      if (!order || order.user_id !== req.user.id) {
        return res.status(404).json({ error: '결제 주문을 찾을 수 없습니다. 결제 페이지에서 다시 시도해주세요.' });
      }
      if (amount !== order.amount) {
        return res.status(400).json({ error: '결제 금액이 주문 정보와 일치하지 않습니다.' });
      }

      if (order.status === 'paid') {
        if (order.payment_key !== paymentKey) {
          return res.status(400).json({ error: '이미 다른 결제 정보로 처리된 주문입니다.' });
        }

        const credits = await store.getCurrentCredits(req.user.id);
        return sendCompletedPayment(res, {
          credits,
          charged: order.credits,
          already_paid: true,
        }, '이미 완료된 결제입니다.');
      }

      const { recovered } = await confirmPayment({
        paymentKey,
        orderId,
        amount: order.amount,
        idempotencyKey: order.idempotency_key,
        secretKey: secretKey(),
      });

      const result = await store.complete({
        orderId,
        userId: req.user.id,
        paymentKey,
      });

      console.log('[payment.complete]', JSON.stringify({
        requestId: req.requestId,
        orderId,
        charged: result.charged,
        recovered,
        alreadyPaid: result.already_paid,
      }));

      return sendCompletedPayment(
        res,
        result,
        result.already_paid ? '이미 완료된 결제입니다.' : `${result.charged}분이 충전되었습니다.`,
      );
    } catch (error) {
      if (error instanceof TossPaymentError) {
        console.error('[payment.provider_error]', JSON.stringify({
          requestId: req.requestId,
          orderId,
          code: error.code,
          status: error.status,
          retryable: error.retryable,
        }));
        return res.status(error.retryable ? 502 : 400).json({
          error: error.message,
          retryable: error.retryable,
        });
      }

      console.error('[payment.error]', JSON.stringify({
        requestId: req.requestId,
        orderId,
        error: error.message,
      }));
      return res.status(500).json({
        error: '결제 처리 확인 중 오류가 발생했습니다. 결제를 다시 진행하지 말고 다시 확인해주세요.',
        retryable: true,
      });
    }
  });

  return router;
}

export function createPaymentWebhookRouter({
  store = paymentOrderStore,
  getPayment = getTossPaymentByOrderId,
  secretKey = () => process.env.TOSS_SECRET_KEY,
} = {}) {
  const router = Router();

  router.post('/', async (req, res) => {
    const { eventType, data } = req.body ?? {};

    if (eventType !== 'PAYMENT_STATUS_CHANGED' || data?.status !== 'DONE') {
      return res.json({ received: true });
    }

    const { paymentKey, orderId } = data;
    if (!isValidPaymentKey(paymentKey) || !isValidOrderId(orderId)) {
      return res.status(400).json({ error: '웹훅 결제 정보가 올바르지 않습니다.' });
    }

    try {
      const order = await store.find(orderId);
      if (!order) {
        console.warn('[payment.webhook_unknown_order]', JSON.stringify({ orderId }));
        return res.json({ received: true });
      }

      if (order.status === 'paid') {
        if (order.payment_key !== paymentKey) {
          console.error('[payment.webhook_payment_key_mismatch]', JSON.stringify({ orderId }));
        }
        return res.json({ received: true, alreadyPaid: true });
      }

      const payment = await getPayment({
        orderId,
        secretKey: secretKey(),
      });
      const expected = { paymentKey, orderId, amount: order.amount };

      if (!isVerifiedTossPayment(payment, expected)) {
        console.error('[payment.webhook_verification_failed]', JSON.stringify({
          orderId,
          status: payment?.status,
        }));
        return res.json({ received: true, ignored: true });
      }

      const result = await store.complete({
        orderId,
        userId: order.user_id,
        paymentKey,
      });

      console.log('[payment.webhook_complete]', JSON.stringify({
        orderId,
        charged: result.charged,
        alreadyPaid: result.already_paid,
      }));
      return res.json({ received: true, completed: true });
    } catch (error) {
      console.error('[payment.webhook_error]', JSON.stringify({
        orderId,
        code: error.code,
        error: error.message,
      }));
      return res.status(500).json({ error: '결제 웹훅을 처리하지 못했습니다.' });
    }
  });

  return router;
}

export const paymentWebhookRouter = createPaymentWebhookRouter();
export default createPaymentRouter();
