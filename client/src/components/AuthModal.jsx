import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function AuthModal({ isOpen, onClose }) {
  const { login, signup, loginWithGoogle } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const localizeError = (msg) => {
    if (!msg) return '오류가 발생했습니다.';
    const map = [
      ['Invalid email', '올바른 이메일 주소를 입력해주세요.'],
      ['User already registered', '이미 가입된 이메일입니다.'],
      ['already registered', '이미 가입된 이메일입니다.'],
      ['Invalid login credentials', '이메일 또는 비밀번호가 올바르지 않습니다.'],
      ['Invalid credentials', '이메일 또는 비밀번호가 올바르지 않습니다.'],
      ['Email not confirmed', '이메일 인증이 완료되지 않았습니다. 메일함을 확인해주세요.'],
      ['Password should be', '비밀번호는 6자 이상이어야 합니다.'],
      ['signup is disabled', '현재 회원가입이 비활성화되어 있습니다.'],
    ];
    for (const [key, val] of map) {
      if (msg.toLowerCase().includes(key.toLowerCase())) return val;
    }
    return msg;
  };

  const handleSubmit = async () => {
    setError('');
    setSuccess('');
    if (!email) return setError('이메일을 입력해주세요.');
    if (mode !== 'reset') {
      if (!password) return setError('비밀번호를 입력해주세요.');
      if (password.length < 6) return setError('비밀번호는 6자 이상이어야 합니다.');
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        onClose();
      } else if (mode === 'signup') {
        await signup(email, password);
        setSuccess('인증 메일이 발송되었습니다! 메일함을 확인해주세요. (스팸함도 확인)');
      } else if (mode === 'reset') {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setSuccess('재설정 링크가 이메일로 발송되었습니다. 메일함을 확인해주세요.');
      }
    } catch (err) {
      setError(localizeError(err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)', borderRadius: '16px',
        padding: '32px', width: '380px', maxWidth: '90vw',
        border: '1px solid var(--border-color)',
      }}>
        <h2 style={{ fontSize: '1.3rem', marginBottom: '24px', color: 'var(--text-primary)', textAlign: 'center' }}>
          {mode === 'login' ? '로그인' : mode === 'signup' ? '회원가입' : '비밀번호 재설정'}
        </h2>

        {mode !== 'reset' && (
          <>
            <button onClick={loginWithGoogle} style={{
              width: '100%', padding: '12px', marginBottom: '16px',
              background: '#fff', color: '#333', border: '1px solid #ddd',
              borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: '8px',
            }}>
              <span style={{ fontSize: '1.2rem' }}>G</span> Google로 {mode === 'login' ? '로그인' : '회원가입'}
            </button>

            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', margin: '16px 0' }}>
              또는 이메일로 {mode === 'login' ? '로그인' : '회원가입'}
            </div>
          </>
        )}

        <input type="email" placeholder="이메일" value={email}
          onChange={e => setEmail(e.target.value)} onKeyDown={handleKeyDown}
          style={{
            width: '100%', padding: '12px', marginBottom: '12px',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
            borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem',
            boxSizing: 'border-box',
          }} />

        {mode !== 'reset' && (
          <input type="password" placeholder="비밀번호 (6자 이상)" value={password}
            onChange={e => setPassword(e.target.value)} onKeyDown={handleKeyDown}
            style={{
              width: '100%', padding: '12px', marginBottom: '16px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
              borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem',
              boxSizing: 'border-box',
            }} />
        )}

        {error && <p style={{ color: '#ff4444', fontSize: '0.85rem', marginBottom: '12px' }}>{error}</p>}
        {success && <p style={{ color: '#22c55e', fontSize: '0.85rem', marginBottom: '12px' }}>{success}</p>}

        {mode === 'reset' && <div style={{ marginBottom: '16px' }} />}

        <button onClick={handleSubmit} disabled={loading} style={{
          width: '100%', padding: '12px', background: 'var(--gradient)',
          border: 'none', borderRadius: '8px', color: '#000',
          fontSize: '0.95rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.7 : 1,
        }}>
          {loading ? '처리 중...' : (mode === 'login' ? '로그인' : mode === 'signup' ? '가입하기' : '재설정 링크 발송')}
        </button>

        <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {mode === 'login' && (
            <>
              <span onClick={() => { setMode('reset'); setError(''); setSuccess(''); }} style={{ color: 'var(--gradient-start)', cursor: 'pointer' }}>비밀번호를 잊으셨나요?</span>
              {'　'}계정이 없으신가요? <span onClick={() => { setMode('signup'); setError(''); setSuccess(''); }} style={{ color: 'var(--gradient-start)', cursor: 'pointer' }}>회원가입</span>
            </>
          )}
          {mode === 'signup' && (
            <>이미 계정이 있으신가요? <span onClick={() => { setMode('login'); setError(''); setSuccess(''); }} style={{ color: 'var(--gradient-start)', cursor: 'pointer' }}>로그인</span></>
          )}
          {mode === 'reset' && (
            <span onClick={() => { setMode('login'); setError(''); setSuccess(''); }} style={{ color: 'var(--gradient-start)', cursor: 'pointer' }}>로그인으로 돌아가기</span>
          )}
        </p>
      </div>
    </div>
  );
}
