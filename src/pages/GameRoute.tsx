import { useParams } from 'react-router-dom';
import { Game } from './Game';
import { MergeGame } from './MergeGame';
import { TwoGame } from './TwoGame';
import { CashGame } from './CashGame';
import { HeroGame } from './HeroGame';
import { SweeperGame } from './SweeperGame';
import { peekLobbyHandoff } from '../store/lobbyHandoff';
import {
  isCashTimeControl,
  isHeroTimeControl,
  isMergeTimeControl,
  isSweeperTimeControl,
  isTwoTimeControl,
} from '../lib/timeControls';

// Tiny dispatcher: peeks at the pending handoff (without consuming it) to
// decide which game component to mount, then that component takes the handoff
// itself. This keeps each game-mode component self-contained.
//
// `key={gameId}` forces a clean remount when navigating to a rematch — same
// component type but every useState/useRef gets fresh state. The shared
// PeerSession is preserved across this remount via the rematch-pending flag
// in lobbyHandoff (see useRematch).
export function GameRoute() {
  const { gameId } = useParams<{ gameId: string }>();
  const handoff = gameId ? peekLobbyHandoff(gameId) : null;
  if (handoff && isMergeTimeControl(handoff.timeControlId)) {
    return <MergeGame key={gameId} />;
  }
  if (handoff && isTwoTimeControl(handoff.timeControlId)) {
    return <TwoGame key={gameId} />;
  }
  if (handoff && isCashTimeControl(handoff.timeControlId)) {
    return <CashGame key={gameId} />;
  }
  if (handoff && isHeroTimeControl(handoff.timeControlId)) {
    return <HeroGame key={gameId} />;
  }
  if (handoff && isSweeperTimeControl(handoff.timeControlId)) {
    return <SweeperGame key={gameId} />;
  }
  return <Game key={gameId} />;
}
