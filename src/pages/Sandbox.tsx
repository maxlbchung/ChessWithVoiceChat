import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { Chess } from 'chess.js';
import { HOLLOW_PURPLE_DRIFT_MS, MergeBoard } from '../components/MergeBoard';
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
  buyUci,
  legalMovesFrom as cashLegalFrom,
  isInCheck as cashIsInCheck,
  isCheckmate as cashIsCheckmate,
} from '../lib/cashChess';
import {
  initialState as heroInitial,
  backRanksForGame,
  abilityUci,
  legalMovesFrom as heroLegalFrom,
  abilityTargets as heroAbilityTargets,
  goofballLegalDestinations,
  twinJutsuLegalDestinations,
  flightLegalDestinations,
  slimeLegalDestinations,
  slimeShiftOptions,
  type SlimeShiftOption,
  isInCheck as heroIsInCheck,
  isCheckmate as heroIsCheckmate,
  HERO_INFO,
  HERO_KINDS,
  kingSquareOf,
  idxToSq as heroIdxToSq,
  type HeroKind,
} from '../lib/heroChess';
import type { AbilityAnim } from '../components/MergeBoard';
import { renderPiece, renderNeutralKing, lettersToPieceKeys } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';
import { useSettingsStore } from '../store/settingsStore';
import { downloadSandboxPng } from '../lib/sandboxExport';
import { buildGameExport, downloadGameExport } from '../lib/gameExport';
import type { Move } from '../lib/types';
import type { DisplaySnapshot } from '../lib/replayView';

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
  // Twin-Jutsu mask flags per square. True iff the piece on that square is
  // hidden from the opponent (rendered as a king icon). Sandbox treats this
  // purely visually: moves / placements clear the flag on the touched squares,
  // and the swap ability re-masks both endpoints.
  masked: boolean[];
  // Squares stunned by a Juggernaut quake leap. Purely visual in sandbox
  // (no ply counter to expire them) — markers clear when the piece moves or
  // is deleted, same bookkeeping as frozenIdxs.
  stunnedIdxs: number[];
  explosiveIdxs: number[];
  // UCI-ish action that produced this state from the previous one. Used only
  // for Export Game so sandbox exports match normal game JSON.
  moveUci?: string;
};

