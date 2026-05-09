// ICE servers for WebRTC. Free TURN via Open Relay Project.
// To replace with paid/self-hosted TURN, override VITE_TURN_URL/USER/PASS at build time.
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
  // Open Relay free TURN — public credentials, rate limited but free
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ...customTurn,
];
