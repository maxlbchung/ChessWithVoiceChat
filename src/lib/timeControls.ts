export type TimeControl = {
  id: string;
  label: string;
  category: 'Bullet' | 'Blitz' | 'Rapid' | 'Classical';
  initialMs: number;
  incrementMs: number;
};

export const TIME_CONTROLS: TimeControl[] = [
  { id: 'bullet-1+0', label: '1+0', category: 'Bullet', initialMs: 60_000, incrementMs: 0 },
  { id: 'bullet-2+1', label: '2+1', category: 'Bullet', initialMs: 120_000, incrementMs: 1_000 },
  { id: 'blitz-3+0', label: '3+0', category: 'Blitz', initialMs: 180_000, incrementMs: 0 },
  { id: 'blitz-3+2', label: '3+2', category: 'Blitz', initialMs: 180_000, incrementMs: 2_000 },
  { id: 'blitz-5+0', label: '5+0', category: 'Blitz', initialMs: 300_000, incrementMs: 0 },
  { id: 'blitz-5+3', label: '5+3', category: 'Blitz', initialMs: 300_000, incrementMs: 3_000 },
  { id: 'rapid-10+0', label: '10+0', category: 'Rapid', initialMs: 600_000, incrementMs: 0 },
  { id: 'rapid-15+10', label: '15+10', category: 'Rapid', initialMs: 900_000, incrementMs: 10_000 },
  { id: 'classical-30+0', label: '30+0', category: 'Classical', initialMs: 1_800_000, incrementMs: 0 },
  { id: 'classical-30+20', label: '30+20', category: 'Classical', initialMs: 1_800_000, incrementMs: 20_000 },
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
