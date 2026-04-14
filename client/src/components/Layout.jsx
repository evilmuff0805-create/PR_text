import { useState, useEffect } from 'react';
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
          height: '52px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: '12px',
          zIndex: 150,
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
      )}

      <div style={{
        flex: 1,
        marginLeft: isMobile ? 0 : '220px',
        paddingTop: '52px',
      }}>
        {!isMobile && <Header />}
        <main style={{ padding: isMobile ? '20px 16px' : '32px 40px', maxWidth: '1000px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
