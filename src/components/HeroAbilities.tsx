import type { ReactElement } from 'react';
import { HERO_INFO, JUG_TIER_INFO, type HeroInfo, type HeroKind } from '../lib/heroChess';
import { renderNeutralKing, renderPiece } from '../lib/pieceSvgs';

type Props = {
  // Whose side this panel shows. The displayed king + ability is for this side.
  perspective: 'white' | 'black';
  // Which colour sits at the BOTTOM of the board — same meaning as MergeBoard's
  // `orientation` prop, and pass the same value. It only decides which side of
  // the Use-ability row each hero card lands on, so the panel reads like the
  // board: the colour at the top of the board is the top card. Flipping the
  // board flips the cards with it.
  orientation: 'white' | 'black';
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
  // Mid-activation confirm, currently Goofball only: its first forced move is
  // staged locally while the player decides on a second one, so they need a
  // way to stop at one. Absent for every other hero.
  onFinish?: () => void;
  finishLabel?: string;
  // Replaces the bottom hint line while a multi-step activation is in flight.
  hintOverride?: string;
  // Compact mode for free-play (tighter layout).
  compact?: boolean;
  // Juggernaut tier per side (1-3); 0 / undefined when that side isn't
  // playing the Juggernaut. Drives the "Tier N · <ability>" line.
  myJugTier?: number;
  oppJugTier?: number;
};

export function HeroAbilities({
  perspective,
  orientation,
  myHero,
  oppHero,
  myCooldownTurns,
  oppCooldownTurns,
  myTurn,
  hasTargets,
  armed,
  onArm,
  onCancel,
  onFinish,
  finishLabel,
  hintOverride,
  compact,
  myJugTier,
  oppJugTier,
}: Props): ReactElement {
  const myInfo = HERO_INFO[myHero];
  const oppInfo = HERO_INFO[oppHero];
  const myReady = myCooldownTurns === 0;
  const myColorLetter: 'w' | 'b' = perspective === 'white' ? 'w' : 'b';
  const oppColorLetter: 'w' | 'b' = perspective === 'white' ? 'b' : 'w';

  const myCard = (
    <HeroCard
      info={myInfo}
      colorLetter={myColorLetter}
      cooldownTurns={myCooldownTurns}
      jugTier={myJugTier}
      highlight
    />
  );
  const oppCard = (
    <HeroCard
      info={oppInfo}
      colorLetter={oppColorLetter}
      cooldownTurns={oppCooldownTurns}
      jugTier={oppJugTier}
    />
  );
  // Each card sits on the side of the Use-ability row matching where its pieces
  // are on the board. `orientation` names the colour at the bottom, so the local
  // side is the bottom card exactly when the two agree. In free play the
  // perspective follows whose turn it is, so this is what keeps a colour's card
  // parked at one end instead of hopping across the button every move — only the
  // highlight moves.
  const myAtBottom = perspective === orientation;

  return (
    <div className={`hero-panel${compact ? ' compact' : ''}`}>
      <div className="hero-panel-title">Heroes</div>

      {myAtBottom ? oppCard : myCard}

      <div className="hero-action-row">
        {armed ? (
          <>
            {onFinish && (
              <button
                type="button"
                className="primary-btn"
                onClick={onFinish}
                data-no-sfx
              >
                {finishLabel ?? 'Done'}
              </button>
            )}
            <button
              type="button"
              className="secondary-btn"
              onClick={onCancel}
              data-no-sfx
            >
              Cancel
            </button>
          </>
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

      {myAtBottom ? myCard : oppCard}

      <div className="hero-panel-hint muted small">
        {hintOverride
          ? hintOverride
          : armed
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
    case 'kamakaze':    return 'No piece available to arm.';
    case 'twin-jutsu':  return 'No legal swap pair right now.';
    case 'slime':       return 'No mini king with room to expand.';
    case 'gojo':        return 'No room beside your king for Hollow Purple.';
    case 'juggernaut':
      return jugTier === 1
        ? 'No safe direction to spawn an earthquake.'
        : jugTier === 2
          ? 'No edge-charge lane is safe right now.'
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
