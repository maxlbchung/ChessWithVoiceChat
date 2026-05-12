import { useState } from 'react';
import type { ReactNode } from 'react';
import { timeControlsForVariant, type TimeControl } from '../lib/timeControls';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
  disabled?: boolean;
  activityCounts?: Record<string, number>;
};

type SectionKey = 'normal' | 'merge' | 'two' | 'chaos';

export function TimeModeSelector({ selectedId, onSelect, disabled, activityCounts }: Props) {
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    normal: true,
    merge: false,
    two: false,
    chaos: false,
  });
  const toggle = (k: SectionKey) => setOpen((s) => ({ ...s, [k]: !s[k] }));

  const renderGrid = (controls: TimeControl[]) => (
    <div className="time-mode-grid">
      {controls.map((tc) => {
        const count = activityCounts?.[tc.id];
        const player = count === 1 ? 'Player' : 'Players';
        const label = count === undefined ? ' ' : `${count} ${player}`;
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

  return (
    <div className="time-mode-box">
      <Section title="Normal" open={open.normal} onToggle={() => toggle('normal')}>
        {renderGrid(timeControlsForVariant('normal'))}
      </Section>

      <Section title="Merge" open={open.merge} onToggle={() => toggle('merge')}>
        <div className="muted small time-mode-blurb">
          Capture your own rook/knight/bishop/queen to merge their movement patterns into one piece.
        </div>
        {renderGrid(timeControlsForVariant('merge'))}
      </Section>

      <Section title="2.0" open={open.two} onToggle={() => toggle('two')}>
        <div className="muted small">Nothing here yet.</div>
      </Section>

      <Section title="Chaos" open={open.chaos} onToggle={() => toggle('chaos')}>
        <div className="muted small">Nothing here yet.</div>
      </Section>
    </div>
  );
}

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`time-mode-section ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="time-mode-section-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="time-mode-section-title">{title}</span>
        <span className={`time-mode-section-chevron ${open ? 'open' : ''}`} aria-hidden>
          ▸
        </span>
      </button>
      {open && <div className="time-mode-section-body">{children}</div>}
    </div>
  );
}
