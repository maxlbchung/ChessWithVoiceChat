import type { ReactElement } from 'react';
import { HERO_INFO, JUG_TIER_INFO, type HeroInfo, type HeroKind } from '../lib/heroChess';
import { renderNeutralKing, renderPiece } from '../lib/pieceSvgs';

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
  // Whether the ability has at least one legal target square right now.
  // Necromancer with no empty adjacent squares (e.g. king fully surrounded)
  // is the common case; same idea for Knight with no adjacent enemy, Frost
  // with no non-king pieces, or Flight when every empty square is attacked.
  hasTargets: boolean;
  // Whether a hero action is currently armed (waiting for a board target).
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  // Compact mode for free-play (tighter layout).
  compact?: boolean;
  // Juggernaut tier per side (1-3); 0 / undefined when that side isn't
  // playing the Juggernaut. Drives the "Tier N · <ability>" line.
  myJugTier?: number;
  oppJugTier?: number;
};

export function HeroAbilities({
  perspective,
  myHero,
  oppHero,
  myCooldownTurns,
  oppCooldownTurns,
  myTurn,
  hasTargets,
  armed,
  onArm,
  onCancel,
  compact,
  myJugTier,
  oppJugTier,
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
        info={myInfo}
        colorLetter={myColorLetter}
        cooldownTurns={myCooldownTurns}
        jugTier={myJugTier}
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
            disabled={!myTurn || !myReady || !hasTargets}
            onClick={onArm}
            data-no-sfx
          >
            Use ability
          </button>
        )}
      </div>

      <HeroCard
        info={oppInfo}
        colorLetter={oppColorLetter}
        cooldownTurns={oppCooldownTurns}
        jugTier={oppJugTier}
      />

      <div className="hero-panel-hint muted small">
        {armed
          ? 'Click a highlighted square to confirm.'
          : myTurn
            ? myReady
              ? hasTargets
                ? 'Click "Use ability" to arm it.'
                : noTargetHint(myHero, myJugTier)
              : myInfo.cooldownTurns == null
                ? 'One-shot — already used.'
                : `Ready in ${myCooldownTurns} turn${myCooldownTurns === 1 ? '' : 's'}.`
            : 'Wait for your turn.'}
      </div>
    </div>
  );
}

function noTargetHint(hero: HeroKind, jugTier?: number): string {
  switch (hero) {
    case 'necromancer': return 'No empty square next to your king.';
    case 'warlord':     return 'No enemy piece adjacent to your king.';
    case 'frost':       return 'No piece available to freeze.';
    case 'flight':      return 'No piece can fly anywhere safely.';
    case 'twin-jutsu':  return 'No legal swap pair right now.';
    case 'slime':       return 'No mini king with room to expand.';
    case 'juggernaut':
      return jugTier === 1
        ? 'No safe direction to spawn an earthquake.'
        : jugTier === 2
          ? 'No diagonal charge lane is safe right now.'
          : 'Nothing to slam.';
    default:            return 'No legal target right now.';
  }
}

function HeroCard({
  info, colorLetter, cooldownTurns, highlight, jugTier,
}: {
  info: HeroInfo;
  colorLetter: 'w' | 'b';
  cooldownTurns: number;
  highlight?: boolean;
  // Juggernaut tier for this side (1-3); 0 / undefined for other heroes.
  jugTier?: number;
}) {
  const isOneShot = info.cooldownTurns == null;
  const cdText = isOneShot
    ? (cooldownTurns === 0 ? 'Ready' : 'Used')
    : cooldownTurns === 0
      ? 'Ready'
      : `${cooldownTurns}T`;
  const isJug = info.kind === 'juggernaut' && !!jugTier && jugTier >= 1;
  const tierInfo = isJug ? JUG_TIER_INFO[jugTier!] : null;
  return (
    <div
      className={`hero-card-row${highlight ? ' highlight' : ''}`}
      style={{ ['--hero-color' as any]: info.glowColor }}
    >
      <div className="hero-card-king small" aria-hidden>
        {isJug ? renderNeutralKing(36) : renderPiece(`${colorLetter}K` as 'wK' | 'bK', 36)}
      </div>
      <div className="hero-card-text">
        <div className="hero-card-name-row">
          <span className="hero-card-name">{info.name}</span>
          <span className="hero-card-cd-line small">{cdText}</span>
        </div>
        {tierInfo && (
          <div className="hero-card-tier-line small muted" title={tierInfo.blurb}>
            Tier {jugTier} · {tierInfo.name}
          </div>
        )}
      </div>
    </div>
  );
}
