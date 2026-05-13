// ICE servers for WebRTC.
//
// Same-LAN peers connect with STUN alone; cross-NAT peers need a TURN relay.
// Configure a TURN provider (e.g. metered.ca free tier) by setting the three
// build-time env vars below in `.env.production.local` before `npm run deploy`.
// Without them, only same-network play works.

const turnUrl = import.meta.env.VITE_TURN_URL;
const turnUser = import.meta.env.VITE_TURN_USER;
const turnPass = import.meta.env.VITE_TURN_PASS;

const customTurn =
  turnUrl && turnUser && turnPass
    ? [{ urls: turnUrl, username: turnUser, credential: turnPass }]
    : [];

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...customTurn,
];
