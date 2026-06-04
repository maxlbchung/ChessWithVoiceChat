import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '../store/settingsStore';

// Phones and small tablets in portrait. The game pages are built around a
// board that wants ~min(viewport) of space, so anything narrower than this
// can't comfortably fit the board AND the side panel side-by-side.
const NARROW_QUERY = '(max-width: 820px)';

function subscribe(cb: () => void) {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function getSnapshot(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

/** True when the viewport is narrow enough to prefer the mobile layout. */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Resolves the user's mobile-layout preference against the current viewport.
 * 'on' / 'off' force it; 'auto' (the default) follows the media query.
 */
export function useMobileLayout(): boolean {
  const mode = useSettingsStore((s) => s.mobileLayout);
  const narrow = useNarrowViewport();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return narrow;
}
