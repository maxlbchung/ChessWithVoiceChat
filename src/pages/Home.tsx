import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { HOLLOW_PURPLE_DRIFT_MS, MergeBoard } from '../components/MergeBoard';
import { PromotionPicker, type PromotionLetter } from '../components/PromotionPicker';
import { CustomSelect } from '../components/CustomSelect';
import { CashShop } from '../components/CashShop';
import { TimeModeSelector } from '../components/TimeModeSelector';
import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';
import {
  initialState as mergeInitial,
  applyMove as mergeApply,
  legalMovesFrom as mergeLegal,
  sqToIdx as mergeSqToIdx,
  type GameState as MergeState,
  type MoveResult as MergeResult,
} from '../lib/mergeChess';
import {
  initialState as twoInitial,
  applyMove as twoApply,
  legalMovesFrom as twoLegal,
  sqToIdx as twoSqToIdx,
  type GameState as TwoState,
  type MoveResult as TwoResult,
} from '../lib/chess2';
import {
  initialState as cashInitial,
  applyMove as cashApply,
  legalMovesFrom as cashLegal,
  legalBuyTargets as cashLegalBuyTargets,
  affordableLetters as cashAffordable,
  buyUci as cashBuyUci,
  parseBuy as cashParseBuy,
  sqToIdx as cashSqToIdx,
  type GameState as CashState,
  type MoveResult as CashResult,
  type ShopLetter,
} from '../lib/cashChess';
import {
  initialState as heroInitial,
  backRanksForGame as heroBackRanksForGame,
  applyMove as heroApply,
  kingSquareOf as heroKingSquareOf,
  hollowPurpleOrigin as heroHollowPurpleOrigin,
  legalMovesFrom as heroLegal,
  abilityTargets as heroAbilityTargets,
  abilityReady as heroAbilityReady,
  abilityUci as heroAbilityUci,
  goofballLegalDestinations as heroGoofballLegalDestinations,
  goofballPreview as heroGoofballPreview,
  goofballHasFollowUp as heroGoofballHasFollowUp,
  goofballSlides as heroGoofballSlides,
  isWithinBlast as heroIsWithinBlast,
  kamakazeDoomedSprites as heroKamakazeDoomedSprites,
  killedSpriteAt as heroKilledSpriteAt,
  type GoofballLeg,
  twinJutsuLegalDestinations as heroTwinJutsuLegalDestinations,
  flightLegalDestinations as heroFlightLegalDestinations,
  slimeLegalDestinations as heroSlimeLegalDestinations,
  slimeShiftOptions,
  resolveSlimeShiftClick,
  type SlimeShiftOption,
  jugTierOf as heroJugTierOf,
  turnsUntilReady as heroTurnsUntilReady,
  sqToIdx as heroSqToIdx,
  idxToSq as heroIdxToSq,
  pieceAtImpactBeforeBlast,
  HERO_INFO,
  HERO_KINDS,
  type GameState as HeroState,
  type MoveResult as HeroResult,
  type HeroKind,
} from '../lib/heroChess';
import {
  applyMove as sweeperApply,
  initialState as sweeperInitial,
  idxToSq as sweeperIdxToSq,
  legalMovesFrom as sweeperLegal,
  minesForGame,
  revealedCounts as sweeperRevealedCounts,
  sqToIdx as sweeperSqToIdx,
  type GameState as SweeperState,
  type MoveResult as SweeperResult,
} from '../lib/sweeperChess';
import {
  ARMY_ORDER as SETUP_ARMY_ORDER,
  applyMove as setupApply,
  autoCompletePlacement as setupAutoComplete,
  canPlaceAt as setupCanPlaceAt,
  idxToSq as setupIdxToSq,
  initialStateFromPlacements as setupInitialFromPlacements,
  legalMovesFrom as setupLegal,
  remainingArmy as setupRemainingArmy,
  sqToIdx as setupSqToIdx,
  type GameState as SetupState,
  type MoveResult as SetupResult,
  type Placement as SetupPlacement,
} from '../lib/setupChess';
import {
  applyMove as secretApply,
  initialState as secretInitial,
  legalMovesFrom as secretLegal,
  pawnSquaresFor as secretPawnSquaresFor,
  randomPickSquare as secretRandomPick,
  startingBoard as secretStartingBoard,
  sqToIdx as secretSqToIdx,
  type GameState as SecretState,
  type MoveResult as SecretResult,
} from '../lib/secretChess';
import { HeroAbilities } from '../components/HeroAbilities';
import { MineRail } from '../components/MineRail';
import type { Piece as MergePiece } from '../lib/mergeChess';
import type { AbilityAnim } from '../components/MergeBoard';
import { renderPiece, type PieceKey } from '../lib/pieceSvgs';
import { useSettingsStore } from '../store/settingsStore';
const ACTIVITY_WINDOWS: Record<string, number> = Object.fromEntries(
  TIME_CONTROLS.map((tc) => [tc.id, tc.activityWindowMs]),
);
import { useIdentityStore } from '../store/identityStore';
import { Matchmaker, fetchQueueStats } from '../lib/matchmaking';
import { PeerSession, makePeerId } from '../lib/peer';
import { getIceServers } from '../lib/iceConfig';
import { setLobbyHandoff } from '../store/lobbyHandoff';
import * as sfx from '../lib/sfx';

// Setup Chess ('setup') and Secret Queen ('secret') play here with their
// hidden information laid bare — one person drives both sides, so free play
// shows everything: Setup runs an untimed placement stage for BOTH armies
// before the merged game, and Secret Queen has you pick both fakes (each
// rendered with the owner-shadow pawn marker; the reveal still fires on the
// fake's first move so the moment previews).
type FreeVariant = 'normal' | 'merge' | 'two' | 'cash' | 'hero' | 'sweeper' | 'setup' | 'secret';

type Mode = 'idle' | 'searching' | 'hosting';

// Kill-effect lead-in. A click-move slides the piece across the board
// (piece-slide is 260ms), so the kill lands just as it arrives; a piece that's
// already on its square (drag, or a scrub into the ply) only needs a beat to
// register before it's destroyed. Same split Chesssweeper uses for mines.
const KILL_ON_LANDING_MS = 275;
const KILL_BEAT_MS = 150;

// The from/to of a plain board-move uci, or null for ability pseudo-UCIs.
function boardMoveOf(uci: string): { from: string; to: string } | null {
  return /^[a-h][1-8][a-h][1-8]/.test(uci)
    ? { from: uci.slice(0, 2), to: uci.slice(2, 4) }
    : null;
}

