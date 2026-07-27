import { useState } from 'react';
import type { ReactNode } from 'react';
import { timeControlsForVariant, type TimeControl } from '../lib/timeControls';
import * as sfx from '../lib/sfx';

type Props = {
  selectedId: string | null;
  onSelect: (tc: TimeControl) => void;
  disabled?: boolean;
  activityCounts?: Record<string, number>;
};

type SectionKey = 'normal' | 'merge' | 'two' | 'cash' | 'hero' | 'sweeper';

export function TimeModeSelector({ selectedId, onSelect, disabled, activityCounts }: Props) {
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    normal: true,
    merge: false,
    two: false,
    cash: false,
    hero: false,
    sweeper: false,
  });
  const toggle = (k: SectionKey) => {
    if (open[k]) sfx.playClose(); else sfx.playOpen();
    setOpen((s) => ({ ...s, [k]: !s[k] }));
  };

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
              data-no-sfx
              onClick={() => {
                if (selectedId !== tc.id) sfx.playSelect();
                onSelect(tc);
              }}
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
          Merge by capturing your own peices! *Pawns and kings can't merge
        </div>
        {renderGrid(timeControlsForVariant('merge'))}
      </Section>

      <Section title="Guerrilla" open={open.two} onToggle={() => toggle('two')}>
        <div className="muted small time-mode-blurb">
          Queen moves like a king. Bishops slide 1-2 squares in any direction.
          Knights jump over an adjacent piece and land directly behind it,
          capturing the hopped enemy checkers-style and any enemy on the
          landing square. Rooks move 1 square orthogonally and push own
          peices. No castling. Lose all peices = checkmate.
        </div>
        {renderGrid(timeControlsForVariant('two'))}
      </Section>

      <Section title="Cash Money" open={open.cash} onToggle={() => toggle('cash')}>
        <div className="muted small time-mode-blurb">
          Spend gold in the shop to upgrade your pawns into pieces.
          Upgrading uses your turn. Pawns promote into 10 coins.
        </div>
        {renderGrid(timeControlsForVariant('cash'))}
      </Section>

      <Section title="Hero" open={open.hero} onToggle={() => toggle('hero')}>
        <div className="muted small time-mode-blurb">
          Pick a hero king with a unique ability — Frost freezes, Warlord
          destroys adjacent, Necromancer spawns pawns, Flight teleports pieces.
          Using an ability takes your turn.
        </div>
        {renderGrid(timeControlsForVariant('hero'))}
      </Section>

      <Section title="Chesssweeper" open={open.sweeper} onToggle={() => toggle('sweeper')}>
        <div className="muted small time-mode-blurb">
          Normal chess, but 4 hidden landmines are buried in the middle two
          ranks. Landing on a square reveals how many mines touch it — land on
          a mine and the piece is destroyed. Blow up your king and you lose.
        </div>
        {renderGrid(timeControlsForVariant('sweeper'))}
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
        data-no-sfx
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
