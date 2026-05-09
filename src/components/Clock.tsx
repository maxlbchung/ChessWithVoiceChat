import { formatClock } from '../lib/timeControls';

type Props = {
  ms: number;
  active: boolean;
  label: string;
  rating: number;
};

export function Clock({ ms, active, label, rating }: Props) {
  const low = ms < 30_000;
  return (
    <div className={`clock ${active ? 'active' : ''} ${low ? 'low' : ''}`}>
      <div className="clock-meta">
        <span className="clock-handle">{label}</span>
        <span className="clock-rating">{rating}</span>
      </div>
      <div className="clock-time">{formatClock(ms)}</div>
    </div>
  );
}
