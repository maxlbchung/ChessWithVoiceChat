import type { ReactNode } from 'react';

const ALLOWED_HOST = 'chess-vc.pages.dev';
const URL_RE = /(https?:\/\/[^\s]+)/g;
const TRAIL_RE = /[.,;:!?)\]]+$/;

// Render plain text with URLs that point at our own site turned into anchors.
// Other URLs and the rest of the text are emitted verbatim (no auto-linking)
// so unknown hosts can't be one-click-clicked from a chat message.
export function renderChatText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let i = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > i) parts.push(text.slice(i, m.index));
    const raw = m[0];
    const trail = raw.match(TRAIL_RE)?.[0] ?? '';
    const url = trail ? raw.slice(0, -trail.length) : raw;
    let sameSite = false;
    try {
      sameSite = new URL(url).hostname === ALLOWED_HOST;
    } catch {}
    if (sameSite) {
      parts.push(
        <a key={m.index} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
    } else {
      parts.push(url);
    }
    if (trail) parts.push(trail);
    i = m.index + raw.length;
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}
