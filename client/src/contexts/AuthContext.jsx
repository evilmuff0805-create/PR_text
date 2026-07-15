import { createContext, useCallback, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  clearPasswordRecoverySession,
  isPasswordRecoveryPath,
  loadPasswordRecoverySession,
  parsePasswordRecoveryHash,
  savePasswordRecoverySession,
} from '../utils/password-recovery.js';

const AuthContext = createContext(null);

function normalizeUser(data) {
  return {
    id: data.id,
    email: data.email,
    credits: data.credits,
    plan: data.plan,
    canChangePassword: data.canChangePassword !== false,
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [recoverySession, setRecoverySession] = useState(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const applyPasswordRecoveryHash = useCallback(() => {
    if (!isPasswordRecoveryPath(window.location.pathname) || !window.location.hash) {
      return false;
    }

    const recovery = parsePasswordRecoveryHash(
      window.location.hash,
      window.location.pathname,
    );
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );

    if (recovery.kind === 'session') {
      savePasswordRecoverySession(sessionStorage, recovery.session);
      setRecoverySession(recovery.session);
      setRecoveryError('');
    } else if (recovery.kind === 'error') {
      clearPasswordRecoverySession(sessionStorage);
      setRecoverySession(null);
      setRecoveryError(recovery.message);
    }

    return true;
  }, []);

  useEffect(() => {
    if (isPasswordRecoveryPath(window.location.pathname)) {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);

      if (!applyPasswordRecoveryHash()) {
        setRecoverySession(loadPasswordRecoverySession(sessionStorage));
      }

      setLoading(false);
      return;
    }

    // 1. OAuth 콜백 해시 처리 (Google 로그인 후 #access_token=... 형태로 리다이렉트됨)
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      const params = new URLSearchParams(hash.slice(1)); // '#' 제거
      const accessToken = params.get('access_token');
      if (accessToken) {
        localStorage.setItem('token', accessToken);
        setToken(accessToken);
        window.history.replaceState(null, '', window.location.pathname); // URL에서 해시 제거
        fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) throw new Error(data.error);
            setUser(normalizeUser(data));
            navigate('/', { replace: true });
          })
          .catch(() => {
            localStorage.removeItem('token');
            setToken(null);
          })
          .finally(() => setLoading(false));
        return;
      }
    }

    // 2. 저장된 토큰으로 세션 복원
    const saved = localStorage.getItem('token');
    if (!saved) {
      setLoading(false);
      return;
    }
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${saved}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setUser(normalizeUser(data));
        setToken(saved);
      })
      .catch(() => {
        // 토큰 만료 또는 유효하지 않음
        localStorage.removeItem('token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, [applyPasswordRecoveryHash]);

  useEffect(() => {
    window.addEventListener('hashchange', applyPasswordRecoveryHash);
    return () => window.removeEventListener('hashchange', applyPasswordRecoveryHash);
  }, [applyPasswordRecoveryHash]);

  const login = async (email, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    localStorage.setItem('token', data.token);
    setToken(data.token);

    // 유저 상세 정보(credits 포함) 로드
    const meRes = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    const me = await meRes.json();
    setUser(normalizeUser(me));
  };

  const signup = async (email, password) => {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // 회원가입 후 이메일 인증 필요 → 자동 로그인 안 함
  };

  const loginWithGoogle = () => {
    window.location.href = '/api/auth/google';
  };

  const logout = async () => {
    try {
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // 서버 오류여도 클라이언트는 로그아웃
    } finally {
      localStorage.removeItem('token');
      clearPasswordRecoverySession(sessionStorage);
      setToken(null);
      setUser(null);
    }
  };

  const completePasswordRecovery = useCallback(async (newPassword) => {
    if (!recoverySession) {
      throw new Error('비밀번호 재설정 링크가 만료되었거나 유효하지 않습니다.');
    }

    const res = await fetch('/api/auth/recovery-password', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${recoverySession.accessToken}`,
      },
      body: JSON.stringify({
        refreshToken: recoverySession.refreshToken,
        newPassword,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (res.status === 401) {
        clearPasswordRecoverySession(sessionStorage);
        setRecoverySession(null);
        setRecoveryError(data.error || '비밀번호 재설정 링크가 유효하지 않습니다.');
      }
      throw new Error(data.error || '비밀번호 재설정을 완료하지 못했습니다.');
    }

    clearPasswordRecoverySession(sessionStorage);
    localStorage.removeItem('token');
    setRecoverySession(null);
    setRecoveryError('');
    setToken(null);
    setUser(null);
    return data;
  }, [recoverySession]);

  const updateCredits = useCallback((newCredits) => {
    setUser((prev) => {
      if (!prev || prev.credits === newCredits) return prev;
      return { ...prev, credits: newCredits };
    });
  }, []);

  const replaceToken = useCallback((newToken) => {
    if (!newToken) return;
    localStorage.setItem('token', newToken);
    setToken(newToken);
  }, []);

  const getToken = useCallback(() => token, [token]);

  if (loading) return null; // 초기 인증 확인 중에는 아무것도 렌더하지 않음

  return (
    <AuthContext.Provider value={{
      user,
      token,
      login,
      signup,
      loginWithGoogle,
      logout,
      updateCredits,
      replaceToken,
      getToken,
      recoverySession,
      recoveryError,
      completePasswordRecovery,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
