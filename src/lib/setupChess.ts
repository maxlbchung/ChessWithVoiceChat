// Setup Chess — before the game starts, both players get 60 seconds
// (simultaneous, not turn-based) to arrange their standard army anywhere on
// their own half of the board: white on ranks 1–4, black on ranks 5–8.
// Opponent placements stay hidden until both sides have finalized; then the
// two halves are merged and a normal game of chess begins, white to move.
//
// Placement rules enforced here:
//   - exactly the standard army: 8 pawns, 2 knights, 2 bishops, 2 rooks,
//     1 queen, 1 king — the king must be placed;
//   - every piece on the owner's half (white ranks 1–4, black ranks 5–8);
//   - pawns may not sit on the owner's back rank (white rank 1 / black
//     rank 8), mirroring normal chess — there is no pawn move from there.
//
// Play-phase legality is delegated to chess.js, exactly like sweeperChess:
// the merged position is loaded as a FEN and every later position travels as
// a FEN snapshot. Decisions baked into that FEN:
//   - castling rights are "-": no castling in this mode (kings and rooks
//     start wherever their owners put them);
//   - en passant target starts "-", and chess.js maintains it normally
//     afterwards: a pawn may double-step only from its color's home rank
//     (rank 2 / rank 7), exactly as in normal chess, so a pawn placed on
//     rank 3 walks one square at a time. Double-steps made in play are
//     capturable en passant as usual.
//
// One wrinkle normal chess never has: the merged position can leave the side
// that is NOT to move (black) already attacked — you can't avoid aiming at a
// king you can't see. chess.js (1.0.0-beta) loads such positions and, since
// the attacked king is just another enemy piece to the move generator,
// offers its capture. We let that stand as the variant's rule: an exposed
// king may simply be taken, which ends the game at once (`kingCaptured`,
// same shape as sweeperChess's `mineLoss`). The resulting kingless FEN is
// never loaded back into chess.js — every terminal query guards on
// `kingCaptured` first. After white's first move the game is an ordinary
// chess position and this path never triggers again.

import { Chess } from 'chess.js';
import type { Piece, PieceLetter, Square } from './mergeChess';

export type { Piece, PieceLetter, Square };
export type SetupColor = 'w' | 'b';

// Wall-clock budget for the simultaneous setup phase. Independent from the
// main-game time control, which only starts ticking once play begins.
export const SETUP_PHASE_MS = 60_000;

// The standard army each side must place, as uppercase letters.
export const ARMY: Record<'P' | 'N' | 'B' | 'R' | 'Q' | 'K', number> = {
  P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1,
};
export const ARMY_ORDER: ('K' | 'Q' | 'R' | 'B' | 'N' | 'P')[] = ['K', 'Q', 'R', 'B', 'N', 'P'];

// ----------------------------------------------------------------------
// Square <-> index helpers (mirrors mergeChess so boards interop)
// ----------------------------------------------------------------------

export function sqToIdx(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  return (7 - rank) * 8 + file;
}

export function idxToSq(idx: number): Square {
  const file = idx % 8;
  const rank = 7 - Math.floor(idx / 8);
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}

function rankOfIdx(idx: number): number {
  return 8 - Math.floor(idx / 8); // 1..8
}

// True when `idx` is on `color`'s half of the board (white ranks 1–4,
// black ranks 5–8).
export function isOwnHalf(color: SetupColor, idx: number): boolean {
  const rank = rankOfIdx(idx);
  return color === 'w' ? rank <= 4 : rank >= 5;
}

// Placement legality for one piece type on one square: own half, and pawns
// off the owner's back rank.
export function canPlaceAt(color: SetupColor, letterUpper: string, idx: number): boolean {
  if (!isOwnHalf(color, idx)) return false;
  if (letterUpper === 'P') {
    const rank = rankOfIdx(idx);
    if (color === 'w' && rank === 1) return false;
    if (color === 'b' && rank === 8) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// Placement encoding
// ----------------------------------------------------------------------
// A side's finalized placement travels (and is stored) as a compact string of
// 3-char tokens: "<LETTER><square>", e.g. "Ke1Qd1Ra1…". Letters are always
// uppercase — the side is carried separately — and tokens are sorted by
// square index so the same placement always serializes identically.

export type Placement = Map<number, string>; // board idx -> uppercase letter

export function placementToString(placement: Placement): string {
  return [...placement.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, letter]) => letter + idxToSq(idx))
    .join('');
}