export function Home() {
  const { identity, rating, loaded, signUp } = useIdentityStore();
  const [handleInput, setHandleInput] = useState('');
  const [selected, setSelected] = useState<TimeControl | null>(TIME_CONTROLS[0] ?? null);
  const [mode, setMode] = useState<Mode>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [searchingCounts, setSearchingCounts] = useState<Record<string, number>>({});
  const [freeChess] = useState(() => new Chess());
  const [freeFen, setFreeFen] = useState(freeChess.fen());
  const [freeOrientation, setFreeOrientation] = useState<'white' | 'black'>('white');
  // Bumped on free-play variant switch / reset so MergeBoard wipes its
  // right-click annotation arrows + highlights against the new position.
  const [freeAnnotationsClearKey, setFreeAnnotationsClearKey] = useState(0);
  // Queued pawn promotion in free play. While non-null the picker overlay
  // is rendered and board interaction is gated. `variant` is needed so the
  // resolver knows which engine's apply path to dispatch to.
  const [freePromo, setFreePromo] = useState<{
    from: string; to: string;
    variant: 'normal' | 'merge' | 'two' | 'hero' | 'sweeper' | 'setup' | 'secret';
    viaClick: boolean;
  } | null>(null);
  const [freeSelected, setFreeSelected] = useState<string | null>(null);
  // Ply we're currently viewing. Equals the active engine's history length at
  // present. Free play lets you make moves while in the past — doing so
  // truncates truth back to viewPly and branches a new line.
  const [freeViewPly, setFreeViewPly] = useState(0);
  const [freeVariant, setFreeVariant] = useState<FreeVariant>('normal');

  // Merge / 2.0 / Cash keep an explicit snapshot list so viewPly can index in
  // O(1) without re-replaying the whole game each render.
  const [mergeStates, setMergeStates] = useState<MergeState[]>(() => [mergeInitial()]);
  const [mergeResults, setMergeResults] = useState<MergeResult[]>([]);
  const [twoStates, setTwoStates] = useState<TwoState[]>(() => [twoInitial()]);
  const [twoResults, setTwoResults] = useState<TwoResult[]>([]);
  const [cashStates, setCashStates] = useState<CashState[]>(() => [cashInitial()]);
  const [cashResults, setCashResults] = useState<CashResult[]>([]);
  // Shop selection (Cash only). When set, board clicks attempt to place the
  // bought piece on a legal target square.
  const [cashShopLetter, setCashShopLetter] = useState<ShopLetter | null>(null);

  // Chesssweeper — a fresh minefield every game. Free play isn't recorded or
  // replayed, so an ephemeral random seed is fine (online games derive theirs
  // from the shared gameId instead).
  const freshSweeperInitial = () => sweeperInitial(minesForGame(Math.random().toString(36).slice(2)));
  const [sweeperStates, setSweeperStates] = useState<SweeperState[]>(() => [freshSweeperInitial()]);
  const [sweeperResults, setSweeperResults] = useState<SweeperResult[]>([]);
  // Blast overlay + the doomed sprite held on the square for the beat before
  // it goes off (same sequencing as the online SweeperGame page).
  const [sweeperAnim, setSweeperAnim] = useState<AbilityAnim | null>(null);
  const [sweeperDoomed, setSweeperDoomed] = useState<{ sq: string; letter: string }[]>([]);
  // Suspected-mine flags. Pure scratch annotation — cleared with the board,
  // never part of the game state. Flagging takes over the right-click gesture,
  // so it sits behind a mode toggle; off, right-click still draws arrows.
  const [sweeperFlags, setSweeperFlags] = useState<string[]>([]);
  const [sweeperFlagMode, setSweeperFlagMode] = useState(false);
  const toggleSweeperFlag = (sq: string) => {
    setSweeperFlags((f) => (f.includes(sq) ? f.filter((s) => s !== sq) : [...f, sq]));
    sfx.playSelect();
  };
  const sweeperBlastTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sweeperAnim) return;
    const t = window.setTimeout(() => setSweeperAnim(null), 1200);
    return () => clearTimeout(t);
  }, [sweeperAnim]);
  useEffect(() => () => {
    if (sweeperBlastTimerRef.current != null) clearTimeout(sweeperBlastTimerRef.current);
  }, []);

  // Setup Chess — an untimed placement stage before play. Unlike online play
  // there is nothing hidden: you arrange BOTH armies (white ranks 1–4, black
  // ranks 5–8) with per-color trays, then Start auto-completes any leftovers
  // and merges into a live game with the king-capture rule.
  const [setupStage, setSetupStage] = useState<'place' | 'play'>('place');
  const [setupPlacements, setSetupPlacements] = useState<{ w: SetupPlacement; b: SetupPlacement }>(
    () => ({ w: new Map(), b: new Map() }),
  );
  // Tray piece armed for click-to-place (color + uppercase letter).
  const [setupArmed, setSetupArmed] = useState<{ color: 'w' | 'b'; letter: string } | null>(null);
  const [setupStates, setSetupStates] = useState<SetupState[]>([]);
  const [setupResults, setSetupResults] = useState<SetupResult[]>([]);

  // Secret Queen — pick white's secret pawn, then black's, then play. Both
  // fakes render with the owner-shadow marker (single player sees all); the
  // reveal still flips on the fake's first move / hidden check.
  const [secretStage, setSecretStage] = useState<'pickW' | 'pickB' | 'play'>('pickW');
  const [secretPicks, setSecretPicks] = useState<{ w: string | null; b: string | null }>({ w: null, b: null });
  const [secretStates, setSecretStates] = useState<SecretState[]>([]);
  const [secretResults, setSecretResults] = useState<SecretResult[]>([]);

  // Hero state — picks default to Frost (W) / Warlord (B); changing either
  // resets the engine. abilityArmed signals "next click is a target".
  const [heroW, setHeroW] = useState<HeroKind>('frost');
  const [heroB, setHeroB] = useState<HeroKind>('warlord');
  // Fresh hero game: a Twin-Jutsu side starts on a randomly shuffled back
  // rank. Free play isn't recorded or replayed, so an ephemeral random seed
  // is fine (online games derive theirs from the shared gameId instead).
  const freshHeroInitial = () =>
    heroInitial(heroW, heroB, heroBackRanksForGame(heroW, heroB, Math.random().toString(36).slice(2)));
  const [heroStates, setHeroStates] = useState<HeroState[]>(() => [heroInitial('frost', 'warlord')]);
  const [heroResults, setHeroResults] = useState<HeroResult[]>([]);
  const [heroAbilityArmed, setHeroAbilityArmed] = useState(false);
  // Goofball is a two-click ability — first click picks the opponent
  // piece, second click picks where to send it. Cleared whenever the
  // ability is disarmed.
  const [goofballFrom, setGoofballFrom] = useState<string | null>(null);
  // One Goofball activation forces up to TWO opponent moves. The first is
  // staged here (not yet committed) while the player picks a second one — or
  // ends the turn on just this one.
  const [goofballLeg1, setGoofballLeg1] = useState<GoofballLeg | null>(null);
  // Twin-Jutsu is also two-click (pick piece → pick swap partner).
  const [twinJutsuFrom, setTwinJutsuFrom] = useState<string | null>(null);
  // Flight is two-click too (pick piece → pick empty destination square).
  const [flightFrom, setFlightFrom] = useState<string | null>(null);
  // Slime too (pick mini king → pick the diagonal corner it expands toward).
  const [slimeFrom, setSlimeFrom] = useState<string | null>(null);
  useEffect(() => {
    if (!heroAbilityArmed) {
      setGoofballFrom(null); setGoofballLeg1(null);
      setTwinJutsuFrom(null); setFlightFrom(null); setSlimeFrom(null);
    }
  }, [heroAbilityArmed]);
  // Transient ability animation overlay (hero free play). Bumped to a fresh
  // key each time it should re-fire.
  const [heroAbilityAnim, setHeroAbilityAnim] = useState<AbilityAnim | null>(null);
  // Pieces destroyed by an ICBM strike that should remain drawn through the
  // 500ms whistle window. Cleared when the explosion fires.
  const [heroDoomedPieces, setHeroDoomedPieces] = useState<{ sq: string; letter: string }[]>([]);
  // Click-to-move smooth slide for free play. Each entry says "the piece now
  // at `to` should appear to slide in from `from`". `key` bumps every event.
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: string; to: string }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: string[]; key: number } | null>(null);
  const [mergeAnim, setMergeAnim] = useState<{ from: string; to: string; fromLetter: string; toLetter: string; mergedLetter: string; key: number; releasePx?: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (!slideAnim) return;
    const t = window.setTimeout(() => setSlideAnim(null), 760);
    return () => clearTimeout(t);
  }, [slideAnim]);
  useEffect(() => {
    if (!popAnim) return;
    const t = window.setTimeout(() => setPopAnim(null), 420);
    return () => clearTimeout(t);
  }, [popAnim]);
  useEffect(() => {
    if (!mergeAnim) return;
    const t = window.setTimeout(() => setMergeAnim(null), 520);
    return () => clearTimeout(t);
  }, [mergeAnim]);
  const { animationsEnabled } = useSettingsStore();

  const navigate = useNavigate();

  // Switching variants resets the board so each mode starts fresh.
  useEffect(() => {
    freeChess.reset();
    setFreeFen(freeChess.fen());
    setMergeStates([mergeInitial()]);
    setMergeResults([]);
    setTwoStates([twoInitial()]);
    setTwoResults([]);
    setCashStates([cashInitial()]);
    setCashResults([]);
    setCashShopLetter(null);
    setHeroStates([freshHeroInitial()]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    setSweeperStates([freshSweeperInitial()]);
    setSweeperResults([]);
    setSweeperDoomed([]);
    setSweeperAnim(null);
    setSweeperFlags([]);
    setSetupStage('place');
    setSetupPlacements({ w: new Map(), b: new Map() });
    setSetupArmed(null);
    setSetupStates([]);
    setSetupResults([]);
    setSecretStage('pickW');
    setSecretPicks({ w: null, b: null });
    setSecretStates([]);
    setSecretResults([]);
    // Clear any stale hero ability animation — without this, switching away
    // from hero and back would re-fire the last animation against a fresh
    // board (e.g. a Knight shake on the king's *old* square).
    setHeroAbilityAnim(null);
    setFreeViewPly(0);
    setFreeSelected(null);
    setFreeAnnotationsClearKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeVariant]);

  // Changing a hero pick re-inits the hero engine from scratch.
  useEffect(() => {
    if (freeVariant !== 'hero') return;
    setHeroStates([freshHeroInitial()]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    setHeroAbilityAnim(null);
    setFreeViewPly(0);
    setFreeSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroW, heroB]);

  // Belt-and-braces: clear the animation state shortly after it's set so a
  // stale value can't outlive the visible effect (e.g. if the user navigates
  // away mid-animation and back). 1.2s comfortably outlasts every ability.
  useEffect(() => {
    if (!heroAbilityAnim) return;
    const t = window.setTimeout(() => setHeroAbilityAnim(null), 1200);
    return () => clearTimeout(t);
  }, [heroAbilityAnim]);

  // Chess instance reflecting the viewed position for the normal variant. At
  // present this is the mutable freeChess; in the past it's a freshly-replayed
  // temporary. Bounded to the actual chess.js history length so we don't
  // replay past the end while merge / 2.0 are driving freeViewPly.
  const previewChess = useMemo(() => {
    if (freeViewPly === freeChess.history().length) return freeChess;
    const tmp = new Chess();
    const all = freeChess.history();
    const upTo = Math.min(freeViewPly, all.length);
    for (let i = 0; i < upTo; i++) tmp.move(all[i]);
    return tmp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeViewPly, freeFen]);

  // Flat 64-square board derived from previewChess (idx 0 = a8 ... 63 = h1).
  // `freeFen` is in deps because previewChess reuses the mutable freeChess at
  // the present ply — its reference never changes across moves, so React's
  // Object.is dep check would otherwise skip recomputation after every move.
  const freeDisplayBoard = useMemo<(MergePiece | null)[]>(() => {
    const out: (MergePiece | null)[] = [];
    for (const row of previewChess.board()) {
      for (const cell of row) {
        if (cell == null) { out.push(null); continue; }
        const letter = cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
        out.push({ color: cell.color, letter: letter as MergePiece['letter'] });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewChess, freeFen]);
  const mergeViewState: MergeState = mergeStates[freeViewPly] ?? mergeStates[0];
  const twoViewState: TwoState = twoStates[freeViewPly] ?? twoStates[0];
  const cashViewState: CashState = cashStates[freeViewPly] ?? cashStates[0];
  const heroBaseState: HeroState = heroStates[freeViewPly] ?? heroStates[0];
  // Position after the staged first Goofball leg. It's still the same side's
  // turn there with the ability still ready, so every hero code path below
  // (targets, clicks, drops, board render) picks up the forced move for free
  // and the player chooses the follow-up on the position it creates.
  const heroGoofballStaged = useMemo<HeroState | null>(() => {
    if (!goofballLeg1 || freeVariant !== 'hero' || freeViewPly !== heroResults.length) return null;
    return heroGoofballPreview(
      heroBaseState,
      heroSqToIdx(goofballLeg1.from),
      heroSqToIdx(goofballLeg1.to),
      goofballLeg1.promo,
    );
  }, [goofballLeg1, freeVariant, freeViewPly, heroResults.length, heroBaseState]);
  const heroViewState: HeroState = heroGoofballStaged ?? heroBaseState;
  const sweeperViewState: SweeperState = sweeperStates[freeViewPly] ?? sweeperStates[0];
  // Null until their pre-play stage finishes (placement / picks).
  const setupViewState: SetupState | null = setupStates[freeViewPly] ?? setupStates[0] ?? null;
  const secretViewState: SecretState | null = secretStates[freeViewPly] ?? secretStates[0] ?? null;
  const totalFreePly =
    freeVariant === 'normal' ? freeChess.history().length :
    freeVariant === 'merge' ? mergeResults.length :
    freeVariant === 'two' ? twoResults.length :
    freeVariant === 'cash' ? cashResults.length :
    freeVariant === 'sweeper' ? sweeperResults.length :
    freeVariant === 'setup' ? setupResults.length :
    freeVariant === 'secret' ? secretResults.length :
    heroResults.length;
  const freeTurn: 'w' | 'b' =
    freeVariant === 'normal' ? previewChess.turn() :
    freeVariant === 'merge' ? mergeViewState.turn :
    freeVariant === 'two' ? twoViewState.turn :
    freeVariant === 'cash' ? cashViewState.turn :
    freeVariant === 'sweeper' ? sweeperViewState.turn :
    freeVariant === 'setup' ? (setupViewState?.turn ?? 'w') :
    // Pre-play the swatch tracks whose secret pawn is being picked.
    freeVariant === 'secret' ? (secretViewState?.turn ?? (secretStage === 'pickB' ? 'b' : 'w')) :
    heroViewState.turn;
  const canUndoFree = freeViewPly > 0;

  // Detect checkmate at the currently-viewed position so the fade-in overlay
  // shows live in free play. Winner = the side that *just* moved (opposite of
  // the side now to move, since the side to move has no legal replies).
  const freeEnd = useMemo<{ winner: 'w' | 'b' } | null>(() => {
    if (freeVariant === 'normal') {
      if (!previewChess.isCheckmate()) return null;
      return { winner: previewChess.turn() === 'w' ? 'b' : 'w' };
    }
    if (freeViewPly === 0) return null;
    if (freeVariant === 'merge') {
      const r = mergeResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: mergeViewState.turn === 'w' ? 'b' : 'w' };
    }
    if (freeVariant === 'two') {
      const r = twoResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: twoViewState.turn === 'w' ? 'b' : 'w' };
    }
    if (freeVariant === 'cash') {
      const r = cashResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: cashViewState.turn === 'w' ? 'b' : 'w' };
    }
    if (freeVariant === 'sweeper') {
      // A blown-up king ends it just as hard as checkmate.
      if (sweeperViewState.mineLoss) {
        return { winner: sweeperViewState.mineLoss === 'w' ? 'b' : 'w' };
      }
      const r = sweeperResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: sweeperViewState.turn === 'w' ? 'b' : 'w' };
    }
    if (freeVariant === 'setup') {
      if (!setupViewState) return null;
      // A captured exposed king ends it just as hard as checkmate.
      if (setupViewState.kingCaptured) {
        return { winner: setupViewState.kingCaptured === 'w' ? 'b' : 'w' };
      }
      const r = setupResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: setupViewState.turn === 'w' ? 'b' : 'w' };
    }
    if (freeVariant === 'secret') {
      if (!secretViewState) return null;
      const r = secretResults[freeViewPly - 1];
      if (!r?.checkmate) return null;
      return { winner: secretViewState.turn === 'w' ? 'b' : 'w' };
    }
    const r = heroResults[freeViewPly - 1];
    if (!r?.checkmate) return null;
    return { winner: heroViewState.turn === 'w' ? 'b' : 'w' };
  }, [freeVariant, previewChess, freeViewPly, mergeResults, mergeViewState.turn, twoResults, twoViewState.turn, cashResults, cashViewState.turn, heroResults, heroViewState.turn, sweeperResults, sweeperViewState, setupResults, setupViewState, secretResults, secretViewState]);

  const freeLegalTargets = useMemo<string[]>(() => {
    if (!freeSelected) return [];
    try {
      const moves = previewChess.moves({ square: freeSelected as any, verbose: true }) as Array<{ to: string }>;
      return moves.map((m) => m.to);
    } catch {
      return [];
    }
  }, [freeSelected, previewChess]);

  // Legal targets reshaped for MergeBoard's `{ to, isCapture, isMerge }` API.
  const normalLegalTargetsForBoard = useMemo(() => {
    if (freeVariant !== 'normal' || !freeSelected) return [];
    return freeLegalTargets.map((to) => ({
      to,
      isCapture: !!previewChess.get(to as any),
      isMerge: false,
    }));
  }, [freeVariant, freeSelected, freeLegalTargets, previewChess]);

  // Merge / 2.0 legal-target sets, in the shape MergeBoard expects.
  const mergeLegalTargets = useMemo(() => {
    if (freeVariant !== 'merge' || !freeSelected) return [];
    return mergeLegal(mergeViewState, freeSelected).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isMerge,
    }));
  }, [freeVariant, freeSelected, mergeViewState]);

  const twoLegalTargets = useMemo(() => {
    if (freeVariant !== 'two' || !freeSelected) return [];
    return twoLegal(twoViewState, freeSelected).map((m) => ({
      // Remap chess2's `isSpecial` (rook push) onto MergeBoard's green-ring
      // `isMerge` slot — same visual treatment.
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [freeVariant, freeSelected, twoViewState]);

  const sweeperLegalTargets = useMemo(() => {
    if (freeVariant !== 'sweeper' || !freeSelected) return [];
    return sweeperLegal(sweeperViewState, freeSelected);
  }, [freeVariant, freeSelected, sweeperViewState]);

  // ---- Setup Chess (free play) ----
  // Board shown during the placement stage: both in-progress armies.
  const setupPlaceBoard = useMemo<(MergePiece | null)[]>(() => {
    const board: (MergePiece | null)[] = new Array(64).fill(null);
    for (const [idx, letter] of setupPlacements.w) {
      board[idx] = { color: 'w', letter: letter.toUpperCase() as MergePiece['letter'] };
    }
    for (const [idx, letter] of setupPlacements.b) {
      board[idx] = { color: 'b', letter: letter.toLowerCase() as MergePiece['letter'] };
    }
    return board;
  }, [setupPlacements]);

  // What's left to place, per side (letter -> count).
  const setupRemaining = useMemo(() => ({
    w: setupRemainingArmy(setupPlacements.w),
    b: setupRemainingArmy(setupPlacements.b),
  }), [setupPlacements]);
  const setupLeftTotal =
    Object.values(setupRemaining.w).reduce((a, b) => a + b, 0) +
    Object.values(setupRemaining.b).reduce((a, b) => a + b, 0);

  // Squares the armed tray piece (or selected placed piece) may land on.
  const setupPlaceTargets = useMemo<{ to: string; isCapture: boolean; isMerge: boolean }[]>(() => {
    if (freeVariant !== 'setup' || setupStage !== 'place') return [];
    let color: 'w' | 'b' | null = null;
    let letter: string | null = null;
    if (setupArmed) {
      color = setupArmed.color;
      letter = setupArmed.letter;
    } else if (freeSelected) {
      const idx = setupSqToIdx(freeSelected);
      const w = setupPlacements.w.get(idx);
      const b = setupPlacements.b.get(idx);
      if (w) { color = 'w'; letter = w; }
      else if (b) { color = 'b'; letter = b; }
    }
    if (!color || !letter) return [];
    const out: { to: string; isCapture: boolean; isMerge: boolean }[] = [];
    for (let idx = 0; idx < 64; idx++) {
      if (setupPlacements.w.has(idx) || setupPlacements.b.has(idx)) continue;
      if (!setupCanPlaceAt(color, letter, idx)) continue;
      out.push({ to: setupIdxToSq(idx), isCapture: false, isMerge: false });
    }
    return out;
  }, [freeVariant, setupStage, setupArmed, freeSelected, setupPlacements]);

  const setupLegalTargets = useMemo(() => {
    if (freeVariant !== 'setup' || setupStage !== 'play' || !freeSelected || !setupViewState) return [];
    return setupLegal(setupViewState, freeSelected);
  }, [freeVariant, setupStage, freeSelected, setupViewState]);

  // ---- Secret Queen (free play) ----
  // Standard starting position shown while the picks are being made.
  const secretPickBoard = useMemo<(MergePiece | null)[]>(
    () => secretStartingBoard() as (MergePiece | null)[],
    [],
  );

  // The 8 candidate pawns of whichever side is currently picking, circled
  // green — same treatment SecretGame uses. A side's already-chosen pawn
  // drops out of the candidates; it wears the grey "picked" circle instead.
  const secretPickCandidates = useMemo<string[]>(() => {
    if (freeVariant !== 'secret' || secretStage === 'play') return [];
    const color = secretStage === 'pickB' ? 'b' : 'w';
    const chosen = secretPicks[color];
    return secretPawnSquaresFor(color).filter((sq) => sq !== chosen);
  }, [freeVariant, secretStage, secretPicks]);
  const secretPickedSqs = useMemo<string[]>(() => {
    if (freeVariant !== 'secret' || secretStage === 'play') return [];
    return [secretPicks.w, secretPicks.b].filter((s): s is string => !!s);
  }, [freeVariant, secretStage, secretPicks]);

  const secretLegalTargets = useMemo(() => {
    if (freeVariant !== 'secret' || secretStage !== 'play' || !freeSelected || !secretViewState) return [];
    return secretLegal(secretViewState, freeSelected);
  }, [freeVariant, secretStage, freeSelected, secretViewState]);

  // Both unrevealed fakes get the owner-shadow pawn marker — no opponent
  // masking in single-player, you see everything.
  const secretSelfPawnSqs = useMemo<string[]>(() => {
    if (freeVariant !== 'secret' || !secretViewState) return [];
    const out: string[] = [];
    for (const c of ['w', 'b'] as const) {
      const f = secretViewState.fakes[c];
      if (f.sq && !f.revealed) out.push(f.sq);
    }
    return out;
  }, [freeVariant, secretViewState]);

  // Revealed numbers + craters at the viewed ply — scrubbing back un-learns
  // whatever the board hadn't uncovered yet.
  const sweeperBoardCounts = useMemo(
    () => sweeperRevealedCounts(sweeperViewState).map(({ idx, count }) => ({ sq: sweeperIdxToSq(idx), count })),
    [sweeperViewState],
  );
  // The engine marks a mine detonated the moment the move commits, but the
  // crater must not appear under a piece that's still sliding toward it —
  // that would spoil the mine before impact. `sweeperDoomed` holds that square
  // for exactly the flight, so hide its crater until the blast goes off.
  const sweeperBoardCraters = useMemo(
    () => {
      const inFlight = new Set(sweeperDoomed.map((d) => d.sq));
      return sweeperViewState.detonated.map(sweeperIdxToSq).filter((sq) => !inFlight.has(sq));
    },
    [sweeperViewState, sweeperDoomed],
  );

  // Cash buy-target squares are derived from the shop selection. When a shop
  // letter is selected, those squares get the green "special" ring and board
  // piece moves are suppressed.
  const cashBuyTargets = useMemo<Set<string>>(() => {
    if (freeVariant !== 'cash' || !cashShopLetter) return new Set();
    return new Set(cashLegalBuyTargets(cashViewState, cashShopLetter));
  }, [freeVariant, cashShopLetter, cashViewState]);

  const cashLegalTargets = useMemo(() => {
    if (freeVariant !== 'cash') return [];
    if (cashShopLetter) {
      return Array.from(cashBuyTargets).map((to) => ({
        to, isCapture: false, isMerge: true,
      }));
    }
    if (!freeSelected) return [];
    return cashLegal(cashViewState, freeSelected).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [freeVariant, freeSelected, cashViewState, cashShopLetter, cashBuyTargets]);

  // Affordable + has-legal-target shop letters for the side currently to move.
  const cashAffordableSet = useMemo<Set<ShopLetter>>(() => {
    if (freeVariant !== 'cash') return new Set();
    // Only allow buying at the present (not while scrubbing history).
    if (freeViewPly !== cashResults.length) return new Set();
    const out = new Set<ShopLetter>();
    for (const L of cashAffordable(cashViewState)) {
      if (cashLegalBuyTargets(cashViewState, L).length > 0) out.add(L);
    }
    return out;
  }, [freeVariant, cashViewState, freeViewPly, cashResults.length]);

  // Hero ability target squares when the ability is armed.
  const heroAbilityTargetSet = useMemo<Set<string>>(() => {
    if (freeVariant !== 'hero' || !heroAbilityArmed) return new Set();
    // Note: scrubbing back is allowed — firing the ability rewrites history
    // from the current view point onward (commitHeroMove truncates first).
    // Goofball is two-click: while a from-square is pending, surface the
    // destination squares for that picked piece instead of the from-squares.
    if (heroViewState.heroes[heroViewState.turn].hero === 'goofball' && goofballFrom) {
      return new Set(heroGoofballLegalDestinations(heroViewState, heroSqToIdx(goofballFrom)).map(heroIdxToSq));
    }
    if (heroViewState.heroes[heroViewState.turn].hero === 'twin-jutsu' && twinJutsuFrom) {
      return new Set(heroTwinJutsuLegalDestinations(heroViewState, heroSqToIdx(twinJutsuFrom)).map(heroIdxToSq));
    }
    // Flight too: once a piece is picked, surface its destination squares.
    if (heroViewState.heroes[heroViewState.turn].hero === 'flight' && flightFrom) {
      return new Set(heroFlightLegalDestinations(heroViewState, heroSqToIdx(flightFrom)).map(heroIdxToSq));
    }
    // Slime: once a mini king is picked, surface the expansion corners.
    if (heroViewState.heroes[heroViewState.turn].hero === 'slime' && slimeFrom) {
      return new Set(heroSlimeLegalDestinations(heroViewState, heroSqToIdx(slimeFrom)).map(heroIdxToSq));
    }
    return new Set(heroAbilityTargets(heroViewState).map((idx) => heroIdxToSq(idx)));
  }, [freeVariant, heroAbilityArmed, heroViewState, freeViewPly, heroResults.length, goofballFrom, twinJutsuFrom, flightFrom, slimeFrom]);

  // Whole-blob shift options when a Slime big-king tile is selected — drives
  // the direction-arrow UI and click/drop resolution.
  const heroSlimeShiftOpts = useMemo<SlimeShiftOption[]>(() => {
    if (freeVariant !== 'hero' || heroAbilityArmed || !freeSelected) return [];
    const p = heroViewState.board[heroSqToIdx(freeSelected)];
    if (!p || p.color !== heroViewState.turn || p.letter.toUpperCase() !== 'S') return [];
    return slimeShiftOptions(heroViewState, heroSqToIdx(freeSelected));
  }, [freeVariant, heroAbilityArmed, freeSelected, heroViewState]);

  const heroLegalTargets = useMemo(() => {
    if (freeVariant !== 'hero') return [];
    if (heroAbilityArmed) {
      // ICBM targets every square — drawing 64 green rings is noise. The
      // ghost crosshair on hover is the affordance instead.
      if (heroViewState.heroes[heroViewState.turn].hero === 'icbm') return [];
      return Array.from(heroAbilityTargetSet).map((to) => ({
        to, isCapture: false, isMerge: true,
      }));
    }
    if (!freeSelected) return [];
    // Selected blob tile: every square the blob can slide onto is clickable.
    // MergeBoard suppresses the dots for these and draws direction arrows.
    if (heroSlimeShiftOpts.length > 0) {
      return heroSlimeShiftOpts.flatMap((o) => o.entered.map((i) => ({
        to: heroIdxToSq(i), isCapture: o.isCapture, isMerge: false,
      })));
    }
    return heroLegal(heroViewState, freeSelected).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [freeVariant, freeSelected, heroViewState, heroAbilityArmed, heroAbilityTargetSet, heroSlimeShiftOpts]);

  // Subtle dark tint on the previous move's from/to squares. Ability (`!`)
  // UCIs have no meaningful "from" and are skipped; cash buys (`+Lxx`) tint
  // just the placement square.
  const freeLastMove = useMemo(() => {
    if (freeViewPly <= 0) return null;
    let uci: string | undefined;
    if (freeVariant === 'normal') {
      const v = freeChess.history({ verbose: true }) as Array<{ from: string; to: string }>;
      const m = v[freeViewPly - 1];
      return m ? { from: m.from, to: m.to } : null;
    } else if (freeVariant === 'merge') uci = mergeResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'two') uci = twoResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'cash') uci = cashResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'hero') uci = heroResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'sweeper') uci = sweeperResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'setup') uci = setupResults[freeViewPly - 1]?.uci;
    else if (freeVariant === 'secret') uci = secretResults[freeViewPly - 1]?.uci;
    if (!uci) return null;
    if (freeVariant === 'cash') {
      const buy = cashParseBuy(uci);
      if (buy) return { from: buy.to, to: buy.to };
    }
    // Hero abilities (UCIs prefixed with '!'): show the green tint by
    // default. Twin-Jutsu only tints an endpoint whose piece was already
    // revealed (unmasked) before the swap — tinting a hidden piece's square
    // would leak which decoys swapped. Two hidden pieces swapping shows no
    // tint at all.
    if (freeVariant === 'hero' && uci.startsWith('!')) {
      const hero = uci[1];
      if (hero === 'T') {
        const a = uci.slice(2, 4);
        const b = uci.slice(4, 6);
        const prev = heroStates[freeViewPly - 1];
        if (!prev) return null;
        const aRevealed = !!prev.board[heroSqToIdx(a)] && !prev.masked[heroSqToIdx(a)];
        const bRevealed = !!prev.board[heroSqToIdx(b)] && !prev.masked[heroSqToIdx(b)];
        if (aRevealed && bRevealed) return { from: a, to: b };
        if (aRevealed) return { from: a, to: a };
        if (bRevealed) return { from: b, to: b };
        return null;
      }
      if (hero === 'G' || hero === 'L' || hero === 'S') {
        // Goofball / Flight move a visible piece from → to; Slime grows a
        // mini king (from) toward an empty corner (to) — tint both ends. A
        // two-move Goofball tints where the puppeting started and ended.
        const legs = hero === 'G' ? heroGoofballSlides(uci) : [];
        if (legs.length > 0) return { from: legs[0].from, to: legs[legs.length - 1].to };
        return { from: uci.slice(2, 4), to: uci.slice(4, 6) };
      }
      const sq = uci.slice(2, 4);
      return { from: sq, to: sq };
    }
    if (!/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
    // A Chesssweeper move cut short by a mine never reached its destination —
    // tint where the piece actually died instead.
    const aborted = freeVariant === 'sweeper' ? sweeperResults[freeViewPly - 1]?.abortedAt : null;
    if (aborted != null) return { from: uci.slice(0, 2), to: sweeperIdxToSq(aborted) };
    return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeVariant, freeViewPly, freeFen, mergeResults, twoResults, cashResults, heroResults, heroStates, sweeperResults, setupResults, secretResults]);

  const applyFreeMove = (from: string, to: string, promotion?: string, viaClick = false): boolean => {
    while (freeChess.history().length > freeViewPly) freeChess.undo();
    let m;
    try {
      m = freeChess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false;
    }
    if (!m) return false;
    const castled = m.flags && (m.flags.includes('k') || m.flags.includes('q'));
    if (castled) sfx.playCastle();
    else if (m.captured) sfx.playCapture();
    else sfx.playMove();
    if (freeChess.isCheckmate()) sfx.playWin();
    else if (freeChess.isCheck()) sfx.playCheck();
    setFreeFen(freeChess.fen());
    setFreeViewPly(freeChess.history().length);
    setFreeSelected(null);
    if (viaClick && animationsEnabled) {
      const slides: { from: string; to: string }[] = [{ from, to }];
      if (m.flags?.includes('k')) {
        slides.push({ from: `h${to[1]}`, to: `f${to[1]}` });
      } else if (m.flags?.includes('q')) {
        slides.push({ from: `a${to[1]}`, to: `d${to[1]}` });
      }
      setSlideAnim({ moves: slides, key: Date.now() });
    }
    if (animationsEnabled && m.flags?.includes('p')) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    return true;
  };

  const applyMergeMove = (
    from: string,
    to: string,
    promotion?: 'Q' | 'R' | 'B' | 'N',
    viaClick = false,
    releasePx?: { x: number; y: number },
  ): boolean => {
    // Branch in past: drop everything after viewPly, then apply on the snapshot we're viewing.
    const truncStates = mergeStates.slice(0, freeViewPly + 1);
    const truncResults = mergeResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const moverLetterBefore = base.board[mergeSqToIdx(from)]?.letter;
    const receiverLetterBefore = base.board[mergeSqToIdx(to)]?.letter;
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    const res = mergeApply(base, uci);
    if (!res) return false;
    if (res.result.castled) sfx.playCastle();
    else if (res.result.merged) sfx.playMerge();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setMergeStates([...truncStates, res.state]);
    setMergeResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    // Merge overrides slide+pop with the flow animation.
    const mergedLetterAfter = res.state.board[mergeSqToIdx(to)]?.letter;
    if (animationsEnabled && res.result.merged && moverLetterBefore && receiverLetterBefore && mergedLetterAfter) {
      setMergeAnim({
        from,
        to,
        fromLetter: moverLetterBefore,
        toLetter: receiverLetterBefore,
        mergedLetter: mergedLetterAfter,
        key: Date.now(),
        releasePx,
      });
    } else {
      if (viaClick && animationsEnabled) {
        setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      }
      if (animationsEnabled && !!promotion) {
        setPopAnim({ squares: [to], key: Date.now() });
      }
    }
    return true;
  };

  // For a rook push, the rook moves onto `to` and every contiguous piece at
  // `to` shifts one square in the push direction. Walk the chain off the
  // pre-move board so each pushed piece can be animated.
  const computeTwoPushSlides = (base: TwoState, from: string, to: string): { from: string; to: string }[] => {
    const slides: { from: string; to: string }[] = [{ from, to }];
    const piece = base.board[twoSqToIdx(from)];
    if (!piece || piece.letter.toUpperCase() !== 'R') return slides;
    if (!base.board[twoSqToIdx(to)]) return slides;
    const ff = from.charCodeAt(0) - 97;
    const fr = parseInt(from[1], 10) - 1;
    const tf = to.charCodeAt(0) - 97;
    const tr = parseInt(to[1], 10) - 1;
    const df = Math.sign(tf - ff);
    const dr = Math.sign(tr - fr);
    if (df === 0 && dr === 0) return slides;
    let f = tf, r = tr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = String.fromCharCode(97 + f) + String.fromCharCode(49 + r);
      if (!base.board[twoSqToIdx(sq)]) break;
      const nf = f + df, nr = r + dr;
      if (nf < 0 || nf >= 8 || nr < 0 || nr >= 8) break;
      const nsq = String.fromCharCode(97 + nf) + String.fromCharCode(49 + nr);
      slides.push({ from: sq, to: nsq });
      f = nf; r = nr;
    }
    return slides;
  };

  const applyTwoMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N', viaClick = false): boolean => {
    const truncStates = twoStates.slice(0, freeViewPly + 1);
    const truncResults = twoResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    const res = twoApply(base, uci);
    if (!res) return false;
    if (res.result.pushed) sfx.playPush();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setTwoStates([...truncStates, res.state]);
    setTwoResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    if (viaClick && animationsEnabled) {
      setSlideAnim({ moves: computeTwoPushSlides(base, from, to), key: Date.now() });
    }
    if (animationsEnabled && !!promotion) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    return true;
  };

  // Piece travels (sliding in, if this move animates) → blast + sfx → gone.
  // The doomed sprite stands in for the mover while it's in flight, since the
  // engine has already cleared the square. Mirrors the online SweeperGame page:
  // a click-move detonates on landing (the slide is 260ms), a drag just gets a
  // short beat since the piece is already there.
  const triggerSweeperBlast = (
    sq: string,
    letter: string | null,
    color: 'w' | 'b',
    key: string,
    sliding = false,
  ) => {
    if (!animationsEnabled) {
      sfx.playExplosion();
      return;
    }
    if (letter) setSweeperDoomed([{ sq, letter }]);
    if (sweeperBlastTimerRef.current != null) clearTimeout(sweeperBlastTimerRef.current);
    sweeperBlastTimerRef.current = window.setTimeout(() => {
      sweeperBlastTimerRef.current = null;
      setSweeperDoomed([]);
      setSweeperAnim({ kind: 'mine', toSq: sq, color, key });
      sfx.playExplosion();
    }, sliding ? 275 : 150);
  };

  const applySweeperMove = (
    from: string,
    to: string,
    promotion?: 'Q' | 'R' | 'B' | 'N',
    viaClick = false,
  ): boolean => {
    // Branch in past: drop everything after viewPly, then apply on the snapshot we're viewing.
    const truncStates = sweeperStates.slice(0, freeViewPly + 1);
    const truncResults = sweeperResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const mover = base.turn;
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    const res = sweeperApply(base, uci);
    if (!res) return false;
    const sliding = viaClick && animationsEnabled;
    if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.mineIdx != null) {
      triggerSweeperBlast(
        sweeperIdxToSq(res.result.mineIdx),
        res.result.destroyedLetter,
        mover,
        `mine-${truncResults.length}-${uci}`,
        sliding,
      );
    } else if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setSweeperStates([...truncStates, res.state]);
    setSweeperResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    // The move animates even when it ends on a mine: the engine has already
    // cleared the square, so the doomed sprite is what slides in, and the
    // blast fires as it arrives. A mine caught in transit stops the slide
    // there — that square is where the piece died. Promotion pops are
    // pointless for a piece that's about to be destroyed.
    if (sliding) {
      const stop = res.result.abortedAt != null ? sweeperIdxToSq(res.result.abortedAt) : to;
      setSlideAnim({ moves: [{ from, to: stop }], key: Date.now() });
    }
    if (animationsEnabled && !!promotion && res.result.mineIdx == null) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    return true;
  };

  // ---- Setup Chess placement-stage actions ----
  // All of them look up which side's map holds a square; the two maps never
  // overlap (placement blocks occupied squares across both).
  const setupOccupantOf = (idx: number): { color: 'w' | 'b'; letter: string } | null => {
    const w = setupPlacements.w.get(idx);
    if (w) return { color: 'w', letter: w };
    const b = setupPlacements.b.get(idx);
    if (b) return { color: 'b', letter: b };
    return null;
  };

  const placeSetupPiece = (color: 'w' | 'b', letter: string, sq: string): boolean => {
    if (setupStage !== 'place') return false;
    const idx = setupSqToIdx(sq);
    if (setupOccupantOf(idx)) return false;
    if (!setupCanPlaceAt(color, letter, idx)) return false;
    if ((setupRemaining[color][letter] ?? 0) <= 0) return false;
    setSetupPlacements((p) => {
      const next = new Map(p[color]);
      next.set(idx, letter);
      return { ...p, [color]: next };
    });
    sfx.playPlace();
    // Keep the letter armed while more of that piece remain — placing 8
    // pawns shouldn't take 16 clicks (same convention as SetupGame).
    if (setupArmed && setupArmed.color === color && setupArmed.letter === letter
        && (setupRemaining[color][letter] ?? 0) <= 1) {
      setSetupArmed(null);
    }
    return true;
  };

  const moveSetupPiece = (from: string, to: string): boolean => {
    if (setupStage !== 'place') return false;
    const fromIdx = setupSqToIdx(from);
    const toIdx = setupSqToIdx(to);
    const occ = setupOccupantOf(fromIdx);
    if (!occ) return false;
    if (setupOccupantOf(toIdx)) return false;
    if (!setupCanPlaceAt(occ.color, occ.letter, toIdx)) return false;
    setSetupPlacements((p) => {
      const next = new Map(p[occ.color]);
      next.delete(fromIdx);
      next.set(toIdx, occ.letter);
      return { ...p, [occ.color]: next };
    });
    sfx.playMove();
    return true;
  };

  const removeSetupPiece = (sq: string) => {
    if (setupStage !== 'place') return;
    const idx = setupSqToIdx(sq);
    const occ = setupOccupantOf(idx);
    if (!occ) return;
    setSetupPlacements((p) => {
      const next = new Map(p[occ.color]);
      next.delete(idx);
      return { ...p, [occ.color]: next };
    });
    setFreeSelected(null);
    sfx.playCaptureReversed();
  };

  // Tray → board HTML5 drag; letter casing encodes color for the board's
  // "spawn:<letter>" payload (same channel SetupGame/Sandbox use).
  const onSetupTrayDragStart = (e: ReactDragEvent<HTMLButtonElement>, color: 'w' | 'b', letter: string) => {
    const cased = color === 'w' ? letter.toUpperCase() : letter.toLowerCase();
    try {
      e.dataTransfer.setData('text/plain', `spawn:${cased}`);
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch {}
  };

  const handleSetupSpawn = (letter: string, to: string) => {
    placeSetupPiece(letter === letter.toUpperCase() ? 'w' : 'b', letter.toUpperCase(), to);
  };

  // Start: auto-complete whatever's left in the trays, merge, begin play.
  const startSetupPlay = () => {
    if (setupStage !== 'place') return;
    const w = setupAutoComplete('w', setupPlacements.w);
    const b = setupAutoComplete('b', setupPlacements.b);
    setSetupPlacements({ w, b });
    const init = setupInitialFromPlacements(w, b);
    setSetupStates([init]);
    setSetupResults([]);
    setSetupStage('play');
    setSetupArmed(null);
    setFreeViewPly(0);
    setFreeSelected(null);
    sfx.playQueue();
  };

  const applySetupMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N', viaClick = false): boolean => {
    // Branch in past: drop everything after viewPly, then apply on the snapshot we're viewing.
    const truncStates = setupStates.slice(0, freeViewPly + 1);
    const truncResults = setupResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    if (!base) return false;
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    const res = setupApply(base, uci);
    if (!res) return false;
    if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.kingCaptured || res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setSetupStates([...truncStates, res.state]);
    setSetupResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    if (viaClick && animationsEnabled) {
      setSlideAnim({ moves: [{ from, to }], key: Date.now() });
    }
    if (animationsEnabled && !!promotion) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    return true;
  };

  // ---- Secret Queen pick-stage + play actions ----
  const startSecretPlay = (w: string, b: string) => {
    const init = secretInitial(w, b);
    setSecretStates([init]);
    setSecretResults([]);
    setSecretStage('play');
    setFreeViewPly(0);
    setFreeSelected(null);
    sfx.playQueue();
  };

  const pickSecretPawn = (sq: string) => {
    if (secretStage === 'pickW') {
      if (!secretPawnSquaresFor('w').includes(sq)) return;
      setSecretPicks((p) => ({ ...p, w: sq }));
      setSecretStage('pickB');
      sfx.playSelect();
      return;
    }
    if (secretStage === 'pickB') {
      if (!secretPawnSquaresFor('b').includes(sq)) return;
      setSecretPicks((p) => ({ ...p, b: sq }));
      startSecretPlay(secretPicks.w ?? secretRandomPick('w'), sq);
    }
  };

  const randomSecretPick = () => {
    if (secretStage === 'pickW') {
      const w = secretRandomPick('w');
      setSecretPicks((p) => ({ ...p, w }));
      setSecretStage('pickB');
      sfx.playSelect();
      return;
    }
    if (secretStage === 'pickB') {
      const b = secretRandomPick('b');
      setSecretPicks((p) => ({ ...p, b }));
      startSecretPlay(secretPicks.w ?? secretRandomPick('w'), b);
    }
  };

  const applySecretMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N', viaClick = false): boolean => {
    const truncStates = secretStates.slice(0, freeViewPly + 1);
    const truncResults = secretResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    if (!base) return false;
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    const res = secretApply(base, uci);
    if (!res) return false;
    if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    // The unmask moment — same smoke-bomb cue + pop SecretGame uses. A
    // capture-reveal keeps the plain capture sound.
    const reveal = res.result.reveal && res.result.reveal.cause !== 'captured' ? res.result.reveal : null;
    if (reveal) sfx.playTwinJutsu();
    if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setSecretStates([...truncStates, res.state]);
    setSecretResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    if (viaClick && animationsEnabled) {
      setSlideAnim({ moves: [{ from, to }], key: Date.now() });
    }
    if (animationsEnabled) {
      const pops: string[] = [];
      if (promotion) pops.push(to);
      const revealSq = reveal ? res.state.fakes[reveal.side].sq : null;
      if (revealSq && !pops.includes(revealSq)) pops.push(revealSq);
      if (pops.length > 0) setPopAnim({ squares: pops, key: Date.now() });
    }
    return true;
  };

  const commitCashMove = (uci: string, slides?: { from: string; to: string }[], pops?: string[]): boolean => {
    const truncStates = cashStates.slice(0, freeViewPly + 1);
    const truncResults = cashResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const res = cashApply(base, uci);
    if (!res) return false;
    if (res.result.cashedIn) sfx.playCashIn();
    else if (res.result.bought) sfx.playPlace();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setCashStates([...truncStates, res.state]);
    setCashResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    setCashShopLetter(null);
    if (slides && slides.length > 0 && animationsEnabled) {
      setSlideAnim({ moves: slides, key: Date.now() });
    }
    if (pops && pops.length > 0 && animationsEnabled) {
      setPopAnim({ squares: pops, key: Date.now() });
    }
    return true;
  };

  const applyCashMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N', viaClick = false): boolean => {
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    return commitCashMove(uci, viaClick ? [{ from, to }] : undefined);
  };

  const applyCashBuy = (letter: ShopLetter, to: string): boolean => {
    // Shop buys spawn a new piece at `to` — pop it in to celebrate the
    // placement; nothing slides since the piece came from the shop.
    return commitCashMove(cashBuyUci(letter, to), undefined, [to]);
  };

  const commitHeroMove = (uci: string, slides?: { from: string; to: string }[], pops?: string[]): boolean => {
    const truncStates = heroStates.slice(0, freeViewPly + 1);
    const truncResults = heroResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const res = heroApply(base, uci);
    if (!res) return false;
    if (res.result.abilityUsed === 'frost') sfx.playFreeze();
    // Slice fires at swing-start; its internal climax is timed to land at the
    // swing midpoint so the whistle leads INTO the blade's apex strike.
    else if (res.result.abilityUsed === 'warlord') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.abilityUsed === 'mutation') sfx.playMutate();
    else if (res.result.abilityUsed === 'icbm') sfx.playMissileLaunch();
    else if (res.result.abilityUsed === 'goofball') sfx.playGoofball();
    else if (res.result.abilityUsed === 'twin-jutsu') sfx.playTwinJutsu();
    else if (res.result.abilityUsed === 'slime') sfx.playSlimeExpand();
    else if (res.result.abilityUsed === 'juggernaut') sfx.playJugQuake();
    else if (res.result.abilityUsed === 'kamakaze') sfx.playKamakazeArm();
    else if (res.result.abilityUsed === 'gojo') sfx.playHollowPurple();
    else if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.checkmate) sfx.playWin();
    // jugPhantomCheck: a sub-tier-3 Juggernaut can't actually be checked but
    // the design calls for the check sound to play anyway as a flavor cue.
    else if (res.result.check || res.result.jugPhantomCheck) sfx.playCheck();
    if (res.result.abilityUsed && animationsEnabled) {
      const ab = res.result.abilityUsed;
      // harem is passive and icbm has its own missile UI; skip overlay.
      if (ab === 'frost' || ab === 'warlord' || ab === 'necromancer' || ab === 'flight' || ab === 'mutation' || ab === 'slime' || ab === 'juggernaut' || ab === 'gojo') {
        const moverColor = base.turn;
        if (ab === 'flight') {
          // !L<from><to>[<promo>] — fly the selected piece from → to.
          const fromSq = res.result.uci.slice(2, 4);
          const toSq = res.result.uci.slice(4, 6);
          const flyer = base.board[heroSqToIdx(fromSq)];
          setHeroAbilityAnim({
            kind: ab,
            fromSq,
            toSq,
            color: moverColor,
            flyerLetter: flyer?.letter,
            key: `${base.ply}-${res.result.uci}-${Date.now()}`,
          });
        } else if (ab === 'slime') {
          // !S<from><to> — the mini king grows toward the corner.
          setHeroAbilityAnim({
            kind: 'slime-expand',
            fromSq: res.result.uci.slice(2, 4),
            toSq: res.result.uci.slice(4, 6),
            color: moverColor,
            key: `${base.ply}-${res.result.uci}-${Date.now()}`,
          });
        } else {
          const targetSq = res.result.uci.slice(2);
          let fromSq: string | undefined;
          if (ab === 'warlord') {
            fromSq = heroKingSquareOf(res.state.board, moverColor) ?? undefined;
          }
          // Juggernaut tier-2 edge-charge slide rides the regular slide track
          // (handled below). Tier-3 slam swaps to the 'jug-slam' overlay so
          // the king physically leaps in place + amplified ground impact.
          const isJugSlam = ab === 'juggernaut' && heroJugTierOf(base, moverColor) === 3;
          setHeroAbilityAnim({
            kind: isJugSlam ? 'jug-slam' : ab,
            fromSq,
            toSq: targetSq,
            color: moverColor,
            key: `${base.ply}-${res.result.uci}-${Date.now()}`,
          });
        }
      }
    }
    // ICBM detonations on this ply (any missile whose landing ply has
    // arrived). The whistle plays immediately; the explosion (and removal
    // of the doomed piece) follows half a second later. Multiple
    // simultaneous landings share the single abilityAnim slot — staggered so
    // each still gets a key bump.
    const landings = base.missiles.filter((m) => m.landsAtPly <= res.state.ply);
    if (landings.length > 0) {
      sfx.playMissileWhistle();
      // A piece that moved INTO the impact square this ply is the doomed
      // sprite — not whatever was on the square before the move applied.
      const doomed = landings
        .map((m) => {
          const p = pieceAtImpactBeforeBlast(base, uci, m.idx);
          return p ? { sq: heroIdxToSq(m.idx), letter: p.letter as string } : null;
        })
        .filter((x): x is { sq: string; letter: string } => x !== null);
      if (doomed.length > 0) setHeroDoomedPieces(doomed);
      landings.forEach((m, i) => {
        const at = 500 + i * 220;
        window.setTimeout(() => {
          if (animationsEnabled) {
            setHeroAbilityAnim({
              kind: 'icbm',
              toSq: heroIdxToSq(m.idx),
              color: m.firedBy,
              key: `icbm-${base.ply}-${m.idx}-${Date.now()}`,
            });
          }
          sfx.playExplosion();
          // Drop this landing's doomed sprite (others linger until their own
          // staggered explosion clears them).
          setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== heroIdxToSq(m.idx)));
        }, at);
      });
    }
    // A drifting Hollow Purple ran a piece down. Hold the victim's sprite for
    // exactly as long as the orb takes to glide onto it, then detonate.
    if (res.result.hollowPurpleBlasts && res.result.hollowPurpleBlasts.length > 0) {
      const squares = res.result.hollowPurpleBlasts;
      // A piece caught by the orb on the ply it moved died at its DESTINATION,
      // so its sprite is the mover's, not the pre-move occupant's.
      const doomed = squares
        .map((sq) => {
          const letter = heroKilledSpriteAt(base, sq, boardMoveOf(uci));
          return letter ? { sq, letter: letter as string } : null;
        })
        .filter((d): d is { sq: string; letter: string } => d !== null);
      if (doomed.length > 0) setHeroDoomedPieces((prev) => [...prev, ...doomed]);
      squares.forEach((sq, i) => {
        window.setTimeout(() => {
          if (animationsEnabled) {
            setHeroAbilityAnim({
              kind: 'gojo-blast',
              toSq: sq,
              color: base.turn,
              key: `gojo-blast-${res.result.uci}-${sq}-${i}-${Date.now()}`,
            });
          }
          sfx.playHollowPurpleHit();
          setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== sq));
        }, HOLLOW_PURPLE_DRIFT_MS + i * 130);
      });
    }
    // Knight ability: the engine already cleared the victim, but we keep it
    // rendered as a doomed-piece overlay through the wind-up of the sword
    // swing and only let it disappear at the swing midpoint (collision).
    if (res.result.abilityUsed === 'warlord') {
      const targetSq = res.result.uci.slice(2);
      const victim = base.board[heroSqToIdx(targetSq)];
      if (victim) {
        const entry = { sq: targetSq, letter: victim.letter };
        setHeroDoomedPieces((prev) => [...prev, entry]);
        window.setTimeout(() => {
          setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== targetSq));
        }, 450);
      }
    }
    // Frost shatter — one or more freeze entries cleared this move.
    if (base.frozen.length > 0) {
      const nextIdxs = new Set(res.state.frozen.map((f) => f.idx));
      const expired = base.frozen.filter((f) => !nextIdxs.has(f.idx));
      if (expired.length > 0) {
        sfx.playFrostShatter();
        if (animationsEnabled) {
          const f = expired[expired.length - 1];
          setHeroAbilityAnim({
            kind: 'frost-shatter',
            toSq: heroIdxToSq(f.idx),
            color: 'w',
            key: `frost-shatter-${base.ply}-${f.idx}-${Date.now()}`,
          });
        }
      }
    }
    // Slime split — a big-king tile was captured / crushed / blasted and the
    // blob burst into mini kings. Squelch + goo splatter + pop the minis in.
    if (res.result.slimeSplits && res.result.slimeSplits.length > 0) {
      sfx.playSlimeSplit();
      if (animationsEnabled) {
        const tile = res.result.slimeSplits[0].tiles[0];
        if (tile) {
          setHeroAbilityAnim({
            kind: 'slime-split',
            toSq: tile,
            color: 'w',
            key: `slime-split-${base.ply}-${tile}-${Date.now()}`,
          });
        }
        const minis = res.result.slimeSplits.flatMap((s) => s.minis);
        if (minis.length > 0) setPopAnim({ squares: minis, key: Date.now() });
      }
    }
    // Juggernaut tier-up — a capture attempt (or missile) fed the boss this
    // move: the attacker died and the Juggernaut powered up. A board-move
    // capture slides the doomed attacker onto the (unmoving) Juggernaut and
    // explodes it at impact; missile feeds just quake immediately.
    let jugAbsorbed = false;
    for (const c of ['w', 'b'] as const) {
      if (heroJugTierOf(res.state, c) > heroJugTierOf(base, c)) {
        const jugSq = heroKingSquareOf(res.state.board, c);
        const isBoardMove = /^[a-h][1-8][a-h][1-8]/.test(uci);
        const fromSq = isBoardMove ? uci.slice(0, 2) : null;
        const attacker = fromSq ? base.board[heroSqToIdx(fromSq)] : null;
        if (jugSq && isBoardMove && uci.slice(2, 4) === jugSq && attacker) {
          jugAbsorbed = true;
          window.setTimeout(() => sfx.playJugQuake(), 320);
          if (animationsEnabled) {
            setHeroAbilityAnim({
              kind: 'jug-absorb',
              fromSq: fromSq!,
              toSq: jugSq,
              color: c,
              flyerLetter: attacker.letter,
              key: `jug-absorb-${base.ply}-${c}-${Date.now()}`,
            });
          }
        } else {
          sfx.playJugQuake();
          if (animationsEnabled && jugSq) {
            setHeroAbilityAnim({
              kind: 'juggernaut',
              toSq: jugSq,
              color: c,
              key: `jug-tier-${base.ply}-${c}-${Date.now()}`,
            });
          }
        }
      }
    }
    // Whether this move will visibly slide a piece — same condition the slide
    // branch below uses. A Kamakaze chain waits for it so the capture is seen.
    const slidingIn = !!slides && slides.length > 0 && !res.result.abilityUsed
      && !jugAbsorbed && animationsEnabled;
    // A Kamakaze chain went off. The engine cleared every victim on commit, so
    // hold their sprites while the capture plays out, then detonate — the
    // attacker's sprite sits on its destination and rides the slide in.
    if (res.result.kamakazeExplosions && res.result.kamakazeExplosions.length > 0) {
      const centers = res.result.kamakazeExplosions;
      const doomed = animationsEnabled
        ? heroKamakazeDoomedSprites(base, res.state, centers, boardMoveOf(uci))
        : [];
      if (doomed.length > 0) setHeroDoomedPieces((prev) => [...prev, ...doomed]);
      const lead = doomed.length === 0 ? 0 : slidingIn ? KILL_ON_LANDING_MS : KILL_BEAT_MS;
      centers.forEach((sq, i) => {
        window.setTimeout(() => {
          if (animationsEnabled) {
            setHeroAbilityAnim({
              kind: 'kamakaze',
              toSq: sq,
              color: 'w',
              key: `kamakaze-${res.result.uci}-${sq}-${i}-${Date.now()}`,
            });
          }
          sfx.playExplosion();
          setHeroDoomedPieces((prev) => prev.filter((d) => !heroIsWithinBlast(sq, d.sq)));
        }, lead + i * 120);
      });
    }
    setHeroStates([...truncStates, res.state]);
    setHeroResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    setHeroAbilityArmed(false);
    // Skip slide on ability moves — abilityAnim already shows the movement
    // effect for Flight, and the others don't move a piece at all. Twin-Jutsu
    // does swap two pieces, so we drive a pair of slides at each endpoint.
    // A Juggernaut absorb also skips it — the jug-absorb overlay carries the
    // attacker's motion, and the Juggernaut itself must not appear to move.
    if (slides && slides.length > 0 && !res.result.abilityUsed && !jugAbsorbed && animationsEnabled) {
      setSlideAnim({ moves: slides, key: Date.now() });
    } else if (res.result.abilityUsed === 'twin-jutsu' && animationsEnabled) {
      const a = uci.slice(2, 4);
      const b = uci.slice(4, 6);
      setSlideAnim({ moves: [{ from: a, to: b }, { from: b, to: a }], key: Date.now() });
    } else if (res.result.abilityUsed === 'goofball' && animationsEnabled) {
      // The puppeted piece(s) move from→to — one or two forced moves per
      // activation.
      setSlideAnim({ moves: heroGoofballSlides(uci), key: Date.now() });
    } else if (res.result.abilityUsed === 'juggernaut' && animationsEnabled) {
      // Edge Charge (tier 2) slides the Juggernaut to a corner. Earthquake
      // (tier 1) keeps it in place and just pops the spawn square. Slam
      // (tier 3) drives its own in-place leap via the jug-slam overlay,
      // so we skip the pop there to avoid a conflicting scale animation.
      const from = heroKingSquareOf(base.board, base.turn);
      const to = uci.slice(2, 4);
      const tier = heroJugTierOf(base, base.turn);
      if (tier === 2 && from && from !== to) setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      else if (tier !== 3) setPopAnim({ squares: [to], key: Date.now() });
    }
    // Pop the destination on promotions and necromancer spawns.
    if (animationsEnabled) {
      const popList = [...(pops ?? [])];
      if (uci.length >= 5 && /^[a-h][1-8][a-h][1-8]/.test(uci)) {
        popList.push(uci.slice(2, 4));
      }
      if (res.result.abilityUsed === 'necromancer') {
        popList.push(uci.slice(2, 4));
      }
      // Mutation transforms the piece into its merged form — pop it.
      if (res.result.abilityUsed === 'mutation') {
        popList.push(uci.slice(2, 4));
      }
      if (popList.length > 0) {
        setPopAnim({ squares: popList, key: Date.now() });
      }
    }
    return true;
  };

  const applyHeroMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N', viaClick = false): boolean => {
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    return commitHeroMove(uci, viaClick ? [{ from, to }] : undefined);
  };

  const applyHeroAbility = (to: string, from?: string, promo?: string, second?: GoofballLeg): boolean => {
    const hero = heroViewState.heroes[heroViewState.turn].hero;
    return commitHeroMove(heroAbilityUci(hero, to, from, promo, second));
  };

  // A Goofball activation forces up to two opponent moves. The first pick is
  // staged (nothing hits the engine yet) so the second can be chosen on the
  // resulting position; the second pick commits both at once. Free play
  // auto-queens forced promotions, same as the single-move flow did.
  const pickGoofballLeg = (from: string, to: string): boolean => {
    if (goofballLeg1) {
      const first = goofballLeg1;
      setGoofballLeg1(null);
      return applyHeroAbility(first.to, first.from, first.promo, { from, to, promo: 'Q' });
    }
    const preview = heroGoofballPreview(heroBaseState, heroSqToIdx(from), heroSqToIdx(to), 'Q');
    if (!preview || !heroGoofballHasFollowUp(preview)) {
      return applyHeroAbility(to, from, 'Q');
    }
    setGoofballLeg1({ from, to, promo: 'Q' });
    sfx.playSelect();
    return true;
  };

  // End the activation on the single staged forced move.
  const finishGoofball = () => {
    if (!goofballLeg1) return;
    const first = goofballLeg1;
    setGoofballLeg1(null);
    applyHeroAbility(first.to, first.from, first.promo);
  };

  // Detect whether `from`→`to` would promote a pawn for the given variant.
  // Cash has no promotion (pawns cash in for gold instead) — always false.
  const isPromotionMove = (
    variant: 'normal' | 'merge' | 'two' | 'cash' | 'hero' | 'sweeper' | 'setup' | 'secret',
    from: string,
    to: string,
  ): boolean => {
    if (variant === 'cash') return false;
    const rank = parseInt(to[1], 10);
    if (rank !== 1 && rank !== 8) return false;
    if (variant === 'normal') {
      const p = previewChess.get(from as any);
      return !!p && p.type === 'p';
    }
    const idx =
      variant === 'merge' ? mergeSqToIdx(from) :
      variant === 'two' ? twoSqToIdx(from) :
      variant === 'sweeper' ? sweeperSqToIdx(from) :
      variant === 'setup' ? setupSqToIdx(from) :
      variant === 'secret' ? secretSqToIdx(from) :
      heroSqToIdx(from);
    // A Secret Queen fake carries letter Q on the board, so it's never
    // offered a promotion — it reaches the last rank and stays a queen.
    const piece =
      variant === 'merge' ? mergeViewState.board[idx] :
      variant === 'two' ? twoViewState.board[idx] :
      variant === 'sweeper' ? sweeperViewState.board[idx] :
      variant === 'setup' ? setupViewState?.board[idx] :
      variant === 'secret' ? secretViewState?.board[idx] :
      heroViewState.board[idx];
    return !!piece && piece.letter.toUpperCase() === 'P';
  };

  // Once the user picks a promotion piece, dispatch the move to the right
  // engine's apply function with that promotion letter.
  const resolveFreePromotion = (letter: PromotionLetter) => {
    if (!freePromo) return;
    const { from, to, variant, viaClick } = freePromo;
    setFreePromo(null);
    if (variant === 'normal') {
      // chess.js wants lowercase letters; restrict to Q/R/B/N for normal.
      const valid = ['Q', 'R', 'B', 'N'].includes(letter) ? letter : 'Q';
      applyFreeMove(from, to, valid.toLowerCase(), viaClick);
      return;
    }
    if (variant === 'merge') {
      const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
        ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
      applyMergeMove(from, to, valid, viaClick);
      return;
    }
    if (variant === 'two') {
      const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
        ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
      applyTwoMove(from, to, valid, viaClick);
      return;
    }
    if (variant === 'sweeper') {
      const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
        ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
      applySweeperMove(from, to, valid, viaClick);
      return;
    }
    if (variant === 'setup') {
      const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
        ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
      applySetupMove(from, to, valid, viaClick);
      return;
    }
    if (variant === 'secret') {
      const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
        ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
      applySecretMove(from, to, valid, viaClick);
      return;
    }
    // hero — Mutation side accepts Z/C/A fused options. The applyHeroMove
    // signature still types its promotion as Q/R/B/N; the underlying engine
    // accepts the extra letters, so cast through.
    const allowed: PromotionLetter[] =
      heroViewState.heroes[heroViewState.turn].hero === 'mutation'
        ? ['Q', 'R', 'B', 'N', 'Z', 'C', 'A']
        : ['Q', 'R', 'B', 'N'];
    const valid = allowed.includes(letter) ? letter : 'Q';
    applyHeroMove(from, to, valid as 'Q' | 'R' | 'B' | 'N', viaClick);
  };

  const handleFreeDrop = (from: string, to: string): boolean => {
    if (isPromotionMove('normal', from, to)) {
      setFreePromo({ from, to, variant: 'normal', viaClick: false });
      return true;
    }
    return applyFreeMove(from, to);
  };

  const handleSweeperDrop = (from: string, to: string): boolean => {
    if (!sweeperLegal(sweeperViewState, from).some((m) => m.to === to)) return false;
    if (isPromotionMove('sweeper', from, to)) {
      setFreePromo({ from, to, variant: 'sweeper', viaClick: false });
      return true;
    }
    return applySweeperMove(from, to);
  };

  const handleMergeDrop = (
    from: string,
    to: string,
    opts?: { releasePx?: { x: number; y: number } },
  ): boolean => {
    if (isPromotionMove('merge', from, to)) {
      setFreePromo({ from, to, variant: 'merge', viaClick: false });
      return true;
    }
    return applyMergeMove(from, to, undefined, false, opts?.releasePx);
  };
  const handleTwoDrop = (from: string, to: string): boolean => {
    if (isPromotionMove('two', from, to)) {
      setFreePromo({ from, to, variant: 'two', viaClick: false });
      return true;
    }
    return applyTwoMove(from, to);
  };
  const handleCashDrop = (from: string, to: string): boolean => {
    return applyCashMove(from, to);
  };
  const handleSetupDrop = (from: string, to: string): boolean => {
    if (setupStage === 'place') {
      const ok = moveSetupPiece(from, to);
      if (ok) setFreeSelected(null);
      return ok;
    }
    if (!setupViewState) return false;
    if (!setupLegal(setupViewState, from).some((m) => m.to === to)) return false;
    if (isPromotionMove('setup', from, to)) {
      setFreePromo({ from, to, variant: 'setup', viaClick: false });
      return true;
    }
    return applySetupMove(from, to);
  };
  const handleSecretDrop = (from: string, to: string): boolean => {
    if (secretStage !== 'play' || !secretViewState) return false;
    if (!secretLegal(secretViewState, from).some((m) => m.to === to)) return false;
    if (isPromotionMove('secret', from, to)) {
      setFreePromo({ from, to, variant: 'secret', viaClick: false });
      return true;
    }
    return applySecretMove(from, to);
  };
  const handleHeroDrop = (from: string, to: string): boolean => {
    // Dragging an enemy piece while Goofball is armed fires the ability:
    // the drag's from/to encodes the forced opponent move directly.
    if (
      heroAbilityArmed &&
      heroViewState.heroes[heroViewState.turn].hero === 'goofball'
    ) {
      const fromPiece = heroViewState.board[heroSqToIdx(from)];
      const opp = heroViewState.turn === 'w' ? 'b' : 'w';
      if (fromPiece && fromPiece.color === opp) {
        const legals = heroGoofballLegalDestinations(heroViewState, heroSqToIdx(from));
        if (legals.includes(heroSqToIdx(to))) {
          setGoofballFrom(null);
          return pickGoofballLeg(from, to);
        }
      }
      return false;
    }
    // Dragging the big king: the grabbed tile's travel gives the slide
    // direction; drops further out resolve like a click on an entered square.
    const fromPiece2 = heroViewState.board[heroSqToIdx(from)];
    if (fromPiece2 && fromPiece2.color === heroViewState.turn && fromPiece2.letter.toUpperCase() === 'S') {
      const opts = slimeShiftOptions(heroViewState, heroSqToIdx(from));
      const df = to.charCodeAt(0) - from.charCodeAt(0);
      const dr = parseInt(to[1], 10) - parseInt(from[1], 10);
      const opt = (Math.abs(df) <= 1 && Math.abs(dr) <= 1
        ? opts.find((o) => o.df === df && o.dr === dr)
        : undefined) ?? resolveSlimeShiftClick(opts, heroSqToIdx(to));
      if (!opt) return false;
      return applyHeroMove(opt.uci.slice(0, 2), opt.uci.slice(2, 4));
    }
    if (isPromotionMove('hero', from, to)) {
      setFreePromo({ from, to, variant: 'hero', viaClick: false });
      return true;
    }
    return applyHeroMove(from, to);
  };

  const onFreeSquareClick = (square: string) => {
    if (freeSelected === square) {
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'normal') {
      const piece = previewChess.get(square as any);
      if (freeSelected && freeLegalTargets.includes(square)) {
        if (isPromotionMove('normal', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'normal', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applyFreeMove(freeSelected, square, undefined, true);
        return;
      }
      if (piece && piece.color === previewChess.turn()) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'merge') {
      const targets = mergeLegalTargets;
      if (freeSelected && targets.some((t) => t.to === square)) {
        if (isPromotionMove('merge', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'merge', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applyMergeMove(freeSelected, square, undefined, true);
        return;
      }
      const piece = mergeViewState.board[mergeSqToIdx(square)];
      if (piece && piece.color === mergeViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'two') {
      const targets = twoLegalTargets;
      if (freeSelected && targets.some((t) => t.to === square)) {
        if (isPromotionMove('two', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'two', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applyTwoMove(freeSelected, square, undefined, true);
        return;
      }
      const piece = twoViewState.board[twoSqToIdx(square)];
      if (piece && piece.color === twoViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'sweeper') {
      if (freeSelected && sweeperLegalTargets.some((t) => t.to === square)) {
        if (isPromotionMove('sweeper', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'sweeper', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applySweeperMove(freeSelected, square, undefined, true);
        return;
      }
      const piece = sweeperViewState.board[sweeperSqToIdx(square)];
      if (piece && piece.color === sweeperViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'setup') {
      if (setupStage === 'place') {
        const occupant = setupOccupantOf(setupSqToIdx(square));
        if (setupArmed) {
          if (occupant) {
            // Clicking a placed piece while armed switches to moving it.
            setSetupArmed(null);
            setFreeSelected(square);
            sfx.playSelect();
            return;
          }
          placeSetupPiece(setupArmed.color, setupArmed.letter, square);
          return;
        }
        if (freeSelected) {
          if (occupant) { setFreeSelected(square); sfx.playSelect(); return; }
          if (moveSetupPiece(freeSelected, square)) setFreeSelected(null);
          return;
        }
        if (occupant) {
          setFreeSelected(square);
          sfx.playSelect();
        }
        return;
      }
      if (!setupViewState) return;
      if (freeSelected && setupLegalTargets.some((t) => t.to === square)) {
        if (isPromotionMove('setup', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'setup', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applySetupMove(freeSelected, square, undefined, true);
        return;
      }
      const piece = setupViewState.board[setupSqToIdx(square)];
      if (piece && piece.color === setupViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'secret') {
      if (secretStage !== 'play') {
        pickSecretPawn(square);
        return;
      }
      if (!secretViewState) return;
      if (freeSelected && secretLegalTargets.some((t) => t.to === square)) {
        if (isPromotionMove('secret', freeSelected, square)) {
          setFreePromo({ from: freeSelected, to: square, variant: 'secret', viaClick: true });
          setFreeSelected(null);
          return;
        }
        applySecretMove(freeSelected, square, undefined, true);
        return;
      }
      const piece = secretViewState.board[secretSqToIdx(square)];
      if (piece && piece.color === secretViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'cash') {
      if (cashShopLetter) {
        if (cashBuyTargets.has(square)) {
          applyCashBuy(cashShopLetter, square);
          return;
        }
        // Click on a non-target square cancels the shop selection.
        setCashShopLetter(null);
        return;
      }
      const cashTargets = cashLegalTargets;
      if (freeSelected && cashTargets.some((t) => t.to === square)) {
        applyCashMove(freeSelected, square, undefined, true);
        return;
      }
      const cashPiece = cashViewState.board[cashSqToIdx(square)];
      if (cashPiece && cashPiece.color === cashViewState.turn) {
        setFreeSelected(square);
        return;
      }
      setFreeSelected(null);
      return;
    }
    // hero
    if (heroAbilityArmed) {
      const armedHero = heroViewState.heroes[heroViewState.turn].hero;
      if (armedHero === 'goofball') {
        // Two-click flow: first click picks an opponent piece, second
        // click picks where to send it. Runs twice per activation — the
        // first forced move is staged, the second commits both.
        if (!goofballFrom) {
          if (heroAbilityTargetSet.has(square)) {
            setGoofballFrom(square);
          } else if (!goofballLeg1) {
            // Not while a first leg is staged — disarming would drop it.
            setHeroAbilityArmed(false);
          }
          return;
        }
        if (heroAbilityTargetSet.has(square)) {
          pickGoofballLeg(goofballFrom, square);
          setGoofballFrom(null);
          return;
        }
        // Click off a legal destination resets back to picking a piece.
        setGoofballFrom(null);
        return;
      }
      if (armedHero === 'twin-jutsu') {
        if (!twinJutsuFrom) {
          if (heroAbilityTargetSet.has(square)) {
            setTwinJutsuFrom(square);
          } else {
            setHeroAbilityArmed(false);
          }
          return;
        }
        if (heroAbilityTargetSet.has(square)) {
          applyHeroAbility(square, twinJutsuFrom);
          setTwinJutsuFrom(null);
          return;
        }
        setTwinJutsuFrom(null);
        return;
      }
      if (armedHero === 'flight') {
        // Two-click teleport: pick one of your pieces, then an empty square.
        // Pawns flown to the back rank auto-queen in free play (same
        // convention as Goofball above).
        if (!flightFrom) {
          if (heroAbilityTargetSet.has(square)) {
            setFlightFrom(square);
          } else {
            setHeroAbilityArmed(false);
          }
          return;
        }
        if (heroAbilityTargetSet.has(square)) {
          applyHeroAbility(square, flightFrom);
          setFlightFrom(null);
          return;
        }
        setFlightFrom(null);
        return;
      }
      if (armedHero === 'slime') {
        // Two-click expansion: pick a mini king, then the diagonal corner of
        // the 2×2 quadrant it grows into.
        if (!slimeFrom) {
          if (heroAbilityTargetSet.has(square)) {
            setSlimeFrom(square);
          } else {
            setHeroAbilityArmed(false);
          }
          return;
        }
        if (heroAbilityTargetSet.has(square)) {
          applyHeroAbility(square, slimeFrom);
          setSlimeFrom(null);
          return;
        }
        setSlimeFrom(null);
        return;
      }
      if (heroAbilityTargetSet.has(square)) {
        applyHeroAbility(square);
        return;
      }
      setHeroAbilityArmed(false);
      return;
    }
    // Selected blob: resolve the click to a whole-blob slide and fire its
    // canonical uci (shared entered squares resolve orthogonal-first).
    if (freeSelected && heroSlimeShiftOpts.length > 0) {
      const opt = resolveSlimeShiftClick(heroSlimeShiftOpts, heroSqToIdx(square));
      if (opt) {
        applyHeroMove(opt.uci.slice(0, 2), opt.uci.slice(2, 4));
        return;
      }
    }
    if (freeSelected && heroLegalTargets.some((t) => t.to === square)) {
      if (isPromotionMove('hero', freeSelected, square)) {
        setFreePromo({ from: freeSelected, to: square, variant: 'hero', viaClick: true });
        setFreeSelected(null);
        return;
      }
      applyHeroMove(freeSelected, square, undefined, true);
      return;
    }
    const heroPiece = heroViewState.board[heroSqToIdx(square)];
    if (heroPiece && heroPiece.color === heroViewState.turn) {
      setFreeSelected(square);
      return;
    }
    setFreeSelected(null);
  };

  // Set selection when dragging starts on the merge / 2.0 board so the
  // legal-target rings appear while dragging, matching MergeGame's behavior.
  const onFreeDragStart = (from: string) => {
    if (freeVariant === 'normal') {
      const piece = previewChess.get(from as any);
      if (!piece || piece.color !== previewChess.turn()) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'merge') {
      const piece = mergeViewState.board[mergeSqToIdx(from)];
      if (!piece || piece.color !== mergeViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'two') {
      const piece = twoViewState.board[twoSqToIdx(from)];
      if (!piece || piece.color !== twoViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'cash') {
      if (cashShopLetter) setCashShopLetter(null);
      const piece = cashViewState.board[cashSqToIdx(from)];
      if (!piece || piece.color !== cashViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'sweeper') {
      const piece = sweeperViewState.board[sweeperSqToIdx(from)];
      if (!piece || piece.color !== sweeperViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'setup') {
      if (setupStage === 'place') {
        if (!setupOccupantOf(setupSqToIdx(from))) return;
        setSetupArmed(null);
        if (freeSelected !== from) setFreeSelected(from);
        return;
      }
      if (!setupViewState) return;
      const piece = setupViewState.board[setupSqToIdx(from)];
      if (!piece || piece.color !== setupViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'secret') {
      if (secretStage !== 'play' || !secretViewState) return;
      const piece = secretViewState.board[secretSqToIdx(from)];
      if (!piece || piece.color !== secretViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
      return;
    }
    if (freeVariant === 'hero') {
      // Goofball: dragging an enemy piece while armed is part of the
      // ability (drop fires it). Don't disarm and don't select our own
      // piece in that case.
      if (
        heroAbilityArmed &&
        heroViewState.heroes[heroViewState.turn].hero === 'goofball'
      ) {
        const piece = heroViewState.board[heroSqToIdx(from)];
        const opp = heroViewState.turn === 'w' ? 'b' : 'w';
        if (piece && piece.color === opp) {
          setGoofballFrom(from);
          return;
        }
        // Otherwise (dragging own / empty) — fall through and disarm, unless
        // a first forced move is staged and would be thrown away with it.
        if (goofballLeg1) return;
      }
      if (heroAbilityArmed) setHeroAbilityArmed(false);
      const piece = heroViewState.board[heroSqToIdx(from)];
      if (!piece || piece.color !== heroViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
    }
  };


  const resetFreePlay = () => {
    sfx.playReset();
    freeChess.reset();
    setFreeFen(freeChess.fen());
    setMergeStates([mergeInitial()]);
    setMergeResults([]);
    setTwoStates([twoInitial()]);
    setTwoResults([]);
    setCashStates([cashInitial()]);
    setCashResults([]);
    setCashShopLetter(null);
    setHeroStates([freshHeroInitial()]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    // Reset re-rolls the minefield, so a replayed opening isn't already solved.
    setSweeperStates([freshSweeperInitial()]);
    setSweeperResults([]);
    setSweeperDoomed([]);
    setSweeperAnim(null);
    setSweeperFlags([]);
    // Setup / Secret Queen: back to their pre-play stages.
    setSetupStage('place');
    setSetupPlacements({ w: new Map(), b: new Map() });
    setSetupArmed(null);
    setSetupStates([]);
    setSetupResults([]);
    setSecretStage('pickW');
    setSecretPicks({ w: null, b: null });
    setSecretStates([]);
    setSecretResults([]);
    setFreeViewPly(0);
    setFreeSelected(null);
    setFreeAnnotationsClearKey((k) => k + 1);
    return;
  };

  const undoFreePlay = () => navigateFreeView(false, false);

  const flipFreePlay = () => {
    sfx.playFlip();
    setFreeOrientation((o) => (o === 'white' ? 'black' : 'white'));
  };

  // Scrub one ply forward or backward. Plays piece SFX (forward or reversed)
  // when invoked from the keyboard; the Undo/Redo buttons pass playSfx=false
  // so they rely on the global button-click SFX instead. Variant-aware so
  // merge/2.0 history navigation plays the right sounds.
  const navigateFreeView = (forward: boolean, playSfx = true) => {
    setFreeViewPly((p) => {
      const next = forward ? Math.min(totalFreePly, p + 1) : Math.max(0, p - 1);
      if (next === p) return p;
      if (playSfx) {
        sfx.cutoffChessSfx();
        if (freeVariant === 'normal') {
          const verbose = freeChess.history({ verbose: true }) as Array<{ captured?: string; san: string }>;
          const m = verbose[forward ? p : next];
          if (m) {
            const isCheck = m.san.includes('+') || m.san.includes('#');
            if (forward) {
              if (m.captured) sfx.playCapture(); else sfx.playMove();
              if (isCheck) sfx.playCheck();
            } else {
              if (m.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (isCheck) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'merge') {
          const r = mergeResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.castled) sfx.playCastle();
              else if (r.merged) sfx.playMerge();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'sweeper') {
          const r = sweeperResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.castled) sfx.playCastle();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              // Scrubbing forward into the ply that set a mine off replays
              // the blast; a quiet move just plays its check cue.
              if (r.mineIdx != null) {
                triggerSweeperBlast(
                  sweeperIdxToSq(r.mineIdx),
                  r.destroyedLetter,
                  r.mineLoss ?? (p % 2 === 0 ? 'w' : 'b'),
                  `mine-view-${p}-${r.uci}`,
                );
              } else if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'two') {
          const r = twoResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.pushed) sfx.playPush();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'cash') {
          const r = cashResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.cashedIn) sfx.playCashIn();
              else if (r.bought) sfx.playPlace();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'setup') {
          const r = setupResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.captured) sfx.playCapture(); else sfx.playMove();
              if (r.kingCaptured) sfx.playWin();
              else if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else if (freeVariant === 'secret') {
          const r = secretResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.captured) sfx.playCapture(); else sfx.playMove();
              // Scrubbing forward into the unmask replays its cue.
              if (r.reveal && r.reveal.cause !== 'captured') sfx.playTwinJutsu();
              if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        } else {
          const r = heroResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.abilityUsed === 'frost') sfx.playFreeze();
              else if (r.abilityUsed === 'warlord') sfx.playSlice();
              else if (r.abilityUsed === 'necromancer') sfx.playSpawn();
              else if (r.abilityUsed === 'flight') sfx.playFly();
              else if (r.abilityUsed === 'mutation') sfx.playMutate();
              else if (r.abilityUsed === 'icbm') sfx.playMissileLaunch();
              else if (r.abilityUsed === 'goofball') sfx.playGoofball();
              else if (r.abilityUsed === 'twin-jutsu') sfx.playTwinJutsu();
              else if (r.abilityUsed === 'slime') sfx.playSlimeExpand();
              else if (r.abilityUsed === 'juggernaut') sfx.playJugQuake();
              else if (r.abilityUsed === 'kamakaze') sfx.playKamakazeArm();
              else if (r.abilityUsed === 'gojo') sfx.playHollowPurple();
              else if (r.castled) sfx.playCastle();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              if ((r.check || r.jugPhantomCheck) && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
            }
          }
        }
      }
      // Re-fire the hero ability animation when scrubbing forward into one.
      if (forward && freeVariant === 'hero') {
        const r = heroResults[p];
        const prevState = heroStates[p];
        const nextState = heroStates[p + 1];
        if (r && r.abilityUsed && prevState && nextState) {
          const ab = r.abilityUsed;
          if (ab === 'frost' || ab === 'warlord' || ab === 'necromancer' || ab === 'flight' || ab === 'mutation' || ab === 'slime' || ab === 'juggernaut' || ab === 'gojo') {
            const moverColor = prevState.turn;
            if (ab === 'flight') {
              // !L<from><to>[<promo>] — fly the selected piece from → to.
              const fromSq = r.uci.slice(2, 4);
              const toSq = r.uci.slice(4, 6);
              const flyer = prevState.board[heroSqToIdx(fromSq)];
              setHeroAbilityAnim({
                kind: ab,
                fromSq,
                toSq,
                color: moverColor,
                flyerLetter: flyer?.letter,
                key: `${prevState.ply}-${r.uci}-${Date.now()}`,
              });
            } else if (ab === 'slime') {
              // !S<from><to> — the mini king grows toward the corner.
              setHeroAbilityAnim({
                kind: 'slime-expand',
                fromSq: r.uci.slice(2, 4),
                toSq: r.uci.slice(4, 6),
                color: moverColor,
                key: `${prevState.ply}-${r.uci}-${Date.now()}`,
              });
            } else {
              const targetSq = r.uci.slice(2);
              let fromSq: string | undefined;
              if (ab === 'warlord') {
                fromSq = heroKingSquareOf(nextState.board, moverColor) ?? undefined;
              }
              // Juggernaut tier 2 slide is driven by the standard ability
              // anim + slide track; tier 1/3 just pop.
              setHeroAbilityAnim({
                kind: ab,
                fromSq,
                toSq: targetSq,
                color: moverColor,
                key: `${prevState.ply}-${r.uci}-${Date.now()}`,
              });
            }
          }
        }
        // Replay missile detonations on this scrubbed-into ply.
        if (prevState && nextState && r) {
          const landings = prevState.missiles.filter((m) => m.landsAtPly <= nextState.ply);
          if (landings.length > 0) {
            sfx.playMissileWhistle();
            // Reconstruct what was on the impact square at detonation time.
            const doomed = landings
              .map((m) => {
                const p = pieceAtImpactBeforeBlast(prevState, r.uci, m.idx);
                return p ? { sq: heroIdxToSq(m.idx), letter: p.letter as string } : null;
              })
              .filter((x): x is { sq: string; letter: string } => x !== null);
            if (doomed.length > 0) setHeroDoomedPieces(doomed);
            landings.forEach((m, i) => {
              const at = 500 + i * 220;
              window.setTimeout(() => {
                setHeroAbilityAnim({
                  kind: 'icbm',
                  toSq: heroIdxToSq(m.idx),
                  color: m.firedBy,
                  key: `icbm-${prevState.ply}-${m.idx}-${Date.now()}`,
                });
                sfx.playExplosion();
                setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== heroIdxToSq(m.idx)));
              }, at);
            });
          }
          // Replay the chain on this scrubbed-into ply. Nothing slides on a
          // scrub, so the victims just get the beat before they go up.
          if (r.kamakazeExplosions && r.kamakazeExplosions.length > 0) {
            const centers = r.kamakazeExplosions;
            const doomed = heroKamakazeDoomedSprites(prevState, nextState, centers, boardMoveOf(r.uci));
            if (doomed.length > 0) setHeroDoomedPieces((prev) => [...prev, ...doomed]);
            centers.forEach((sq, i) => {
              window.setTimeout(() => {
                setHeroAbilityAnim({
                  kind: 'kamakaze',
                  toSq: sq,
                  color: 'w',
                  key: `kamakaze-${r.uci}-${sq}-${i}-${Date.now()}`,
                });
                sfx.playExplosion();
                setHeroDoomedPieces((prev) => prev.filter((d) => !heroIsWithinBlast(sq, d.sq)));
              }, (doomed.length === 0 ? 0 : KILL_BEAT_MS) + i * 120);
            });
          }
          // Replay the orb's impact on this scrubbed-into ply.
          if (r.hollowPurpleBlasts && r.hollowPurpleBlasts.length > 0) {
            const squares = r.hollowPurpleBlasts;
            const doomed = squares
              .map((sq) => {
                const letter = heroKilledSpriteAt(prevState, sq, boardMoveOf(r.uci));
                return letter ? { sq, letter: letter as string } : null;
              })
              .filter((d): d is { sq: string; letter: string } => d !== null);
            if (doomed.length > 0) setHeroDoomedPieces((prev) => [...prev, ...doomed]);
            squares.forEach((sq, i) => {
              window.setTimeout(() => {
                setHeroAbilityAnim({
                  kind: 'gojo-blast',
                  toSq: sq,
                  color: prevState.turn,
                  key: `gojo-blast-${r.uci}-${sq}-${i}-${Date.now()}`,
                });
                sfx.playHollowPurpleHit();
                setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== sq));
              }, HOLLOW_PURPLE_DRIFT_MS + i * 130);
            });
          }
          // Replay warlord-ability doomed sprite on this scrubbed-into ply.
          if (r.abilityUsed === 'warlord') {
            const targetSq = r.uci.slice(2);
            const victim = prevState.board[heroSqToIdx(targetSq)];
            if (victim) {
              const entry = { sq: targetSq, letter: victim.letter };
              setHeroDoomedPieces((prev) => [...prev, entry]);
              window.setTimeout(() => {
                setHeroDoomedPieces((prev) => prev.filter((d) => d.sq !== targetSq));
              }, 450);
            }
          }
          // Replay frost shatter when scrubbing into the ply on which any
          // freeze expired (entry present in prev but missing in next).
          if (prevState.frozen.length > 0) {
            const nextIdxs = new Set(nextState.frozen.map((f) => f.idx));
            const expired = prevState.frozen.filter((f) => !nextIdxs.has(f.idx));
            if (expired.length > 0) {
              const f = expired[expired.length - 1];
              sfx.playFrostShatter();
              setHeroAbilityAnim({
                kind: 'frost-shatter',
                toSq: heroIdxToSq(f.idx),
                color: 'w',
                key: `frost-shatter-${prevState.ply}-${f.idx}-${Date.now()}`,
              });
            }
          }
          // Replay the slime split (squelch + splatter + mini pops) when
          // scrubbing into the ply on which a blob burst.
          if (r.slimeSplits && r.slimeSplits.length > 0) {
            sfx.playSlimeSplit();
            const tile = r.slimeSplits[0].tiles[0];
            if (tile) {
              setHeroAbilityAnim({
                kind: 'slime-split',
                toSq: tile,
                color: 'w',
                key: `slime-split-${prevState.ply}-${tile}-${Date.now()}`,
              });
            }
            const minis = r.slimeSplits.flatMap((s) => s.minis);
            if (minis.length > 0) setPopAnim({ squares: minis, key: Date.now() });
          }
          // Replay the Juggernaut tier-up when scrubbing into the ply on
          // which a capture attempt fed it — attacker slides in + explodes
          // for board-move captures, plain quake otherwise.
          for (const c of ['w', 'b'] as const) {
            if (heroJugTierOf(nextState, c) > heroJugTierOf(prevState, c)) {
              const jugSq = heroKingSquareOf(nextState.board, c);
              const isBoardMove = /^[a-h][1-8][a-h][1-8]/.test(r.uci);
              const fromSq = isBoardMove ? r.uci.slice(0, 2) : null;
              const attacker = fromSq ? prevState.board[heroSqToIdx(fromSq)] : null;
              if (jugSq && isBoardMove && r.uci.slice(2, 4) === jugSq && attacker) {
                window.setTimeout(() => sfx.playJugQuake(), 320);
                setHeroAbilityAnim({
                  kind: 'jug-absorb',
                  fromSq: fromSq!,
                  toSq: jugSq,
                  color: c,
                  flyerLetter: attacker.letter,
                  key: `jug-absorb-${prevState.ply}-${c}-${Date.now()}`,
                });
              } else {
                sfx.playJugQuake();
                if (jugSq) {
                  setHeroAbilityAnim({
                    kind: 'juggernaut',
                    toSq: jugSq,
                    color: c,
                    key: `jug-tier-${prevState.ply}-${c}-${Date.now()}`,
                  });
                }
              }
            }
          }
        }
      }
      return next;
    });
  };

  const canRedoFree = freeViewPly < totalFreePly;

  // Stash the latest navigate callback so the keydown handler — registered
  // once at mount — always sees current variant + history state.
  const navigateRef = useRef(navigateFreeView);
  useEffect(() => { navigateRef.current = navigateFreeView; });

  // Arrow keys scrub free-play history. Skip when an input/textarea is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      navigateRef.current(e.key === 'ArrowRight');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear any stale selection when the viewed ply changes via arrow keys.
  useEffect(() => {
    setFreeSelected(null);
    setCashShopLetter(null);
    setHeroAbilityArmed(false);
    setSetupArmed(null);
  }, [freeViewPly]);

  // Poll queue stats so the home page shows how many people are searching per mode.
  useEffect(() => {
    if (!identity) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      try {
        const counts = await fetchQueueStats(ACTIVITY_WINDOWS, ctrl.signal);
        if (!stopped) setSearchingCounts(counts);
      } catch {
        // network blip — keep last known counts
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    };
    tick();

    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [identity]);

  // Quickplay: matchmaker queue
  useEffect(() => {
    if (mode !== 'searching') return;
    if (!identity || !selected) return;

    let cancelled = false;
    let handedOff = false;
    const matcher = new Matchmaker();
    let session: PeerSession | null = null;

    const myPeerId = makePeerId();
    setStatusMsg(`Looking for ${selected.label}…`);

    (async () => {
      const iceServers = await getIceServers();
      if (cancelled) return;
      session = new PeerSession(myPeerId, {
        onOpen: async () => {
          if (cancelled) return;
          const result = await matcher.start({
            identity,
            peerId: myPeerId,
            rating,
            timeControlId: selected.id,
          });
          if (cancelled) return;
          if (result.status !== 'matched') {
            setMode('idle');
            setStatusMsg('Search cancelled.');
            return;
          }
          handedOff = true;
          setLobbyHandoff({
            gameId: result.gameId,
            session: session!,
            myPeerId,
            partnerPeerId: result.partnerPeerId,
            partnerHandle: result.partnerHandle,
            partnerRating: result.partnerRating,
            iAmWhite: result.iAmWhite,
            timeControlId: selected.id,
          });
          navigate(`/play/${result.gameId}`);
        },
        onError: (err) => {
          console.error('peer error', err);
          if (cancelled) return;
          setStatusMsg(`Connection error: ${err.message}`);
          setMode('idle');
        },
      }, iceServers);
    })();

    return () => {
      cancelled = true;
      matcher.cancel();
      if (!handedOff) {
        try { session?.destroy(); } catch { }
      }
    };
  }, [mode, identity, selected, rating, navigate]);

  // Play a friend: host an open peer + shareable join link
  useEffect(() => {
    if (mode !== 'hosting') return;
    if (!identity || !selected) return;

    let cancelled = false;
    let handedOff = false;
    let joinerPeerId: string | null = null;
    let session: PeerSession | null = null;
    const myPeerId = makePeerId();

    setShareUrl('');
    setStatusMsg('Creating lobby…');

    (async () => {
      const iceServers = await getIceServers();
      if (cancelled) return;
      session = new PeerSession(myPeerId, {
        onOpen: (id) => {
          if (cancelled) return;
          setShareUrl(`${location.origin}${location.pathname}#/join/${id}`);
          setStatusMsg('Share the link with your opponent.');
        },
        onConnect: (conn) => {
          if (cancelled) return;
          joinerPeerId = conn.peer;
          setStatusMsg('Opponent connected, syncing…');
        },
        onMessage: (msg) => {
          if (cancelled) return;
          if (msg.type !== 'hello') return;
          if (!joinerPeerId) return;
          const gameId = randomGameId();
          const hostIsWhite = Math.random() < 0.5;
          session!.send({
            type: 'lobby-confirm',
            gameId,
            iAmWhite: !hostIsWhite,
            timeControlId: selected.id,
            hostHandle: identity.handle,
            hostRating: rating,
          });
          handedOff = true;
          setLobbyHandoff({
            gameId,
            session: session!,
            myPeerId,
            partnerPeerId: joinerPeerId,
            partnerHandle: msg.handle,
            partnerRating: msg.rating,
            iAmWhite: hostIsWhite,
            timeControlId: selected.id,
          });
          navigate(`/play/${gameId}`);
        },
        onError: (err) => {
          if (cancelled) return;
          setStatusMsg(`Connection error: ${err.message}`);
          setMode('idle');
        },
      }, iceServers);
    })();

    return () => {
      cancelled = true;
      if (!handedOff) {
        try { session?.destroy(); } catch { }
      }
    };
  }, [mode, identity, selected, rating, navigate]);

  const cancel = () => {
    setMode('idle');
    setStatusMsg('');
    setShareUrl('');
    setCopied(false);
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the input is still selectable manually
    }
  };

  if (!loaded) {
    return <div className="page-narrow muted">Loading…</div>;
  }

  if (!identity) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">Welcome</h1>
        <p className="muted">
          Pick a handle to play. No server account, no email, no password — your handle and rating
          stay local on this device.
        </p>
        <form
          className="signup-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (handleInput.trim()) signUp(handleInput.trim());
          }}
        >
          <input
            className="text-input"
            placeholder="your handle"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            maxLength={20}
          />
          <button className="primary-btn" type="submit" disabled={!handleInput.trim()}>
            Continue
          </button>
        </form>
      </div>
    );
  }

  const busy = mode !== 'idle';

  return (
    <div className="page">
      <div className="home-play-area">
        <div className="hero">
          <h1 className="page-title">Voice Chat Chess</h1>
          <p className="muted">
            Chess with voice chat, new variants, and more!
          </p>
        </div>
        <div className={`free-play-board${
          freeVariant === 'cash' || freeVariant === 'hero' || freeVariant === 'sweeper' ||
          (freeVariant === 'setup' && setupStage === 'place') ||
          (freeVariant === 'secret' && secretStage !== 'play')
            ? ' with-shop' : ''}`}>
          {freeVariant === 'sweeper' && (
            <div className="free-play-shop-col">
              <MineRail
                detonated={sweeperViewState.detonated.length}
                flagMode={sweeperFlagMode}
                onToggleFlagMode={() => {
                  setSweeperFlagMode((v) => !v);
                  sfx.playClick();
                }}
              />
            </div>
          )}
          {freeVariant === 'setup' && setupStage === 'place' && (
            <div className="free-play-shop-col">
              <div className="setup-tray">
                <div className="setup-tray-title">Deploy both armies</div>
                {(['w', 'b'] as const).map((color) => (
                  <div key={color}>
                    <div className="setup-tray-side-label">{color === 'w' ? 'White' : 'Black'}</div>
                    <div className="setup-tray-grid">
                      {SETUP_ARMY_ORDER.map((letter) => {
                        const left = setupRemaining[color][letter] ?? 0;
                        const armed = setupArmed?.color === color && setupArmed?.letter === letter;
                        return (
                          <button
                            key={color + letter}
                            type="button"
                            className={`setup-tray-piece${armed ? ' armed' : ''}${left <= 0 ? ' spent' : ''}`}
                            disabled={left <= 0}
                            draggable={left > 0}
                            onDragStart={(e) => onSetupTrayDragStart(e, color, letter)}
                            onClick={() => {
                              setFreeSelected(null);
                              setSetupArmed((cur) =>
                                cur && cur.color === color && cur.letter === letter
                                  ? null
                                  : { color, letter },
                              );
                              sfx.playSelect();
                            }}
                            aria-label={`${color === 'w' ? 'White' : 'Black'} ${letter}, ${left} left to place`}
                            data-no-sfx
                          >
                            <span className="setup-tray-sprite">{renderPiece((color + letter) as PieceKey, 26)}</span>
                            <span className="setup-tray-count">×{left}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <button type="button" className="primary-btn" onClick={startSetupPlay}>
                  {setupLeftTotal > 0 ? `Start (${setupLeftTotal} random)` : 'Start game'}
                </button>
                <div className="setup-tray-hint muted small">
                  Place both armies anywhere on their own halves — pawns not
                  on the back rank. Click or drag from the trays; right-click
                  a placed piece to return it. Leftovers are placed at random
                  when you start. An exposed king may simply be captured.
                </div>
              </div>
            </div>
          )}
          {freeVariant === 'secret' && secretStage !== 'play' && (
            <div className="free-play-shop-col">
              <div className="setup-tray">
                <div className="setup-tray-title">Pick the secret queens</div>
                <div className="secret-pick-line">
                  {secretStage === 'pickW'
                    ? 'Click one of White’s pawns.'
                    : 'Click one of Black’s pawns.'}
                </div>
                {secretPicks.w && (
                  <div className="secret-pick-line">
                    White’s pick: <span className="secret-pick-sq">{secretPicks.w}</span>
                  </div>
                )}
                <button type="button" className="primary-btn" onClick={randomSecretPick}>
                  Random
                </button>
                <div className="setup-tray-hint muted small">
                  One pawn per side secretly moves like a queen. Free play
                  shows both with the owner’s shadow marker — the disguise
                  still drops for good on the fake’s first move.
                </div>
              </div>
            </div>
          )}
          {freeVariant === 'cash' && (
            <div className="free-play-shop-col">
              <CashShop
                whiteGold={cashViewState.gold.w}
                blackGold={cashViewState.gold.b}
                // Free play: shop reflects whichever side is to move (alternates
                // each turn). Online play passes the local player's color.
                perspective={cashViewState.turn === 'w' ? 'white' : 'black'}
                canBuy={freeViewPly === cashResults.length}
                selectedLetter={cashShopLetter}
                affordable={cashAffordableSet}
                onSelect={(L) => {
                  setFreeSelected(null);
                  setCashShopLetter(L);
                  if (L) sfx.playBuy();
                }}
                compact
              />
            </div>
          )}
          {freeVariant === 'hero' && (
            <div className="free-play-shop-col">
              <div className="hero-side-pickers">
                <label className="hero-side-picker">
                  <span className="sandbox-king-label" aria-label="White">
                    {renderPiece('wK', 22)}
                  </span>
                  <CustomSelect<HeroKind>
                    value={heroW}
                    options={HERO_KINDS.map((h) => ({ value: h, label: HERO_INFO[h].name }))}
                    onChange={(next) => {
                      if (next !== heroW) {
                        if (next === 'frost') sfx.playFreeze();
                        else if (next === 'warlord') sfx.playSlice();
                        else if (next === 'necromancer') sfx.playSpawn();
                        else if (next === 'flight') sfx.playFly();
                        else if (next === 'mutation') sfx.playMutate();
                        else if (next === 'harem') sfx.playHarem();
                        else if (next === 'icbm') sfx.playMissileLaunch();
                        else if (next === 'goofball') sfx.playGoofball();
                        else if (next === 'twin-jutsu') sfx.playTwinJutsu();
                        else if (next === 'slime') sfx.playSlimeExpand();
                        else if (next === 'juggernaut') sfx.playJugQuake();
                        else if (next === 'kamakaze') sfx.playKamakazeArm();
                        else if (next === 'gojo') sfx.playHollowPurple();
                      }
                      setHeroW(next);
                    }}
                    data-no-sfx
                  />
                </label>
                <label className="hero-side-picker">
                  <span className="sandbox-king-label" aria-label="Black">
                    {renderPiece('bK', 22)}
                  </span>
                  <CustomSelect<HeroKind>
                    value={heroB}
                    options={HERO_KINDS.map((h) => ({ value: h, label: HERO_INFO[h].name }))}
                    onChange={(next) => {
                      if (next !== heroB) {
                        if (next === 'frost') sfx.playFreeze();
                        else if (next === 'warlord') sfx.playSlice();
                        else if (next === 'necromancer') sfx.playSpawn();
                        else if (next === 'flight') sfx.playFly();
                        else if (next === 'mutation') sfx.playMutate();
                        else if (next === 'harem') sfx.playHarem();
                        else if (next === 'icbm') sfx.playMissileLaunch();
                        else if (next === 'goofball') sfx.playGoofball();
                        else if (next === 'twin-jutsu') sfx.playTwinJutsu();
                        else if (next === 'slime') sfx.playSlimeExpand();
                        else if (next === 'juggernaut') sfx.playJugQuake();
                        else if (next === 'kamakaze') sfx.playKamakazeArm();
                        else if (next === 'gojo') sfx.playHollowPurple();
                      }
                      setHeroB(next);
                    }}
                    data-no-sfx
                  />
                </label>
              </div>
              <HeroAbilities
                perspective={heroViewState.turn === 'w' ? 'white' : 'black'}
                orientation={freeOrientation}
                myHero={heroViewState.heroes[heroViewState.turn].hero}
                oppHero={heroViewState.heroes[heroViewState.turn === 'w' ? 'b' : 'w'].hero}
                myCooldownTurns={heroTurnsUntilReady(heroViewState, heroViewState.turn)}
                oppCooldownTurns={heroTurnsUntilReady(heroViewState, heroViewState.turn === 'w' ? 'b' : 'w')}
                myTurn={heroAbilityReady(heroViewState, heroViewState.turn)}
                hasTargets={heroAbilityTargets(heroViewState).length > 0}
                armed={heroAbilityArmed}
                onArm={() => { setFreeSelected(null); setHeroAbilityArmed(true); sfx.playSelect(); }}
                onCancel={() => setHeroAbilityArmed(false)}
                onFinish={goofballLeg1 ? finishGoofball : undefined}
                finishLabel="End turn"
                hintOverride={goofballLeg1
                  ? 'Force a second opponent move — any piece, the same one included — or end your turn.'
                  : undefined}
                compact
                myJugTier={heroJugTierOf(heroViewState, heroViewState.turn)}
                oppJugTier={heroJugTierOf(heroViewState, heroViewState.turn === 'w' ? 'b' : 'w')}
              />
            </div>
          )}
          <div className="free-play-header">
            <div className="free-play-turn-group">
              <div className="free-play-turn" aria-label={`${freeTurn === 'w' ? 'White' : 'Black'} to move`}>
                <span className={`turn-swatch ${freeTurn === 'w' ? 'white' : 'black'}`} aria-hidden />
              </div>
              <CustomSelect<FreeVariant>
                value={freeVariant}
                aria-label="Free-play game mode"
                options={[
                  { value: 'normal', label: 'Normal' },
                  { value: 'merge',  label: 'Merge' },
                  { value: 'two',    label: 'Guerrilla' },
                  { value: 'cash',   label: 'Cash Money' },
                  { value: 'hero',   label: 'Hero' },
                  { value: 'sweeper', label: 'Chesssweeper' },
                  { value: 'setup',  label: 'Setup' },
                  { value: 'secret', label: 'Secret Queen' },
                ]}
                onChange={(next) => {
                  if (next !== freeVariant) {
                    if (next === 'merge') sfx.playMerge();
                    else if (next === 'two') sfx.playPush();
                    else if (next === 'cash') sfx.playPlace();
                    else if (next === 'hero') sfx.playSlice();
                    else if (next === 'sweeper') sfx.playExplosion();
                    else if (next === 'setup') sfx.playPlace();
                    else if (next === 'secret') sfx.playTwinJutsu();
                    else sfx.playMove();
                  }
                  setFreeVariant(next);
                }}
              />
            </div>
            <div className="free-play-header-actions">
              <button
                className="free-play-btn"
                onClick={undoFreePlay}
                type="button"
                disabled={!canUndoFree}
              >
                Undo
              </button>
              <button
                className="free-play-btn"
                onClick={() => navigateFreeView(true, false)}
                type="button"
                disabled={!canRedoFree}
              >
                Redo
              </button>
              <button className="free-play-btn" onClick={flipFreePlay} type="button">Flip</button>
              <button className="free-play-btn" onClick={resetFreePlay} type="button">Reset</button>
            </div>
          </div>
          <div className="free-play-board-wrap">
              {freeVariant === 'normal' ? (
                <MergeBoard
                  board={freeDisplayBoard}
                  orientation={freeOrientation}
                  selectedSquare={freeSelected}
                  legalTargets={normalLegalTargetsForBoard}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleFreeDrop}
                  onDragStartSquare={onFreeDragStart}
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  mergeAnim={mergeAnim}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'sweeper' ? (
                <MergeBoard
                  board={sweeperViewState.board as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={freeSelected}
                  legalTargets={sweeperLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleSweeperDrop}
                  onDragStartSquare={onFreeDragStart}
                  onRightClickSquare={sweeperFlagMode ? toggleSweeperFlag : undefined}
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  abilityAnim={sweeperAnim}
                  doomedPieces={sweeperDoomed as { sq: string; letter: MergePiece['letter'] }[]}
                  sweeperCounts={sweeperBoardCounts}
                  sweeperCraters={sweeperBoardCraters}
                  sweeperFlags={sweeperFlags}
                  sweeperZone
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'setup' ? (
                <MergeBoard
                  board={setupStage === 'place'
                    ? setupPlaceBoard
                    : ((setupViewState?.board ?? setupPlaceBoard) as (MergePiece | null)[])}
                  orientation={freeOrientation}
                  selectedSquare={freeSelected}
                  legalTargets={setupStage === 'place' ? setupPlaceTargets : setupLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleSetupDrop}
                  onDragStartSquare={onFreeDragStart}
                  onSpawn={setupStage === 'place' ? handleSetupSpawn : undefined}
                  onRightClickSquare={setupStage === 'place' ? removeSetupPiece : undefined}
                  lastMove={setupStage === 'play' ? freeLastMove : null}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'secret' ? (
                <MergeBoard
                  board={(secretStage === 'play'
                    ? (secretViewState?.board ?? secretPickBoard)
                    : secretPickBoard) as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={secretStage === 'play' ? freeSelected : null}
                  legalTargets={secretStage === 'play' ? secretLegalTargets : []}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleSecretDrop}
                  onDragStartSquare={onFreeDragStart}
                  lastMove={secretStage === 'play' ? freeLastMove : null}
                  // Pick phase: green circles on the candidates, grey on any
                  // already-confirmed pick (White's stays marked while Black
                  // chooses).
                  secretPickSquares={secretStage !== 'play' ? secretPickCandidates : undefined}
                  secretPickedSquares={secretStage !== 'play' ? secretPickedSqs : undefined}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  maskedSelfPawnSquares={secretSelfPawnSqs}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'merge' ? (
                <MergeBoard
                  board={mergeViewState.board as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={freeSelected}
                  legalTargets={mergeLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleMergeDrop}
                  onDragStartSquare={onFreeDragStart}
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  mergeAnim={mergeAnim}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'two' ? (
                <MergeBoard
                  board={twoViewState.board as unknown as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={freeSelected}
                  legalTargets={twoLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleTwoDrop}
                  onDragStartSquare={onFreeDragStart}
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  mergeAnim={mergeAnim}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : freeVariant === 'cash' ? (
                <MergeBoard
                  board={cashViewState.board as unknown as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={cashShopLetter ? null : freeSelected}
                  legalTargets={cashLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleCashDrop}
                  onDragStartSquare={onFreeDragStart}
                  ghostSpawn={
                    cashShopLetter
                      ? {
                          letter: cashViewState.turn === 'w'
                            ? cashShopLetter
                            : cashShopLetter.toLowerCase(),
                        }
                      : null
                  }
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  mergeAnim={mergeAnim}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                />
              ) : (
                <MergeBoard
                  board={heroViewState.board as unknown as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={heroAbilityArmed ? (goofballFrom ?? twinJutsuFrom ?? flightFrom ?? slimeFrom ?? null) : freeSelected}
                  legalTargets={heroLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleHeroDrop}
                  onDragStartSquare={onFreeDragStart}
                  kingGlows={{
                    w: heroViewState.heroes.w.hero === 'slime' ? undefined : HERO_INFO[heroViewState.heroes.w.hero].glowColor,
                    b: heroViewState.heroes.b.hero === 'slime' ? undefined : HERO_INFO[heroViewState.heroes.b.hero].glowColor,
                  }}
                  frozenSquares={
                    heroViewState.frozen
                      .filter((f) => heroViewState.ply < f.expiresAtPly)
                      .map((f) => heroIdxToSq(f.idx))
                  }
                  frozenCrackingSquares={
                    heroViewState.frozen
                      .filter((f) => f.expiresAtPly - heroViewState.ply === 1)
                      .map((f) => heroIdxToSq(f.idx))
                  }
                  missiles={heroViewState.missiles.map((m) => ({
                    sq: heroIdxToSq(m.idx),
                    pliesLeft: Math.max(0, m.landsAtPly - heroViewState.ply),
                    firedBy: m.firedBy,
                  }))}
                  doomedPieces={heroDoomedPieces.map((d) => ({
                    sq: d.sq as any,
                    letter: d.letter as any,
                  }))}
                  ghostCrosshair={
                    heroAbilityArmed &&
                    heroViewState.heroes[heroViewState.turn].hero === 'icbm'
                      ? { firedBy: heroViewState.turn }
                      : null
                  }
                  abilityAnim={heroAbilityAnim}
                  lastMove={freeLastMove}
                  slideMoves={slideAnim?.moves}
                  slideKey={slideAnim?.key}
                  popSquares={popAnim?.squares}
                  popKey={popAnim?.key}
                  mergeAnim={mergeAnim}
                  clearAnnotationsKey={freeAnnotationsClearKey}
                  // Twin-Jutsu masks: in local play the same screen hosts both
                  // sides, so we take the current turn as "self" — that side
                  // sees its own masked pieces with the translucent overlay
                  // while the other side's masked pieces render as kings.
                  maskedSelfSquares={(() => {
                    const out: string[] = [];
                    for (let i = 0; i < 64; i++) {
                      if (!heroViewState.masked[i]) continue;
                      const p = heroViewState.board[i];
                      if (p && p.color === heroViewState.turn) out.push(heroIdxToSq(i));
                    }
                    return out;
                  })()}
                  maskedAsKingSquares={(() => {
                    const out: string[] = [];
                    for (let i = 0; i < 64; i++) {
                      if (!heroViewState.masked[i]) continue;
                      const p = heroViewState.board[i];
                      if (p && p.color !== heroViewState.turn) out.push(heroIdxToSq(i));
                    }
                    return out;
                  })()}
                  slimeShiftArrows={heroSlimeShiftOpts.map((o) => ({ df: o.df, dr: o.dr, isCapture: o.isCapture }))}
                  slimeBigKings={heroViewState.slimes
                    .map((g) => {
                      const ref = heroViewState.board[g.tiles[0]];
                      return ref ? { tiles: g.tiles.map(heroIdxToSq), color: ref.color } : null;
                    })
                    .filter((g): g is { tiles: string[]; color: 'w' | 'b' } => g !== null)}
                  slimeKingSquares={(() => {
                    const out: string[] = [];
                    for (let i = 0; i < 64; i++) {
                      const p = heroViewState.board[i];
                      if (!p || p.letter.toUpperCase() !== 'K') continue;
                      if (heroViewState.heroes[p.color].hero === 'slime') out.push(heroIdxToSq(i));
                    }
                    return out;
                  })()}
                  juggernauts={(() => {
                    const out: { sq: string; tier: number }[] = [];
                    for (const c of ['w', 'b'] as const) {
                      if (heroViewState.heroes[c].hero !== 'juggernaut') continue;
                      const sq = heroKingSquareOf(heroViewState.board, c);
                      if (sq) out.push({ sq, tier: heroViewState.jugTier[c] });
                    }
                    return out;
                  })()}
                  stunnedSquares={heroViewState.stunned
                    .filter((s) => heroViewState.ply < s.expiresAtPly)
                    .map((s) => heroIdxToSq(s.idx))}
                  explosiveSquares={heroViewState.explosives
                    .filter((idx) => heroViewState.board[idx] != null)
                    .map((idx) => heroIdxToSq(idx))}
                  earthquakes={(heroViewState.earthquakes ?? []).map((eq) => ({
                    sq: heroIdxToSq(eq.idx),
                    df: eq.df,
                    dr: eq.dr,
                    color: eq.color,
                  }))}
                  hollowPurples={(heroViewState.hollowPurples ?? []).map((hp) => ({
                    sq: heroIdxToSq(hp.idx),
                    df: hp.df,
                    dr: hp.dr,
                    color: hp.color,
                    from: heroHollowPurpleOrigin(heroViewState, hp) ?? undefined,
                  }))}
                  hollowPurpleSlideKey={heroViewState.ply}
                />
              )}
              {freePromo && (
                <PromotionPicker
                  square={freePromo.to}
                  color={
                    freePromo.variant === 'normal' ? previewChess.turn() :
                    freePromo.variant === 'merge' ? mergeViewState.turn :
                    freePromo.variant === 'two' ? twoViewState.turn :
                    freePromo.variant === 'setup' ? (setupViewState?.turn ?? 'w') :
                    freePromo.variant === 'secret' ? (secretViewState?.turn ?? 'w') :
                    heroViewState.turn
                  }
                  orientation={freeOrientation}
                  options={
                    freePromo.variant === 'hero' &&
                    heroViewState.heroes[heroViewState.turn].hero === 'mutation'
                      ? ['Q', 'R', 'B', 'N', 'Z', 'C', 'A']
                      : ['Q', 'R', 'B', 'N']
                  }
                  onPick={resolveFreePromotion}
                  onCancel={() => setFreePromo(null)}
                />
              )}
              {freeEnd && (
                <div
                  className="board-finish-overlay"
                  key={`${freeVariant}-${freeViewPly}-${freeEnd.winner}`}
                >
                  <div className="victor">
                    {freeEnd.winner === 'w' ? 'White wins' : 'Black wins'}
                  </div>
                </div>
              )}
          </div>
        </div>

        <div className="home-controls">
          <TimeModeSelector
            selectedId={selected?.id ?? null}
            onSelect={(tc) => setSelected(tc)}
            disabled={busy}
            activityCounts={searchingCounts}
          />

          {!busy && (
            <div className="play-row">
              <button
                className="primary-btn big"
                data-no-sfx
                disabled={!selected}
                onClick={() => { sfx.playQueue(); setMode('searching'); }}
              >
                Quickplay {selected?.label}
              </button>
              <button
                className="secondary-btn big"
                data-no-sfx
                disabled={!selected}
                onClick={() => { sfx.playQueue(); setMode('hosting'); }}
              >
                Play a friend
              </button>
            </div>
          )}

          {mode === 'searching' && (
            <div className="play-row">
              <button className="secondary-btn big" onClick={cancel}>Cancel search</button>
              {statusMsg && <div className="status-msg">{statusMsg}</div>}
            </div>
          )}

          {mode === 'hosting' && (
            <div className="lobby-panel">
              {shareUrl ? (
                <>
                  <div className="lobby-label">Send this link to your friend:</div>
                  <div className="share-row">
                    <input
                      className="text-input"
                      readOnly
                      value={shareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button className="secondary-btn" onClick={copyShareUrl}>
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="muted">Spinning up lobby…</div>
              )}
              <div className="play-row">
                <button className="secondary-btn big" onClick={cancel}>Cancel lobby</button>
                {statusMsg && <div className="status-msg">{statusMsg}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function randomGameId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