// Piece sets per variant, in the order they appear in the palette (top→bottom).
type PaletteSpec = Record<'w' | 'b', string[]>;
const standardPalette: PaletteSpec = {
  w: ['K', 'Q', 'R', 'B', 'N', 'P'],
  b: ['K', 'Q', 'R', 'B', 'N', 'P'],
};
const PALETTE_LETTERS: Record<SandboxVariant, PaletteSpec> = {
  normal: standardPalette,
  two: standardPalette,
  cash: standardPalette,
  hero: standardPalette,
  // Merge exposes the three combo pieces too — chancellor (R+N),
  // archbishop (B+N), amazon (Q+N).
  merge: {
    w: ['K', 'Q', 'C', 'A', 'Z', 'R', 'B', 'N', 'P'],
    b: ['K', 'Q', 'C', 'A', 'Z', 'R', 'B', 'N', 'P'],
  },
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
  // Twin-Jutsu sides start on a randomly shuffled back rank, mirroring real
  // games. Sandbox is freeform, so an ephemeral random seed is fine.
  return heroInitial(
    heroW, heroB,
    backRanksForGame(heroW, heroB, Math.random().toString(36).slice(2)),
  ).board.slice() as unknown as (MergePiece | null)[];
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
// Stun markers share the freeze bookkeeping shape (move follows the piece,
// clear drops the marker).
const stunnedAfterMove = frozenAfterMove;
const stunnedAfterClear = frozenAfterClear;
const explosiveAfterMove = frozenAfterMove;
const explosiveAfterClear = frozenAfterClear;

function freshState(variant: SandboxVariant, heroW: HeroKind, heroB: HeroKind): SandboxState {
  const board = initialBoard(variant, heroW, heroB);
  const masked = new Array(64).fill(false);
  if (variant === 'hero') {
    if (heroW === 'twin-jutsu') {
      for (let i = 0; i < 64; i++) if (board[i]?.color === 'w') masked[i] = true;
    }
    if (heroB === 'twin-jutsu') {
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
    stunnedIdxs: [],
    explosiveIdxs: [],
  };
}

function newSandboxGameId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `sandbox-${crypto.randomUUID()}`;
  } catch {
    /* fall through */
  }
  return `sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sandboxTimeControlId(variant: SandboxVariant): string {
  switch (variant) {
    case 'merge': return 'merge-blitz-5+0';
    case 'two': return 'two-blitz-5+0';
    case 'cash': return 'cash-blitz-5+0';
    case 'hero': return 'hero-blitz-5+0';
    default: return 'blitz-5+0';
  }
}

function moveFromUci(uci: string, index: number): Move {
  return {
    uci,
    fenAfter: '',
    ply: index + 1,
    whiteClockMs: 0,
    blackClockMs: 0,
  };
}

function heroBackRanksFromInitial(state: SandboxState): { w?: string; b?: string } | undefined {
  const out: { w?: string; b?: string } = {};
  if (state.heroW === 'twin-jutsu') {
    out.w = state.board.slice(56, 64).map((p) => p?.letter.toUpperCase() ?? 'K').join('');
  }
  if (state.heroB === 'twin-jutsu') {
    out.b = state.board.slice(0, 8).map((p) => p?.letter.toUpperCase() ?? 'K').join('');
  }
  return out.w || out.b ? out : undefined;
}

// Letter casing → color. 'K' = white king, 'k' = black king.
function colorOf(letter: string): 'w' | 'b' {
  return letter === letter.toUpperCase() ? 'w' : 'b';
}

function hasKing(board: (MergePiece | null)[], color: 'w' | 'b'): boolean {
  for (const p of board) {
    if (!p || p.color !== color) continue;
    const up = p.letter.toUpperCase();
    // Slime big-king tiles count as king material.
    if (up === 'K' || up === 'S') return true;
  }
  return false;
}

// Reconstruct Slime blob groups from raw board contents: any 2×2 block of
// same-color 'S' tiles forms a blob (scanned top-left first, each tile used
// once). Sandbox is freeform, so the engine's group bookkeeping isn't
// available — stray 'S' tiles that aren't part of a full block just render
// as single king sprites and stop moving as a blob.
function deriveSlimeGroups(board: (MergePiece | null)[]): { tiles: number[] }[] {
  const used = new Set<number>();
  const out: { tiles: number[] }[] = [];
  const isFreeS = (i: number, color: 'w' | 'b') => {
    const p = board[i];
    return !!p && p.color === color && p.letter.toUpperCase() === 'S' && !used.has(i);
  };
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      const i = row * 8 + col;
      const p = board[i];
      if (!p || p.letter.toUpperCase() !== 'S' || used.has(i)) continue;
      const tiles = [i, i + 1, i + 8, i + 9];
      if (tiles.every((t) => isFreeS(t, p.color))) {
        for (const t of tiles) used.add(t);
        out.push({ tiles });
      }
    }
  }
  return out;
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
  jugTier?: { w: number; b: number },
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
      const state = {
        ...heroInitial(heroW, heroB),
        board: board as any,
        turn: color,
        slimes: deriveSlimeGroups(board),
        ...(jugTier ? { jugTier } : {}),
      };
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
  jugTier?: { w: number; b: number },
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
      const state = {
        ...heroInitial(heroW, heroB),
        board: board as any,
        turn: color,
        slimes: deriveSlimeGroups(board),
        ...(jugTier ? { jugTier } : {}),
      };
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
  jugTier?: { w: number; b: number },
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
      const state = {
        ...heroInitial(heroW, heroB),
        board: board as any,
        turn: color,
        enPassant,
        slimes: deriveSlimeGroups(board),
        ...(jugTier ? { jugTier } : {}),
      };
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
  // Juggernaut tier dials (1-3) — like the hero kinds, not undoable. They
  // drive movement / abilities / check immunity for a Juggernaut side, and
  // tick up automatically when a sandbox capture attempt feeds the boss.
  const [jugTierW, setJugTierW] = useState(1);
  const [jugTierB, setJugTierB] = useState(1);
  const jugTiers = { w: jugTierW, b: jugTierB };

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
  // Twin-Jutsu is also two-click: first click picks one of the active side's
  // own pieces, second click picks the swap partner.
  const [twinJutsuFrom, setTwinJutsuFrom] = useState<number | null>(null);
  // Flight is two-click too: first click picks one of the active side's own
  // pieces, second click picks the empty destination square.
  const [flightFrom, setFlightFrom] = useState<number | null>(null);
  // Slime too: first click picks a mini king, second click picks the diagonal
  // corner of the 2×2 quadrant it expands into.
  const [slimeFrom, setSlimeFrom] = useState<number | null>(null);
  // Goofball / Twin-Jutsu / Flight promotions pause the flow for a picker,
  // just like a regular pawn move that reaches the back rank.
  const [pendingAbilityPromo, setPendingAbilityPromo] = useState<{
    hero: 'goofball' | 'twin-jutsu' | 'flight';
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
      setTwinJutsuFrom(null);
      setFlightFrom(null);
      setSlimeFrom(null);
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
  const pushState = (next: SandboxState, moveUci?: string) => {
    // Layer a check / checkmate sound on top of the action sound played by
    // movePiece / spawnPiece / etc. — same as free play. Compute it from the
    // before→after transition so a check that was already present before the
    // change doesn't re-fire the SFX on every action.
    const wWasMate = inMate(variant, current.board, 'w', current.heroW, current.heroB, jugTiers);
    const bWasMate = inMate(variant, current.board, 'b', current.heroW, current.heroB, jugTiers);
    const wWasCheck = inCheck(variant, current.board, 'w', current.heroW, current.heroB, jugTiers);
    const bWasCheck = inCheck(variant, current.board, 'b', current.heroW, current.heroB, jugTiers);
    const wNowMate = inMate(variant, next.board, 'w', next.heroW, next.heroB, jugTiers);
    const bNowMate = inMate(variant, next.board, 'b', next.heroW, next.heroB, jugTiers);
    const wNowCheck = inCheck(variant, next.board, 'w', next.heroW, next.heroB, jugTiers);
    const bNowCheck = inCheck(variant, next.board, 'b', next.heroW, next.heroB, jugTiers);
    if ((wNowMate && !wWasMate) || (bNowMate && !bWasMate)) {
      sfx.playWin();
    } else if ((wNowCheck && !wWasCheck) || (bNowCheck && !bWasCheck)) {
      sfx.playCheck();
    }
    setHistory((h) => {
      const trunc = h.slice(0, viewPly + 1);
      return [...trunc, { ...next, moveUci }];
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
    setHistory((h) => [...h.slice(0, viewPly + 1), { ...current, board: emptyBoard(), frozenIdxs: [], stunnedIdxs: [], explosiveIdxs: [], enPassant: null, masked: new Array(64).fill(false), moveUci: undefined }]);
    setViewPly((p) => p + 1);
    setSelectedSq(null);
    setShopArmed(null);
    setAbilityArmed(null);
    setAnnotationsClearKey((k) => k + 1);
  };

  // Spawn a piece on the board (palette → drop, or shop-letter → click).
  const spawnPiece = (letter: PieceLetter, sq: string, moveUci?: string) => {
    const idx = mergeSqToIdx(sq);
    const nextBoard = current.board.slice();
    nextBoard[idx] = { color: colorOf(letter), letter };
    const nextMasked = current.masked.slice();
    nextMasked[idx] = false;
    pushState({
      ...current,
      board: nextBoard,
      frozenIdxs: frozenAfterClear(current.frozenIdxs, idx),
      stunnedIdxs: stunnedAfterClear(current.stunnedIdxs, idx),
      explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, idx),
      enPassant: null,
      masked: nextMasked,
    }, moveUci);
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
    const uci = from + to;

    // Juggernaut absorb (hero variant): capturing a sub-tier-3 Juggernaut
    // kills the attacker and feeds the boss a tier — mirror the live engine.
    if (variant === 'hero' && target && target.color !== moving.color && target.letter.toUpperCase() === 'K') {
      const side = target.color === 'w' ? current.heroW : current.heroB;
      const tier = target.color === 'w' ? jugTierW : jugTierB;
      if (side === 'juggernaut' && tier < 3) {
        const nextBoard = current.board.slice();
        nextBoard[fromIdx] = null;
        const nextMasked = current.masked.slice();
        nextMasked[fromIdx] = false;
        pushState({
          ...current,
          board: nextBoard,
          frozenIdxs: frozenAfterClear(current.frozenIdxs, fromIdx),
          stunnedIdxs: stunnedAfterClear(current.stunnedIdxs, fromIdx),
          explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, fromIdx),
          enPassant: null,
          masked: nextMasked,
        }, uci);
        (target.color === 'w' ? setJugTierW : setJugTierB)((t) => Math.min(3, t + 1));
        window.setTimeout(() => sfx.playJugQuake(), 320);
        if (animationsEnabled) {
          // Doomed attacker slides onto the (unmoving) Juggernaut and bursts.
          setAbilityAnim({
            kind: 'jug-absorb',
            fromSq: from,
            toSq: to,
            color: target.color,
            flyerLetter: moving.letter,
            key: `jug-absorb-${Date.now()}`,
          });
        }
        return true;
      }
    }

    // Slime blob shift: moving a big-king tile one square moves the whole
    // 2×2 blob, crushing enemy pieces on the squares it enters (own pieces
    // block). Longer drags fall through to the freeform single-tile move
    // below — sandbox is "no rules", so tearing a tile off the blob is fine.
    if (moving.letter.toUpperCase() === 'S') {
      const groups = deriveSlimeGroups(current.board);
      const group = groups.find((g) => g.tiles.includes(fromIdx));
      const df = (toIdx % 8) - (fromIdx % 8);
      const dr = Math.floor(toIdx / 8) - Math.floor(fromIdx / 8);
      if (group && Math.abs(df) <= 1 && Math.abs(dr) <= 1 && !group.tiles.includes(toIdx)) {
        const shifted = group.tiles.map((t) => {
          const f = (t % 8) + df;
          const r = Math.floor(t / 8) + dr;
          return f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1;
        });
        const blocked = shifted.some((t) => {
          if (t === -1) return true;
          if (group.tiles.includes(t)) return false;
          const occ = current.board[t];
          return !!occ && occ.color === moving.color;
        });
        if (blocked) return false;
        const nextBoard = current.board.slice();
        const nextMasked = current.masked.slice();
        let nextFrozen = current.frozenIdxs;
        let captured = false;
        let split = false;
        for (const t of shifted) {
          if (group.tiles.includes(t)) continue;
          const victim = nextBoard[t];
          if (victim) {
            captured = true;
            // Crushing an enemy big-king tile splits that blob into minis.
            // Groups derived up-front: a second tile of the same blob hit in
            // this shift is already a mini by the time we reach it.
            if (victim.letter.toUpperCase() === 'S') {
              split = true;
              const vGroup = groups.find((g) => g.tiles.includes(t));
              if (vGroup) {
                for (const vt of vGroup.tiles) {
                  const vp = nextBoard[vt];
                  if (vt !== t && vp && vp.letter.toUpperCase() === 'S') {
                    nextBoard[vt] = { color: vp.color, letter: (vp.color === 'w' ? 'K' : 'k') as PieceLetter };
                  }
                }
              }
            }
            nextBoard[t] = null;
            nextFrozen = frozenAfterClear(nextFrozen, t);
          }
        }
        for (const t of group.tiles) {
          if (!shifted.includes(t)) { nextBoard[t] = null; nextMasked[t] = false; }
        }
        for (const t of shifted) {
          nextBoard[t] = { color: moving.color, letter: moving.letter };
          nextMasked[t] = false;
        }
        pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null, masked: nextMasked }, uci);
        if (split) sfx.playSlimeSplit();
        else if (captured) sfx.playCapture();
        else sfx.playMove();
        return true;
      }
      // Stray / long-distance drag — freeform single-tile move below.
    }

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
      pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null, masked: nextMasked }, uci);
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

    // Capturing a Slime big-king tile splits the rest of that blob into mini
    // kings, matching the live engine.
    if (target && target.color !== moving.color && target.letter.toUpperCase() === 'S') {
      const vGroup = deriveSlimeGroups(current.board).find((g) => g.tiles.includes(toIdx));
      if (vGroup) {
        for (const vt of vGroup.tiles) {
          const vp = nextBoard[vt];
          if (vt !== toIdx && vp && vp.letter.toUpperCase() === 'S') {
            nextBoard[vt] = { color: vp.color, letter: (vp.color === 'w' ? 'K' : 'k') as PieceLetter };
          }
        }
      }
    }

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
    let nextStunned = stunnedAfterMove(current.stunnedIdxs, fromIdx, toIdx);
    if (epCapturedIdx != null) nextStunned = stunnedAfterClear(nextStunned, epCapturedIdx);
    let nextExplosive = explosiveAfterMove(current.explosiveIdxs, fromIdx, toIdx);
    if (epCapturedIdx != null) nextExplosive = explosiveAfterClear(nextExplosive, epCapturedIdx);
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = false;
    nextMasked[toIdx] = false;
    if (epCapturedIdx != null) nextMasked[epCapturedIdx] = false;
    pushState({ ...current, board: nextBoard, frozenIdxs: nextFrozen, stunnedIdxs: nextStunned, explosiveIdxs: nextExplosive, enPassant: nextEnPassant, masked: nextMasked }, uci);
    if (isMerge) sfx.playMerge();
    else if (target && target.color !== moving.color && target.letter.toUpperCase() === 'S') sfx.playSlimeSplit();
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
      stunnedIdxs: stunnedAfterClear(current.stunnedIdxs, idx),
      explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, idx),
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
    const nextExplosive = explosiveAfterMove(current.explosiveIdxs, fromIdx, toIdx);
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = false;
    nextMasked[toIdx] = false;
    pushState(
      { ...current, board: nextBoard, frozenIdxs: nextFrozen, explosiveIdxs: nextExplosive, enPassant: null, masked: nextMasked },
      abilityUci('goofball', targetSq, heroIdxToSq(fromIdx), promoLetter),
    );
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

  // Commit a resolved Twin-Jutsu swap. promoLetter applies to whichever
  // endpoint pawn lands on its promo rank.
  const commitTwinJutsu = (
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
    const aExplosive = current.explosiveIdxs.includes(fromIdx);
    const bExplosive = current.explosiveIdxs.includes(toIdx);
    const nextExplosive = current.explosiveIdxs.filter((idx) => idx !== fromIdx && idx !== toIdx);
    if (aExplosive) nextExplosive.push(toIdx);
    if (bExplosive) nextExplosive.push(fromIdx);
    pushState(
      { ...current, board: nextBoard, frozenIdxs: current.frozenIdxs, explosiveIdxs: nextExplosive, enPassant: null, masked: nextMasked },
      abilityUci('twin-jutsu', targetSq, heroIdxToSq(fromIdx), promoLetter),
    );
    sfx.playTwinJutsu();
    if (animationsEnabled) {
      setSlideAnim({
        moves: [
          { from: heroIdxToSq(fromIdx), to: targetSq },
          { from: targetSq, to: heroIdxToSq(fromIdx) },
        ],
        key: Date.now(),
      });
    }
    setTwinJutsuFrom(null);
    setAbilityArmed(null);
  };

  // Commit a resolved Flight teleport. promoLetter applies when the flyer
  // is a pawn landing on its promo rank.
  const commitFlight = (
    color: 'w' | 'b', fromIdx: number, toIdx: number, targetSq: string,
    promoLetter?: PromotionLetter,
  ) => {
    const piece = current.board[fromIdx];
    if (!piece) { setFlightFrom(null); setAbilityArmed(null); return; }
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
    const nextExplosive = explosiveAfterMove(current.explosiveIdxs, fromIdx, toIdx);
    const nextMasked = current.masked.slice();
    nextMasked[fromIdx] = false;
    nextMasked[toIdx] = false;
    pushState(
      { ...current, board: nextBoard, frozenIdxs: nextFrozen, explosiveIdxs: nextExplosive, enPassant: null, masked: nextMasked },
      abilityUci('flight', targetSq, heroIdxToSq(fromIdx), promoLetter),
    );
    sfx.playFly();
    if (animationsEnabled) {
      setAbilityAnim({
        kind: 'flight',
        fromSq: heroIdxToSq(fromIdx),
        toSq: targetSq,
        color,
        flyerLetter: piece.letter,
        key: `flight-${Date.now()}`,
      });
    }
    setFlightFrom(null);
    setAbilityArmed(null);
  };

  // Commit a resolved Slime expansion: the mini king at fromIdx grows into
  // the 2×2 quadrant whose far corner is toIdx (validated empty by
  // slimeLegalDestinations through heroLegalAbilityTargets).
  const commitSlimeExpand = (color: 'w' | 'b', fromIdx: number, toIdx: number) => {
    const piece = current.board[fromIdx];
    if (!piece) { setSlimeFrom(null); setAbilityArmed(null); return; }
    const fCol = fromIdx % 8, fRow = Math.floor(fromIdx / 8);
    const cCol = toIdx % 8, cRow = Math.floor(toIdx / 8);
    const tiles = [fromIdx, fRow * 8 + cCol, cRow * 8 + fCol, toIdx];
    const letter = (color === 'w' ? 'S' : 's') as PieceLetter;
    const nextBoard = current.board.slice();
    const nextMasked = current.masked.slice();
    for (const t of tiles) {
      nextBoard[t] = { color, letter };
      nextMasked[t] = false;
    }
    pushState({
      ...current,
      board: nextBoard,
      frozenIdxs: frozenAfterClear(current.frozenIdxs, fromIdx),
      explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, fromIdx),
      enPassant: null,
      masked: nextMasked,
    }, abilityUci('slime', heroIdxToSq(toIdx), heroIdxToSq(fromIdx)));
    sfx.playSlimeExpand();
    if (animationsEnabled) {
      setAbilityAnim({
        kind: 'slime-expand',
        fromSq: heroIdxToSq(fromIdx),
        toSq: heroIdxToSq(toIdx),
        color,
        key: `slime-expand-${Date.now()}`,
      });
    }
    setSlimeFrom(null);
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
    } else if (hero === 'flight') {
      commitFlight(color, fromIdx, toIdx, heroIdxToSq(toIdx), valid);
    } else {
      commitTwinJutsu(color, fromIdx, toIdx, heroIdxToSq(toIdx), valid);
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

    // Twin-Jutsu: two-click swap. First click picks one of the active side's
    // own pieces, second click picks the swap partner. Both endpoints end up
    // masked after.
    if (hero === 'twin-jutsu') {
      if (twinJutsuFrom == null) {
        if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
        setTwinJutsuFrom(idx);
        sfx.playSelect();
        return;
      }
      if (!heroLegalAbilityTargets.has(idx)) { setTwinJutsuFrom(null); return; }
      // Detect pawn-to-back-rank in the swap. At most one of the two
      // endpoints can land on a promo rank (a pawn can't be on its own
      // promo rank pre-swap because it would've already promoted).
      const aPiece = current.board[twinJutsuFrom];
      const bPiece = current.board[idx];
      // After swap: aPiece sits on `idx`, bPiece sits on `twinJutsuFrom`.
      const aLandsRow = Math.floor(idx / 8);
      const bLandsRow = Math.floor(twinJutsuFrom / 8);
      let promoIdx: number | null = null;
      let promoSq: string | null = null;
      let promoColor: 'w' | 'b' | null = null;
      if (aPiece && aPiece.letter.toUpperCase() === 'P'
          && ((aPiece.color === 'w' && aLandsRow === 0) || (aPiece.color === 'b' && aLandsRow === 7))) {
        promoIdx = idx; promoSq = targetSq; promoColor = aPiece.color;
      } else if (bPiece && bPiece.letter.toUpperCase() === 'P'
          && ((bPiece.color === 'w' && bLandsRow === 0) || (bPiece.color === 'b' && bLandsRow === 7))) {
        promoIdx = twinJutsuFrom; promoSq = heroIdxToSq(twinJutsuFrom); promoColor = bPiece.color;
      }
      if (promoIdx != null && promoSq && promoColor) {
        setPendingAbilityPromo({
          hero: 'twin-jutsu',
          color,
          fromIdx: twinJutsuFrom,
          toIdx: idx,
          pickerSquare: promoSq,
          pawnColor: promoColor,
        });
        return;
      }
      commitTwinJutsu(color, twinJutsuFrom, idx, targetSq);
      return;
    }

    // Flight: two-click teleport. First click picks one of the active side's
    // own pieces, second click picks the empty destination square.
    if (hero === 'flight') {
      if (flightFrom == null) {
        if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
        setFlightFrom(idx);
        sfx.playSelect();
        return;
      }
      if (!heroLegalAbilityTargets.has(idx)) {
        // Click off a legal destination resets to the pick-a-piece state.
        setFlightFrom(null);
        return;
      }
      const piece = current.board[flightFrom];
      if (!piece) { setFlightFrom(null); setAbilityArmed(null); return; }
      const isPawn = piece.letter.toUpperCase() === 'P';
      const destRow = Math.floor(idx / 8); // 0 = rank 8, 7 = rank 1
      if (isPawn && ((piece.color === 'w' && destRow === 0) || (piece.color === 'b' && destRow === 7))) {
        // Pause for the picker — same flow as a regular pawn promotion.
        setPendingAbilityPromo({
          hero: 'flight',
          color,
          fromIdx: flightFrom,
          toIdx: idx,
          pickerSquare: targetSq,
          pawnColor: piece.color,
        });
        return;
      }
      commitFlight(color, flightFrom, idx, targetSq);
      return;
    }

    // Slime: two-click expansion. First click picks a mini king of the armed
    // side, second click picks the diagonal corner of the quadrant.
    if (hero === 'slime') {
      if (slimeFrom == null) {
        if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
        setSlimeFrom(idx);
        sfx.playSelect();
        return;
      }
      if (!heroLegalAbilityTargets.has(idx)) {
        // Click off a legal corner resets to the pick-a-king state.
        setSlimeFrom(null);
        return;
      }
      commitSlimeExpand(color, slimeFrom, idx);
      return;
    }

    // Juggernaut: single-click, tier-dependent (tier comes from the dial).
    // Tier 1 fires an earthquake (sandbox spawns the wave in place and
    // also kills any enemy on the spawn square — without ply tracking the
    // wave doesn't auto-advance here); tier 2 charges along any queen
    // direction (cardinal or diagonal) to the board edge, flattening the
    // path; tier 3 slams (destroys radius 1, stuns radius 2).
    if (hero === 'juggernaut') {
      if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
      const tier = color === 'w' ? jugTierW : jugTierB;
      // The Juggernaut is this side's first (normally only) king.
      let k = -1;
      for (let i = 0; i < 64; i++) {
        const p = current.board[i];
        if (p && p.color === color && p.letter.toUpperCase() === 'K') { k = i; break; }
      }
      const nextBoard = current.board.slice();
      const nextMasked = current.masked.slice();
      let nextFrozen = current.frozenIdxs;
      let nextStunned = current.stunnedIdxs;
      if (tier === 1) {
        // Earthquake spawn: kill any enemy on the chosen adjacent square.
        // (Sandbox doesn't simulate the wave creeping further.)
        const p = nextBoard[idx];
        if (p && p.color !== color) {
          nextBoard[idx] = null;
          nextFrozen = frozenAfterClear(nextFrozen, idx);
          nextStunned = stunnedAfterClear(nextStunned, idx);
          nextMasked[idx] = false;
        }
        if (animationsEnabled) setPopAnim({ squares: [targetSq], key: Date.now() });
      } else if (tier === 2) {
        if (k === -1) { setAbilityArmed(null); return; }
        // Edge charge: flatten every square between the Juggernaut and the
        // chosen edge-most tile along any queen direction (Slime tiles
        // split as they're crushed). Math.sign supports cardinal directions
        // (one delta is 0) alongside the diagonals.
        const kCol = k % 8, kRow = Math.floor(k / 8);
        const tCol = idx % 8, tRow = Math.floor(idx / 8);
        const dCol = Math.sign(tCol - kCol);
        const dRow = Math.sign(tRow - kRow);
        const groups = deriveSlimeGroups(current.board);
        nextBoard[k] = null;
        nextMasked[k] = false;
        let c2 = kCol + dCol, r2 = kRow + dRow;
        while (c2 >= 0 && c2 < 8 && r2 >= 0 && r2 < 8) {
          const pIdx = r2 * 8 + c2;
          const victim = nextBoard[pIdx];
          if (victim) {
            if (victim.letter.toUpperCase() === 'S') {
              const vGroup = groups.find((g) => g.tiles.includes(pIdx));
              if (vGroup) {
                for (const vt of vGroup.tiles) {
                  const vp = nextBoard[vt];
                  if (vt !== pIdx && vp && vp.letter.toUpperCase() === 'S') {
                    nextBoard[vt] = { color: vp.color, letter: (vp.color === 'w' ? 'K' : 'k') as PieceLetter };
                  }
                }
              }
            }
            nextBoard[pIdx] = null;
            nextFrozen = frozenAfterClear(nextFrozen, pIdx);
            nextStunned = stunnedAfterClear(nextStunned, pIdx);
          }
          nextMasked[pIdx] = false;
          if (pIdx === idx) break;
          c2 += dCol; r2 += dRow;
        }
        nextBoard[idx] = current.board[k];
        if (animationsEnabled) setSlideAnim({ moves: [{ from: heroIdxToSq(k), to: targetSq }], key: Date.now() });
      } else {
        if (k === -1) { setAbilityArmed(null); return; }
        // Slam: destroy at chebyshev distance 1, stun at distance 2.
        const kCol = k % 8, kRow = Math.floor(k / 8);
        for (let dc = -2; dc <= 2; dc++) {
          for (let dr = -2; dr <= 2; dr++) {
            if (dc === 0 && dr === 0) continue;
            const c2 = kCol + dc, r2 = kRow + dr;
            if (c2 < 0 || c2 > 7 || r2 < 0 || r2 > 7) continue;
            const aIdx = r2 * 8 + c2;
            const dist = Math.max(Math.abs(dc), Math.abs(dr));
            if (dist === 1) {
              if (nextBoard[aIdx]) {
                nextBoard[aIdx] = null;
                nextFrozen = frozenAfterClear(nextFrozen, aIdx);
                nextStunned = stunnedAfterClear(nextStunned, aIdx);
              }
              nextMasked[aIdx] = false;
            } else if (dist === 2) {
              const v = nextBoard[aIdx];
              if (v && !nextStunned.includes(aIdx)) {
                const up = v.letter.toUpperCase();
                if (up !== 'K' && up !== 'S') {
                  nextStunned = [...nextStunned, aIdx];
                }
              }
            }
          }
        }
        // Slam routes the overlay through 'jug-slam' (in-place leap +
        // amplified ground impact); skip the standard pop on this tier
        // so it doesn't clash with the leap-body scale animation.
      }
      pushState(
        { ...current, board: nextBoard, frozenIdxs: nextFrozen, enPassant: null, masked: nextMasked, stunnedIdxs: nextStunned },
        abilityUci('juggernaut', targetSq),
      );
      sfx.playJugQuake();
      if (animationsEnabled) {
        setAbilityAnim({
          kind: tier === 3 ? 'jug-slam' : 'juggernaut',
          toSq: targetSq,
          color,
          key: `jug-${Date.now()}`,
        });
      }
      setAbilityArmed(null);
      return;
    }

    // Gojo: single-click. The sandbox has no ply clock for the orb to drift
    // on, so Hollow Purple resolves its entire journey at once — everything
    // from the chosen adjacent square out to the board edge is annihilated,
    // this side's own pieces included (Slime tiles split as they're erased).
    if (hero === 'gojo') {
      if (!heroLegalAbilityTargets.has(idx)) { setAbilityArmed(null); return; }
      let k = -1;
      for (let i = 0; i < 64; i++) {
        const p = current.board[i];
        if (p && p.color === color && p.letter.toUpperCase() === 'K') { k = i; break; }
      }
      if (k === -1) { setAbilityArmed(null); return; }
      const nextBoard = current.board.slice();
      const nextMasked = current.masked.slice();
      let nextFrozen = current.frozenIdxs;
      let nextStunned = current.stunnedIdxs;
      let nextExplosive = current.explosiveIdxs;
      const groups = deriveSlimeGroups(current.board);
      const dCol = Math.sign((idx % 8) - (k % 8));
      const dRow = Math.sign(Math.floor(idx / 8) - Math.floor(k / 8));
      const swept: string[] = [];
      // Squares that actually held something — each gets a staggered blast so
      // the sweep reads as the orb travelling down the lane.
      const hits: { sq: string; letter: string }[] = [];
      let c2 = idx % 8, r2 = Math.floor(idx / 8);
      while (c2 >= 0 && c2 < 8 && r2 >= 0 && r2 < 8) {
        const pIdx = r2 * 8 + c2;
        const victim = nextBoard[pIdx];
        if (victim) {
          hits.push({ sq: heroIdxToSq(pIdx), letter: victim.letter });
          if (victim.letter.toUpperCase() === 'S') {
            const vGroup = groups.find((g) => g.tiles.includes(pIdx));
            if (vGroup) {
              for (const vt of vGroup.tiles) {
                const vp = nextBoard[vt];
                if (vt !== pIdx && vp && vp.letter.toUpperCase() === 'S') {
                  nextBoard[vt] = { color: vp.color, letter: (vp.color === 'w' ? 'K' : 'k') as PieceLetter };
                }
              }
            }
          }
          nextBoard[pIdx] = null;
          nextFrozen = frozenAfterClear(nextFrozen, pIdx);
          nextStunned = stunnedAfterClear(nextStunned, pIdx);
          nextExplosive = explosiveAfterClear(nextExplosive, pIdx);
        }
        nextMasked[pIdx] = false;
        swept.push(heroIdxToSq(pIdx));
        c2 += dCol; r2 += dRow;
      }
      pushState({
        ...current,
        board: nextBoard,
        frozenIdxs: nextFrozen,
        stunnedIdxs: nextStunned,
        explosiveIdxs: nextExplosive,
        masked: nextMasked,
        enPassant: null,
      }, abilityUci('gojo', targetSq));
      sfx.playHollowPurple();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'gojo', toSq: targetSq, color, key: `gojo-${Date.now()}` });
        setPopAnim({ squares: swept, key: Date.now() });
        // Walk a blast down the lane, one per victim, at the same cadence the
        // orb would drift at in a real game — and hold each victim's sprite
        // until its own blast fires.
        if (hits.length > 0) setDoomedPieces((prev) => [...prev, ...hits]);
        hits.forEach((hit, i) => {
          window.setTimeout(() => {
            setAbilityAnim({
              kind: 'gojo-blast',
              toSq: hit.sq,
              color,
              key: `gojo-blast-${hit.sq}-${i}-${Date.now()}`,
            });
            sfx.playHollowPurpleHit();
            setDoomedPieces((prev) => prev.filter((d) => d.sq !== hit.sq));
          }, HOLLOW_PURPLE_DRIFT_MS + i * 240);
        });
      }
      setAbilityArmed(null);
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
      pushState({ ...current, frozenIdxs: nextFrozen, enPassant: null }, alreadyFrozen ? undefined : abilityUci('frost', targetSq));
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
        explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, idx),
        enPassant: null,
      }, abilityUci('warlord', targetSq));
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
      pushState({ ...current, board: nextBoard, enPassant: null }, abilityUci('necromancer', targetSq));
      sfx.playSpawn();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'necromancer', toSq: targetSq, color, key: `necro-${Date.now()}` });
        // Pop the freshly spawned pawn in so it matches HeroGame's behaviour.
        setPopAnim({ squares: [targetSq], key: Date.now() });
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
      pushState({ ...current, board: nextBoard, enPassant: null }, abilityUci('mutation', targetSq));
      sfx.playMutate();
      if (animationsEnabled) {
        setAbilityAnim({ kind: 'mutation', toSq: targetSq, color, key: `mut-${Date.now()}` });
        setPopAnim({ squares: [targetSq], key: Date.now() });
      }
    } else if (hero === 'kamakaze') {
      if (!targetPiece || targetPiece.color !== color) return;
      if (current.explosiveIdxs.includes(idx)) return;
      pushState({
        ...current,
        explosiveIdxs: [...current.explosiveIdxs, idx],
        enPassant: null,
      }, abilityUci('kamakaze', targetSq));
      sfx.playKamakazeArm();
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
        explosiveIdxs: explosiveAfterClear(current.explosiveIdxs, idx),
        enPassant: null,
      }, abilityUci('icbm', targetSq));
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
      spawnPiece(letterCased, sq, buyUci(shopArmed.letter as Parameters<typeof buyUci>[0], sq));
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
    if (inMate(variant, current.board, 'w', current.heroW, current.heroB, jugTiers)) return { winner: 'b' };
    if (inMate(variant, current.board, 'b', current.heroW, current.heroB, jugTiers)) return { winner: 'w' };
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
    const changedWithPiece: number[] = [];
    for (let i = 0; i < 64; i++) {
      const a = prev.board[i];
      const b = current.board[i];
      const same = (!a && !b) || (a && b && a.color === b.color && a.letter === b.letter);
      if (same) continue;
      if (!b) { emptied++; fromIdx = i; }
      else { arrived++; toIdx = i; changedWithPiece.push(i); }
    }
    if (emptied === 1 && arrived === 1) {
      return { from: heroIdxToSq(fromIdx), to: heroIdxToSq(toIdx) };
    }
    // Twin-Jutsu swap: both endpoints still hold a piece, so the generic
    // from/to diff above doesn't match. Only tint an endpoint whose piece was
    // already revealed (unmasked) before the swap — tinting a hidden piece's
    // square would leak which decoys swapped. Two hidden pieces swapping
    // shows no tint at all.
    if (emptied === 0 && arrived === 2) {
      const revealed = changedWithPiece.filter((i) => prev.board[i] && !prev.masked[i]);
      if (revealed.length === 2) return { from: heroIdxToSq(revealed[0]), to: heroIdxToSq(revealed[1]) };
      if (revealed.length === 1) {
        const sq = heroIdxToSq(revealed[0]);
        return { from: sq, to: sq };
      }
      return null;
    }
    return null;
  }, [viewPly, history, current]);

  // Engine-driven set of legal ability target indices for the armed side.
  // Empty when no ability is armed or the engine can't determine targets.
  // Knight/Necromancer require an own king; Frost excludes kings. For the
  // two-click abilities (Goofball / Twin-Jutsu / Flight), once a from-square
  // has been picked the set flips from "pickable pieces" to "legal
  // destinations for the picked piece".
  const heroLegalAbilityTargets = useMemo<Set<number>>(() => {
    if (variant !== 'hero' || !abilityArmed) return new Set();
    try {
      const state = {
        ...heroInitial(current.heroW, current.heroB),
        board: current.board as any,
        turn: abilityArmed,
        masked: current.masked,
        slimes: deriveSlimeGroups(current.board),
        jugTier: jugTiers,
        explosives: current.explosiveIdxs,
      };
      const armedHero = abilityArmed === 'w' ? current.heroW : current.heroB;
      if (armedHero === 'goofball' && goofballFrom != null) {
        return new Set(goofballLegalDestinations(state as any, goofballFrom));
      }
      if (armedHero === 'twin-jutsu' && twinJutsuFrom != null) {
        return new Set(twinJutsuLegalDestinations(state as any, twinJutsuFrom));
      }
      if (armedHero === 'flight' && flightFrom != null) {
        return new Set(flightLegalDestinations(state as any, flightFrom));
      }
      if (armedHero === 'slime' && slimeFrom != null) {
        return new Set(slimeLegalDestinations(state as any, slimeFrom));
      }
      return new Set(heroAbilityTargets(state as any));
    } catch {
      return new Set();
    }
  }, [variant, abilityArmed, current, goofballFrom, twinJutsuFrom, flightFrom, slimeFrom, jugTierW, jugTierB]);

  // Whole-blob shift options when a Slime big-king tile is selected — drives
  // the direction-arrow UI and click resolution (same synthetic-state recipe
  // as engineLegalTargets).
  const sandboxSlimeShiftOpts = useMemo<SlimeShiftOption[]>(() => {
    if (variant !== 'hero' || abilityArmed || !selectedSq) return [];
    const idx = mergeSqToIdx(selectedSq);
    const p = current.board[idx];
    if (!p || p.letter.toUpperCase() !== 'S') return [];
    try {
      const state = {
        ...heroInitial(current.heroW, current.heroB),
        board: current.board as any,
        turn: p.color,
        masked: current.masked,
        slimes: deriveSlimeGroups(current.board),
        jugTier: jugTiers,
        explosives: current.explosiveIdxs,
      };
      return slimeShiftOptions(state as any, idx);
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, abilityArmed, selectedSq, current, jugTierW, jugTierB]);

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
    // Selected blob tile: every square the blob can slide onto is clickable;
    // MergeBoard suppresses the dots for these and draws direction arrows.
    if (sandboxSlimeShiftOpts.length > 0) {
      return sandboxSlimeShiftOpts.flatMap((o) => o.entered.map((i) => ({
        to: heroIdxToSq(i), isCapture: o.isCapture, isMerge: false,
      })));
    }
    // No king of the mover's color → check filtering is meaningless, so fall
    // back to raw patterns. Otherwise the variant's engine generates the
    // proper check-filtered legal moves.
    if (!hasKing(current.board, piece.color)) return patternTargets(variant, current.board, selectedSq);
    return engineLegalTargets(variant, current.board, selectedSq, current.heroW, current.heroB, current.enPassant, jugTiers);
  }, [selectedSq, variant, current, shopArmed, abilityArmed, heroLegalAbilityTargets, sandboxSlimeShiftOpts, jugTierW, jugTierB]);

  const frozenSquares = current.frozenIdxs.map((i) => heroIdxToSq(i));

  const kingGlows = variant === 'hero'
    ? {
        w: current.heroW === 'slime' ? undefined : HERO_INFO[current.heroW].glowColor,
        b: current.heroB === 'slime' ? undefined : HERO_INFO[current.heroB].glowColor,
      }
    : undefined;

  // Projection of the live board into the shared snapshot the canvas renderer
  // consumes (same shape Review/video use), so the PNG export reproduces the
  // squares, pieces, and every Hero overlay. Built lazily but memoized so the
  // export handler reads it straight off.
  const displaySnapshot = useMemo<DisplaySnapshot>(() => {
    const board = current.board;
    const slimeBigKings = deriveSlimeGroups(board)
      .map((g) => {
        const ref = board[g.tiles[0]];
        return ref ? { tiles: g.tiles.map(heroIdxToSq), color: ref.color } : null;
      })
      .filter((g): g is { tiles: string[]; color: 'w' | 'b' } => g !== null);
    const maskedAsKingSquares: string[] = [];
    for (let i = 0; i < 64; i++) if (current.masked[i]) maskedAsKingSquares.push(heroIdxToSq(i));
    const slimeKingSquares: string[] = [];
    const juggernauts: { sq: string; tier: number }[] = [];
    if (variant === 'hero') {
      for (let i = 0; i < 64; i++) {
        const p = board[i];
        if (!p || p.letter.toUpperCase() !== 'K') continue;
        const side = p.color === 'w' ? current.heroW : current.heroB;
        if (side === 'slime') slimeKingSquares.push(heroIdxToSq(i));
        else if (side === 'juggernaut') juggernauts.push({ sq: heroIdxToSq(i), tier: p.color === 'w' ? jugTierW : jugTierB });
      }
    }
    return {
      board,
      lastMove,
      kingGlows,
      frozenSquares,
      maskedAsKingSquares,
      slimeBigKings,
      slimeKingSquares,
      juggernauts,
      stunnedSquares: variant === 'hero' ? current.stunnedIdxs.map((i) => heroIdxToSq(i)) : [],
      explosiveSquares: variant === 'hero' ? current.explosiveIdxs.map((i) => heroIdxToSq(i)) : [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, variant, lastMove, kingGlows, frozenSquares, jugTierW, jugTierB]);

  const handleExportGame = () => {
    const moveUcis = history
      .slice(1, viewPly + 1)
      .map((state) => state.moveUci)
      .filter((uci): uci is string => typeof uci === 'string' && uci.length > 0);
    const startedAt = Date.now();
    const exp = buildGameExport({
      variant,
      gameId: newSandboxGameId(),
      timeControlId: sandboxTimeControlId(variant),
      white: { handle: 'Sandbox White', rating: 0 },
      black: { handle: 'Sandbox Black', rating: 0 },
      startedAt,
      endedAt: null,
      outcome: null,
      reason: null,
      moves: moveUcis.map(moveFromUci),
      ...(variant === 'hero' ? { heroes: { w: current.heroW, b: current.heroB } } : {}),
      ...(variant === 'hero' ? { heroBackRanks: heroBackRanksFromInitial(history[0]) } : {}),
    });
    downloadGameExport(exp);
    sfx.playSelect();
  };

  const handleExportPng = () => {
    sfx.playSelect();
    void downloadSandboxPng({ snapshot: displaySnapshot, orientation, variant })
      .catch((err) => console.error('Sandbox PNG export failed', err));
  };

  // For each side, can their hero ability fire? Defers to the engine's
  // `abilityTargets`, which encodes the full legality (own king present,
  // adjacency, a flyable piece for Flight, etc.).
  const heroAvailable = useMemo(() => {
    const check = (color: 'w' | 'b'): boolean => {
      try {
        const state = {
          ...heroInitial(current.heroW, current.heroB),
          board: current.board as any,
          turn: color,
          masked: current.masked,
          slimes: deriveSlimeGroups(current.board),
          jugTier: jugTiers,
          explosives: current.explosiveIdxs,
        };
        return heroAbilityTargets(state as any).length > 0;
      } catch {
        return false;
      }
    };
    return { w: check('w'), b: check('b') };
  }, [current, jugTierW, jugTierB]);

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
                : abilityArmed && twinJutsuFrom != null ? heroIdxToSq(twinJutsuFrom)
                : abilityArmed && flightFrom != null ? heroIdxToSq(flightFrom)
                : abilityArmed && slimeFrom != null ? heroIdxToSq(slimeFrom)
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
              slimeBigKings={deriveSlimeGroups(current.board)
                .map((g) => {
                  const ref = current.board[g.tiles[0]];
                  return ref ? { tiles: g.tiles.map(heroIdxToSq), color: ref.color } : null;
                })
                .filter((g): g is { tiles: string[]; color: 'w' | 'b' } => g !== null)}
              slimeKingSquares={(() => {
                if (variant !== 'hero') return [];
                const out: string[] = [];
                for (let i = 0; i < 64; i++) {
                  const p = current.board[i];
                  if (!p || p.letter.toUpperCase() !== 'K') continue;
                  const side = p.color === 'w' ? current.heroW : current.heroB;
                  if (side === 'slime') out.push(heroIdxToSq(i));
                }
                return out;
              })()}
              juggernauts={(() => {
                if (variant !== 'hero') return [];
                const out: { sq: string; tier: number }[] = [];
                for (let i = 0; i < 64; i++) {
                  const p = current.board[i];
                  if (!p || p.letter.toUpperCase() !== 'K') continue;
                  const side = p.color === 'w' ? current.heroW : current.heroB;
                  if (side === 'juggernaut') out.push({ sq: heroIdxToSq(i), tier: p.color === 'w' ? jugTierW : jugTierB });
                }
                return out;
              })()}
              stunnedSquares={variant === 'hero' ? current.stunnedIdxs.map((i) => heroIdxToSq(i)) : []}
              explosiveSquares={variant === 'hero' ? current.explosiveIdxs.map((i) => heroIdxToSq(i)) : []}
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
                  setTwinJutsuFrom(null);
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
            <button className="free-play-btn" type="button" onClick={handleExportGame} title="Download this position as JSON">Export Game</button>
            <button className="free-play-btn" type="button" onClick={handleExportPng} title="Download a PNG of the current board">Export PNG</button>
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
                    else if (h === 'twin-jutsu') sfx.playTwinJutsu();
                    else if (h === 'slime') sfx.playSlimeExpand();
                    else if (h === 'juggernaut') sfx.playJugQuake();
                    else if (h === 'kamakaze') sfx.playKamakazeArm();
                    else if (h === 'gojo') sfx.playHollowPurple();
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
                    else if (h === 'twin-jutsu') sfx.playTwinJutsu();
                    else if (h === 'slime') sfx.playSlimeExpand();
                    else if (h === 'juggernaut') sfx.playJugQuake();
                    else if (h === 'kamakaze') sfx.playKamakazeArm();
                    else if (h === 'gojo') sfx.playHollowPurple();
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
                jugTierW={jugTierW}
                jugTierB={jugTierB}
                onJugTierW={setJugTierW}
                onJugTierB={setJugTierB}
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
  letters: PaletteSpec;
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
              {letters[color].map((L) => {
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
  jugTierW,
  jugTierB,
  onJugTierW,
  onJugTierB,
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
  // Juggernaut tier dials — shown only when that side picked the Juggernaut.
  jugTierW: number;
  jugTierB: number;
  onJugTierW: (t: number) => void;
  onJugTierB: (t: number) => void;
}) {
  const tierOptions = [
    { value: '1', label: 'Tier 1 · Earthquake' },
    { value: '2', label: 'Tier 2 · Edge Charge' },
    { value: '3', label: 'Tier 3 · Slam' },
  ];
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
      {(heroW === 'juggernaut' || heroB === 'juggernaut') && (
        <div className="hero-side-pickers">
          {heroW === 'juggernaut' && (
            <label className="hero-side-picker">
              <span className="sandbox-king-label" aria-label="White Juggernaut tier">
                {renderNeutralKing(22)}
              </span>
              <CustomSelect<'1' | '2' | '3'>
                value={String(jugTierW) as '1' | '2' | '3'}
                options={tierOptions as { value: '1' | '2' | '3'; label: string }[]}
                onChange={(t) => onJugTierW(Number(t))}
                data-no-sfx
              />
            </label>
          )}
          {heroB === 'juggernaut' && (
            <label className="hero-side-picker">
              <span className="sandbox-king-label" aria-label="Black Juggernaut tier">
                {renderNeutralKing(22)}
              </span>
              <CustomSelect<'1' | '2' | '3'>
                value={String(jugTierB) as '1' | '2' | '3'}
                options={tierOptions as { value: '1' | '2' | '3'; label: string }[]}
                onChange={(t) => onJugTierB(Number(t))}
                data-no-sfx
              />
            </label>
          )}
        </div>
      )}

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
