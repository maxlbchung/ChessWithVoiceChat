import type { ReactElement } from 'react';
import { HERO_INFO, HERO_KINDS, type HeroKind } from '../lib/heroChess';
import { renderPiece } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';

type Props = {
  // Which side the local player will pick FOR. The picker shows that side's
  // king colour on each option (white or black king SVG).
  side: 'white' | 'black';
  // The hero the local player has picked, or null if they haven't yet.
  myPick: HeroKind | null;
  // The hero the opponent has picked, or null if not yet (online).
  oppPick?: HeroKind | null;
  // True if the opponent is the AI / local-control (free play). The picker
  // also shows their pick for free play; we hide the "waiting" hint then.
  inline?: boolean;
  onPick: (hero: HeroKind) => void;
};

export function HeroPicker({ side, myPick, oppPick, inline, onPick }: Props): ReactElement {
  const myColorLetter: 'w' | 'b' = side === 'white' ? 'w' : 'b';
  return (
    <div className={`hero-picker${inline ? ' inline' : ''}`}>
      <div className="hero-picker-title">
        {inline ? `Pick your hero (${side})` : 'Choose your hero'}
      </div>
      <div className="hero-picker-grid">
        {HERO_KINDS.map((h) => {
          const info = HERO_INFO[h];
          const selected = myPick === h;
          return (
            <button
              key={h}
              type="button"
              data-no-sfx
              className={`hero-card${selected ? ' selected' : ''}`}
              onClick={() => {
                if (!selected) sfx.playSelect();
                onPick(h);
              }}
              style={{
                ['--hero-color' as any]: info.glowColor,
              }}
            >
              <div className="hero-card-king" aria-hidden>
                {renderPiece(`${myColorLetter}K` as 'wK' | 'bK', 48)}
              </div>
              <div className="hero-card-name">{info.name}</div>
              <div className="hero-card-blurb">{info.blurb}</div>
              <div className="hero-card-cd">
                {info.cooldownTurns == null
                  ? 'once per match'
                  : `${info.cooldownTurns}-turn cooldown`}
              </div>
            </button>
          );
        })}
      </div>
      {!inline && (
        <div className="hero-picker-status muted small">
          {myPick == null
            ? 'Pick a hero to begin.'
            : oppPick == null
              ? 'Waiting for opponent to pick…'
              : 'Both ready. Starting…'}
        </div>
      )}
    </div>
  );
}
