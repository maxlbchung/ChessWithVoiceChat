import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { Chess } from 'chess.js';
import { MergeBoard } from '../components/MergeBoard';
import { CustomSelect } from '../components/CustomSelect';
import { PromotionPicker, type PromotionLetter } from '../components/PromotionPicker';
import {
  initialState as mergeInitial,
  legalMovesFrom as mergeLegalFrom,
  isInCheck as mergeIsInCheck,
  isCheckmate as mergeIsCheckmate,
  sqToIdx as mergeSqToIdx,
  isMergeable,
  pieceAbilities,
  mergeAbilities,
  type Piece as MergePiece,
  type PieceLetter,
} from '../lib/mergeChess';
import {
  initialState as twoInitial,
  legalMovesFrom as twoLegalFrom,
  isInCheck as twoIsInCheck,
  isCheckmate as twoIsCheckmate,
} from '../lib/chess2';
import {
  initialState as cashInitial,
  legalMovesFrom as cashLegalFrom,
  isInCheck as cashIsInCheck,
  isCheckmate as cashIsCheckmate,
} from '../lib/cashChess';
import {
  initialState as heroInitial,
  legalMovesFrom as heroLegalFrom,
  abilityTargets as heroAbilityTargets,
  goofballLegalDestinations,
  twinJitsuLegalDestinations,
  isInCheck as heroIsInCheck,
  isCheckmate as heroIsCheckmate,
  HERO_INFO,
  HERO_KINDS,
  kingSquareOf,
  idxToSq as heroIdxToSq,
  type HeroKind,
} from '../lib/heroChess';
import type { AbilityAnim } from '../components/MergeBoard';
import { renderPiece, lettersToPieceKeys } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';
import { useSettingsStore } from '../store/settingsStore';

type SandboxVariant = 'normal' | 'merge' | 'two' | 'cash' | 'hero';

type SandboxState = {
  board: (MergePiece | null)[];
  heroW: HeroKind;
  heroB: HeroKind;
  // Currently-frozen squares (Hero / Frost ability). Multiple freezes can
  // coexist — matching the live engine's `frozen[]` shape — so the user
  // can layer freezes the way they would in free play. Purely visual in
  // sandbox; the user can still drag a frozen piece wherever they like.
  frozenIdxs: number[];
  // En-passant target square — the empty square a just-double-pushed pawn
  // passed through. Set only on the ply right after a double push, and
  // cleared on every other state mutation. Without this, the engines'
  // `legalMovesFrom` see `enPassant: null` and never offer en-passant.
  enPassant: string | null;
  // Twin-Jitsu mask flags per square. True iff the piece on that square is
  // hidden from the opponent (rendered as a king icon). Sandbox treats this
  // purely visually: moves / placements clear the flag on the touched squares,
  // and the swap ability re-masks both endpoints.
  masked: boolean[];
};

// Piece sets per variant, in the order they appear in the palette (top→bottom).
const PALETTE_LETTERS: Record<SandboxVariant, string[]> = {
  normal: ['K', 'Q', 'R', 'B', 'N', 'P'],
  two: ['K', 'Q', 'R', 'B', 'N', 'P'],
  cash: ['K', 'Q', 'R', 'B', 'N', 'P'],
  hero: ['K', 'Q', 'R', 'B', 'N', 'P'],
  // Merge exposes the three combo pieces too — chancellor (R+N),
  // archbishop (B+N), amazon (Q+N).
  merge: ['K', 'Q', 'C', 'A', 'Z', 'R', 'B', 'N', 'P'],
};

const SHOP_LETTERS_SANDBOX: string[] = ['Q', 'R', 'B', 'N'];

// Initial board for each variant, returned as a flat 64-square Piece[] array
// in the layout MergeBoard expects (idx 0 = a8 ... 63 = h1).
function initialBoard(variant: SandboxVariant, heroW: HeroKind, heroB: HeroKind): (MergePiece | null)[] {
  if (variant === 'normal') {
    const c = new Chess();
    const out: (MergePiece | null)[] = [];
    for (const row of c.board()) {
      for (const cell of row) {
        if (cell == null) { out.push(null); continue; }
        const letter = cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
        out.push({ color: cell.color, letter: letter as PieceLetter });
      }
    }
    return out;
  }
  if (variant === 'merge') return mergeInitial().board.slice() as (MergePiece | null)[];
  if (variant === 'two') return twoInitial().board.slice() as unknown as (MergePiece | null)[];
  if (variant === 'cash') return cashInitial().board.slice() as unknown as (MergePiece | null)[];
  return heroInitial(heroW, heroB).board.slice() as unknown as (MergePiece | null)[];
}

function emptyBoard(): (MergePiece | null)[] {
  return new Array(64).fill(null);
}

// Frozen-list bookkeeping. A move relocates its `from` square's freeze (if
// any) to the `to` square; a freeze on the destination is consumed (the
// piece sitting there was just captured or replaced).
function frozenAfterMove(frozenIdxs: number[], fromIdx: number, toIdx: number): number[] {
  return frozenIdxs
    .filter((idx) => idx !== toIdx)
    .map((idx) => (idx === fromIdx ? toIdx : idx));
}
// Drop a freeze from a square (piece deleted, demolished by ICBM, etc.).
function frozenAfterClear(frozenIdxs: number[], idx: number): number[] {
  return frozenIdxs.filter((f) => f !== idx);
}

function freshState(variant: SandboxVariant, heroW: HeroKind, heroB: HeroKind): SandboxState {
  const board = initialBoard(variant, heroW, heroB);
  const masked = new Array(64).fill(false);
  if (variant === 'hero') {
    if (heroW === 'twin-jitsu') {
      for (let i = 0; i < 64; i++) if (board[i]?.color === 'w') masked[i] = true;
    }
    if (heroB === 'twin-jitsu') {
      for (let i = 0; i < 64; i++) if (board[i]?.color === 'b') masked[i] = true;
    }
  }
  return {
    board,
    heroW,
    heroB,
    frozenIdxs: [],
    enPassant: null,
    masked,
  };
}

// Letter casing → color. 'K' = white king, 'k' = black king.
function colorOf(letter: string): 'w' | 'b' {
  return letter === letter.toUpperCase() ? 'w' : 'b';
}

function hasKing(board: (MergePiece | null)[], color: 'w' | 'b'): boolean {
  for (const p of board) if (p && p.color === color && p.letter.toUpperCase() === 'K') return true;
  return false;
}

// Is `color`'s king currently attacked in this variant? Defers to each
// engine's `isInCheck` against a synthesized state. Safe when the side has
// no king (returns false) so sandbox positions with one or zero kings don't
// crash.
function inCheck(
  variant: SandboxVariant,
  board: (MergePiece | null)[],
  color: 'w' | 'b',
  heroW: HeroKind,
  heroB: HeroKind,
): boolean {
  if (!hasKing(board, color)) return false;
  try {
    if (variant === 'two') {
      const state = { ...twoInitial(), board: board as any, turn: color };
      return twoIsInCheck(state as any, color);
    }
    if (variant === 'cash') {
      const state = { ...cashInitial(), board: board as any, turn: color };
      return cashIsInCheck(state as any, color);
    }
    if (variant === 'hero') {
      const state = { ...heroInitial(heroW, heroB), board: board as any, turn: color };
      return heroIsInCheck(state as any, color);
    }
    const state = { ...mergeInitial(), board, turn: color };
    return mergeIsInCheck(state, color);
  } catch {
    return false;
  }
}

// Is `color` (the side-to-move in the synthesized state) checkmated? Engines
// derive this by asking "in check AND zero legal moves resolve it".
function inMate(
  variant: SandboxVariant,
  board: (MergePiece | null)[],
  color: 'w' | 'b',
  heroW: HeroKind,
  heroB: HeroKind,
): boolean {
  if (!hasKing(board, color)) return false;
  try {
    if (variant === 'two') {
      const state = { ...twoInitial(), board: board as any, turn: color };
      return twoIsCheckmate(state as any);
    }
    if (variant === 'cash') {
      const state = { ...cashInitial(), board: board as any, turn: color };
      return cashIsCheckmate(state as any);
    }
    if (variant === 'hero') {
      const state = { ...heroInitial(heroW, heroB), board: board as any, turn: color };
      return heroIsCheckmate(state as any);
    }
    const state = { ...mergeInitial(), board, turn: color };
    return mergeIsCheckmate(state);
  } catch {
    return false;
  }
}

