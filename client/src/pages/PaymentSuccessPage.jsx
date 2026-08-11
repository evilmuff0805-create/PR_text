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
  const orderId = searchParams.get('orderId');

  useEffect(() => {
    const paymentKey = searchParams.get('paymentKey');
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
          error.needsLogin = res.status === 401;
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
        setMessage(err.needsLogin
          ? '로그인이 풀려 결제를 확인하지 못했습니다. 다시 로그인한 뒤 아래 버튼을 눌러주세요.'
          : (err.message || '결제 처리 중 오류가 발생했습니다.'));
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
            <h1>결제 처리 중</h1>
            <p>{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <p className="payment-status-card__icon payment-status-card__icon--success" aria-hidden="true">OK</p>
            <h1 className="payment-status-card__title--success">충전 완료</h1>
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
            <h1 className="payment-status-card__title--error">결제를 확인하지 못했습니다</h1>
            <p>{message}</p>
            {/*
              여기서 결제 페이지로 보내면, 이미 승인된 카드에 대해 새 주문을 하나 더
              만들어 이중결제가 된다. 같은 주문을 다시 확인하는 것만 제공한다.
            */}
            <p className="payment-status-card__warning">
              카드 승인 문자를 받으셨다면 결제는 이미 완료됐을 수 있습니다.
              <strong> 새로 결제하지 마시고</strong> 아래 버튼으로 다시 확인해주세요.
              그래도 반영되지 않으면 아래 주문번호로 문의해주시면 바로 처리해드립니다.
            </p>
            {orderId && (
              <p className="payment-status-card__note">주문번호: <code>{orderId}</code></p>
            )}
            <button className="gradient-btn payment-status-card__button" onClick={() => confirmRef.current?.()} type="button">
              결제 다시 확인
            </button>
            <button className="payment-status-card__link" onClick={() => navigate('/support')} type="button">
              고객센터 문의
            </button>
          </>
        )}
        {status === 'retry' && (
          <>
            <p className="payment-status-card__icon payment-status-card__icon--warn" aria-hidden="true">!</p>
            <h1 className="payment-status-card__title--warn">결제 확인 필요</h1>
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
