import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PaymentPage() {
  const { user, getToken } = useAuth();
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const plans = [
    {
      id: 'basic',
      name: '베이직',
      credits: 100,
      originalPrice: 9900,
      salePrice: 4900,
      discount: 50,
      tone: 'green',
      summary: '가벼운 테스트와 짧은 클립 변환',
      detail: '약 100분 변환',
    },
    {
      id: 'pro',
      name: '프로',
      credits: 300,
      originalPrice: 25900,
      salePrice: 12900,
      discount: 50,
      tone: 'cyan',
      popular: true,
      summary: '인터뷰, 회의, 유튜브 초안 작업',
      detail: '약 300분 변환',
    },
    {
      id: 'creator',
      name: '크리에이터',
      credits: 1000,
      originalPrice: 90000,
      salePrice: 34900,
      discount: 61,
      tone: 'coral',
      summary: '정기 콘텐츠와 대량 자막 작업',
      detail: '약 1,000분 변환',
    },
  ];

  const selectedPlan = plans.find((plan) => plan.id === loading);
  const bestPlan = plans.reduce((best, plan) => (
    plan.salePrice / plan.credits < best.salePrice / best.credits ? plan : best
  ), plans[0]);
  const remainingCredits = Number.isFinite(user?.credits) ? user.credits : 0;

  async function handlePurchase(plan) {
    if (!user) {
      setError('로그인이 필요합니다.');
      return;
    }

    setError('');
    setSuccess('');
    setLoading(plan.id);

    try {
      const token = getToken();
      const res = await fetch('/api/payment/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ planId: plan.id }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '결제 요청 실패');
      }

      const { orderId, amount, orderName, customerEmail, clientKey } = await res.json();

      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: user.id });

      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: amount },
        orderId,
        orderName,
        customerEmail,
        successUrl: `${window.location.origin}/payment/success`,
        failUrl: `${window.location.origin}/payment/fail`,
      });
    } catch (err) {
      if (err.code === 'USER_CANCEL') {
        setLoading(null);
        return;
      }
      setError(err.message || '결제 중 오류가 발생했습니다.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="payment-page">
      <section className="payment-heading" aria-labelledby="payment-title">
        <p className="workspace-kicker">PAYMENT</p>
        <div className="payment-heading__row">
          <div>
            <h2 id="payment-title" className="workspace-title">변환 시간 충전</h2>
            <p className="workspace-description">
              결제한 시간은 분 단위로 차감되며, 충전된 시간은 만료되지 않습니다.
            </p>
          </div>
          <div className="payment-balance" aria-label="현재 보유 변환 시간">
            <span>현재 보유</span>
            <strong>{remainingCredits.toLocaleString()}분</strong>
          </div>
        </div>
      </section>

      <section className="payment-brief" aria-label="충전 안내">
        <div>
          <span>무료 체험</span>
          <strong>회원가입 시 10분 제공</strong>
        </div>
        <div>
          <span>사용 방식</span>
          <strong>음성 길이 1분당 1분 차감</strong>
        </div>
        <div>
          <span>가성비</span>
          <strong>{bestPlan.name} {Math.round(bestPlan.salePrice / bestPlan.credits).toLocaleString()}원/분</strong>
        </div>
      </section>

      {(error || success || selectedPlan) && (
        <div className={error ? 'payment-alert payment-alert--error' : 'payment-alert'}>
          {error || success || `${selectedPlan.name} 결제창을 여는 중입니다.`}
        </div>
      )}

      <section className="payment-plans" aria-label="충전 상품">
        {plans.map((plan) => (
          <article
            key={plan.name}
            className={plan.popular ? 'payment-plan is-popular' : 'payment-plan'}
          >
            {plan.popular && (
              <span className="payment-plan__badge">추천</span>
            )}
            <div className="payment-plan__topline">
              <span className={`payment-plan__mark payment-plan__mark--${plan.tone}`} aria-hidden="true" />
              <span>{plan.detail}</span>
            </div>
            <h3>{plan.name}</h3>
            <p className="payment-plan__summary">{plan.summary}</p>
            <div className="payment-plan__credits">
              <strong>{plan.credits.toLocaleString()}</strong>
              <span>분</span>
            </div>
            <dl className="payment-plan__price">
              <div>
                <dt>판매가</dt>
                <dd>{plan.salePrice.toLocaleString()}원</dd>
              </div>
              <div>
                <dt>정상가</dt>
                <dd>
                  <span>{plan.originalPrice.toLocaleString()}원</span>
                  <em>{plan.discount}%</em>
                </dd>
              </div>
              <div>
                <dt>분당</dt>
                <dd>{Math.round(plan.salePrice / plan.credits).toLocaleString()}원</dd>
              </div>
            </dl>
            <button
              className="gradient-btn payment-plan__button"
              onClick={() => handlePurchase(plan)}
              disabled={loading !== null}
              type="button"
            >
              {loading === plan.id ? '처리 중...' : '충전하기'}
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}

function loadTossPayments(clientKey) {
  return new Promise((resolve, reject) => {
    if (window.TossPayments) {
      resolve(window.TossPayments(clientKey));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.tosspayments.com/v2/standard';
    script.onload = () => resolve(window.TossPayments(clientKey));
    script.onerror = () => reject(new Error('토스페이먼츠 SDK 로드 실패'));
    document.head.appendChild(script);
  });
}
