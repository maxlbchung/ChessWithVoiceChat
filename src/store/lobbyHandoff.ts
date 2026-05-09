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