// Engine-driven legal targets. Each variant's `legalMovesFrom` filters out
// moves that would leave the mover's king in check. For Normal we delegate
// to the merge engine and drop merge targets — it's a superset of standard
// chess that doesn't strictly validate the position the way chess.js does,
// so it works on the unusual setups people build in sandbox.
function engineLegalTargets(
  variant: SandboxVariant,
  board: (MergePiece | null)[],
  sq: string,
  heroW: HeroKind,
  heroB: HeroKind,
  enPassant: string | null,
): { to: string; isCapture: boolean; isMerge: boolean }[] {
  const idx = mergeSqToIdx(sq);
  const piece = board[idx];
  if (!piece) return [];
  const color = piece.color;
  try {
    if (variant === 'two') {
      // Guerrilla has no double pawn, so no en-passant to thread through.
      const state = { ...twoInitial(), board: board as any, turn: color };
      return twoLegalFrom(state as any, sq).map((m) => ({ to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial }));
    }
    if (variant === 'cash') {
      const state = { ...cashInitial(), board: board as any, turn: color, enPassant };
      return cashLegalFrom(state as any, sq).map((m) => ({ to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial }));
    }
    if (variant === 'hero') {
      const state = { ...heroInitial(heroW, heroB), board: board as any, turn: color, enPassant };
      return heroLegalFrom(state as any, sq).map((m) => ({ to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial }));
    }
    // normal / merge
    const state = { ...mergeInitial(), board, turn: color, enPassant };
    const moves = mergeLegalFrom(state, sq).map((m) => ({ to: m.to, isCapture: m.isCapture, isMerge: m.isMerge }));
    return variant === 'merge' ? moves : moves.filter((m) => !m.isMerge);
  } catch {
    return [];
  }
}

// Pattern-based legal-move targets for the piece at `sq`. Pure movement
// patterns per variant — no check filtering, no king requirement. Used as a
// fallback when there's no king to check against.
function patternTargets(
  variant: SandboxVariant,
  board: (MergePiece | null)[],
  sq: string,
): { to: string; isCapture: boolean; isMerge: boolean }[] {
  const fromIdx = mergeSqToIdx(sq);
  const piece = board[fromIdx];
  if (!piece) return [];
  const color = piece.color;
  const up = piece.letter.toUpperCase();
  const fileOf = (i: number) => i % 8;
  const rankOf = (i: number) => 7 - Math.floor(i / 8);
  const idxOf = (f: number, r: number) => (7 - r) * 8 + f;
  const inBounds = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const moverMergeable = variant === 'merge' && isMergeable(piece);
  const f0 = fileOf(fromIdx);
  const r0 = rankOf(fromIdx);
  const out: { to: string; isCapture: boolean; isMerge: boolean }[] = [];

  // Push a target. `mode` controls how an occupied square is handled.
  // Returns whether a slide along this direction should stop here.
  type Mode = 'free' | 'forwardOnly' | 'captureOnly';
  const push = (toIdx: number, mode: Mode): boolean => {
    const dest = board[toIdx];
    const toSq = heroIdxToSq(toIdx);
    if (!dest) {
      if (mode !== 'captureOnly') out.push({ to: toSq, isCapture: false, isMerge: false });
      return false;
    }
    if (dest.color !== color) {
      if (mode !== 'forwardOnly') out.push({ to: toSq, isCapture: true, isMerge: false });
      return true;
    }
    // Same-color destination → only show as a merge target in Merge mode,
    // and only when both pieces are mergeable.
    if (moverMergeable && isMergeable(dest)) {
      out.push({ to: toSq, isCapture: false, isMerge: true });
    }
    return true;
  };

  const slide = (df: number, dr: number, maxSteps = 7) => {
    for (let s = 1; s <= maxSteps; s++) {
      const f = f0 + df * s;
      const r = r0 + dr * s;
      if (!inBounds(f, r)) break;
      const stop = push(idxOf(f, r), 'free');
      if (stop) break;
    }
  };

  const step = (df: number, dr: number) => {
    const f = f0 + df, r = r0 + dr;
    if (inBounds(f, r)) push(idxOf(f, r), 'free');
  };

  const KNIGHT: [number, number][] = [
    [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
  ];
  const EIGHT: [number, number][] = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const ROOK: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  if (up === 'P') {
    const dir = color === 'w' ? 1 : -1;
    const startRank = color === 'w' ? 1 : 6;
    const oneR = r0 + dir;
    if (inBounds(f0, oneR) && !board[idxOf(f0, oneR)]) {
      out.push({ to: heroIdxToSq(idxOf(f0, oneR)), isCapture: false, isMerge: false });
      const twoR = r0 + 2 * dir;
      if (r0 === startRank && inBounds(f0, twoR) && !board[idxOf(f0, twoR)]) {
        out.push({ to: heroIdxToSq(idxOf(f0, twoR)), isCapture: false, isMerge: false });
      }
    }
    for (const df of [-1, 1]) {
      const f = f0 + df, r = r0 + dir;
      if (!inBounds(f, r)) continue;
      push(idxOf(f, r), 'captureOnly');
    }
  } else if (up === 'K') {
    for (const [df, dr] of EIGHT) step(df, dr);
  } else if (up === 'N') {
    if (variant === 'two') {
      // Guerrilla knight: hop over any adjacent piece to the square two
      // steps further in the same direction.
      for (const [df, dr] of EIGHT) {
        const adjF = f0 + df, adjR = r0 + dr;
        if (!inBounds(adjF, adjR)) continue;
        if (!board[idxOf(adjF, adjR)]) continue;
        const landF = f0 + 2 * df, landR = r0 + 2 * dr;
        if (!inBounds(landF, landR)) continue;
        push(idxOf(landF, landR), 'free');
      }
    } else {
      for (const [df, dr] of KNIGHT) step(df, dr);
    }
  } else if (up === 'B') {
    // Guerrilla bishop: max 2 squares per diagonal. Otherwise unlimited.
    const maxSteps = variant === 'two' ? 2 : 7;
    for (const [df, dr] of BISHOP) slide(df, dr, maxSteps);
  } else if (up === 'R') {
    if (variant === 'two') {
      // Guerrilla rook: one-square orthogonal. Adjacent friendly pieces are
      // pushable when the chain ends at an empty square inside the board.
      for (const [df, dr] of ROOK) {
        const f = f0 + df, r = r0 + dr;
        if (!inBounds(f, r)) continue;
        const toIdx = idxOf(f, r);
        const dest = board[toIdx];
        if (!dest) {
          out.push({ to: heroIdxToSq(toIdx), isCapture: false, isMerge: false });
        } else if (dest.color !== color) {
          out.push({ to: heroIdxToSq(toIdx), isCapture: true, isMerge: false });
        } else {
          let cf = f, cr = r;
          while (inBounds(cf, cr) && board[idxOf(cf, cr)]) { cf += df; cr += dr; }
          if (inBounds(cf, cr)) {
            out.push({ to: heroIdxToSq(toIdx), isCapture: false, isMerge: true });
          }
        }
      }
    } else {
      for (const [df, dr] of ROOK) slide(df, dr);
    }
  } else if (up === 'Q') {
    if (variant === 'two') {
      // Guerrilla queen: one square in any direction, king-like.
      for (const [df, dr] of EIGHT) step(df, dr);
    } else {
      for (const [df, dr] of ROOK) slide(df, dr);
      for (const [df, dr] of BISHOP) slide(df, dr);
    }
  } else if (up === 'C') {
    // Merge chancellor: rook + knight.
    for (const [df, dr] of ROOK) slide(df, dr);
    for (const [df, dr] of KNIGHT) step(df, dr);
  } else if (up === 'A') {
    // Merge archbishop: bishop + knight.
    for (const [df, dr] of BISHOP) slide(df, dr);
    for (const [df, dr] of KNIGHT) step(df, dr);
  } else if (up === 'Z') {
    // Merge amazon: queen + knight.
    for (const [df, dr] of ROOK) slide(df, dr);
    for (const [df, dr] of BISHOP) slide(df, dr);
    for (const [df, dr] of KNIGHT) step(df, dr);
  }

  // Dedupe in case two patterns landed on the same square (e.g. amazon
  // queen + knight rarely overlap, but be safe).
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(t.to) ? false : (seen.add(t.to), true)));
}

