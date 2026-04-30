import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';

export default function Layout({ children }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    setIsMobile(mq.matches);
    const handler = (e) => {
      setIsMobile(e.matches);
      if (!e.matches) setSidebarOpen(false); // 데스크탑 전환 시 자동 닫기
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        isOpen={!isMobile || sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
      />

      {/* 모바일 전용 상단 헤더바 */}
      {isMobile && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 'auto',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 150,
        }}>
          {/* 1단: 햄버거 + 로고 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: '12px',
            height: '44px',
          }}>
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="메뉴 열기"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-primary)',
                fontSize: '1.4rem',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '6px',
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              ☰
            </button>
            <span style={{
              fontSize: '1rem',
              fontWeight: 700,
              background: 'var(--gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              프리뷰 자막 머신
            </span>
          </div>
          {/* 2단: 소개 / 사용법 / 결제 탭 */}
          <nav style={{
            display: 'flex',
            justifyContent: 'space-around',
            borderTop: '1px solid var(--border-color)',
            height: '48px',
            alignItems: 'center',
          }}>
            {[
              { to: '/intro', label: '소개' },
              { to: '/guide', label: '사용법' },
              { to: '/payment', label: '결제' },
            ].map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                style={({ isActive }) => ({
                  flex: 1,
                  textAlign: 'center',
                  padding: '8px 0',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  textDecoration: 'none',
                  borderBottom: isActive ? '2px solid var(--gradient-start)' : '2px solid transparent',
                  transition: 'all 0.2s',
                })}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <div style={{
        flex: 1,
        marginLeft: isMobile ? 0 : '220px',
        paddingTop: isMobile ? '92px' : '52px',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
      }}>
        {!isMobile && <Header />}
        <main style={{ padding: isMobile ? '20px 16px' : '32px 40px', maxWidth: '1000px', flex: 1 }}>
          {children}
        </main>
        <footer style={{
          borderTop: '1px solid var(--border-color)',
          padding: '24px',
          textAlign: 'center',
          fontSize: '0.75rem',
          color: 'var(--text-muted, #666)',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '6px 12px',
          lineHeight: 1.8,
        }}>
          <span>상호명: 코드밋(CodeMeet)</span>
          <span style={{ color: 'var(--border-color, #333)' }}>|</span>
          <span>사업자등록번호: 470-32-01835</span>
          <span style={{ color: 'var(--border-color, #333)' }}>|</span>
          <span>대표자: 석예림</span>
          <span style={{ color: 'var(--border-color, #333)' }}>|</span>
          <span>사업장 주소: 경기도 김포시 김포한강9로12번길 50(구래동)</span>
          <span style={{ color: 'var(--border-color, #333)' }}>|</span>
          <span>전화번호: 010-4901-1421</span>
        </footer>
      </div>
    </div>
  );
}
