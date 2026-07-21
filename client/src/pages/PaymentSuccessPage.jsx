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
  const confirmRef = useRef(null);

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
      setStatus('processing');
      setMessage('결제 승인 중...');
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
          const error = new Error(data.error || '결제 승인 실패');
          error.retryable = data.retryable === true;
          throw error;
        }

        updateCredits(data.credits);
        setStatus('success');
        const prefix = data.alreadyPaid ? '이미 반영된 결제입니다.' : `${data.charged}분이 충전되었습니다!`;
        setMessage(`${prefix} (총 ${data.credits}분)`);

        let count = 5;
        timerRef.current = setInterval(() => {
          count -= 1;
          setCountdown(count);
          if (count <= 0) {
            clearInterval(timerRef.current);
            navigate('/transcribe');
          }
        }, 1000);
      } catch (err) {
        setStatus(err.retryable ? 'retry' : 'error');
        setMessage(err.message || '결제 처리 중 오류가 발생했습니다.');
      }
    };

    confirmRef.current = confirm;
    confirm();
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div className="payment-status-page">
      <div
        className="payment-status-card"
        role={status === 'error' || status === 'retry' ? 'alert' : 'status'}
        aria-live={status === 'error' || status === 'retry' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {status === 'processing' && (
          <>
            <p className="payment-status-card__icon" aria-hidden="true">...</p>
            <h2>결제 처리 중</h2>
            <p>{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <p className="payment-status-card__icon payment-status-card__icon--success" aria-hidden="true">OK</p>
            <h2 className="payment-status-card__title--success">충전 완료</h2>
            <p>{message}</p>
            <p className="payment-status-card__note">
              {countdown}초 후 자동으로 이동합니다...
            </p>
            <button className="gradient-btn payment-status-card__button" onClick={() => { clearInterval(timerRef.current); navigate('/transcribe'); }} type="button">
              자막 변환하러 가기
            </button>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="payment-status-card__icon payment-status-card__icon--error" aria-hidden="true">!</p>
            <h2 className="payment-status-card__title--error">결제 실패</h2>
            <p>{message}</p>
            <button className="gradient-btn payment-status-card__button" onClick={() => navigate('/payment')} type="button">
              다시 시도
            </button>
          </>
        )}
        {status === 'retry' && (
          <>
            <p className="payment-status-card__icon payment-status-card__icon--warn" aria-hidden="true">!</p>
            <h2 className="payment-status-card__title--warn">결제 확인 필요</h2>
            <p>{message}</p>
            <button className="gradient-btn payment-status-card__button" onClick={() => confirmRef.current?.()} type="button">
              결제 다시 확인
            </button>
          </>
        )}
      </div>
    </div>
  );
}