// Combine two same-color, mergeable pieces into one. Returns null if either
// piece can't merge (pawn/king) or one has no recognised abilities.
function tryMerge(mover: MergePiece, target: MergePiece): MergePiece | null {
  if (mover.color !== target.color) return null;
  if (!isMergeable(mover) || !isMergeable(target)) return null;
  const a = pieceAbilities(mover);
  const b = pieceAbilities(target);
  if (!a || !b) return null;
  const combined = mergeAbilities(a, b);
  let letter: 'R' | 'B' | 'N' | 'Q' | 'C' | 'A' | 'Z';
  if (combined.R && combined.B && combined.N) letter = 'Z';
  else if (combined.R && combined.B) letter = 'Q';
  else if (combined.R && combined.N) letter = 'C';
  else if (combined.B && combined.N) letter = 'A';
  else if (combined.R) letter = 'R';
  else if (combined.B) letter = 'B';
  else if (combined.N) letter = 'N';
  else return null;
  const cased = mover.color === 'w' ? letter : (letter.toLowerCase() as PieceLetter);
  return { color: mover.color, letter: cased as PieceLetter };
}

export function Sandbox() {
  const [variant, setVariant] = useState<SandboxVariant>('normal');
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');

  // Hero kinds live outside the state stack so swapping a hero kind isn't an
  // undoable action (matches free-play hero behavior — instant re-init).
  const [heroW, setHeroW] = useState<HeroKind>('frost');
  const [heroB, setHeroB] = useState<HeroKind>('warlord');

  const [history, setHistory] = useState<SandboxState[]>(() => [freshState('normal', 'frost', 'warlord')]);
  const [viewPly, setViewPly] = useState(0);

  // Bumped on variant switch / reset / clear so MergeBoard wipes its
  // right-click annotation arrows + highlights (they'd otherwise reference
  // stale squares from the previous position).
  const [annotationsClearKey, setAnnotationsClearKey] = useState(0);

  // Drag-from-board source tracking (for moving pieces around the board).
  const [selectedSq, setSelectedSq] = useState<string | null>(null);

  // Palette-armed letter (cased: 'K' = white king, 'k' = black king).
  // Clicking a palette button arms it; the next board click spawns the piece.
  const [paletteArmed, setPaletteArmed] = useState<string | null>(null);

  // Cash mode: shop-armed letter, per color.
  const [shopArmed, setShopArmed] = useState<{ color: 'w' | 'b'; letter: string } | null>(null);

  // Hero mode: ability-armed, per color.
  const [abilityArmed, setAbilityArmed] = useState<'w' | 'b' | null>(null);
  // Goofball is a two-click ability: first click picks the opponent piece
  // being puppeted, second click picks where it goes. Stored as a board idx.
  const [goofballFrom, setGoofballFrom] = useState<number | null>(null);
  // Twin-Jitsu is also two-click: first click picks one of the active side's
  // own pieces, second click picks the swap partner.
  const [twinJitsuFrom, setTwinJitsuFrom] = useState<number | null>(null);
  // Goofball / Twin-Jitsu promotions pause the flow for a picker, just like
  // a regular pawn move that reaches the back rank.
  const [pendingAbilityPromo, setPendingAbilityPromo] = useState<{
    hero: 'goofball' | 'twin-jitsu';
    color: 'w' | 'b';
    fromIdx: number;
    toIdx: number;
    pickerSquare: string;
    pawnColor: 'w' | 'b';
  } | null>(null);
  const [abilityAnim, setAbilityAnim] = useState<AbilityAnim | null>(null);
  // Knight-ability doomed-piece overlay: the engine clears the target on
  // commit, but we keep the sprite visible through the wind-up of the sword
  // swing and only drop it at collision (swing midpoint).
  const [doomedPieces, setDoomedPieces] = useState<{ sq: string; letter: string }[]>([]);
  useEffect(() => {
    if (!abilityArmed) {
      setGoofballFrom(null);
      setTwinJitsuFrom(null);
      setPendingAbilityPromo(null);
    }
  }, [abilityArmed]);

  // Fullscreen mode for the board. Uses the HTML5 Fullscreen API on the
  // board-wrap element; ESC exits, plus an in-corner button while active.
  const boardWrapRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void boardWrapRef.current?.requestFullscreen?.();
    }
  };

  // Movement / placement / merge animations. Same shape as the game pages so
  // MergeBoard's animation props get values it understands.
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: string; to: string }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: string[]; key: number } | null>(null);
  const [mergeAnim, setMergeAnim] = useState<{ from: string; to: string; fromLetter: string; toLetter: string; mergedLetter: string; key: number; releasePx?: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (!slideAnim) return;
    const t = window.setTimeout(() => setSlideAnim(null), 320);
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

  const current = history[viewPly] ?? history[0];

  // When variant changes, rebuild history from the variant's initial position.
  // SFX for the change is fired from the <select>'s onChange instead — putting
  // it here would also play on the very first mount (and twice in dev under
  // React StrictMode).
  useEffect(() => {
    setHistory([freshState(variant, heroW, heroB)]);
    setViewPly(0);
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setGoofballFrom(null);
    setAbilityAnim(null);
    setAnnotationsClearKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // Picking a different hero kind re-inits the Hero starting board if no edits
  // have been made; otherwise updates the live state's hero glow only.
  useEffect(() => {
    if (variant !== 'hero') return;
    setHistory((h) => {
      if (h.length === 1 && viewPly === 0) {
        // Fresh board → re-init to reflect the new pick.
        return [freshState('hero', heroW, heroB)];
      }
      // Edited board → just swap the hero kinds on every snapshot so the king's
      // glow updates without losing user edits.
      return h.map((s) => ({ ...s, heroW, heroB }));
    });
    setAbilityArmed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroW, heroB]);

  // Auto-clear stale ability animation overlays.
  useEffect(() => {
    if (!abilityAnim) return;
    const t = window.setTimeout(() => setAbilityAnim(null), 1200);
    return () => clearTimeout(t);
  }, [abilityAnim]);

  const canUndo = viewPly > 0;
  const canRedo = viewPly < history.length - 1;

  // Truncate any "future" redo states and append a new state on top.
  const pushState = (next: SandboxState) => {
    // Layer a check / checkmate sound on top of the action sound played by
    // movePiece / spawnPiece / etc. — same as free play. Compute it from the
    // before→after transition so a check that was already present before the
    // change doesn't re-fire the SFX on every action.
    const wWasMate = inMate(variant, current.board, 'w', current.heroW, current.heroB);
    const bWasMate = inMate(variant, current.board, 'b', current.heroW, current.heroB);
    const wWasCheck = inCheck(variant, current.board, 'w', current.heroW, current.heroB);
    const bWasCheck = inCheck(variant, current.board, 'b', current.heroW, current.heroB);
    const wNowMate = inMate(variant, next.board, 'w', next.heroW, next.heroB);
    const bNowMate = inMate(variant, next.board, 'b', next.heroW, next.heroB);
    const wNowCheck = inCheck(variant, next.board, 'w', next.heroW, next.heroB);
    const bNowCheck = inCheck(variant, next.board, 'b', next.heroW, next.heroB);
    if ((wNowMate && !wWasMate) || (bNowMate && !bWasMate)) {
      sfx.playWin();
    } else if ((wNowCheck && !wWasCheck) || (bNowCheck && !bWasCheck)) {
      sfx.playCheck();
    }
    setHistory((h) => {
      const trunc = h.slice(0, viewPly + 1);
      return [...trunc, next];
    });
    setViewPly((p) => p + 1);
  };

  const handleUndo = () => {
    if (!canUndo) return;
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setViewPly((p) => p - 1);
    sfx.playMoveReversed();
  };
  const handleRedo = () => {
    if (!canRedo) return;
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setViewPly((p) => p + 1);
    sfx.playMove();
  };
  const handleFlip = () => {
    sfx.playFlip();
    setOrientation((o) => (o === 'white' ? 'black' : 'white'));
  };
  const handleReset = () => {
    sfx.playReset();
    setHistory([freshState(variant, heroW, heroB)]);
    setViewPly(0);
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setAbilityAnim(null);
    setAnnotationsClearKey((k) => k + 1);
  };
  const handleClear = () => {
    sfx.playReset();
    setHistory((h) => [...h.slice(0, viewPly + 1), { ...current, board: emptyBoard(), frozenIdxs: [], enPassant: null, masked: new Array(64).fill(false) }]);
    setViewPly((p) => p + 1);
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setAnnotationsClearKey((k) => k + 1);
  };

  // Spawn a piece on the board (palette → drop, or shop-letter → click).
  const spawnPiece = (letter: PieceLetter, sq: string) => {
    const idx = mergeSqToIdx(sq);
    const nextBoard = current.board.slice();
    nextBoard[idx] = { color: colorOf(letter), letter };
    const nextMasked = current.masked.slice();
    nextMasked[idx] = false;
    pushState({ ...current, board: nextBoard, frozenIdxs: frozenAfterClear(current.frozenIdxs, idx), enPassant: null, masked: nextMasked });
    sfx.playPlace();
    if (animationsEnabled) {
      setPopAnim({ squares: [sq], key: Date.now() });
    }
  };

  // Move a piece. Self-capture is blocked, with two exceptions:
  //  - Merge variant: landing on a same-color mergeable piece fuses them.
  //  - Guerrilla (two) variant: a rook moving onto an adjacent same-color
  //    piece shoves the contiguous chain one square along the same axis,
  //    provided the chain ends at an empty square inside the board.
  // Returns true if the move was applied, false if rejected.
  const movePiece = (
    from: string,
    to: string,
    viaClick = false,
    releasePx?: { x: number; y: number },
  ): boolean => {
    if (from === to) return false;
    const fromIdx = mergeSqToIdx(from);
    const toIdx = mergeSqToIdx(to);
    const moving = current.board[fromIdx];
    if (!moving) return false;
    const target = current.board[toIdx];

    // Guerrilla rook push.
    if (
      variant === 'two' &&
      moving.letter.toUpperCase() === 'R' &&
      target && target.color === moving.color
    ) {
      const ff = fromIdx % 8, fr = 7 - Math.floor(fromIdx / 8);
      const tf = toIdx % 8, tr = 7 - Math.floor(toIdx / 8);
      const adj = (Math.abs(tf - ff) === 1 && tr === fr) || (Math.abs(tr - fr) === 1 && tf === ff);
      if (!adj) return false;
      const df = Math.sign(tf - ff);
      const dr = Math.sign(tr - fr);
      const idxOf = (f: number, r: number) => (7 - r) * 8 + f;
      // Walk the contiguous chain starting at `to`.
      const chain: number[] = [];
      let cf = tf, cr = tr;
      while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8 && current.board[idxOf(cf, cr)]) {
        chain.push(idxOf(cf, cr));
        cf += df; cr += dr;
      }
      if (cf < 0 || cf >= 8 || cr < 0 || cr >= 8) return false; // chain hits the board edge

      const nextBoard = current.board.slice();
      // Shift back-to-front so we don't clobber the next piece's source.
      for (let i = chain.length - 1; i >= 0; i--) {
        const srcIdx = chain[i];
        const sf = srcIdx % 8, sr = 7 - Math.floor(srcIdx / 8);
        const dstIdx = idxOf(sf + df, sr + dr);
        nextBoard[dstIdx] = nextBoard[srcIdx];
        nextBoard[srcIdx] = null;
      }
      nextBoard[toIdx] = moving;
      nextBoard[fromIdx] = null;
      // Freezes follow whichever square they sat on through the push.
      const movedMap = new Map<number, number>();
      movedMap.set(fromIdx, toIdx);
      for (const srcIdx of chain) {
        const sf = srcIdx % 8, sr = 7 - Math.floor(srcIdx / 8);
        movedMap.set(srcIdx, idxOf(sf + df, sr + dr));
      }
      const nextFrozen = current.frozenIdxs.map((f) => movedMap.get(f) ?? f);
      // Push reveals everything it touches.
      const nextMasked = current.masked.slice();
      nextMasked[fromIdx] = false;
      nextMasked[toIdx] = false;
      for (const srcIdx of chain) {
        const sf = srcIdx % 8, sr = 7 - Math.floor(srcIdx / 8);
        nextMasked[srcIdx] = false;
        nextMasked[idxOf(sf + df, sr + dr)] = false;
      }
      pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null, masked: nextMasked });
      sfx.playPush();
      // Animate the rook + each pushed piece chained behind it.
      if (viaClick && animationsEnabled) {
        const slides: { from: string; to: string }[] = [{ from, to }];
        for (const srcIdx of chain) {
          const sf = srcIdx % 8, sr = 7 - Math.floor(srcIdx / 8);
          const dstIdx = idxOf(sf + df, sr + dr);
          slides.push({ from: heroIdxToSq(srcIdx), to: heroIdxToSq(dstIdx) });
        }
        setSlideAnim({ moves: slides, key: Date.now() });
      }
      return true;
    }

    let placed: MergePiece = moving;
    let isMerge = false;
    if (target && target.color === moving.color) {
      if (variant !== 'merge') return false;
      const merged = tryMerge(moving, target);
      if (!merged) return false;
      placed = merged;
      isMerge = true;
    }

    const nextBoard = current.board.slice();
    nextBoard[fromIdx] = null;
    nextBoard[toIdx] = placed;

    // Pawn-specific bookkeeping: detect en-passant capture (diagonal pawn
    // move onto the EP target with no piece on the dest), and detect a
    // double push so the *next* ply offers en-passant. Skip for Guerrilla,
    // which has no double pawn move at all.
    let epCapturedIdx: number | null = null;
    let nextEnPassant: string | null = null;
    if (variant !== 'two' && moving.letter.toUpperCase() === 'P') {
      const ff = fromIdx % 8, fr = 7 - Math.floor(fromIdx / 8);
      const tf = toIdx % 8, tr = 7 - Math.floor(toIdx / 8);
      const dir = moving.color === 'w' ? 1 : -1;
      const startRank = moving.color === 'w' ? 1 : 6;
      // En-passant capture: diagonal step onto the recorded EP square with
      // an empty destination — the captured pawn sits one rank behind.
      if (
        !target && current.enPassant === to &&
        Math.abs(tf - ff) === 1 && (tr - fr) === dir
      ) {
        const capRank = moving.color === 'w' ? tr - 1 : tr + 1;
        epCapturedIdx = (7 - capRank) * 8 + tf;
        nextBoard[epCapturedIdx] = null;
      }
      // Double push from start rank: arm EP for the passed-over square.
      if (fr === startRank && (tr - fr) === 2 * dir && ff === tf) {
        const epRank = moving.color === 'w' ? tr - 1 : tr + 1;
        nextEnPassant = heroIdxToSq((7 - epRank) * 8 + tf);
      }
    }

    let nextFrozen = frozenAfterMove(current.frozenIdxs, fromIdx, toIdx);
    if (epCapturedIdx != null) nextFrozen = frozenAfterClear(nextFrozen, epCapturedIdx);
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = false;
    nextMasked[toIdx] = false;
    if (epCapturedIdx != null) nextMasked[epCapturedIdx] = false;
    pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: nextEnPassant, masked: nextMasked });
    if (isMerge) sfx.playMerge();
    else if (target || epCapturedIdx != null) sfx.playCapture();
    else sfx.playMove();
    // Merge gets its own flow animation; otherwise click moves slide.
    if (animationsEnabled) {
      if (isMerge) {
        setMergeAnim({
          from,
          to,
          fromLetter: moving.letter,
          toLetter: target!.letter,
          mergedLetter: placed.letter,
          key: Date.now(),
          releasePx,
        });
      } else if (viaClick) {
        setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      }
    }
    return true;
  };

  const deletePiece = (sq: string) => {
    const idx = mergeSqToIdx(sq);
    if (!current.board[idx]) return;
    const nextBoard = current.board.slice();
    nextBoard[idx] = null;
    const nextMasked = current.masked.slice();
    nextMasked[idx] = false;
    pushState({
      ...current,
      board: nextBoard,
      frozenIdxs: frozenAfterClear(current.frozenIdxs, idx),
      enPassant: null,
      masked: nextMasked,
    });
    sfx.playCapture();
  };

  // ----- Hero ability effects (sandbox semantics) -----
  // Cooldowns / turn checks are skipped, but the *target* must still be
  // legal — the engine decides what counts (e.g. Flight can't land on an
  // attacked square). We probe heroLegalAbilityTargets before firing.
  // ICBM is compressed to an immediate detonation since sandbox has no ply
  // counter to fly missiles through; goofball walks two clicks (pick →
  // destination); harem is passive and never reaches here.

  // Commit a resolved Goofball move. promoLetter is the uppercase Q/R/B/N
  // chosen by the picker; undefined means no promotion (non-pawn or pawn
  // not on a promo rank).
  const commitGoofball = (
    _color: 'w' | 'b', fromIdx: number, toIdx: number, targetSq: string,
    promoLetter?: PromotionLetter,
  ) => {
    const piece = current.board[fromIdx];
    if (!piece) { setGoofballFrom(null); setAbilityArmed(null); return; }
    let placed: MergePiece = piece;
    if (promoLetter) {
      placed = {
        color: piece.color,
        letter: (piece.color === 'w' ? promoLetter : promoLetter.toLowerCase()) as PieceLetter,
      };
    }
    const nextBoard = current.board.slice();
    nextBoard[fromIdx] = null;
    nextBoard[toIdx] = placed;
    const nextFrozen = frozenAfterMove(current.frozenIdxs, fromIdx, toIdx);
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = false;
    nextMasked[toIdx] = false;
    pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null, masked: nextMasked });
    sfx.playGoofball();
    if (animationsEnabled) {
      setSlideAnim({
        moves: [{ from: heroIdxToSq(fromIdx), to: targetSq }],
        key: Date.now(),
      });
    }
    setGoofballFrom(null);
    setAbilityArmed(null);
  };

  // Commit a resolved Twin-Jitsu swap. promoLetter applies to whichever
  // endpoint pawn lands on its promo rank.
  const commitTwinJitsu = (
    _color: 'w' | 'b', fromIdx: number, toIdx: number, targetSq: string,
    promoLetter?: PromotionLetter,
  ) => {
    const a = current.board[fromIdx];
    const b = current.board[toIdx];
    const nextBoard = current.board.slice();
    nextBoard[fromIdx] = b;
    nextBoard[toIdx] = a;
    if (promoLetter) {
      for (const slot of [fromIdx, toIdx]) {
        const p = nextBoard[slot];
        if (!p || p.letter.toUpperCase() !== 'P') continue;
        const row = Math.floor(slot / 8);
        const onPromo = (p.color === 'w' && row === 0) || (p.color === 'b' && row === 7);
        if (!onPromo) continue;
        nextBoard[slot] = {
          color: p.color,
          letter: (p.color === 'w' ? promoLetter : promoLetter.toLowerCase()) as PieceLetter,
        };
      }
    }
    // Swap freezes too: if either endpoint was frozen, the freeze stays
    // on whichever square it sat on (the piece that was there moved out
    // and a new one moved in — the freeze marker tracks the square).
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = true;
    nextMasked[toIdx] = true;
    pushState({ ...current, board: nextBoard, frozenIdxs: current.frozenIdxs, enPassant: null, masked: nextMasked });
    sfx.playTwinJitsu();
    if (animationsEnabled) {
      setSlideAnim({
        moves: [
          { from: heroIdxToSq(fromIdx), to: targetSq },
          { from: targetSq, to: heroIdxToSq(fromIdx) },
        ],
        key: Date.now(),
      });
    }
    setTwinJitsuFrom(null);
    setAbilityArmed(null);
  };

  const resolveAbilityPromotion = (letter: PromotionLetter) => {
    if (!pendingAbilityPromo) return;
    const { hero, color, fromIdx, toIdx } = pendingAbilityPromo;
    const valid: PromotionLetter = (['Q', 'R', 'B', 'N'] as PromotionLetter[]).includes(letter)
      ? letter : 'Q';
    setPendingAbilityPromo(null);
    if (hero === 'goofball') {
      commitGoofball(color, fromIdx, toIdx, heroIdxToSq(toIdx), valid);
    } else {
      commitTwinJitsu(color, fromIdx, toIdx, heroIdxToSq(toIdx), valid);
    }
  };

  const fireAbility = (color: 'w' | 'b', targetSq: string) => {
    const hero = color === 'w' ? heroW : heroB;
    const idx = mergeSqToIdx(targetSq);

    // Goofball: two-click flow. First click picks the opponent piece, second
    // click picks the destination. heroLegalAbilityTargets switches between
    // from-squares and destinations based on goofballFrom (see memo below).
    if (hero === 'goofball') {
      if (goofballFrom == null) {
        if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
        setGoofballFrom(idx);
        sfx.playSelect();
        return;
      }
      if (!heroLegalAbilityTargets.has(idx)) {
        // Click off a legal destination resets to the pick-a-piece state.
        setGoofballFrom(null);
        return;
      }
      const piece = current.board[goofballFrom];
      if (!piece) { setGoofballFrom(null); setAbilityArmed(null); return; }
      const isPawn = piece.letter.toUpperCase() === 'P';
      const destRank = Math.floor(idx / 8); // 0 = rank 8, 7 = rank 1
      if (isPawn && (destRank === 0 || destRank === 7)) {
        // Pause for the picker — same flow as a regular pawn promotion.
        setPendingAbilityPromo({
          hero: 'goofball',
          color,
          fromIdx: goofballFrom,
          toIdx: idx,
          pickerSquare: targetSq,
          pawnColor: piece.color,
        });
        return;
      }
      commitGoofball(color, goofballFrom, idx, targetSq);
      return;
    }

    // Twin-Jitsu: two-click swap. First click picks one of the active side's
    // own pieces, second click picks the swap partner. Both endpoints end up
    // masked after.
    if (hero === 'twin-jitsu') {
      if (twinJitsuFrom == null) {
        if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
        setTwinJitsuFrom(idx);
        sfx.playSelect();
        return;
      }
      if (!heroLegalAbilityTargets.has(idx)) { setTwinJitsuFrom(null); return; }
      // Detect pawn-to-back-rank in the swap. At most one of the two
      // endpoints can land on a promo rank (a pawn can't be on its own
      // promo rank pre-swap because it would've already promoted).
      const aPiece = current.board[twinJitsuFrom];
      const bPiece = current.board[idx];
      // After swap: aPiece sits on `idx`, bPiece sits on `twinJitsuFrom`.
      const aLandsRow = Math.floor(idx / 8);
      const bLandsRow = Math.floor(twinJitsuFrom / 8);
      let promoIdx: number | null = null;
      let promoSq: string | null = null;
      let promoColor: 'w' | 'b' | null = null;
      if (aPiece && aPiece.letter.toUpperCase() === 'P'
          && ((aPiece.color === 'w' && aLandsRow === 0) || (aPiece.color === 'b' && aLandsRow === 7))) {
        promoIdx = idx; promoSq = targetSq; promoColor = aPiece.color;
      } else if (bPiece && bPiece.letter.toUpperCase() === 'P'
          && ((bPiece.color === 'w' && bLandsRow === 0) || (bPiece.color === 'b' && bLandsRow === 7))) {
        promoIdx = twinJitsuFrom; promoSq = heroIdxToSq(twinJitsuFrom); promoColor = bPiece.color;
      }
      if (promoIdx != null && promoSq && promoColor) {
        setPendingAbilityPromo({
          hero: 'twin-jitsu',
          color,
          fromIdx: twinJitsuFrom,
          toIdx: idx,
          pickerSquare: promoSq,
          pawnColor: promoColor,
        });
        return;
      }
      commitTwinJitsu(color, twinJitsuFrom, idx, targetSq);
      return;
    }

    if (!heroLegalAbilityTargets.has(idx)) return;
    const targetPiece = current.board[idx];
    if (hero === 'frost') {
      // Toggle: clicking an already-frozen square unfreezes it; clicking
      // another piece adds another freeze. Multiple freezes can coexist —
      // matches free-play, where each Frost use stacks an independent
      // freeze entry. Clicking an empty square is a no-op.
      const alreadyFrozen = current.frozenIdxs.includes(idx);
      let nextFrozen: number[];
      if (alreadyFrozen) nextFrozen = current.frozenIdxs.filter((f) => f !== idx);
      else if (targetPiece) nextFrozen = [...current.frozenIdxs, idx];
      else { setAbilityArmed(null); return; }
      pushState({ ...current, frozenIdxs: nextFrozen, enPassant: null });
      sfx.playFreeze();
      if (animationsEnabled) setAbilityAnim({ kind: 'frost', toSq: targetSq, color, key: `frost-${Date.now()}` });
    } else if (hero === 'warlord') {
      if (!targetPiece) return;
      const nextBoard = current.board.slice();
      nextBoard[idx] = null;
      pushState({
        ...current,
        board: nextBoard,
        frozenIdxs: frozenAfterClear(current.frozenIdxs, idx),
        enPassant: null,
      });
      // Slice fires at swing-start; its internal climax lands at the swing
      // midpoint so the whistle leads INTO the blade's apex strike.
      sfx.playSlice();
      const kingSq = kingSquareOf(current.board as any, color);
      if (animationsEnabled) {
        setAbilityAnim({
          kind: 'warlord',
          fromSq: kingSq ?? targetSq,
          toSq: targetSq,
          color,
          key: `warlord-${Date.now()}`,
        });
        // Doomed-sprite overlay: keep the victim rendered through the
        // wind-up; clear it at the swing midpoint when the blade collides.
        const entry = { sq: targetSq, letter: targetPiece.letter };
        setDoomedPieces((prev) => [...prev, entry]);
        window.setTimeout(() => {
          setDoomedPieces((prev) => prev.filter((d) => d.sq !== targetSq));
        }, 450);
      }
    } else if (hero === 'necromancer') {
      if (targetPiece) return;
      const nextBoard = current.board.slice();
      nextBoard[idx] = { color, letter: (color === 'w' ? 'P' : 'p') as PieceLetter };
      pushState({ ...current, board: nextBoard, enPassant: null });
      sfx.playSpawn();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'necromancer', toSq: targetSq, color, key: `necro-${Date.now()}` });
        // Pop the freshly spawned pawn in so it matches HeroGame's behaviour.
        setPopAnim({ squares: [targetSq], key: Date.now() });
      }
    } else if (hero === 'flight') {
      const kingFromIdx = current.board.findIndex(
        (p) => p && p.color === color && p.letter.toUpperCase() === 'K',
      );
      if (kingFromIdx < 0) return;
      if (kingFromIdx === idx) return;
      const fromSq = heroIdxToSq(kingFromIdx);
      const nextBoard = current.board.slice();
      const king = nextBoard[kingFromIdx];
      nextBoard[kingFromIdx] = null;
      nextBoard[idx] = king;
      const nextFrozen = frozenAfterMove(current.frozenIdxs, kingFromIdx, idx);
      pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null });
      sfx.playFly();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'flight', fromSq, toSq: targetSq, color, key: `flight-${Date.now()}` });
      }
    } else if (hero === 'mutation') {
      // B → A, R → C, Q → Z (preserve case). Anything else falls through.
      if (!targetPiece) return;
      const up = targetPiece.letter.toUpperCase();
      if (up !== 'B' && up !== 'R' && up !== 'Q') return;
      const mergedUp = up === 'B' ? 'A' : up === 'R' ? 'C' : 'Z';
      const wasLower = targetPiece.letter !== up;
      const nextBoard = current.board.slice();
      nextBoard[idx] = {
        color: targetPiece.color,
        letter: (wasLower ? mergedUp.toLowerCase() : mergedUp) as PieceLetter,
      };
      pushState({ ...current, board: nextBoard, enPassant: null });
      sfx.playMutate();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'mutation', toSq: targetSq, color, key: `mut-${Date.now()}` });
        setPopAnim({ squares: [targetSq], key: Date.now() });
      }
    } else if (hero === 'icbm') {
      // Sandbox compresses the 7-ply missile flight into an immediate strike:
      // the target square is demolished now, with the launch + explosion sfx
      // staggered to keep the visual "ka-thoom" cadence from Hero mode.
      const nextBoard = current.board.slice();
      nextBoard[idx] = null;
      pushState({
        ...current,
        board: nextBoard,
        frozenIdxs: frozenAfterClear(current.frozenIdxs, idx),
        enPassant: null,
      });
      sfx.playMissileLaunch();
      window.setTimeout(() => sfx.playExplosion(), 450);
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'icbm', toSq: targetSq, color, key: `icbm-${Date.now()}` });
      }
    }
    setAbilityArmed(null);
  };

  // ----- Board interaction wiring -----
  const onSquareClick = (sq: string) => {
    // Hero ability armed: click resolves the ability target.
    if (variant === 'hero' && abilityArmed) {
      fireAbility(abilityArmed, sq);
      return;
    }
    // Cash shop armed: click spawns the armed piece.
    if (variant === 'cash' && shopArmed) {
      const letterCased = shopArmed.color === 'w'
        ? (shopArmed.letter as PieceLetter)
        : (shopArmed.letter.toLowerCase() as PieceLetter);
      spawnPiece(letterCased, sq);
      setShopArmed(null);
      return;
    }
    // Palette armed: click spawns the armed piece.
    if (paletteArmed) {
      spawnPiece(paletteArmed as PieceLetter, sq);
      setPaletteArmed(null);
      return;
    }
    // Standard click-to-move: first click selects a piece, second click moves.
    const idx = mergeSqToIdx(sq);
    if (selectedSq && selectedSq !== sq) {
      const moved = movePiece(selectedSq, sq, true);
      if (moved) {
        setSelectedSq(null);
        return;
      }
      // Blocked (e.g. self-capture outside Merge mode). Fall through so the
      // clicked square gets selected if it has a piece — natural re-select UX.
    }
    if (selectedSq === sq) {
      setSelectedSq(null);
      return;
    }
    if (current.board[idx]) {
      setSelectedSq(sq);
    } else {
      setSelectedSq(null);
    }
  };

  const onDragStartSquare = (from: string) => {
    setShopArmed(null);
    setAbilityArmed(null);
    setPaletteArmed(null);
    setSelectedSq(from);
  };

  const onPieceDrop = (
    from: string,
    to: string,
    opts?: { releasePx?: { x: number; y: number } },
  ): boolean => {
    const moved = movePiece(from, to, false, opts?.releasePx);
    setSelectedSq(null);
    return moved;
  };

  const onSpawnDrop = (letter: PieceLetter, to: string) => {
    spawnPiece(letter, to);
    setSelectedSq(null);
    setShopArmed(null);
    setPaletteArmed(null);
  };

  // ----- Palette drag-start payload -----
  // effectAllowed must include 'move' so the board's dropEffect='move' is
  // accepted; mismatched operations cause the browser to reject the drop.
  const onPaletteDragStart = (e: ReactDragEvent<HTMLDivElement>, letterCased: string) => {
    try {
      e.dataTransfer.setData('text/plain', `spawn:${letterCased}`);
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch {}
  };

  const togglePaletteArmed = (letterCased: string) => {
    setPaletteArmed((prev) => (prev === letterCased ? null : letterCased));
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    sfx.playSelect();
  };

  // Last-move highlight: diff prev vs current snapshot. Only displays when
  // exactly one square emptied AND one square gained/changed (i.e. a move or
  // capture). Spawns / deletes / clears intentionally don't light up.
  // End-of-game overlay (checkmate). Mirrors free play: shows on top of the
  // board with the winning side. Free placement still works underneath.
  const sandboxEnd = useMemo<{ winner: 'w' | 'b' } | null>(() => {
    if (inMate(variant, current.board, 'w', current.heroW, current.heroB)) return { winner: 'b' };
    if (inMate(variant, current.board, 'b', current.heroW, current.heroB)) return { winner: 'w' };
    return null;
  }, [variant, current]);

  const lastMove = useMemo<{ from: string; to: string } | null>(() => {
    if (viewPly === 0) return null;
    const prev = history[viewPly - 1];
    if (!prev) return null;
    let fromIdx = -1;
    let toIdx = -1;
    let emptied = 0;
    let arrived = 0;
    for (let i = 0; i < 64; i++) {
      const a = prev.board[i];
      const b = current.board[i];
      const same = (!a && !b) || (a && b && a.color === b.color && a.letter === b.letter);
      if (same) continue;
      if (!b) { emptied++; fromIdx = i; }
      else { arrived++; toIdx = i; }
    }
    if (emptied === 1 && arrived === 1) {
      return { from: heroIdxToSq(fromIdx), to: heroIdxToSq(toIdx) };
    }
    return null;
  }, [viewPly, history, current]);

  // Engine-driven set of legal ability target indices for the armed side.
  // Empty when no ability is armed or the engine can't determine targets.
  // Flight excludes attacked squares; Knight/Necromancer require an own king;
  // Frost excludes kings. For Goofball, once a from-square has been picked
  // (goofballFrom != null), the set flips from "enemy pieces with at least
  // one legal move" to "legal destinations for the picked piece".
  const heroLegalAbilityTargets = useMemo<Set<number>>(() => {
    if (variant !== 'hero' || !abilityArmed) return new Set();
    try {
      const state = {
        ...heroInitial(current.heroW, current.heroB),
        board: current.board as any,
        turn: abilityArmed,
        masked: current.masked,
      };
      const armedHero = abilityArmed === 'w' ? current.heroW : current.heroB;
      if (armedHero === 'goofball' && goofballFrom != null) {
        return new Set(goofballLegalDestinations(state as any, goofballFrom));
      }
      if (armedHero === 'twin-jitsu' && twinJitsuFrom != null) {
        return new Set(twinJitsuLegalDestinations(state as any, twinJitsuFrom));
      }
      return new Set(heroAbilityTargets(state as any));
    } catch {
      return new Set();
    }
  }, [variant, abilityArmed, current, goofballFrom, twinJitsuFrom]);

  // Advisory indicators on the board. Three modes:
  //   1. Cash shop armed → squares with own pawns of the armed color.
  //   2. Hero ability armed → engine-computed legal ability targets.
  //   3. Selected piece → engine legal moves when the mover's king is on
  //      the board (so checks are honored); otherwise raw pattern moves.
  // Cash/Palette indicators are hints only — they don't restrict placement.
  // Hero ability targets ARE enforced when firing (see fireAbility).
  const legalTargets = useMemo(() => {
    const ringTarget = (i: number) => ({ to: heroIdxToSq(i), isCapture: false, isMerge: true });

    if (variant === 'cash' && shopArmed) {
      const out: { to: string; isCapture: boolean; isMerge: boolean }[] = [];
      for (let i = 0; i < 64; i++) {
        const p = current.board[i];
        if (p && p.color === shopArmed.color && p.letter.toUpperCase() === 'P') out.push(ringTarget(i));
      }
      return out;
    }
    if (variant === 'hero' && abilityArmed) {
      // ICBM targets every square — drawing 64 green rings is noise. The
      // ghost crosshair on hover is the affordance instead.
      const armedHero = abilityArmed === 'w' ? current.heroW : current.heroB;
      if (armedHero === 'icbm') return [];
      return Array.from(heroLegalAbilityTargets).map((i) => ringTarget(i));
    }
    if (!selectedSq) return [];
    const piece = current.board[mergeSqToIdx(selectedSq)];
    if (!piece) return [];
    // No king of the mover's color → check filtering is meaningless, so fall
    // back to raw patterns. Otherwise the variant's engine generates the
    // proper check-filtered legal moves.
    if (!hasKing(current.board, piece.color)) return patternTargets(variant, current.board, selectedSq);
    return engineLegalTargets(variant, current.board, selectedSq, current.heroW, current.heroB, current.enPassant);
  }, [selectedSq, variant, current, shopArmed, abilityArmed, heroLegalAbilityTargets]);

  const frozenSquares = current.frozenIdxs.map((i) => heroIdxToSq(i));

  const kingGlows = variant === 'hero'
    ? { w: HERO_INFO[current.heroW].glowColor, b: HERO_INFO[current.heroB].glowColor }
    : undefined;

  // For each side, can their hero ability fire? Defers to the engine's
  // `abilityTargets`, which encodes the full legality (own king present,
  // adjacency, Flight's "not attacked" rule, etc.).
  const heroAvailable = useMemo(() => {
    const check = (color: 'w' | 'b'): boolean => {
      try {
        const state = {
          ...heroInitial(current.heroW, current.heroB),
          board: current.board as any,
          turn: color,
          masked: current.masked,
        };
        return heroAbilityTargets(state as any).length > 0;
      } catch {
        return false;
      }
    };
    return { w: check('w'), b: check('b') };
  }, [current]);

  // Disarm whichever side's ability was armed when it becomes unavailable
  // (e.g. user deleted the king mid-arm).
  useEffect(() => {
    if (!abilityArmed) return;
    if (!heroAvailable[abilityArmed]) setAbilityArmed(null);
  }, [abilityArmed, heroAvailable]);

  // Keyboard arrows scrub undo/redo, matching free play.
  const undoRef = useRef(handleUndo);
  const redoRef = useRef(handleRedo);
  useEffect(() => { undoRef.current = handleUndo; redoRef.current = handleRedo; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); undoRef.current(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); redoRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="page">
      <div className="hero">
        <h1 className="page-title">Sandbox</h1>
        <p className="muted">
          Free-form board for messing around. Drag from the palette to spawn,
          drag pieces anywhere, right-click to delete. No turns, no rules.
        </p>
      </div>

      <div className="home-play-area">
        <div className="free-play-board">
          <div
            ref={boardWrapRef}
            className={`free-play-board-wrap${isFullscreen ? ' is-fullscreen' : ''}`}
          >
            <MergeBoard
              board={current.board}
              orientation={orientation}
              selectedSquare={
                abilityArmed && goofballFrom != null ? heroIdxToSq(goofballFrom)
                : abilityArmed && twinJitsuFrom != null ? heroIdxToSq(twinJitsuFrom)
                : selectedSq
              }
              legalTargets={legalTargets}
              onSquareClick={onSquareClick}
              onPieceDrop={onPieceDrop}
              onDragStartSquare={onDragStartSquare}
              onSpawn={onSpawnDrop}
              onWheelDownSquare={deletePiece}
              kingGlows={kingGlows}
              frozenSquares={frozenSquares}
              ghostCrosshair={
                variant === 'hero' && abilityArmed &&
                (abilityArmed === 'w' ? current.heroW : current.heroB) === 'icbm'
                  ? { firedBy: abilityArmed }
                  : null
              }
              ghostSpawn={
                paletteArmed
                  ? { letter: paletteArmed }
                  : shopArmed
                    ? {
                        letter: shopArmed.color === 'w'
                          ? shopArmed.letter
                          : shopArmed.letter.toLowerCase(),
                      }
                    : null
              }
              abilityAnim={abilityAnim}
              doomedPieces={doomedPieces.map((d) => ({
                sq: d.sq,
                letter: d.letter as PieceLetter,
              }))}
              lastMove={lastMove}
              slideMoves={slideAnim?.moves}
              slideKey={slideAnim?.key}
              popSquares={popAnim?.squares}
              popKey={popAnim?.key}
              mergeAnim={mergeAnim}
              clearAnnotationsKey={annotationsClearKey}
              // Sandbox: show every masked piece with the translucent-king
              // overlay so the editor still reads the real piece underneath.
              maskedSelfSquares={(() => {
                const out: string[] = [];
                for (let i = 0; i < 64; i++) if (current.masked[i]) out.push(heroIdxToSq(i));
                return out;
              })()}
            />
            {isFullscreen && (
              <button
                type="button"
                className="fullscreen-exit-btn"
                onClick={toggleFullscreen}
                title="Exit fullscreen (Esc)"
                aria-label="Exit fullscreen"
              >×</button>
            )}
            {pendingAbilityPromo && (
              <PromotionPicker
                square={pendingAbilityPromo.pickerSquare}
                color={pendingAbilityPromo.pawnColor}
                orientation={orientation}
                options={['Q', 'R', 'B', 'N']}
                onPick={resolveAbilityPromotion}
                onCancel={() => {
                  setPendingAbilityPromo(null);
                  setGoofballFrom(null);
                  setTwinJitsuFrom(null);
                  setAbilityArmed(null);
                }}
              />
            )}
            {sandboxEnd && (
              <div
                className="board-finish-overlay"
                key={`${viewPly}-${sandboxEnd.winner}`}
              >
                <div className="victor">
                  <span aria-label={sandboxEnd.winner === 'w' ? 'White' : 'Black'}>
                    {renderPiece(sandboxEnd.winner === 'w' ? 'wK' : 'bK', 48)}
                  </span>
                  <span>wins</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sandbox-tools">
          <div className="sandbox-controls">
            <CustomSelect<SandboxVariant>
              triggerClassName="free-play-select sandbox-variant-select"
              value={variant}
              aria-label="Sandbox game mode"
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'merge',  label: 'Merge' },
                { value: 'two',    label: 'Guerrilla' },
                { value: 'cash',   label: 'Cash Money' },
                { value: 'hero',   label: 'Hero' },
              ]}
              onChange={(next) => {
                if (next !== variant) {
                  if (next === 'merge') sfx.playMerge();
                  else if (next === 'two') sfx.playPush();
                  else if (next === 'cash') sfx.playPlace();
                  else if (next === 'hero') sfx.playSlice();
                  else sfx.playMove();
                }
                setVariant(next);
              }}
            />
            <button className="free-play-btn" type="button" onClick={handleUndo} disabled={!canUndo}>Undo</button>
            <button className="free-play-btn" type="button" onClick={handleRedo} disabled={!canRedo}>Redo</button>
            <button className="free-play-btn" type="button" onClick={handleFlip}>Flip</button>
            <button className="free-play-btn" type="button" onClick={handleReset}>Reset</button>
            <button className="free-play-btn" type="button" onClick={handleClear}>Clear</button>
            <button className="free-play-btn" type="button" onClick={toggleFullscreen}>
              {isFullscreen ? 'Exit FS' : 'Fullscreen'}
            </button>
          </div>

          <PiecePalette
            letters={PALETTE_LETTERS[variant]}
            armed={paletteArmed}
            onDragStart={onPaletteDragStart}
            onClick={togglePaletteArmed}
          />

          <div className="sandbox-extras">
            {variant === 'cash' && (
              <SandboxCashShop
                armed={shopArmed}
                onArm={(arm) => {
                  setShopArmed(arm);
                  setSelectedSq(null);
                  setAbilityArmed(null);
                  if (arm) sfx.playBuy();
                }}
              />
            )}

            {variant === 'hero' && (
              <SandboxHeroPanel
                heroW={current.heroW}
                heroB={current.heroB}
                availableW={heroAvailable.w}
                availableB={heroAvailable.b}
                onPickW={(h) => {
                  if (h !== heroW) {
                    if (h === 'frost') sfx.playFreeze();
                    else if (h === 'warlord') sfx.playSlice();
                    else if (h === 'necromancer') sfx.playSpawn();
                    else if (h === 'flight') sfx.playFly();
                    else if (h === 'mutation') sfx.playMutate();
                    else if (h === 'harem') sfx.playHarem();
                    else if (h === 'icbm') sfx.playMissileLaunch();
                    else if (h === 'goofball') sfx.playGoofball();
                    else if (h === 'twin-jitsu') sfx.playTwinJitsu();
                  }
                  setHeroW(h);
                }}
                onPickB={(h) => {
                  if (h !== heroB) {
                    if (h === 'frost') sfx.playFreeze();
                    else if (h === 'warlord') sfx.playSlice();
                    else if (h === 'necromancer') sfx.playSpawn();
                    else if (h === 'flight') sfx.playFly();
                    else if (h === 'mutation') sfx.playMutate();
                    else if (h === 'harem') sfx.playHarem();
                    else if (h === 'icbm') sfx.playMissileLaunch();
                    else if (h === 'goofball') sfx.playGoofball();
                    else if (h === 'twin-jitsu') sfx.playTwinJitsu();
                  }
                  setHeroB(h);
                }}
                armed={abilityArmed}
                onArm={(c) => {
                  setAbilityArmed(c);
                  setSelectedSq(null);
                  setShopArmed(null);
                  sfx.playSelect();
                }}
                onCancel={() => setAbilityArmed(null)}
              />
            )}

            <SandboxTips />
          </div>
        </div>
      </div>
    </div>
  );
}

