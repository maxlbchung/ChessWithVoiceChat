import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useIdentityStore } from '../store/identityStore';
import { APP_VERSION } from '../lib/version';
import * as sfx from '../lib/sfx';

export function Layout() {
  const { identity, rating, avatar, loaded, load } = useIdentityStore();
  const location = useLocation();

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // Global click SFX for any interactive control — buttons + router links
  // (the nav <Link>s render as <a>). Anything that opts out via data-no-sfx
  // or is disabled is skipped, so action-specific SFX (queue, select,
  // open/close, chat send) don't double up.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const el = target.closest('button, a');
      if (!el) return;
      if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).disabled) return;
      if (el.hasAttribute('data-no-sfx')) return;
      sfx.playClick();
    };
    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true } as any);
  }, []);

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
          <Link
            to="/settings"
            className={location.pathname.startsWith('/settings') ? 'active' : ''}
          >
            Settings
          </Link>
        </nav>
        <div className="user-chip">
          {identity ? (
            <>
              {avatar ? (
                <img className="user-chip-avatar" src={avatar} alt="" />
              ) : (
                <span className="user-chip-avatar placeholder" aria-hidden>
                  {identity.handle.slice(0, 1).toUpperCase()}
                </span>
              )}
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
