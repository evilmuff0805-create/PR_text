import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PaymentSuccessPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { updateCredits, getToken } = useAuth();
  const [status, setStatus] = useState('processing');
  const [message, setMessage] = useState('결제 승인 중...');
  const [countdown, setCountdown] = useState(5);
  const timerRef = useRef(null);

  useEffect(() => {
    const paymentKey = searchParams.get('paymentKey');
    const orderId = searchParams.get('orderId');
    const amount = searchParams.get('amount');

    if (!paymentKey || !orderId || !amount) {
      setStatus('error');
      setMessage('결제 정보가 올바르지 않습니다.');
      return;
    }

    const confirm = async () => {
      try {
        const token = getToken();
        const res = await fetch('/api/payment/confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || '결제 승인 실패');
        }

        updateCredits(data.credits);
        setStatus('success');
        setMessage(`${data.charged} 크레딧이 충전되었습니다! (총 ${data.credits} 크레딧)`);

        let count = 5;
        timerRef.current = setInterval(() => {
          count -= 1;
          setCountdown(count);
          if (count <= 0) {
            clearInterval(timerRef.current);
            navigate('/');
          }
        }, 1000);
      } catch (err) {
        setStatus('error');
        setMessage(err.message || '결제 처리 중 오류가 발생했습니다.');
      }
    };

    confirm();
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div style={{ maxWidth: '500px', margin: '80px auto', textAlign: 'center' }}>
      <div className="card" style={{ padding: '40px' }}>
        {status === 'processing' && (
          <>
            <p style={{ fontSize: '3rem', marginBottom: '16px' }}>⏳</p>
            <h2 style={{ color: 'var(--text-primary)', marginBottom: '12px' }}>결제 처리 중</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <p style={{ fontSize: '3rem', marginBottom: '16px' }}>✅</p>
            <h2 style={{ color: '#22c55e', marginBottom: '12px' }}>충전 완료!</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>{message}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '24px' }}>
              {countdown}초 후 자동으로 이동합니다...
            </p>
            <button className="gradient-btn" onClick={() => { clearInterval(timerRef.current); navigate('/'); }} style={{ padding: '12px 32px' }}>
              자막 변환하러 가기
            </button>
          </>
        )}
        {status === 'error' && (
          <>
            <p style={{ fontSize: '3rem', marginBottom: '16px' }}>❌</p>
            <h2 style={{ color: '#FF4444', marginBottom: '12px' }}>결제 실패</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{message}</p>
            <button className="gradient-btn" onClick={() => navigate('/payment')} style={{ padding: '12px 32px' }}>
              다시 시도
            </button>
          </>
        )}
      </div>
    </div>
  );
}