function PiecePalette({
  letters,
  armed,
  onDragStart,
  onClick,
}: {
  letters: string[];
  armed: string | null;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>, letterCased: string) => void;
  onClick: (letterCased: string) => void;
}) {
  return (
    <div className="sandbox-palette">
      <div className="sandbox-palette-title">Pieces</div>
      <div className="sandbox-palette-grid">
        {(['w', 'b'] as const).map((color) => (
          <div key={color} className="sandbox-palette-row" aria-label={color === 'w' ? 'White pieces' : 'Black pieces'}>
            <div className="sandbox-palette-row-buttons">
              {letters.map((L) => {
                const letterCased = color === 'w' ? L : L.toLowerCase();
                return (
                  <PaletteButton
                    key={`${color}-${L}`}
                    letterCased={letterCased}
                    armed={armed === letterCased}
                    onDragStart={onDragStart}
                    onClick={onClick}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="muted small sandbox-palette-hint">
        {armed ? 'Click a square to place.' : 'Drag or click a piece, then drop on a square.'}
      </div>
    </div>
  );
}

function SandboxTips() {
  return (
    <div className="sandbox-tips-card">
      <div className="sandbox-palette-title">Tips</div>
      <ul className="sandbox-tip-list">
        <li><b>Drag</b> or <b>click</b> a piece to spawn it.</li>
        <li><b>Scroll down</b> on a square — or <b>drag a piece off the board</b> — to delete it.</li>
        <li><b>Right-click + drag</b> to draw arrows; <b>right-click</b> a square to highlight it.</li>
        <li><b>Click</b> a piece on the board to see its legal moves.</li>
        <li><b>Drag</b> a piece to move it anywhere.</li>
        <li><b>← / →</b> arrow keys undo / redo.</li>
      </ul>
    </div>
  );
}

function PaletteButton({
  letterCased,
  armed,
  onDragStart,
  onClick,
}: {
  letterCased: string;
  armed: boolean;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>, letterCased: string) => void;
  onClick: (letterCased: string) => void;
}) {
  const keys = lettersToPieceKeys(letterCased);
  const isMerged = keys.length > 1;
  const size = 30;
  return (
    <div
      className={`sandbox-palette-btn${armed ? ' armed' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, letterCased)}
      onClick={() => onClick(letterCased)}
      title={letterCased}
      data-no-sfx
    >
      {!isMerged ? renderPiece(keys[0], size) : (
        <div className="sandbox-palette-merged">
          <div style={{ position: 'absolute', left: 0, top: 4 }}>{renderPiece(keys[0], size * 0.7)}</div>
          <div style={{ position: 'absolute', right: 0, bottom: 0 }}>{renderPiece(keys[1], size * 0.7)}</div>
        </div>
      )}
    </div>
  );
}

function SandboxCashShop({
  armed,
  onArm,
}: {
  armed: { color: 'w' | 'b'; letter: string } | null;
  onArm: (arm: { color: 'w' | 'b'; letter: string } | null) => void;
}) {
  return (
    <div className="cash-shop compact sandbox-shop">
      <div className="cash-shop-header">
        <div className="cash-shop-title">Shop (∞ gold)</div>
      </div>
      {(['w', 'b'] as const).map((color) => (
        <div key={color} className="sandbox-shop-row" aria-label={color === 'w' ? 'White shop' : 'Black shop'}>
          <div className="sandbox-shop-row-buttons">
            {SHOP_LETTERS_SANDBOX.map((L) => {
              const isSelected = armed?.color === color && armed?.letter === L;
              const pieceKey = `${color}${L}` as
                'wQ' | 'wR' | 'wB' | 'wN' | 'bQ' | 'bR' | 'bB' | 'bN';
              return (
                <button
                  key={L}
                  type="button"
                  className={`cash-shop-item${isSelected ? ' selected' : ''}`}
                  data-no-sfx
                  onClick={() => onArm(isSelected ? null : { color, letter: L })}
                  title={L}
                >
                  <div className="cash-shop-piece">{renderPiece(pieceKey, 30)}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="cash-shop-hint muted small">
        {armed
          ? 'Click a square to place.'
          : 'Pick a piece, then click a square to place it.'}
      </div>
    </div>
  );
}

function SandboxHeroPanel({
  heroW,
  heroB,
  availableW,
  availableB,
  onPickW,
  onPickB,
  armed,
  onArm,
  onCancel,
}: {
  heroW: HeroKind;
  heroB: HeroKind;
  // Whether each side's ability has a legal target right now (own king on
  // the board, and at least one matching target square). Disables the
  // corresponding Use button when false.
  availableW: boolean;
  availableB: boolean;
  onPickW: (h: HeroKind) => void;
  onPickB: (h: HeroKind) => void;
  armed: 'w' | 'b' | null;
  onArm: (c: 'w' | 'b') => void;
  onCancel: () => void;
}) {
  return (
    <div className="hero-panel compact sandbox-hero">
      <div className="hero-panel-title">Heroes</div>
      <div className="hero-side-pickers">
        <label className="hero-side-picker">
          <span className="sandbox-king-label" aria-label="White">
            {renderPiece('wK', 22)}
          </span>
          <CustomSelect<HeroKind>
            value={heroW}
            options={HERO_KINDS.map((h) => ({ value: h, label: HERO_INFO[h].name }))}
            onChange={(next) => onPickW(next)}
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
            onChange={(next) => onPickB(next)}
            data-no-sfx
          />
        </label>
      </div>

      <div className="sandbox-hero-actions">
        {(['w', 'b'] as const).map((c) => {
          const isArmed = armed === c;
          const hero = c === 'w' ? heroW : heroB;
          const available = c === 'w' ? availableW : availableB;
          return (
            <button
              key={c}
              type="button"
              className={`${isArmed ? 'secondary-btn' : 'primary-btn'} sandbox-hero-btn`}
              data-no-sfx
              disabled={!isArmed && !available}
              onClick={() => (isArmed ? onCancel() : onArm(c))}
              aria-label={`${isArmed ? 'Cancel' : 'Use'} ${c === 'w' ? 'white' : 'black'} ability (${HERO_INFO[hero].name})`}
            >
              <span className="sandbox-hero-btn-king" aria-hidden>{renderPiece(c === 'w' ? 'wK' : 'bK', 20)}</span>
              <span>{isArmed ? 'Cancel' : HERO_INFO[hero].name}</span>
            </button>
          );
        })}
      </div>

      <div className="hero-panel-hint muted small">
        {armed
          ? 'Click a square to fire the ability.'
          : (!availableW && !availableB)
            ? 'No legal ability targets.'
            : 'Abilities have no cooldown in sandbox.'}
      </div>
    </div>
  );
}

