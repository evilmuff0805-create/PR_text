import { useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useDialogAccessibility } from '../utils/use-dialog-accessibility.js';

export default function AuthModal({ isOpen, onClose, restoreFocusRef, returnPath = '/' }) {
  const { login, signup, loginWithGoogle } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef(null);
  const emailInputRef = useRef(null);

  useDialogAccessibility({
    active: isOpen,
    containerRef: dialogRef,
    initialFocusRef: emailInputRef,
    onClose,
    restoreFocusRef,
    closeOnEscape: !loading,
  });

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
      ['Password should be', '비밀번호는 8자 이상이어야 합니다.'],
      ['signup is disabled', '현재 회원가입이 비활성화되어 있습니다.'],
    ];
    for (const [key, val] of map) {
      if (msg.toLowerCase().includes(key.toLowerCase())) return val;
    }
    return msg;
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    setError('');
    setSuccess('');
    if (!email) return setError('이메일을 입력해주세요.');
    if (mode !== 'reset') {
      if (!password) return setError('비밀번호를 입력해주세요.');
      if (mode === 'signup' && password.length < 8) {
        return setError('비밀번호는 8자 이상이어야 합니다.');
      }
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        onClose();
      } else if (mode === 'signup') {
        await signup(email, password);
        setSuccess('인증 메일이 발송되었습니다! 메일함을 확인해주세요.');
        let count = 3;
        const timer = setInterval(() => {
          count -= 1;
          if (count <= 0) {
            clearInterval(timer);
            setMode('login');
            setSuccess('이메일 인증이 완료되면 로그인할 수 있습니다.');
          }
        }, 1000);
      } else if (mode === 'reset') {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setSuccess('계정이 확인되면 재설정 링크가 발송됩니다. 메일함을 확인해주세요.');
      }
    } catch (err) {
      setError(localizeError(err.message));
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError('');
    setSuccess('');
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        aria-describedby="auth-modal-description"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
        background: 'var(--bg-secondary)', borderRadius: '16px',
        padding: '32px', width: '380px', maxWidth: '90vw',
        border: '1px solid var(--border-color)', position: 'relative',
      }}
      >
        <button
          type="button"
          aria-label="로그인 창 닫기"
          disabled={loading}
          onClick={onClose}
          style={{
            position: 'absolute', top: '12px', right: '12px', width: '36px', height: '36px',
            border: '1px solid var(--border-color)', borderRadius: '8px',
            background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '1.2rem', lineHeight: 1,
          }}
        >
          <span aria-hidden="true">×</span>
        </button>

        <h2 id="auth-modal-title" style={{ fontSize: '1.3rem', marginBottom: '24px', color: 'var(--text-primary)', textAlign: 'center' }}>
          {mode === 'login' ? '로그인' : mode === 'signup' ? '회원가입' : '비밀번호 재설정'}
        </h2>

        <form onSubmit={handleSubmit}>
          <button type="button" onClick={() => loginWithGoogle(returnPath)} style={{
            width: '100%', padding: '12px', marginBottom: '16px',
            background: '#fff', color: '#333', border: '1px solid #ddd',
            borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600,
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: '8px',
          }}>
            <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>G</span>
            Google로 {mode === 'signup' ? '회원가입' : '로그인'}
          </button>

          <div id="auth-modal-description" style={{
            textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem',
            lineHeight: 1.6, margin: '16px 0', wordBreak: 'keep-all',
          }}>
            {mode === 'reset' ? (
              <>
                Google 비밀번호는 PR_text에서 변경되지 않습니다.<br />
                Google 계정은 위 버튼으로 로그인하고, 이메일 계정만 아래에서 재설정하세요.
              </>
            ) : (
              <>또는 이메일로 {mode === 'login' ? '로그인' : '회원가입'}</>
            )}
          </div>

          <label className="sr-only" htmlFor="auth-email">이메일</label>
          <input
            ref={emailInputRef}
            id="auth-email"
            type="email"
            placeholder="이메일"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            required
            style={{
              width: '100%', padding: '12px', marginBottom: '12px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
              borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem',
              boxSizing: 'border-box',
            }}
          />

          {mode !== 'reset' && (
            <>
              <label className="sr-only" htmlFor="auth-password">
                {mode === 'signup' ? '비밀번호, 8자 이상' : '비밀번호'}
              </label>
              <input
                id="auth-password"
                type="password"
                placeholder={mode === 'signup' ? '비밀번호 (8자 이상)' : '비밀번호'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                minLength={mode === 'signup' ? 8 : undefined}
                required
                style={{
                  width: '100%', padding: '12px', marginBottom: '16px',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                  borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem',
                  boxSizing: 'border-box',
                }}
              />
            </>
          )}

          {error && <p role="alert" style={{ color: '#ff6b72', fontSize: '0.85rem', marginBottom: '12px' }}>{error}</p>}
          {success && (
            <div role="status" aria-live="polite" style={{ marginBottom: '12px' }}>
              <p style={{ color: '#3df274', fontSize: '0.85rem', marginBottom: '4px' }}>{success}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>이메일이 도착하지 않으면 스팸함을 확인해주세요.</p>
            </div>
          )}

          {mode === 'reset' && <div style={{ marginBottom: '16px' }} />}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '12px', background: 'var(--gradient)',
            border: 'none', borderRadius: '8px', color: '#000',
            fontSize: '0.95rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}>
            {loading ? '처리 중...' : (mode === 'login' ? '로그인' : mode === 'signup' ? '가입하기' : '재설정 링크 발송')}
          </button>

          {mode === 'signup' && (
            <p style={{
              color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.6,
              marginTop: '10px', textAlign: 'center', wordBreak: 'keep-all',
            }}>
              신규 무료 10분은 동일 로그인 계정에 최초 1회만 지급됩니다.
            </p>
          )}

          <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {mode === 'login' && (
              <>
                <button className="auth-modal__text-button" type="button" onClick={() => switchMode('reset')}>비밀번호를 잊으셨나요?</button>
                {' · '}계정이 없으신가요?{' '}
                <button className="auth-modal__text-button" type="button" onClick={() => switchMode('signup')}>회원가입</button>
              </>
            )}
            {mode === 'signup' && (
              <>이미 계정이 있으신가요?{' '}<button className="auth-modal__text-button" type="button" onClick={() => switchMode('login')}>로그인</button></>
            )}
            {mode === 'reset' && (
              <button className="auth-modal__text-button" type="button" onClick={() => switchMode('login')}>로그인으로 돌아가기</button>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
