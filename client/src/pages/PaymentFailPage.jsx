import { useSearchParams, useNavigate } from 'react-router-dom';

export default function PaymentFailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const code = searchParams.get('code') || 'UNKNOWN';
  const message = searchParams.get('message') || '알 수 없는 오류가 발생했습니다.';

  return (
    <div className="payment-status-page">
      <div className="payment-status-card">
        <p className="payment-status-card__icon payment-status-card__icon--error" aria-hidden="true">!</p>
        <h2 className="payment-status-card__title--error">결제 실패</h2>
        <p>{message}</p>
        <p className="payment-status-card__note">
          오류 코드: {code}
        </p>
        <div className="payment-status-card__actions">
          <button
            className="gradient-btn payment-status-card__button"
            onClick={() => navigate('/payment')}
            type="button"
          >
            다시 시도
          </button>
          <button
            className="button button--secondary payment-status-card__button"
            onClick={() => navigate('/')}
            type="button"
          >
            홈으로
          </button>
        </div>
      </div>
    </div>
  );
}
