import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authMiddleware } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

const PLANS = {
  basic: { credits: 100, price: 4900, name: '베이직 100분' },
  pro: { credits: 300, price: 12900, name: '프로 300분' },
  creator: { credits: 1000, price: 34900, name: '크리에이터 1000분' },
};

function isValidPaymentKey(paymentKey) {
  return typeof paymentKey === 'string' && paymentKey.length > 0 && paymentKey.length <= 200;
}

async function getCurrentCredits(userId) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return profile.credits;
}

// 결제 요청 생성
router.post('/create', authMiddleware, async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: '유효하지 않은 플랜입니다.' });
  }

  const orderId = `order_${randomUUID()}`;
  const { error: orderError } = await supabaseAdmin
    .from('payment_orders')
    .insert({
      order_id: orderId,
      user_id: req.user.id,
      plan_id: planId,
      plan_name: plan.name,
      amount: plan.price,
      credits: plan.credits,
    });

  if (orderError) {
    console.error('[payment] 주문 생성 실패:', orderError.message);
    return res.status(500).json({ error: '결제 주문을 준비하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }

  res.json({
    orderId,
    amount: plan.price,
    orderName: plan.name,
    credits: plan.credits,
    customerEmail: req.user.email,
    clientKey: process.env.TOSS_CLIENT_KEY,
  });
});

// 결제 승인 (토스 결제 완료 후 호출)
router.post('/confirm', authMiddleware, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;

  try {
    if (!isValidPaymentKey(paymentKey) || typeof orderId !== 'string' || !Number.isInteger(amount)) {
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다.' });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('payment_orders')
      .select('order_id, user_id, amount, credits, status, payment_key, idempotency_key')
      .eq('order_id', orderId)
      .maybeSingle();

    if (orderError) throw orderError;
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

      const credits = await getCurrentCredits(req.user.id);
      return res.json({
        success: true,
        credits,
        charged: order.credits,
        alreadyPaid: true,
        message: '이미 완료된 결제입니다.',
      });
    }

    // 토스페이먼츠 결제 승인 API 호출
    const secretKey = process.env.TOSS_SECRET_KEY;
    const basicAuth = Buffer.from(`${secretKey}:`).toString('base64');

    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': order.idempotency_key,
      },
      body: JSON.stringify({ paymentKey, orderId, amount: order.amount }),
    });

    const tossData = await tossRes.json();

    if (!tossRes.ok) {
      console.error('[payment] 토스 승인 실패:', tossData);
      const retryable = tossRes.status >= 500;
      return res.status(retryable ? 502 : 400).json({
        error: tossData.message || '결제 승인에 실패했습니다.',
        retryable,
      });
    }

    if (tossData.orderId !== orderId || tossData.totalAmount !== order.amount || tossData.status !== 'DONE') {
      console.error('[payment] 토스 응답 검증 실패:', { orderId, tossOrderId: tossData.orderId, tossAmount: tossData.totalAmount, status: tossData.status });
      return res.status(502).json({
        error: '결제 승인 결과를 검증하지 못했습니다. 결제를 다시 진행하지 말고 잠시 후 다시 확인해주세요.',
        retryable: true,
      });
    }

    const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_payment_order', {
      p_order_id: orderId,
      p_user_id: req.user.id,
      p_payment_key: paymentKey,
    });

    if (completeError) throw completeError;
    const result = Array.isArray(completed) ? completed[0] : completed;
    if (!result) throw new Error('결제 완료 결과를 받지 못했습니다.');

    console.log(`[payment] 유저 ${req.user.email}: ${result.charged}크레딧 충전 (${result.credits} 보유)`);

    res.json({
      success: true,
      credits: result.credits,
      charged: result.charged,
      alreadyPaid: result.already_paid,
      message: `${result.charged}분이 충전되었습니다.`,
    });
  } catch (err) {
    console.error('[payment] 오류:', err.message);
    res.status(500).json({
      error: '결제 처리 확인 중 오류가 발생했습니다. 결제를 다시 진행하지 말고 다시 확인해주세요.',
      retryable: true,
    });
  }
});

export default router;
