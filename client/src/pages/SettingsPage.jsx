import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function SettingsPage() {
  const { user, getToken } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user) {
    return (
      <div>
        <p style={{ color: 'var(--text-secondary)' }}>로그인이 필요합니다.</p>
      </div>
    );
  }

  const handleChange = async () => {
    setError('');
    setSuccess('');
    if (newPassword.length < 6) return setError('비밀번호는 6자 이상이어야 합니다.');
    if (newPassword !== confirmPassword) return setError('비밀번호가 일치하지 않습니다.');

    setLoading(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('비밀번호가 변경되었습니다.');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message || '비밀번호 변경에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '12px',
    boxSizing: 'border-box',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
  };

  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        계정 설정
      </h2>
      <div className="card" style={{ maxWidth: '420px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: 'var(--text-primary)' }}>
          비밀번호 변경
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            type="password"
            placeholder="새 비밀번호 (6자 이상)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="새 비밀번호 확인"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            style={inputStyle}
          />
          {error && <p style={{ color: '#FF4444', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
          {success && <p style={{ color: '#22c55e', fontSize: '0.85rem', margin: 0 }}>{success}</p>}
          <button
            className="gradient-btn"
            onClick={handleChange}
            disabled={loading}
            style={{ padding: '12px', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? '변경 중...' : '비밀번호 변경'}
          </button>
        </div>
      </div>
    </div>
  );
}
