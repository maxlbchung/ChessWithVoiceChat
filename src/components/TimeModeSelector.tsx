import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
};

export function TimeModeSelector({ selectedId, onSelect }: Props) {
  const grouped: Record<TimeControl['category'], TimeControl[]> = {
    Bullet: [],
    Blitz: [],
    Rapid: [],
    Classical: [],
  };
  for (const tc of TIME_CONTROLS) grouped[tc.category].push(tc);

  return (
    <div className="time-mode-grid">
      {(['Bullet', 'Blitz', 'Rapid', 'Classical'] as const).map((cat) => (
        <div key={cat} className="time-mode-col">
          <div className="time-mode-cat">{cat}</div>
          {grouped[cat].map((tc) => (
            <button
              key={tc.id}
              className={`time-mode-btn ${selectedId === tc.id ? 'selected' : ''}`}
              onClick={() => onSelect(tc)}
            >
              {tc.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
