import type { PeerSession } from '../lib/peer';

// In-memory handoff from Home → Game so we don't tear down the open
// PeerSession just because the route changed.

export type LobbyHandoff = {
  gameId: string;
  session: PeerSession;
  myPeerId: string;
  partnerPeerId: string;
  partnerPubKey: string;
  partnerHandle: string;
  partnerRating: number;
  iAmWhite: boolean;
  timeControlId: string;
};

let pending: LobbyHandoff | null = null;

export function setLobbyHandoff(h: LobbyHandoff) {
  pending = h;
}

export function takeLobbyHandoff(gameId: string): LobbyHandoff | null {
  if (pending && pending.gameId === gameId) {
    const h = pending;
    pending = null;
    return h;
  }
  return null;
}

// Look at the pending handoff without consuming it. Used by route-level
// dispatch so it can read timeControlId before deciding which game component
// to mount.
export function peekLobbyHandoff(gameId: string): LobbyHandoff | null {
  if (pending && pending.gameId === gameId) return pending;
  return null;
}

// One-shot flag set by the rematch flow so the outgoing game page knows to
// keep the PeerSession alive across the route change. Cleared by the
// incoming game page once it has taken over.
let rematchPending = false;
export function setRematchPending(v: boolean) {
  rematchPending = v;
}
export function isRematchPending(): boolean {
  return rematchPending;
}
