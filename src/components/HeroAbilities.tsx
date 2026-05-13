import type { ReactElement } from 'react';
import { HERO_INFO, type HeroInfo, type HeroKind } from '../lib/heroChess';
import { renderPiece } from '../lib/pieceSvgs';

type Props = {
  // Whose side this panel shows. The displayed king + ability is for this side.
  perspective: 'white' | 'black';
  myHero: HeroKind;
  oppHero: HeroKind;
  // Cooldown turns remaining for the local player (0 = ready, Infinity = used-and-one-shot).
  myCooldownTurns: number;
  oppCooldownTurns: number;
  // Whose turn it is in the engine. The Use button is only enabled if it's
  // the local player's turn AND their ability is ready.
  myTurn: boolean;
  // Whether a hero action is currently armed (waiting for a board target).
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  // Compact mode for free-play (tighter layout).
  compact?: boolean;
};

export function HeroAbilities({
  perspective,
  myHero,
  oppHero,
  myCooldownTurns,
  oppCooldownTurns,
  myTurn,
  armed,
  onArm,
  onCancel,
  compact,
}: Props): ReactElement {
  const myInfo = HERO_INFO[myHero];
  const oppInfo = HERO_INFO[oppHero];
  const myReady = myCooldownTurns === 0;
  const myColorLetter: 'w' | 'b' = perspective === 'white' ? 'w' : 'b';
  const oppColorLetter: 'w' | 'b' = perspective === 'white' ? 'b' : 'w';

  return (
    <div className={`hero-panel${compact ? ' compact' : ''}`}>
      <div className="hero-panel-title">Heroes</div>

      <HeroCard
        title={compact ? (perspective === 'white' ? 'White' : 'Black') : 'You'}
        info={myInfo}
        colorLetter={myColorLetter}
        cooldownTurns={myCooldownTurns}
        highlight
      />

      <div className="hero-action-row">
        {armed ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={onCancel}
            data-no-sfx
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="primary-btn"
            disabled={!myTurn || !myReady}
            onClick={onArm}
            data-no-sfx
          >
            Use ability
          </button>
        )}
      </div>

      <HeroCard
        title={compact ? (perspective === 'white' ? 'Black' : 'White') : 'Opp'}
        info={oppInfo}
        colorLetter={oppColorLetter}
        cooldownTurns={oppCooldownTurns}
      />

      <div className="hero-panel-hint muted small">
        {armed
          ? 'Click a highlighted square to confirm.'
          : myTurn
            ? myReady
              ? 'Click "Use ability" to arm it.'
              : myInfo.cooldownTurns == null
                ? 'One-shot — already used.'
                : `Ready in ${myCooldownTurns} turn${myCooldownTurns === 1 ? '' : 's'}.`
            : 'Wait for your turn.'}
      </div>
    </div>
  );
}

function HeroCard({
  title, info, colorLetter, cooldownTurns, highlight,
}: {
  title: string;
  info: HeroInfo;
  colorLetter: 'w' | 'b';
  cooldownTurns: number;
  highlight?: boolean;
}) {
  const isOneShot = info.cooldownTurns == null;
  return (
    <div
      className={`hero-card-row${highlight ? ' highlight' : ''}`}
      style={{ ['--hero-color' as any]: info.glowColor }}
    >
      <div className="hero-card-king small" aria-hidden>
        {renderPiece(`${colorLetter}K` as 'wK' | 'bK', 36)}
      </div>
      <div className="hero-card-text">
        <div className="hero-card-row-label muted small">{title}</div>
        <div className="hero-card-name">{info.name}</div>
        <div className="hero-card-cd-line small">
          {isOneShot
            ? (cooldownTurns === 0 ? 'Ready (once per match)' : 'Used')
            : cooldownTurns === 0
              ? 'Ready'
              : `${cooldownTurns}T`}
        </div>
      </div>
    </div>
  );
}