// Parses and fully validates a placement string for `color`. Returns null on
// anything malformed: wrong army composition, off-half squares, pawns on the
// back rank, duplicate squares. Both peers run this on the opponent's string,
// so a tampered client can't smuggle in an illegal army.
export function parsePlacement(color: SetupColor, str: string): Placement | null {
  if (typeof str !== 'string' || str.length !== 48) return null;
  const placement: Placement = new Map();
  const counts: Record<string, number> = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0 };
  for (let i = 0; i < str.length; i += 3) {
    const letter = str[i];
    const sq = str.slice(i + 1, i + 3);
    if (!(letter in counts)) return null;
    if (!/^[a-h][1-8]$/.test(sq)) return null;
    const idx = sqToIdx(sq);
    if (placement.has(idx)) return null;
    if (!canPlaceAt(color, letter, idx)) return null;
    placement.set(idx, letter);
    counts[letter]++;
  }
  for (const k of ARMY_ORDER) {
    if (counts[k] !== ARMY[k]) return null;
  }
  return placement;
}

// Letters (with multiplicity) still missing from a partial placement.
export function remainingArmy(placement: Placement): Record<string, number> {
  const left: Record<string, number> = { ...ARMY };
  for (const letter of placement.values()) left[letter]--;
  return left;
}

// Completes a partial placement by dropping every still-unplaced piece on a
// random empty legal square of `color`'s half. Called locally when the setup
// countdown expires — determinism doesn't matter because the *result* is
// what crosses the wire. Pawns go first (they have the tighter square
// constraint): a half has 32 squares, 24 of them pawn-legal, and at most 8
// can already be taken by the 8 non-pawn pieces, so a legal completion
// always exists.
export function autoCompletePlacement(
  color: SetupColor,
  partial: Placement,
  rand: () => number = Math.random,
): Placement {
  const placement: Placement = new Map(partial);
  const left = remainingArmy(placement);
  const order: string[] = ['P', 'K', 'Q', 'R', 'B', 'N'];
  for (const letter of order) {
    for (let n = 0; n < (left[letter] ?? 0); n++) {
      const candidates: number[] = [];
      for (let idx = 0; idx < 64; idx++) {
        if (placement.has(idx)) continue;
        if (canPlaceAt(color, letter, idx)) candidates.push(idx);
      }
      const pick = candidates[Math.floor(rand() * candidates.length)];
      placement.set(pick, letter);
    }
  }
  return placement;
}

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

export type GameState = {
  // 64-square array, 0 = a8 … 63 = h1.
  board: (Piece | null)[];
  turn: SetupColor;
  // Authoritative position for legality queries. After a king capture this
  // is a kingless FEN — display-only from then on, never reloaded.
  fen: string;
  // Position keys (FEN minus the move counters) for threefold detection.
  positionHistory: string[];
  // Set when a side's king was captured outright (only possible while the
  // merged opening position still had a king en prise — see header comment).
  kingCaptured: SetupColor | null;
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  san: string;
  captured: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
  // Side whose king this move captured, or null. Ends the game.
  kingCaptured: SetupColor | null;
};

function boardOf(chess: Chess): (Piece | null)[] {
  const out: (Piece | null)[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) {
        out.push(null);
        continue;
      }
      const letter = (cell.color === 'w' ? cell.type.toUpperCase() : cell.type) as PieceLetter;
      out.push({ color: cell.color as SetupColor, letter });
    }
  }
  return out;
}

