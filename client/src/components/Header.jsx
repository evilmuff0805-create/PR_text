import { NavLink } from 'react-router-dom';

export default function Header() {
  const linkStyle = (isActive) => ({
    padding: '8px 20px',
    fontSize: '0.85rem',
    fontWeight: isActive ? 600 : 400,
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    textDecoration: 'none',
    borderBottom: isActive ? '2px solid var(--gradient-start)' : '2px solid transparent',
    transition: 'all 0.2s',
  });

  return (
    <header style={{
      height: '52px',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      paddingLeft: '220px',
      paddingRight: '24px',
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 99,
    }}>
      <nav style={{ display: 'flex', gap: '4px', marginLeft: '24px' }}>
        <NavLink to="/intro" style={({ isActive }) => linkStyle(isActive)}>
          소개
        </NavLink>
        <NavLink to="/guide" style={({ isActive }) => linkStyle(isActive)}>
          사용법
        </NavLink>
        <NavLink to="/payment" style={({ isActive }) => linkStyle(isActive)}>
          결제
        </NavLink>
      </nav>
    </header>
  );
}
