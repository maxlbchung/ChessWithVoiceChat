import { useParams } from 'react-router-dom';
import { Game } from './Game';
import { MergeGame } from './MergeGame';
import { peekLobbyHandoff } from '../store/lobbyHandoff';
import { isMergeTimeControl } from '../lib/timeControls';

// Tiny dispatcher: peeks at the pending handoff (without consuming it) to
// decide which game component to mount, then that component takes the handoff
// itself. This keeps both Game.tsx and MergeGame.tsx self-contained.
export function GameRoute() {
  const { gameId } = useParams<{ gameId: string }>();
  const handoff = gameId ? peekLobbyHandoff(gameId) : null;
  if (handoff && isMergeTimeControl(handoff.timeControlId)) {
    return <MergeGame />;
  }
  return <Game />;
}
