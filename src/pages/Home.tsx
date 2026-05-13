import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { MergeBoard } from '../components/MergeBoard';
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
  sqToIdx as cashSqToIdx,
  type GameState as CashState,
  type MoveResult as CashResult,
  type ShopLetter,
} from '../lib/cashChess';
import {
  initialState as heroInitial,
  applyMove as heroApply,
  legalMovesFrom as heroLegal,
  abilityTargets as heroAbilityTargets,
  abilityReady as heroAbilityReady,
  abilityUci as heroAbilityUci,
  turnsUntilReady as heroTurnsUntilReady,
  sqToIdx as heroSqToIdx,
  idxToSq as heroIdxToSq,
  HERO_INFO,
  HERO_KINDS,
  type GameState as HeroState,
  type MoveResult as HeroResult,
  type HeroKind,
} from '../lib/heroChess';
import { HeroAbilities } from '../components/HeroAbilities';
import type { Piece as MergePiece } from '../lib/mergeChess';
const ACTIVITY_WINDOWS: Record<string, number> = Object.fromEntries(
  TIME_CONTROLS.map((tc) => [tc.id, tc.activityWindowMs]),
);
import { useIdentityStore } from '../store/identityStore';
import { Matchmaker, fetchQueueStats } from '../lib/matchmaking';
import { PeerSession, makePeerId } from '../lib/peer';
import { setLobbyHandoff } from '../store/lobbyHandoff';
import * as sfx from '../lib/sfx';

type FreeVariant = 'normal' | 'merge' | 'two' | 'cash' | 'hero';

