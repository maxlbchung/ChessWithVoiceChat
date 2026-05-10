import { formatClock } from '../lib/timeControls';

export type MicState = 'off' | 'muted' | 'idle' | 'talking';

type Props = {
  avatarDataUrl: string | null;
  handle: string;
  rating: number;
  micState: MicState;
  ms: number;
  active: boolean;
};

export function PlayerCard({ avatarDataUrl, handle, rating, micState, ms, active }: Props) {
  const low = ms < 30_000;
  const initial = (handle?.[0] ?? '?').toUpperCase();
  return (
    <div className={`player-card ${active ? 'active' : ''} ${low && active ? 'low' : ''}`}>
      <div className="player-avatar">
        {avatarDataUrl ? (
          <img src={avatarDataUrl} alt={handle} />
        ) : (
          <span className="player-avatar-initial">{initial}</span>
        )}
      </div>
      <div className="player-meta">
        <div className="player-handle">{handle}</div>
        <div className="player-rating">{rating}</div>
      </div>
      <MicIcon state={micState} />
      <div className="player-clock-time">{formatClock(ms)}</div>
    </div>
  );
}

function MicIcon({ state }: { state: MicState }) {
  return (
    <div className={`mic-icon mic-${state}`} title={micLabel(state)} aria-label={micLabel(state)}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" />
        <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21h-2a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-3.08A7 7 0 0 0 19 11z" />
      </svg>
      {state === 'muted' && <div className="mic-slash" />}
      {state === 'talking' && <div className="mic-pulse" />}
    </div>
  );
}

function micLabel(state: MicState): string {
  switch (state) {
    case 'off': return 'Voice chat not started';
    case 'muted': return 'Mic muted';
    case 'idle': return 'Mic on';
    case 'talking': return 'Talking';
  }
}
