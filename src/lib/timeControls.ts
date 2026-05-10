export type TimeControl = {
  id: string;
  label: string;
  initialMs: number;
  incrementMs: number;
  // When set, the clock resets to this value at the start of every turn
  // (i.e. the player has perMoveMs to make each individual move).
  perMoveMs?: number;
  // Window used by the home-page activity counter — roughly the typical
  // duration of a game in this mode, so "N joined recently" stays meaningful.
  activityWindowMs: number;
};

export const TIME_CONTROLS: TimeControl[] = [
  { id: 'blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 10 * 60_000 },
  { id: 'rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 20 * 60_000 },
  { id: 'per-move-60', label: '1 min / move', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000 },
];

export function getTimeControl(id: string): TimeControl | undefined {
  return TIME_CONTROLS.find((tc) => tc.id === id);
}

export function formatClock(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 10) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  // show tenths under 10s when little time left
  if (safe < 10_000) {
    const tenths = Math.floor((safe % 1000) / 100);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
