import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authMiddleware } from '../middleware/auth.js';
import { paymentOrderStore } from '../services/payment-orders.js';
import {
  cancelOrRecoverTossPayment,
  confirmOrRecoverTossPayment,
  getTossPaymentByOrderId,
  isVerifiedCanceledTossPayment,
  isVerifiedTossPayment,
  TossPaymentError,
  validateTossKeyPair,
} from '../services/toss-payments.js';

export const PLANS = {
  basic: { credits: 100, price: 4900, name: '베이직 100분' },
  pro: { credits: 300, price: 12900, name: '프로 300분' },
  creator: { credits: 1000, price: 34900, name: '크리에이터 1000분' },
};

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const REFUND_CLIENT_ERROR_CODES = new Set(['PR001', 'PR002', 'PR003', 'PR004', 'PR005', 'PR006']);

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

function normalizeRefundReason(value) {
  if (value === undefined || value === null || value === '') return '고객 요청';
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length >= 1 && reason.length <= 200 ? reason : null;
}

export function createPaymentRouter({
  auth = authMiddleware,
  store = paymentOrderStore,
  confirmPayment = confirmOrRecoverTossPayment,
  cancelPayment = cancelOrRecoverTossPayment,
  clientKey = () => process.env.TOSS_CLIENT_KEY,
  secretKey = () => process.env.TOSS_SECRET_KEY,
  paymentEnvironment = () => validateTossKeyPair({
    clientKey: clientKey(),
    secretKey: secretKey(),
  }).environment,
  refundsEnabled = () => {
    const environment = paymentEnvironment();
    return environment === 'test' || process.env.PAYMENT_REFUNDS_ENABLED === 'true';
  },
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
        payment_environment: paymentEnvironment(),
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

  router.get('/orders', auth, async (req, res) => {
    try {
      const environment = paymentEnvironment();
      const storedOrders = await store.listForRefund(req.user.id, 10);
      const orders = storedOrders.map((order) => (
        order.payment_environment === environment
          ? order
          : {
            ...order,
            can_refund: false,
            can_retry: false,
            eligibility_reason: 'environment_mismatch',
          }
      ));
      return res.json({
        orders,
        refundsEnabled: refundsEnabled(),
      });
    } catch (error) {
      console.error('[payment.orders_error]', JSON.stringify({
        requestId: req.requestId,
        userId: req.user.id,
        error: error.message,
      }));
      return res.status(500).json({ error: '결제 내역을 불러오지 못했습니다.' });
    }
  });

  router.post('/refund', auth, async (req, res) => {
    const { orderId } = req.body ?? {};
    const reason = normalizeRefundReason(req.body?.reason);
    let prepared;

    try {
      if (!refundsEnabled()) {
        return res.status(503).json({
          error: '자동 환불은 현재 테스트 환경에서만 사용할 수 있습니다.',
        });
      }
      if (!isValidOrderId(orderId) || !reason) {
        return res.status(400).json({ error: '환불 요청 정보가 올바르지 않습니다.' });
      }

      const order = await store.find(orderId);
      if (!order || order.user_id !== req.user.id) {
        return res.status(404).json({ error: '결제 주문을 찾을 수 없습니다.' });
      }
      if (order.payment_environment !== paymentEnvironment()) {
        return res.status(409).json({
          error: '현재 결제 환경과 다른 주문입니다. 고객센터에 문의해주세요.',
          retryable: false,
        });
      }

      prepared = await store.prepareRefund({
        orderId,
        userId: req.user.id,
        reason,
      });

      if (prepared.already_refunded) {
        return res.json({
          success: true,
          credits: prepared.credits_remaining,
          refunded: prepared.credits,
          alreadyRefunded: true,
          message: '이미 환불된 결제입니다.',
        });
      }

      const { recovered } = await cancelPayment({
        paymentKey: prepared.payment_key,
        orderId: prepared.order_id,
        amount: prepared.amount,
        cancelReason: reason,
        idempotencyKey: prepared.refund_idempotency_key,
        secretKey: secretKey(),
      });

      const result = await store.completeRefund({
        orderId,
        userId: req.user.id,
        paymentKey: prepared.payment_key,
      });

      console.log('[payment.refund_complete]', JSON.stringify({
        requestId: req.requestId,
        orderId,
        refunded: result.refunded,
        recovered,
        alreadyRefunded: result.already_refunded,
      }));

      return res.json({
        success: true,
        credits: result.credits_remaining,
        refunded: result.refunded,
        alreadyRefunded: result.already_refunded,
        message: `${result.refunded}분 결제가 전액 환불되었습니다.`,
      });
    } catch (error) {
      if (error instanceof TossPaymentError) {
        let restoredCredits = null;

        if (error.definitivelyNotCanceled && prepared) {
          try {
            const restored = await store.failRefund({
              orderId,
              userId: req.user.id,
              errorCode: error.code || 'TOSS_CANCELLATION_REJECTED',
            });
            restoredCredits = restored.credits_remaining;
          } catch (restoreError) {
            try {
              const latestOrder = await store.find(orderId);
              if (latestOrder?.refund_status === 'refunded') {
                const credits = await store.getCurrentCredits(req.user.id);
                return res.json({
                  success: true,
                  credits,
                  refunded: latestOrder.credits,
                  alreadyRefunded: true,
                  message: '결제가 전액 환불되었습니다.',
                });
              }
            } catch (statusError) {
              console.error('[payment.refund_restore_status_error]', JSON.stringify({
                requestId: req.requestId,
                orderId,
                error: statusError.message,
              }));
            }

            console.error('[payment.refund_restore_error]', JSON.stringify({
              requestId: req.requestId,
              orderId,
              error: restoreError.message,
            }));
            return res.status(500).json({
              error: '환불 실패 후 크레딧 복구 상태를 확인하지 못했습니다. 고객센터에 문의해주세요.',
              retryable: true,
            });
          }
        }

        console.error('[payment.refund_provider_error]', JSON.stringify({
          requestId: req.requestId,
          orderId,
          code: error.code,
          retryable: error.retryable,
          definitivelyNotCanceled: error.definitivelyNotCanceled,
        }));

        return res.status(error.definitivelyNotCanceled ? 409 : 502).json({
          error: error.definitivelyNotCanceled
            ? '결제가 취소되지 않아 회수한 크레딧을 복구했습니다. 고객센터에 문의해주세요.'
            : error.message,
          retryable: !error.definitivelyNotCanceled,
          credits: restoredCredits,
        });
      }

      if (REFUND_CLIENT_ERROR_CODES.has(error.code)) {
        return res.status(409).json({ error: error.message, retryable: false });
      }

      console.error('[payment.refund_error]', JSON.stringify({
        requestId: req.requestId,
        orderId,
        error: error.message,
      }));
      return res.status(500).json({
        error: '환불 처리 상태를 확인하지 못했습니다. 환불 확인을 다시 시도해주세요.',
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

    if (eventType !== 'PAYMENT_STATUS_CHANGED' || !['DONE', 'CANCELED'].includes(data?.status)) {
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

      if (data.status === 'CANCELED') {
        const payment = await getPayment({
          orderId,
          secretKey: secretKey(),
        });
        const expected = { paymentKey, orderId, amount: order.amount };

        if (!isVerifiedCanceledTossPayment(payment, expected)) {
          console.error('[payment.webhook_cancel_verification_failed]', JSON.stringify({
            orderId,
            status: payment?.status,
          }));
          return res.json({ received: true, ignored: true });
        }

        const result = order.user_id
          ? await store.reconcileCanceledRefund({ orderId, paymentKey })
          : await store.recordDeletedAccountCancellation({ orderId, paymentKey });
        console.log('[payment.webhook_refund_complete]', JSON.stringify({
          orderId,
          refunded: result.refunded || null,
          manualReview: result.manual_review,
          alreadyRefunded: result.already_refunded,
        }));
        return res.json({
          received: true,
          refunded: !result.manual_review,
          manualReview: result.manual_review,
        });
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
