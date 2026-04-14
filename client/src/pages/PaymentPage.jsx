import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PaymentPage() {
  const { user, updateCredits, getToken } = useAuth();
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const plans = [
    { id: 'basic', name: '베이직', credits: 100, originalPrice: 9900, salePrice: 4900, discount: 50, color: '#39FF14' },
    { id: 'pro', name: '프로', credits: 300, originalPrice: 25900, salePrice: 12900, discount: 50, color: '#00F5FF', popular: true },
    { id: 'creator', name: '크리에이터', credits: 1000, originalPrice: 90000, salePrice: 34900, discount: 61, color: '#FF6B6B' },
  ];

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
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '8px' }}>
        크레딧 충전
      </h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '12px' }}>
        1크레딧 = 1분 변환. 크레딧은 만료되지 않습니다.
      </p>
      <div className="card" style={{ marginBottom: '24px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '1.5rem' }}>🎁</span>
        <div>
          <p style={{ color: 'var(--text-primary)', fontWeight: 600 }}>무료 체험 10크레딧</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>회원가입 시 10분 무료 변환 제공</p>
        </div>
      </div>

      {error && <p style={{ color: '#FF4444', marginBottom: '16px', textAlign: 'center' }}>{error}</p>}
      {success && <p style={{ color: '#22c55e', marginBottom: '16px', textAlign: 'center' }}>{success}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        {plans.map((plan) => (
          <div
            key={plan.name}
            className="card"
            style={{
              position: 'relative',
              textAlign: 'center',
              padding: '28px 20px',
              border: plan.popular ? '2px solid var(--gradient-end)' : '1px solid var(--border-color)',
            }}
          >
            {plan.popular && (
              <div style={{
                position: 'absolute',
                top: '-12px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--gradient)',
                color: '#000',
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '4px 14px',
                borderRadius: '20px',
              }}>
                인기
              </div>
            )}
            <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '8px' }}>
              {plan.name}
            </h3>
            <p style={{ fontSize: '2rem', fontWeight: 700, color: plan.color, marginBottom: '4px' }}>
              {plan.credits} <span style={{ fontSize: '0.9rem', fontWeight: 400 }}>크레딧</span>
            </p>
            <p style={{ marginBottom: '4px' }}>
              <span style={{ color: '#FF4444', textDecoration: 'line-through', fontSize: '0.95rem' }}>
                {plan.originalPrice.toLocaleString()}원
              </span>
              <span style={{
                background: '#FF4444',
                color: '#fff',
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: '4px',
                marginLeft: '6px',
              }}>
                {plan.discount}% 할인
              </span>
            </p>
            <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
              {plan.salePrice.toLocaleString()}원
            </p>
            <button
              className="gradient-btn"
              style={{ width: '100%', padding: '10px', opacity: loading === plan.id ? 0.5 : 1 }}
              onClick={() => handlePurchase(plan)}
              disabled={loading !== null}
            >
              {loading === plan.id ? '처리 중...' : '충전하기'}
            </button>
          </div>
        ))}
      </div>
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
