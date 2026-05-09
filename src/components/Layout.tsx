import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useIdentityStore } from '../store/identityStore';
import { APP_VERSION } from '../lib/version';

export function Layout() {
  const { identity, rating, loaded, load } = useIdentityStore();
  const location = useLocation();

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">♞</span>
          <span className="brand-text">VCC</span>
        </Link>
        <nav className="topnav">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
            Play
          </Link>
          <Link
            to="/profile"
            className={location.pathname.startsWith('/profile') ? 'active' : ''}
          >
            Profile
          </Link>
        </nav>
        <div className="user-chip">
          {identity ? (
            <>
              <span className="handle">{identity.handle}</span>
              <span className="rating">{rating}</span>
            </>
          ) : (
            <span className="handle muted">not signed in</span>
          )}
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <span>P2P • signed moves • no central server for play</span>
      </footer>
      <div className="version-tag" aria-hidden>v{APP_VERSION}</div>
    </div>
  );
}
