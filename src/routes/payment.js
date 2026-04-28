import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

const PLANS = {
  basic: { credits: 100, price: 4900, name: '베이직 100크레딧' },
  pro: { credits: 300, price: 12900, name: '프로 300크레딧' },
  creator: { credits: 1000, price: 34900, name: '크리에이터 1000크레딧' },
};

// 결제 요청 생성
router.post('/create', authMiddleware, async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: '유효하지 않은 플랜입니다.' });
  }

  const orderId = `order_${planId}_${req.user.id.slice(0, 8)}_${Date.now()}`;

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

  // orderId에서 planId 파싱 (신규 포맷: order_${planId}_${userId}_${ts})
  // 구버전 포맷(order_${userId}_${ts}) fallback: amount로 플랜 역방향 검색
  const orderParts = orderId.split('_');
  const parsedPlanId = orderParts.length >= 4 ? orderParts[1] : null;
  let planEntry = parsedPlanId ? Object.entries(PLANS).find(([id]) => id === parsedPlanId) : null;
  if (!planEntry) {
    planEntry = Object.entries(PLANS).find(([, p]) => p.price === amount);
  }
  if (!planEntry) {
    return res.status(400).json({ error: '결제 금액이 유효하지 않습니다.' });
  }

  const [planId, plan] = planEntry;

  try {
    // 중복 결제 방지: orderId가 이미 처리됐는지 확인
    const { data: existing } = await supabaseAdmin
      .from('usage_logs')
      .select('id')
      .eq('order_id', orderId)
      .maybeSingle();

    if (existing) {
      console.warn(`[payment] 중복 결제 시도 — orderId: ${orderId}, user: ${req.user.email}`);
      return res.status(400).json({ error: '이미 처리된 결제입니다.' });
    }

    // 토스페이먼츠 결제 승인 API 호출
    const secretKey = process.env.TOSS_SECRET_KEY;
    const basicAuth = Buffer.from(`${secretKey}:`).toString('base64');

    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });

    const tossData = await tossRes.json();

    if (!tossRes.ok) {
      console.error('[payment] 토스 승인 실패:', tossData);
      return res.status(400).json({ error: tossData.message || '결제 승인에 실패했습니다.' });
    }

    // 크레딧 충전
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('credits')
      .eq('id', req.user.id)
      .single();

    const currentCredits = profile?.credits ?? 0;
    const newCredits = currentCredits + plan.credits;

    await supabaseAdmin
      .from('profiles')
      .update({ credits: newCredits, updated_at: new Date().toISOString() })
      .eq('id', req.user.id);

    // 충전 내역 기록
    await supabaseAdmin
      .from('usage_logs')
      .insert({
        user_id: req.user.id,
        action: 'charge',
        credits_used: -plan.credits,
        order_id: orderId,
        description: `${plan.name} 결제 (${plan.price.toLocaleString()}원)`,
      });

    console.log(`[payment] 유저 ${req.user.email}: ${plan.credits}크레딧 충전 (${newCredits} 보유)`);

    res.json({
      success: true,
      credits: newCredits,
      charged: plan.credits,
      message: `${plan.credits} 크레딧이 충전되었습니다.`,
    });
  } catch (err) {
    console.error('[payment] 오류:', err.message);
    res.status(500).json({ error: '결제 처리 중 오류가 발생했습니다.' });
  }
});

export default router;
