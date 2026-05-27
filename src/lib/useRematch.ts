import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  isRematchPending,
  setLobbyHandoff,
  setRematchPending,
  type LobbyHandoff,
} from '../store/lobbyHandoff';
import type { PeerSession } from './peer';
import type { WireMessage } from './types';

// Rematch handshake state machine, shared across all online game modes.
//
// Flow:
//   - Either side calls offerRematch() → sends rematch-offer with a fresh
//     gameId. The opponent's side flips rematchOfferedByOpp.
//   - Opponent calls acceptRematch() → sends rematch-accept. Both sides then
//     navigate to the new gameId via the existing PeerSession with colors
//     swapped from the previous game.
//   - Opponent calls declineRematch() → sends rematch-decline; the offer
//     resets so either side can re-offer.
//
// The hook keeps refs in sync with state so the message handler (which is
// usually bound at mount with stale closures) reads fresh values.
export function useRematch(handoff: LobbyHandoff, session: PeerSession) {
  const navigate = useNavigate();
  const [rematchOfferedByMe, setRematchOfferedByMe] = useState(false);
  const [rematchOfferedByOpp, setRematchOfferedByOpp] = useState(false);
  const pendingGameIdRef = useRef<string | null>(null);

  // Clear the cross-route flag once we're up — older mount may have set it
  // mid-rematch to keep the session alive.
  useEffect(() => {
    setRematchPending(false);
  }, []);

  const performRematch = (newGameId: string) => {
    setRematchPending(true);
    setLobbyHandoff({
      gameId: newGameId,
      session,
      myPeerId: handoff.myPeerId,
      partnerPeerId: handoff.partnerPeerId,
      partnerHandle: handoff.partnerHandle,
      partnerRating: handoff.partnerRating,
      // Swap colors so the same pair alternates white/black across rematches.
      iAmWhite: !handoff.iAmWhite,
      timeControlId: handoff.timeControlId,
    });
    navigate(`/play/${newGameId}`);
  };

  const offerRematch = () => {
    const newId = randomGameId();
    pendingGameIdRef.current = newId;
    setRematchOfferedByMe(true);
    try {
      session.send({ type: 'rematch-offer', gameId: newId });
    } catch {
      // peer might be down; UI just shows "offered" until user cancels
    }
  };

  const acceptRematch = () => {
    const id = pendingGameIdRef.current;
    if (!id) return;
    try { session.send({ type: 'rematch-accept' }); } catch {}
    performRematch(id);
  };

  const declineRematch = () => {
    try { session.send({ type: 'rematch-decline' }); } catch {}
    pendingGameIdRef.current = null;
    setRematchOfferedByOpp(false);
  };

  // Returns true if the message was a rematch frame and was consumed —
  // callers should `if (handleRematchMessage(msg)) return;` from their own
  // handleMessage so subsequent code doesn't double-process.
  const handleRematchMessage = (msg: WireMessage): boolean => {
    if (msg.type === 'rematch-offer') {
      const incoming = msg.gameId;
      const ours = pendingGameIdRef.current;
      // If we both happened to offer at the same time, deterministically pick
      // the lexicographically smaller id so both sides land on the same game.
      const chosen = ours ? (ours < incoming ? ours : incoming) : incoming;
      pendingGameIdRef.current = chosen;
      setRematchOfferedByOpp(true);
      return true;
    }
    if (msg.type === 'rematch-accept') {
      const id = pendingGameIdRef.current;
      if (id) performRematch(id);
      return true;
    }
    if (msg.type === 'rematch-decline') {
      pendingGameIdRef.current = null;
      setRematchOfferedByMe(false);
      return true;
    }
    return false;
  };

  return {
    rematchOfferedByMe,
    rematchOfferedByOpp,
    offerRematch,
    acceptRematch,
    declineRematch,
    handleRematchMessage,
  };
}

// Module-level helper exposed for the unmount cleanup so each game page
// only destroys the session when this isn't a rematch transition.
export function shouldKeepSessionForRematch(): boolean {
  return isRematchPending();
}

function randomGameId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
