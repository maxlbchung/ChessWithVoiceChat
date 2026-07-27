import { MINE_COUNT } from '../lib/sweeperChess';

type Props = {
  // How many of the buried mines have already gone off.
  detonated: number;
  // Total buried this game. Defaults to the engine's count.
  total?: number;
  // Flag-placing mode. Omit both to render read-only (Review).
  flagMode?: boolean;
  onToggleFlagMode?: () => void;
};

// Chesssweeper's side panel — same card format as the Cash shop / Hero panel,
// hugging the board's left edge. One bomb per buried mine, no counter: a mine
// that has gone off collapses into a flat shadow of itself, so a glance says
// how much of the field is still live.
export function MineRail({ detonated, total = MINE_COUNT, flagMode, onToggleFlagMode }: Props) {
  const left = Math.max(0, total - detonated);
  return (
    <div className="mine-panel">
      <div className="mine-panel-title">Minefield</div>
      <div
        className="mine-panel-bombs"
        role="img"
        aria-label={`${left} of ${total} mines still buried`}
      >
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`mine-rail-bomb${i < detonated ? ' spent' : ''}`} aria-hidden>
            💣
          </span>
        ))}
      </div>
      {onToggleFlagMode && (
        <>
          <button
            type="button"
            className={flagMode ? 'primary-btn' : 'secondary-btn'}
            onClick={onToggleFlagMode}
            aria-pressed={!!flagMode}
            data-no-sfx
          >
            {flagMode ? 'Placing flags' : 'Place flags'}
          </button>
          <div className="mine-panel-hint muted small">
            {flagMode
              ? 'Right-click a square to flag or unflag it.'
              : 'Right-click draws arrows. Turn flags on to mark suspected mines instead.'}
          </div>
        </>
      )}
    </div>
  );
}
