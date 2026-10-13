import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-api';

function turnstileTime(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '잠시 후';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function TurnstileChallenge({ challenge, resetKey, onToken, onError }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);

  useEffect(() => {
    let active = true;
    const render = () => {
      if (!active || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: challenge.siteKey,
        action: challenge.action,
        cData: challenge.nonce,
        size: 'compact',
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => { onToken(''); onError(); },
      });
    };

    let script = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (script?.dataset.failed === 'true') {
      script.remove();
      script = null;
    }
    if (!script) {
      script = document.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const handleScriptError = () => {
      script.dataset.failed = 'true';
      onError();
    };
    script.addEventListener('load', render);
    script.addEventListener('error', handleScriptError);
    render();

    return () => {
      active = false;
      script.removeEventListener('load', render);
      script.removeEventListener('error', handleScriptError);
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, [challenge.action, challenge.nonce, challenge.siteKey, onError, onToken, resetKey]);

  return <div ref={containerRef} aria-label="추가 계정 확인" />;
}

export default function WelcomeCreditCard() {
  const { user, token, updateCredits } = useAuth();
  const [status, setStatus] = useState('loading');
  const [challenge, setChallenge] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [retryAt, setRetryAt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeReset, setChallengeReset] = useState(0);
  const requestVersion = useRef(0);

  const loadStatus = async () => {
    const version = ++requestVersion.current;
    setError('');
    try {
      const response = await fetch('/api/auth/welcome-credit', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (version !== requestVersion.current) return;
      if (!response.ok) throw new Error(data.error || '무료 체험 지급 상태를 확인하지 못했습니다.');
      if (data.status === 'granted' || data.status === 'not_eligible' || data.status === 'email_unconfirmed') {
        setStatus('hidden');
        return;
      }
      setStatus(data.status);
      setChallenge(data.challenge || null);
      setRetryAt(data.retryAt || null);
    } catch {
      if (version === requestVersion.current) {
        setStatus('error');
        setError('무료 체험 지급을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.');
      }
    }
  };

  useEffect(() => {
    setStatus(user && token ? 'loading' : 'hidden');
    setChallenge(null);
    setTurnstileToken('');
    setError('');
    if (user && token) loadStatus();
    return () => { requestVersion.current += 1; };
  }, [user?.id, token]);

  const onTurnstileError = useCallback(() => {
    setTurnstileToken('');
    setError('추가 확인을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
  }, []);

  const retryChallenge = async () => {
    setTurnstileToken('');
    setChallengeReset((value) => value + 1);
    await loadStatus();
  };

  const claimWelcomeCredit = async () => {
    if (busy) return;
    if (status === 'challenge_required' && !turnstileToken) {
      setError('추가 계정 확인을 먼저 완료해주세요.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/welcome-credit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeNonce: challenge?.nonce || null,
          turnstileToken: turnstileToken || null,
        }),
      });
      const data = await response.json();
      if (response.status === 428 && data.challenge) {
        setChallenge(data.challenge);
        setStatus('challenge_required');
        setTurnstileToken('');
        setChallengeReset((value) => value + 1);
        return;
      }
      if (response.status === 429 && data.status === 'ip_limit') {
        setStatus('ip_limit');
        setRetryAt(data.retryAt || null);
        setChallenge(null);
        setTurnstileToken('');
        return;
      }
      if (response.status === 409 && data.status === 'retry_required') {
        await loadStatus();
        return;
      }
      if (response.status === 409 && data.status === 'not_eligible') {
        setStatus('hidden');
        return;
      }
      if (!response.ok) {
        if (status === 'challenge_required') {
          setTurnstileToken('');
          setChallengeReset((value) => value + 1);
        }
        throw new Error(data.error || '무료 10분을 지급하지 못했습니다.');
      }
      if (data.status === 'granted') {
        if (Number.isFinite(data.credits)) updateCredits(data.credits);
        setStatus('success');
        setChallenge(null);
        setTurnstileToken('');
        return;
      }
      setStatus('hidden');
    } catch (requestError) {
      setError(requestError.message || '무료 10분을 지급하지 못했습니다. 다시 시도해주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (!user || !token || status === 'hidden' || status === 'loading') return null;

  return (
    <section
      aria-label="무료 체험 시간"
      style={{
        margin: '0 12px 12px', padding: '12px', borderRadius: '10px',
        background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
      }}
    >
      {status === 'success' ? (
        <p role="status" aria-live="polite" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.875rem', lineHeight: 1.5 }}>
          무료 10분을 지급했습니다. 잔여 시간에서 확인할 수 있습니다.
        </p>
      ) : status === 'ip_limit' ? (
        <div>
          <p role="status" style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.5 }}>
            같은 네트워크에서는 24시간마다 한 계정만 무료 시간을 받을 수 있습니다. {turnstileTime(retryAt)} 이후 다시 확인해주세요.
          </p>
          <button type="button" onClick={loadStatus} style={{ padding: '6px 8px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.875rem', cursor: 'pointer' }}>
            다시 확인
          </button>
        </div>
      ) : status === 'error' ? (
        <div>
          <p role="alert" style={{ margin: '0 0 8px', color: '#ff6b72', fontSize: '0.875rem', lineHeight: 1.4 }}>{error}</p>
          <button type="button" onClick={loadStatus} style={{ padding: '6px 8px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.875rem', cursor: 'pointer' }}>
            상태 다시 확인
          </button>
        </div>
      ) : (
        <>
          <p style={{ margin: '0 0 6px', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.875rem' }}>신규 가입 무료 10분</p>
          <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.5 }}>
          이메일 인증을 마친 계정에 무료 10분을 1회 지급합니다. 중복 가입 방지를 위해 같은 네트워크의 추가 무료 지급은 24시간 제한될 수 있으며, 공유 와이파이에서는 다른 사람의 이용이 영향을 줄 수 있습니다.
          </p>
          {status === 'challenge_required' && challenge && (
            <div style={{ marginBottom: '10px' }}>
              <TurnstileChallenge
                challenge={challenge}
                resetKey={challengeReset}
                onToken={setTurnstileToken}
                onError={onTurnstileError}
              />
            </div>
          )}
          {error && (
            <div>
              <p role="alert" style={{ margin: '0 0 8px', color: '#ff6b72', fontSize: '0.875rem', lineHeight: 1.4 }}>{error}</p>
              {status === 'challenge_required' && (
                <button type="button" onClick={retryChallenge} style={{ marginBottom: '8px', padding: '6px 8px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.875rem', cursor: 'pointer' }}>
                  추가 확인 다시 불러오기
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={claimWelcomeCredit}
            disabled={busy || (status === 'challenge_required' && !turnstileToken)}
            style={{
              width: '100%', padding: '8px', border: 'none', borderRadius: '7px',
              background: 'var(--gradient)', color: '#000', fontSize: '0.875rem',
              fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? '확인 중…' : '무료 10분 받기'}
          </button>
        </>
      )}
    </section>
  );
}
