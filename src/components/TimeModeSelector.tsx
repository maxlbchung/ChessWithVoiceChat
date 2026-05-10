import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
  disabled?: boolean;
  activityCounts?: Record<string, number>;
};

export function TimeModeSelector({ selectedId, onSelect, disabled, activityCounts }: Props) {
  return (
    <div className="time-mode-grid">
      {TIME_CONTROLS.map((tc) => {
        const count = activityCounts?.[tc.id];
        const player = count === 1 ? 'Player' : 'Players';
        const label = count === undefined ? ' ' : `${count} ${player}`;
        return (
          <div key={tc.id} className="time-mode-cell">
            <button
              className={`time-mode-btn ${selectedId === tc.id ? 'selected' : ''}`}
              onClick={() => onSelect(tc)}
              disabled={disabled}
            >
              {tc.label}
            </button>
            <div className="time-mode-count muted">{label}</div>
          </div>
        );
      })}
    </div>
  );
}
