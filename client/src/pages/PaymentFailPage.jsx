import { useSearchParams, useNavigate } from 'react-router-dom';

export default function PaymentFailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const code = searchParams.get('code');
  const message = searchParams.get('message');

  return (
    <div style={{ maxWidth: '500px', margin: '80px auto', textAlign: 'center' }}>
      <div className="card" style={{ padding: '40px' }}>
        <p style={{ fontSize: '3rem', marginBottom: '16px' }}>❌</p>
        <h2 style={{ color: '#FF4444', marginBottom: '12px' }}>결제 실패</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>
          {message || '결제가 취소되었거나 실패했습니다.'}
        </p>
        {code && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '24px' }}>
            에러 코드: {code}
          </p>
        )}
        <button className="gradient-btn" onClick={() => navigate('/payment')} style={{ padding: '12px 32px' }}>
          다시 시도
        </button>
      </div>
    </div>
  );
}
