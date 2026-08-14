import { useSearchParams, useNavigate } from 'react-router-dom';

export default function PaymentFailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const code = searchParams.get('code') || 'UNKNOWN';
  const message = searchParams.get('message') || '알 수 없는 오류가 발생했습니다.';

  return (
    <div className="payment-status-page">
      <div
        className="payment-status-card"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <p className="payment-status-card__icon payment-status-card__icon--error" aria-hidden="true">!</p>
        <h1 className="payment-status-card__title--error">결제 실패</h1>
        <p>{message}</p>
        <p className="payment-status-card__note">
          오류 코드: {code}
        </p>
        <p className="payment-status-card__issuer-note">
          우리카드·하나카드 계열을 사용했다면 다른 카드사로 다시 시도해주세요.
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
