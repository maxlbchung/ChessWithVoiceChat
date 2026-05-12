import { useParams } from 'react-router-dom';
import { Game } from './Game';
import { MergeGame } from './MergeGame';
import { TwoGame } from './TwoGame';
import { CashGame } from './CashGame';
import { peekLobbyHandoff } from '../store/lobbyHandoff';
import { isCashTimeControl, isMergeTimeControl, isTwoTimeControl } from '../lib/timeControls';

// Tiny dispatcher: peeks at the pending handoff (without consuming it) to
// decide which game component to mount, then that component takes the handoff
// itself. This keeps each game-mode component self-contained.
export function GameRoute() {
  const { gameId } = useParams<{ gameId: string }>();
  const handoff = gameId ? peekLobbyHandoff(gameId) : null;
  if (handoff && isMergeTimeControl(handoff.timeControlId)) {
    return <MergeGame />;
  }
  if (handoff && isTwoTimeControl(handoff.timeControlId)) {
    return <TwoGame />;
  }
  if (handoff && isCashTimeControl(handoff.timeControlId)) {
    return <CashGame />;
  }
  return <Game />;
}
