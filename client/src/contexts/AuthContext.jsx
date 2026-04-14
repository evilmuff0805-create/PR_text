import { createContext, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
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
            setUser({ id: data.id, email: data.email, credits: data.credits, plan: data.plan });
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
        setUser({ id: data.id, email: data.email, credits: data.credits, plan: data.plan });
        setToken(saved);
      })
      .catch(() => {
        // 토큰 만료 또는 유효하지 않음
        localStorage.removeItem('token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

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
    setUser({ id: me.id, email: me.email, credits: me.credits, plan: me.plan });
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
      setToken(null);
      setUser(null);
    }
  };

  const updateCredits = (newCredits) => {
    setUser((prev) => prev ? { ...prev, credits: newCredits } : prev);
  };

  const getToken = () => token;

  if (loading) return null; // 초기 인증 확인 중에는 아무것도 렌더하지 않음

  return (
    <AuthContext.Provider value={{ user, token, login, signup, loginWithGoogle, logout, updateCredits, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
