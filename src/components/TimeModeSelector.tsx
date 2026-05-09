import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
};

export function TimeModeSelector({ selectedId, onSelect }: Props) {
  return (
    <div className="time-mode-grid">
      {TIME_CONTROLS.map((tc) => (
        <button
          key={tc.id}
          className={`time-mode-btn ${selectedId === tc.id ? 'selected' : ''}`}
          onClick={() => onSelect(tc)}
        >
          {tc.label}
        </button>
      ))}
    </div>
  );
}
