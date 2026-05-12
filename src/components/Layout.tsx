import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useIdentityStore } from '../store/identityStore';
import { APP_VERSION } from '../lib/version';
import * as sfx from '../lib/sfx';

export function Layout() {
  const { identity, rating, loaded, load } = useIdentityStore();
  const location = useLocation();

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // Global button click SFX. Any <button> that isn't disabled and doesn't
  // opt out via data-no-sfx gets the generic click tap. Buttons that have
  // their own dedicated SFX (time mode select, section open/close, queue,
  // chat send) set data-no-sfx to avoid doubling.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest('button');
      if (!btn) return;
      if ((btn as HTMLButtonElement).disabled) return;
      if (btn.hasAttribute('data-no-sfx')) return;
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
