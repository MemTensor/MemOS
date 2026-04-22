import { Link, useLocation } from 'react-router-dom';

export default function Header() {
  const location = useLocation();
  const pathname = location.pathname;

  return (
    <header className="drag-region sticky top-0 z-50 border-b border-border bg-background-card/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        {/* Logo */}
        <Link to="/" className="no-drag flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
            <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-base font-medium text-text">Openwork</span>
        </Link>

        {/* Navigation */}
        <nav className="no-drag flex items-center gap-1">
          <NavLink to="/" active={pathname === '/'}>
            Home
          </NavLink>
          <NavLink to="/history" active={pathname === '/history'}>
            History
          </NavLink>
          <NavLink to="/settings" active={pathname === '/settings'}>
            Settings
          </NavLink>
        </nav>

        {/* Spacer for balance */}
        <div className="w-24" />
      </div>
    </header>
  );
}

function NavLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`nav-link ${active ? 'nav-link-active' : ''}`}
    >
      {children}
    </Link>
  );
}