// FEN minus the halfmove/fullmove counters — the repetition key.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// Builds the merged starting FEN from the two placements. Castling "-"
// (no castling in this mode), en passant "-", clocks fresh, white to move.
export function placementsToFen(white: Placement, black: Placement): string {
  const board: (string | null)[] = new Array(64).fill(null);
  for (const [idx, letter] of white) board[idx] = letter.toUpperCase();
  for (const [idx, letter] of black) board[idx] = letter.toLowerCase();
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const cell = board[r * 8 + f];
      if (cell == null) {
        empty++;
      } else {
        if (empty > 0) { row += empty; empty = 0; }
        row += cell;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} w - - 0 1`;
}

export function initialStateFromPlacements(white: Placement, black: Placement): GameState {
  const fen = placementsToFen(white, black);
  return {
    board: boardOf(new Chess(fen)),
    turn: 'w',
    fen,
    positionHistory: [positionKey(fen)],
    kingCaptured: null,
  };
}

// Convenience for replay/page code that starts from the two wire strings.
// Throws on invalid input — callers validated the strings at exchange time.
export function initialStateFromStrings(whiteStr: string, blackStr: string): GameState {
  const w = parsePlacement('w', whiteStr);
  const b = parsePlacement('b', blackStr);
  if (!w || !b) throw new Error('invalid setup placement string');
  return initialStateFromPlacements(w, b);
}

export function toFen(state: GameState): string {
  return state.fen;
}

// ----------------------------------------------------------------------
// Moves
// ----------------------------------------------------------------------

export function legalMovesFrom(
  state: GameState,
  from: Square,
): { to: Square; isCapture: boolean; isMerge: boolean }[] {
  if (state.kingCaptured) return [];
  try {
    const chess = new Chess(state.fen);
    const moves = chess.moves({ square: from as never, verbose: true }) as Array<{
      to: string;
      captured?: string;
    }>;
    // Dedupe promotion moves — four entries share one destination square.
    const seen = new Set<string>();
    const out: { to: Square; isCapture: boolean; isMerge: boolean }[] = [];
    for (const m of moves) {
      if (seen.has(m.to)) continue;
      seen.add(m.to);
      out.push({ to: m.to, isCapture: !!m.captured, isMerge: false });
    }
    return out;
  } catch {
    return [];
  }
}

export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  if (state.kingCaptured) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;

  // Detect a king capture up front — the position after one is kingless and
  // must never be queried through chess.js.
  const target = state.board[sqToIdx(to)];
  const isKingCapture = !!target && target.color !== state.turn && target.letter.toUpperCase() === 'K';

  const chess = new Chess(state.fen);
  let mv;
  try {
    mv = chess.move({ from, to, promotion: promotion ?? 'q' });
  } catch {
    return null;
  }
  if (!mv) return null;

  const fenAfter = chess.fen();
  const loser: SetupColor | null = isKingCapture ? (target!.color as SetupColor) : null;

  const next: GameState = {
    board: boardOf(chess),
    turn: chess.turn() as SetupColor,
    fen: fenAfter,
    positionHistory: [...state.positionHistory, positionKey(fenAfter)],
    kingCaptured: loser,
  };
  const result: MoveResult = {
    uci,
    fenAfter,
    san: mv.san,
    captured: !!mv.captured,
    // The post-king-capture position has no meaningful check flags.
    check: !loser && chess.isCheck(),
    checkmate: !loser && chess.isCheckmate(),
    stalemate: !loser && chess.isStalemate(),
    kingCaptured: loser,
  };
  return { state: next, result };
}

// ----------------------------------------------------------------------
// Terminal-state queries (mirror sweeperChess)
// ----------------------------------------------------------------------

export function isCheckmate(state: GameState): boolean {
  if (state.kingCaptured) return false;
  return new Chess(state.fen).isCheckmate();
}

export function isStalemate(state: GameState): boolean {
  if (state.kingCaptured) return false;
  return new Chess(state.fen).isStalemate();
}

export function isInCheck(state: GameState): boolean {
  if (state.kingCaptured) return false;
  return new Chess(state.fen).isCheck();
}

export function isInsufficientMaterial(state: GameState): boolean {
  if (state.kingCaptured) return false;
  return new Chess(state.fen).isInsufficientMaterial();
}

export function isFiftyMoveRule(state: GameState): boolean {
  if (state.kingCaptured) return false;
  const halfmove = parseInt(state.fen.split(' ')[4] ?? '0', 10);
  return Number.isFinite(halfmove) && halfmove >= 100;
}

export function isThreefoldRepetition(state: GameState): boolean {
  if (state.kingCaptured) return false;
  const key = state.positionHistory[state.positionHistory.length - 1];
  let n = 0;
  for (const k of state.positionHistory) if (k === key) n++;
  return n >= 3;
}
