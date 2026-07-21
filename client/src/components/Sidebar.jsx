import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useRef, useState } from 'react';
import AuthModal from './AuthModal.jsx';
import { useDialogAccessibility } from '../utils/use-dialog-accessibility.js';

export default function Sidebar({ isOpen, isMobile, onClose, triggerRef }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);
  const sidebarRef = useRef(null);
  const mobileCloseRef = useRef(null);

  useDialogAccessibility({
    active: isMobile && isOpen,
    containerRef: sidebarRef,
    initialFocusRef: mobileCloseRef,
    onClose,
    restoreFocusRef: triggerRef,
  });

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
          aria-hidden="true"
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            zIndex: 199,
          }}
        />
      )}

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        aria-hidden={isMobile && !isOpen}
        aria-label={isMobile ? '주요 메뉴' : undefined}
        aria-modal={isMobile && isOpen ? 'true' : undefined}
        inert={isMobile && !isOpen ? '' : undefined}
        role={isMobile ? 'dialog' : undefined}
        tabIndex={isMobile ? -1 : undefined}
        style={{
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
        }}
      >
        {isMobile && isOpen && (
          <button
            ref={mobileCloseRef}
            aria-label="메뉴 닫기"
            className="icon-button mobile-sidebar-close"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
        <div style={{ padding: '0 20px', marginBottom: '20px' }}>
          <Link
            to="/transcribe"
            aria-label="프리뷰 자막으로 이동"
            onClick={isMobile ? onClose : undefined}
            style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
          >
            <p style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              background: 'var(--gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1.3,
            }}>
              프리뷰<br />자막 머신
            </p>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
              with editor
            </p>
          </Link>
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
            }}>⏱</span>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>잔여 변환 시간</p>
              <p style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {user ? user.credits : 0}분
              </p>
              <p style={{ fontSize: '0.75rem', color: '#999' }}>(분 단위로 차감)</p>
            </div>
          </div>
          {user && (
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </p>
          )}
        </div>

        <nav aria-label="작업 메뉴" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 12px' }}>
          <NavLink to="/transcribe" style={navLinkStyle} onClick={isMobile ? onClose : undefined}>
            🎬 프리뷰_자막
          </NavLink>
          <NavLink to="/usage" style={navLinkStyle} onClick={isMobile ? onClose : undefined}>
            📊 사용 내역
          </NavLink>
          <NavLink to="/redownload" style={navLinkStyle} onClick={isMobile ? onClose : undefined}>
            📥 변환_재다운로드
          </NavLink>
        </nav>

        <div style={{ marginTop: 'auto', padding: '0 12px' }}>
          {user && (
            <button
              type="button"
              onClick={() => { navigate('/settings'); if (isMobile) onClose(); }}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: '8px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                fontWeight: 400,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              ⚙️ 계정 설정
            </button>
          )}
          {user ? (
            <button
              type="button"
              onClick={() => { logout(); if (isMobile) onClose(); }}
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
              type="button"
              onClick={() => { setShowAuth(true); if (isMobile) onClose(); }}
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
            to="/privacy"
            style={{ display: 'block', padding: '8px 12px', fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'none' }}
            onClick={isMobile ? onClose : undefined}
          >
            개인정보처리방침
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

      <AuthModal
        isOpen={showAuth}
        onClose={() => setShowAuth(false)}
        restoreFocusRef={isMobile ? triggerRef : undefined}
      />
    </>
  );
}
