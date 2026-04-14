import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function UsagePage() {
  const { user, token } = useAuth();
  const [usageLogs, setUsageLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setUsageLogs(data.usageLogs || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const formatDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 24px' }}>
      {/* 상단 크레딧 표시 */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '32px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: 'var(--gradient)',
          color: '#000',
          fontSize: '1.2rem',
          fontWeight: 700,
        }}>C</span>
        <div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '4px' }}>현재 보유 크레딧</p>
          <p style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {user ? user.credits : '-'}
          </p>
        </div>
      </div>

      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
        사용 내역
      </h2>

      {loading && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>불러오는 중...</p>
      )}

      {!loading && error && (
        <p style={{ color: '#FF4444', textAlign: 'center', padding: '40px 0' }}>{error}</p>
      )}

      {!loading && !error && !token && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
          로그인 후 사용 내역을 확인할 수 있습니다.
        </p>
      )}

      {!loading && !error && token && usageLogs.length === 0 && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
          사용 내역이 없습니다.
        </p>
      )}

      {!loading && !error && usageLogs.length > 0 && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                {['날짜', '구분', '크레딧 변동', '설명'].map((h) => (
                  <th key={h} style={{
                    padding: '14px 16px',
                    textAlign: 'left',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usageLogs.map((log, i) => {
                const isCharge = log.action === 'charge';
                return (
                  <tr
                    key={log.id || i}
                    style={{
                      borderBottom: i < usageLogs.length - 1 ? '1px solid var(--border-color)' : 'none',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {formatDate(log.created_at)}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: '20px',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        background: isCharge ? 'rgba(57,255,20,0.12)' : 'rgba(255,68,68,0.12)',
                        color: isCharge ? '#39FF14' : '#FF4444',
                      }}>
                        {isCharge ? '충전' : '변환'}
                      </span>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '0.95rem', fontWeight: 700, color: isCharge ? '#39FF14' : '#FF4444' }}>
                      {isCharge ? '+' : '-'}{Math.abs(log.amount ?? log.credits_used ?? 0)}
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {log.description || log.note || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
