export type GameVariant = 'normal' | 'merge' | 'two' | 'cash' | 'hero';

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
  variant: GameVariant;
};

export const TIME_CONTROLS: TimeControl[] = [
  { id: 'blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 10 * 60_000, variant: 'normal' },
  { id: 'rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 20 * 60_000, variant: 'normal' },
  { id: 'per-move-60', label: '+ 1 min', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000, variant: 'normal' },
  { id: 'merge-blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 10 * 60_000, variant: 'merge' },
  { id: 'merge-rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 20 * 60_000, variant: 'merge' },
  { id: 'merge-per-move-60', label: '+ 1 min', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000, variant: 'merge' },
  { id: 'two-blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 10 * 60_000, variant: 'two' },
  { id: 'two-rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 20 * 60_000, variant: 'two' },
  { id: 'two-per-move-60', label: '+ 1 min', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000, variant: 'two' },
  { id: 'cash-blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 15 * 60_000, variant: 'cash' },
  { id: 'cash-rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 30 * 60_000, variant: 'cash' },
  { id: 'cash-per-move-60', label: '+ 1 min', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000, variant: 'cash' },
  { id: 'hero-blitz-5+0', label: '5 min', initialMs: 300_000, incrementMs: 0, activityWindowMs: 15 * 60_000, variant: 'hero' },
  { id: 'hero-rapid-10+0', label: '10 min', initialMs: 600_000, incrementMs: 0, activityWindowMs: 30 * 60_000, variant: 'hero' },
  { id: 'hero-per-move-60', label: '+ 1 min', initialMs: 60_000, incrementMs: 0, perMoveMs: 60_000, activityWindowMs: 30 * 60_000, variant: 'hero' },
];

export function getTimeControl(id: string): TimeControl | undefined {
  return TIME_CONTROLS.find((tc) => tc.id === id);
}

export function isMergeTimeControl(id: string): boolean {
  return getTimeControl(id)?.variant === 'merge';
}

export function isTwoTimeControl(id: string): boolean {
  return getTimeControl(id)?.variant === 'two';
}

export function isCashTimeControl(id: string): boolean {
  return getTimeControl(id)?.variant === 'cash';
}

export function isHeroTimeControl(id: string): boolean {
  return getTimeControl(id)?.variant === 'hero';
}

export function timeControlsForVariant(variant: GameVariant): TimeControl[] {
  return TIME_CONTROLS.filter((tc) => tc.variant === variant);
}

// Threshold below which the clock is considered "low" — drives the urgent
// red styling on PlayerCard and the per-second ticking SFX. Scales with the
// time control so a 60s per-move game doesn't sit in the red zone for half
// of every turn.
export function lowTimeThresholdMs(tc: TimeControl): number {
  if (tc.perMoveMs != null) {
    // Last 20% of the move budget — 12s for a 60s/move control.
    return Math.max(5_000, Math.round(tc.perMoveMs * 0.2));
  }
  // Last 10% of the initial budget, clamped 10–60s — 30s for 5min, 60s for 10min.
  return Math.min(60_000, Math.max(10_000, Math.round(tc.initialMs * 0.1)));
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
