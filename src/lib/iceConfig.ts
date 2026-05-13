// ICE servers for WebRTC.
//
// Same-LAN peers connect with STUN alone; cross-NAT peers need a TURN relay.
// Configure a TURN provider (e.g. metered.ca free tier) by setting the three
// build-time env vars below in `.env.production.local` before `npm run deploy`.
// Without them, only same-network play works.

const turnUrl = import.meta.env.VITE_TURN_URL;
const turnUser = import.meta.env.VITE_TURN_USER;
const turnPass = import.meta.env.VITE_TURN_PASS;

// VITE_TURN_URL accepts either a single URL or a comma-separated list (the
// format Metered's dashboard hands you). RTCIceServer's `urls` field rejects
// a comma-joined string — it must be a single string OR an array of strings —
// so we split here.
const turnUrls = (turnUrl ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const customTurn =
  turnUrls.length && turnUser && turnPass
    ? [{ urls: turnUrls, username: turnUser, credential: turnPass }]
    : [];

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...customTurn,
];
