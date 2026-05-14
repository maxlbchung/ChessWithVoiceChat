import { formatClock } from '../lib/timeControls';

export type VoiceState = 'off' | 'muted' | 'active';

type Props = {
  avatarDataUrl: string | null;
  handle: string;
  rating: number;
  voiceState: VoiceState;
  volume: number;
  ms: number;
  lowMs: number;
  active: boolean;
};

export function PlayerCard({
  avatarDataUrl,
  handle,
  rating,
  voiceState,
  volume,
  ms,
  lowMs,
  active,
}: Props) {
  const low = ms < lowMs;
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
      <VoiceIndicator state={voiceState} volume={volume} />
      <div className="player-clock-time">{formatClock(ms)}</div>
    </div>
  );
}

function VoiceIndicator({ state, volume }: { state: VoiceState; volume: number }) {
  const vol = state === 'active' ? Math.max(0, Math.min(1, volume)) : 0;
  const vibrating = state === 'active' && vol > 0.85;
  // Pre-activation ('off') reads visually the same as muted: slashed icon, no
  // volume track. Once voice is started, the track appears and tracks input.
  const showSlash = state !== 'active';
  const showTrack = state !== 'off';
  return (
    <div
      className={`voice-indicator state-${state} ${vibrating ? 'vibrating' : ''}`}
      title={voiceLabel(state)}
      aria-label={voiceLabel(state)}
    >
      <div className="voice-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
          <path d="M14.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
        </svg>
        {showSlash && <div className="voice-slash" />}
      </div>
      {showTrack && (
        <div className="volume-track">
          <div
            className="volume-fill"
            style={{
              ['--vol' as any]: vol,
              ['--vol-color' as any]: volumeColor(vol),
            }}
          />
        </div>
      )}
    </div>
  );
}

// Hold green up to ~0.55, then ramp green → yellow → red by 1.0.
function volumeColor(vol: number): string {
  const t = Math.max(0, Math.min(1, (vol - 0.55) / (1.0 - 0.55)));
  const hue = 120 - 120 * t;
  return `hsl(${hue.toFixed(0)}, 72%, 42%)`;
}

function voiceLabel(state: VoiceState): string {
  switch (state) {
    case 'off': return 'Voice chat not started';
    case 'muted': return 'Mic muted';
    case 'active': return 'Voice active';
  }
}
