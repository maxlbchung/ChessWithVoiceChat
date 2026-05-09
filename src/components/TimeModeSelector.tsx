import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
  disabled?: boolean;
};

export function TimeModeSelector({ selectedId, onSelect, disabled }: Props) {
  return (
    <div className="time-mode-grid">
      {TIME_CONTROLS.map((tc) => (
        <button
          key={tc.id}
          className={`time-mode-btn ${selectedId === tc.id ? 'selected' : ''}`}
          onClick={() => onSelect(tc)}
          disabled={disabled}
        >
          {tc.label}
        </button>
      ))}
    </div>
  );
}
