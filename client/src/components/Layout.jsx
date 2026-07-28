import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';

function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>상호명: 코드밋(CodeMeet)</span>
      <span className="footer-divider">|</span>
      <span>사업자등록번호: 470-32-01835</span>
      <span className="footer-divider">|</span>
      <span>대표자: 석예림</span>
      <span className="footer-divider">|</span>
      <span>사업장 주소: 경기도 김포시 김포한강9로12번길 50(구래동)</span>
      <span className="footer-divider">|</span>
      <span>이메일: codemeet@naver.com</span>
      <span className="footer-divider">|</span>
      <span>통신판매업 신고번호: 제 2026-경기김포-4391 호</span>
      <div className="footer-break" />
      <NavLink to="/terms">이용약관</NavLink>
      <span className="footer-divider">|</span>
      <NavLink to="/privacy">개인정보처리방침</NavLink>
      <span className="footer-divider">|</span>
      <NavLink to="/support">고객센터</NavLink>
    </footer>
  );
}

function LandingHeader() {
  return (
    <header className="landing-header">
      <div className="landing-header__inner">
        <Link className="landing-brand" to="/" aria-label="프리뷰 자막 머신 소개">
          <span className="landing-brand__mark" aria-hidden="true">P</span>
          <span>
            <strong>프리뷰 자막 머신</strong>
            <small>with editor</small>
          </span>
        </Link>

        <nav className="landing-nav" aria-label="소개 페이지">
          <a href="#features">특징</a>
          <a href="#workflow">사용 흐름</a>
          <a href="#formats">지원 포맷</a>
          <Link to="/guide">사용법</Link>
          <Link to="/payment">요금</Link>
        </nav>

        <Link className="button button--primary landing-header__cta" to="/transcribe">
          변환 시작
        </Link>
      </div>
    </header>
  );
}

export default function Layout({ children }) {
  const location = useLocation();
  const isLanding = location.pathname === '/' || location.pathname === '/intro';
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mobileMenuButtonRef = useRef(null);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    setIsMobile(mq.matches);
    const handler = (e) => {
      setIsMobile(e.matches);
      if (!e.matches) setSidebarOpen(false);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (isLanding) {
    return (
      <div className="landing-shell">
        <a className="skip-link" href="#main-content">본문 바로가기</a>
        <LandingHeader />
        <main id="main-content" className="landing-main">
          {children}
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문 바로가기</a>
      <Sidebar
        isOpen={!isMobile || sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        triggerRef={mobileMenuButtonRef}
      />

      {isMobile && (
        <div className="mobile-header">
          <div className="mobile-header__brand-row">
            <button
              ref={mobileMenuButtonRef}
              className="icon-button mobile-menu-button"
              onClick={() => setSidebarOpen(true)}
              aria-label="메뉴 열기"
              aria-controls="app-sidebar"
              aria-expanded={sidebarOpen}
              type="button"
            >
              <span aria-hidden="true">☰</span>
            </button>
            <Link className="mobile-brand" to="/transcribe">
              프리뷰 자막 머신
            </Link>
          </div>
          <nav className="mobile-tabs" aria-label="주요 페이지">
            {[
              { to: '/', label: '소개' },
              { to: '/guide', label: '사용법' },
              { to: '/payment', label: '결제' },
            ].map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => isActive ? 'mobile-tab is-active' : 'mobile-tab'}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <div className={isMobile ? 'app-content is-mobile' : 'app-content'}>
        {!isMobile && <Header />}
        <main className="app-main" id="main-content" tabIndex={-1}>
          {children}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}

