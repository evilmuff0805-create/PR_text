import { NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useState } from 'react';
import AuthModal from './AuthModal.jsx';

export default function Sidebar({ isOpen, isMobile, onClose }) {
  const { user, logout } = useAuth();
  const [showAuth, setShowAuth] = useState(false);

  const navLinkStyle = ({ isActive }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '0.9rem',
    fontWeight: isActive ? 600 : 400,
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: isActive ? 'var(--bg-tertiary)' : 'transparent',
    textDecoration: 'none',
    transition: 'all 0.2s',
  });

  return (
    <>
      {/* 모바일 오버레이 — 클릭 시 사이드바 닫기 */}
      {isMobile && isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            zIndex: 199,
          }}
        />
      )}

      <aside style={{
        width: '220px',
        minHeight: '100vh',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-color)',
        padding: '24px 0',
        display: 'flex',
        flexDirection: 'column',
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: 200,
        transform: isMobile && !isOpen ? 'translateX(-100%)' : 'translateX(0)',
        transition: 'transform 0.25s ease',
      }}>
        <div style={{ padding: '0 20px', marginBottom: '20px' }}>
          <h1 style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            background: 'var(--gradient)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            lineHeight: 1.3,
          }}>
            프리뷰<br />자막 머신
          </h1>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            with editor
          </p>
        </div>

        <div style={{
          padding: '12px 20px',
          marginBottom: '20px',
          borderTop: '1px solid var(--border-color)',
          borderBottom: '1px solid var(--border-color)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              background: 'var(--gradient)',
              color: '#000',
              fontSize: '0.8rem',
              fontWeight: 700,
            }}>C</span>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>잔여 크레딧</p>
              <p style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {user ? user.credits : 0}
              </p>
            </div>
          </div>
          {user && (
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </p>
          )}
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 12px' }}>
          <NavLink to="/" style={navLinkStyle} onClick={isMobile ? onClose : undefined}>
            🎬 프리뷰_자막
          </NavLink>
          <NavLink to="/usage" style={navLinkStyle} onClick={isMobile ? onClose : undefined}>
            📊 사용 내역
          </NavLink>
        </nav>

        <div style={{ marginTop: 'auto', padding: '0 12px' }}>
          {user ? (
            <button
              onClick={logout}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: '12px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              로그아웃
            </button>
          ) : (
            <button
              onClick={() => setShowAuth(true)}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: '12px',
                background: 'var(--gradient)',
                border: 'none',
                borderRadius: '8px',
                color: '#000',
                fontSize: '0.85rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              로그인
            </button>
          )}
          <NavLink
            to="/terms"
            style={{ display: 'block', padding: '8px 12px', fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'none' }}
            onClick={isMobile ? onClose : undefined}
          >
            이용약관
          </NavLink>
          <NavLink
            to="/support"
            style={{ display: 'block', padding: '8px 12px', fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'none' }}
            onClick={isMobile ? onClose : undefined}
          >
            고객센터
          </NavLink>
        </div>
      </aside>

      <AuthModal isOpen={showAuth} onClose={() => setShowAuth(false)} />
    </>
  );
}
