// ICE servers for WebRTC.
//
// Same-LAN peers connect with STUN alone; cross-NAT peers need a TURN relay.
// Production uses Cloudflare Realtime TURN: the Worker mints ephemeral
// credentials via the CF TURN API and returns them to the browser. No long-
// lived TURN secret ever ships in the client bundle.
//
// As a fallback (e.g. self-hosted coturn or local dev), the build-time env
// vars VITE_TURN_URL / VITE_TURN_USER / VITE_TURN_PASS still work.

const STUN_ONLY: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Static TURN fallback (kept for self-hosters). VITE_TURN_URL accepts either
// a single URL or a comma-separated list. RTCIceServer's `urls` field rejects
// a comma-joined string — it must be a single string OR an array of strings —
// so we split here.
function staticTurnFallback(): RTCIceServer[] {
  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUser = import.meta.env.VITE_TURN_USER;
  const turnPass = import.meta.env.VITE_TURN_PASS;
  const turnUrls = (turnUrl ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!turnUrls.length || !turnUser || !turnPass) return [];
  return [{ urls: turnUrls, username: turnUser, credential: turnPass }];
}

const MATCHMAKE_URL =
  import.meta.env.VITE_MATCHMAKE_URL ||
  (import.meta.env.DEV ? '/api/matchmake' : 'https://chess-matchmaker.maxlbchung.workers.dev');

// Cache the worker response in module memory. Cloudflare credentials are
// long-lived (24h by default) so one fetch per tab session is plenty.
let cached: { iceServers: RTCIceServer[]; expiresAt: number } | null = null;
const SAFETY_MARGIN_MS = 5 * 60_000;

export async function getIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cached && cached.expiresAt - SAFETY_MARGIN_MS > now) {
    return cached.iceServers;
  }
  try {
    const res = await fetch(MATCHMAKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'turn' }),
    });
    if (res.ok) {
      const data = await res.json();
      // CF returns iceServers as a single object; normalize to an array and
      // prepend our STUN list so a TURN-only failure still leaves STUN intact.
      const raw = data?.iceServers;
      const turnList: RTCIceServer[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (turnList.length) {
        const merged = [...STUN_ONLY, ...turnList];
        const expiresAt = typeof data?.expiresAt === 'number'
          ? data.expiresAt
          : now + 60 * 60_000;
        cached = { iceServers: merged, expiresAt };
        return merged;
      }
    } else {
      console.warn('[ice] turn endpoint returned', res.status);
    }
  } catch (err) {
    console.warn('[ice] failed to fetch turn credentials', err);
  }
  // Fallbacks: static env-var TURN, then STUN-only (LAN play still works).
  const fallback = [...STUN_ONLY, ...staticTurnFallback()];
  return fallback;
}
