import { useSearchParams, useNavigate } from 'react-router-dom';

export default function PaymentFailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const code = searchParams.get('code') || 'UNKNOWN';
  const message = searchParams.get('message') || '알 수 없는 오류가 발생했습니다.';

  return (
    <div style={{ maxWidth: '500px', margin: '80px auto', textAlign: 'center' }}>
      <div className="card" style={{ padding: '40px' }}>
        <p style={{ fontSize: '3rem', marginBottom: '16px' }}>❌</p>
        <h2 style={{ color: '#FF4444', marginBottom: '12px' }}>결제 실패</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>{message}</p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '28px' }}>
          오류 코드: {code}
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button
            className="gradient-btn"
            style={{ padding: '12px 28px' }}
            onClick={() => navigate('/payment')}
          >
            다시 시도
          </button>
          <button
            style={{
              padding: '12px 28px',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '0.95rem',
            }}
            onClick={() => navigate('/')}
          >
            홈으로
          </button>
        </div>
      </div>
    </div>
  );
}