type Mode = 'idle' | 'searching' | 'hosting';

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
  const [freeSelected, setFreeSelected] = useState<string | null>(null);
  const [freeHighlights, setFreeHighlights] = useState<Set<string>>(new Set());
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

  // Hero state — picks default to Frost (W) / Knight (B); changing either
  // resets the engine. abilityArmed signals "next click is a target".
  const [heroW, setHeroW] = useState<HeroKind>('frost');
  const [heroB, setHeroB] = useState<HeroKind>('knight');
  const [heroStates, setHeroStates] = useState<HeroState[]>(() => [heroInitial('frost', 'knight')]);
  const [heroResults, setHeroResults] = useState<HeroResult[]>([]);
  const [heroAbilityArmed, setHeroAbilityArmed] = useState(false);

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
    setHeroStates([heroInitial(heroW, heroB)]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    setFreeViewPly(0);
    setFreeSelected(null);
    setFreeHighlights(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeVariant]);

  // Changing a hero pick re-inits the hero engine from scratch.
  useEffect(() => {
    if (freeVariant !== 'hero') return;
    setHeroStates([heroInitial(heroW, heroB)]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    setFreeViewPly(0);
    setFreeSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroW, heroB]);

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

  const freeDisplayFen = previewChess.fen();
  const mergeViewState: MergeState = mergeStates[freeViewPly] ?? mergeStates[0];
  const twoViewState: TwoState = twoStates[freeViewPly] ?? twoStates[0];
  const cashViewState: CashState = cashStates[freeViewPly] ?? cashStates[0];
  const heroViewState: HeroState = heroStates[freeViewPly] ?? heroStates[0];
  const totalFreePly =
    freeVariant === 'normal' ? freeChess.history().length :
    freeVariant === 'merge' ? mergeResults.length :
    freeVariant === 'two' ? twoResults.length :
    freeVariant === 'cash' ? cashResults.length :
    heroResults.length;
  const freeTurn: 'w' | 'b' =
    freeVariant === 'normal' ? previewChess.turn() :
    freeVariant === 'merge' ? mergeViewState.turn :
    freeVariant === 'two' ? twoViewState.turn :
    freeVariant === 'cash' ? cashViewState.turn :
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
    const r = cashResults[freeViewPly - 1];
    if (!r?.checkmate) return null;
    return { winner: cashViewState.turn === 'w' ? 'b' : 'w' };
  }, [freeVariant, previewChess, freeViewPly, mergeResults, mergeViewState.turn, twoResults, twoViewState.turn, cashResults, cashViewState.turn]);

  const freeLegalTargets = useMemo<string[]>(() => {
    if (!freeSelected) return [];
    try {
      const moves = previewChess.moves({ square: freeSelected as any, verbose: true }) as Array<{ to: string }>;
      return moves.map((m) => m.to);
    } catch {
      return [];
    }
  }, [freeSelected, previewChess]);

  const freeSquareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    const styles: Record<string, React.CSSProperties> = {};
    // Right-click highlights underlay everything else.
    for (const sq of freeHighlights) {
      styles[sq] = { backgroundColor: 'rgba(255,170,0,0.45)' };
    }
    if (freeSelected) {
      styles[freeSelected] = {
        background:
          'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
      };
      for (const t of freeLegalTargets) {
        const isCapture = !!previewChess.get(t as any);
        styles[t] = isCapture
          ? {
            background:
              'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
          }
          : {
            background:
              'radial-gradient(circle, rgba(0,0,0,0.35) 22%, transparent 24%)',
          };
      }
    }
    return styles;
  }, [freeSelected, freeLegalTargets, previewChess, freeHighlights]);

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
    if (freeViewPly !== heroResults.length) return new Set();
    return new Set(heroAbilityTargets(heroViewState).map((idx) => heroIdxToSq(idx)));
  }, [freeVariant, heroAbilityArmed, heroViewState, freeViewPly, heroResults.length]);

  const heroLegalTargets = useMemo(() => {
    if (freeVariant !== 'hero') return [];
    if (heroAbilityArmed) {
      return Array.from(heroAbilityTargetSet).map((to) => ({
        to, isCapture: false, isMerge: true,
      }));
    }
    if (!freeSelected) return [];
    return heroLegal(heroViewState, freeSelected).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [freeVariant, freeSelected, heroViewState, heroAbilityArmed, heroAbilityTargetSet]);

  const applyFreeMove = (from: string, to: string, promotion?: string): boolean => {
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
    return true;
  };

  const applyMergeMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N'): boolean => {
    // Branch in past: drop everything after viewPly, then apply on the snapshot we're viewing.
    const truncStates = mergeStates.slice(0, freeViewPly + 1);
    const truncResults = mergeResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
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
    return true;
  };

  const applyTwoMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N'): boolean => {
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
    return true;
  };

  const commitCashMove = (uci: string): boolean => {
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
    return true;
  };

  const applyCashMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N'): boolean => {
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    return commitCashMove(uci);
  };

  const applyCashBuy = (letter: ShopLetter, to: string): boolean => {
    return commitCashMove(cashBuyUci(letter, to));
  };

  const commitHeroMove = (uci: string): boolean => {
    const truncStates = heroStates.slice(0, freeViewPly + 1);
    const truncResults = heroResults.slice(0, freeViewPly);
    const base = truncStates[truncStates.length - 1];
    const res = heroApply(base, uci);
    if (!res) return false;
    if (res.result.abilityUsed === 'frost') sfx.playFreeze();
    else if (res.result.abilityUsed === 'knight') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.checkmate) sfx.playWin();
    else if (res.result.check) sfx.playCheck();
    setHeroStates([...truncStates, res.state]);
    setHeroResults([...truncResults, res.result]);
    setFreeViewPly(truncStates.length);
    setFreeSelected(null);
    setHeroAbilityArmed(false);
    return true;
  };

  const applyHeroMove = (from: string, to: string, promotion?: 'Q' | 'R' | 'B' | 'N'): boolean => {
    const uci = from + to + (promotion ? promotion.toLowerCase() : '');
    return commitHeroMove(uci);
  };

  const applyHeroAbility = (to: string): boolean => {
    const hero = heroViewState.heroes[heroViewState.turn].hero;
    return commitHeroMove(heroAbilityUci(hero, to));
  };

  // Pawn promotions in free play default to queen — no prompt mid-board to
  // keep the practice flow snappy. (chess.js handles 'q' via its own arg.)
  // Cash has no promotion: pawns reaching the back rank cash in for gold.
  // Hero auto-promotes pawns to queen.
  const promotionFor = (
    variant: 'merge' | 'two' | 'cash' | 'hero',
    from: string,
    to: string,
  ): 'Q' | undefined => {
    if (variant === 'cash') return undefined;
    const rank = parseInt(to[1], 10);
    if (rank !== 1 && rank !== 8) return undefined;
    const idx =
      variant === 'merge' ? mergeSqToIdx(from) :
      variant === 'two' ? twoSqToIdx(from) :
      heroSqToIdx(from);
    const piece =
      variant === 'merge' ? mergeViewState.board[idx] :
      variant === 'two' ? twoViewState.board[idx] :
      heroViewState.board[idx];
    if (!piece) return undefined;
    return piece.letter.toUpperCase() === 'P' ? 'Q' : undefined;
  };

  const handleFreeDrop = (sourceSquare: string, targetSquare: string, piece: string): boolean => {
    const promotion = piece && piece.length === 2 ? piece[1].toLowerCase() : undefined;
    return applyFreeMove(sourceSquare, targetSquare, promotion);
  };

  const handleMergeDrop = (from: string, to: string): boolean => {
    return applyMergeMove(from, to, promotionFor('merge', from, to));
  };
  const handleTwoDrop = (from: string, to: string): boolean => {
    return applyTwoMove(from, to, promotionFor('two', from, to));
  };
  const handleCashDrop = (from: string, to: string): boolean => {
    return applyCashMove(from, to, promotionFor('cash', from, to));
  };
  const handleHeroDrop = (from: string, to: string): boolean => {
    return applyHeroMove(from, to, promotionFor('hero', from, to));
  };

  const onFreeSquareClick = (square: string) => {
    if (freeHighlights.size > 0) setFreeHighlights(new Set());
    if (freeSelected === square) {
      setFreeSelected(null);
      return;
    }
    if (freeVariant === 'normal') {
      const piece = previewChess.get(square as any);
      if (freeSelected && freeLegalTargets.includes(square)) {
        applyFreeMove(freeSelected, square);
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
        applyMergeMove(freeSelected, square, promotionFor('merge', freeSelected, square));
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
        applyTwoMove(freeSelected, square, promotionFor('two', freeSelected, square));
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
        applyCashMove(freeSelected, square, promotionFor('cash', freeSelected, square));
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
      if (heroAbilityTargetSet.has(square)) {
        applyHeroAbility(square);
        return;
      }
      setHeroAbilityArmed(false);
      return;
    }
    if (freeSelected && heroLegalTargets.some((t) => t.to === square)) {
      applyHeroMove(freeSelected, square, promotionFor('hero', freeSelected, square));
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
    if (freeVariant === 'hero') {
      if (heroAbilityArmed) setHeroAbilityArmed(false);
      const piece = heroViewState.board[heroSqToIdx(from)];
      if (!piece || piece.color !== heroViewState.turn) return;
      if (freeSelected !== from) setFreeSelected(from);
    }
  };

  const onFreeSquareRightClick = (square: string) => {
    setFreeHighlights((prev) => {
      const next = new Set(prev);
      if (next.has(square)) next.delete(square);
      else next.add(square);
      return next;
    });
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
    setHeroStates([heroInitial(heroW, heroB)]);
    setHeroResults([]);
    setHeroAbilityArmed(false);
    setFreeViewPly(0);
    setFreeSelected(null);
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
        } else {
          const r = heroResults[forward ? p : next];
          if (r) {
            if (forward) {
              if (r.abilityUsed === 'frost') sfx.playFreeze();
              else if (r.abilityUsed === 'knight') sfx.playSlice();
              else if (r.abilityUsed === 'necromancer') sfx.playSpawn();
              else if (r.abilityUsed === 'flight') sfx.playFly();
              else if (r.captured) sfx.playCapture();
              else sfx.playMove();
              if (r.check && !r.checkmate) sfx.playCheck();
            } else {
              if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
              if (r.check) sfx.playCheckReversed();
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
          partnerPubKey: result.partnerPubKey,
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
    });

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
    const myPeerId = makePeerId();

    setShareUrl('');
    setStatusMsg('Creating lobby…');

    const session: PeerSession = new PeerSession(myPeerId, {
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
        session.send({
          type: 'lobby-confirm',
          gameId,
          iAmWhite: !hostIsWhite,
          timeControlId: selected.id,
          hostPubKey: identity.publicKeyHex,
          hostHandle: identity.handle,
          hostRating: rating,
        });
        handedOff = true;
        setLobbyHandoff({
          gameId,
          session,
          myPeerId,
          partnerPeerId: joinerPeerId,
          partnerPubKey: msg.publicKeyHex,
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
    });

    return () => {
      cancelled = true;
      if (!handedOff) {
        try { session.destroy(); } catch { }
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
          Pick a handle. We'll generate a keypair in your browser — your identity stays local. No
          server account, no email, no password.
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
            Create identity
          </button>
        </form>
      </div>
    );
  }

  const busy = mode !== 'idle';

  return (
    <div className="page">
      <div className="hero">
        <h1 className="page-title">Voice Chat Chess</h1>
        <p className="muted">
          Chess with voice chat, new variants, and more!
        </p>
      </div>

      <div className="home-play-area">
        <div className={`free-play-board${freeVariant === 'cash' || freeVariant === 'hero' ? ' with-shop' : ''}`}>
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
                  <span className="muted small">White</span>
                  <select
                    value={heroW}
                    onChange={(e) => {
                      const next = e.target.value as HeroKind;
                      if (next !== heroW) {
                        if (next === 'frost') sfx.playFreeze();
                        else if (next === 'knight') sfx.playSlice();
                        else if (next === 'necromancer') sfx.playSpawn();
                        else if (next === 'flight') sfx.playFly();
                      }
                      setHeroW(next);
                    }}
                    className="free-play-select"
                    data-no-sfx
                  >
                    {HERO_KINDS.map((h) => (
                      <option key={h} value={h}>{HERO_INFO[h].name}</option>
                    ))}
                  </select>
                </label>
                <label className="hero-side-picker">
                  <span className="muted small">Black</span>
                  <select
                    value={heroB}
                    onChange={(e) => {
                      const next = e.target.value as HeroKind;
                      if (next !== heroB) {
                        if (next === 'frost') sfx.playFreeze();
                        else if (next === 'knight') sfx.playSlice();
                        else if (next === 'necromancer') sfx.playSpawn();
                        else if (next === 'flight') sfx.playFly();
                      }
                      setHeroB(next);
                    }}
                    className="free-play-select"
                    data-no-sfx
                  >
                    {HERO_KINDS.map((h) => (
                      <option key={h} value={h}>{HERO_INFO[h].name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <HeroAbilities
                perspective={heroViewState.turn === 'w' ? 'white' : 'black'}
                myHero={heroViewState.heroes[heroViewState.turn].hero}
                oppHero={heroViewState.heroes[heroViewState.turn === 'w' ? 'b' : 'w'].hero}
                myCooldownTurns={heroTurnsUntilReady(heroViewState, heroViewState.turn)}
                oppCooldownTurns={heroTurnsUntilReady(heroViewState, heroViewState.turn === 'w' ? 'b' : 'w')}
                myTurn={freeViewPly === heroResults.length && heroAbilityReady(heroViewState, heroViewState.turn)}
                armed={heroAbilityArmed}
                onArm={() => { setFreeSelected(null); setHeroAbilityArmed(true); sfx.playSelect(); }}
                onCancel={() => setHeroAbilityArmed(false)}
                compact
              />
            </div>
          )}
          <div className="free-play-header">
            <div className="free-play-turn-group">
              <div className="free-play-turn" aria-label={`${freeTurn === 'w' ? 'White' : 'Black'} to move`}>
                <span className={`turn-swatch ${freeTurn === 'w' ? 'white' : 'black'}`} aria-hidden />
              </div>
              <select
                className="free-play-select"
                value={freeVariant}
                onChange={(e) => {
                  const next = e.target.value as FreeVariant;
                  if (next !== freeVariant) {
                    if (next === 'merge') sfx.playMerge();
                    else if (next === 'two') sfx.playPush();
                    else if (next === 'cash') sfx.playPlace();
                    else if (next === 'hero') sfx.playFly();
                    else sfx.playMove();
                  }
                  setFreeVariant(next);
                }}
                aria-label="Free-play game mode"
              >
                <option value="normal">Normal</option>
                <option value="merge">Merge</option>
                <option value="two">Guerrilla</option>
                <option value="cash">Cash Money</option>
                <option value="hero">Hero</option>
              </select>
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
                <Chessboard
                  position={freeDisplayFen}
                  onPieceDrop={handleFreeDrop}
                  onSquareClick={onFreeSquareClick}
                  onSquareRightClick={onFreeSquareRightClick}
                  boardOrientation={freeOrientation}
                  customBoardStyle={{ borderRadius: 8 }}
                  customDarkSquareStyle={{ backgroundColor: '#5d6c89' }}
                  customLightSquareStyle={{ backgroundColor: '#dfe5f0' }}
                  customSquareStyles={freeSquareStyles}
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
                />
              ) : (
                <MergeBoard
                  board={heroViewState.board as unknown as (MergePiece | null)[]}
                  orientation={freeOrientation}
                  selectedSquare={heroAbilityArmed ? null : freeSelected}
                  legalTargets={heroLegalTargets}
                  onSquareClick={onFreeSquareClick}
                  onPieceDrop={handleHeroDrop}
                  onDragStartSquare={onFreeDragStart}
                  kingGlows={{
                    w: HERO_INFO[heroViewState.heroes.w.hero].glowColor,
                    b: HERO_INFO[heroViewState.heroes.b.hero].glowColor,
                  }}
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
