// Chesssweeper — standard chess played over a hidden minefield. Four
// landmines are buried in the middle two ranks (4 and 5). Moving a piece onto
// a square reveals how many live mines sit in the eight squares around it;
// moving onto a mine detonates it and destroys the piece that stepped on it.
//
// Legality comes straight from chess.js, so castling, en passant, promotion
// and check detection all behave exactly like normal chess. The mine effect is
// applied on top of the resulting position by removing the destroyed piece —
// which is not expressible as a chess move, so positions travel as explicit
// FEN snapshots (one per ply) instead of a chess.js move history.
//
// Both players derive the same minefield from the shared gameId, so no mine
// data ever crosses the wire — a peer can't learn the layout by sniffing.

import { Chess } from 'chess.js';
import type { Piece, PieceLetter, Square } from './mergeChess';

export type { Piece, PieceLetter, Square };
export type SweeperColor = 'w' | 'b';

export const MINE_COUNT = 4;

// Board indices are the same convention MergeBoard uses: 0 = a8 … 63 = h1.
// Ranks 5 and 4 are rows 3 and 4 from the top, i.e. indices 24..39.
export const MINE_ZONE: number[] = Array.from({ length: 16 }, (_, i) => 24 + i);

export type GameState = {
  // 64-square array, 0 = a8 … 63 = h1. This is the *display* truth: after a
  // king detonates it loses that king even though `fen` keeps it (a kingless
  // FEN can't be loaded back into chess.js, and the game is over anyway).
  board: (Piece | null)[];
  turn: SweeperColor;
  // Authoritative position for legality queries.
  fen: string;
  // Buried mines (board indices). Hidden from the UI until they blow.
  mines: number[];
  // Squares a piece has landed on — their live-mine count is shown.
  revealed: number[];
  // Mines that have already gone off. They leave a permanent crater and no
  // longer count toward any neighbour's number.
  detonated: number[];
  // Position keys (FEN minus the move counters) for threefold detection.
  positionHistory: string[];
  // Set when a side lost outright to an explosion — its king was destroyed,
  // or the blast left its king in check with the opponent to move.
  mineLoss: SweeperColor | null;
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  san: string;
  captured: boolean;
  castled: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
  // Square the mover landed on — newly revealed by this move.
  revealedIdx: number;
  // Index of the mine this move set off, or null for a quiet move.
  mineIdx: number | null;
  // Piece the blast destroyed (the mover), for the capture/animation UI.
  destroyedLetter: PieceLetter | null;
  // Side that lost outright to the blast (king destroyed / king exposed).
  mineLoss: SweeperColor | null;
};

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

// ----------------------------------------------------------------------
// Minefield generation
// ----------------------------------------------------------------------

// FNV-1a. Turns the gameId into a 32-bit seed so both peers (and the Review
// page, replaying from a stored record) lay the same minefield.
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Four distinct squares from the middle two ranks. Deterministic in `seed`.
export function minesForGame(seed: string): number[] {
  const rand = mulberry32(hashSeed(seed || 'chesssweeper'));
  const pool = [...MINE_ZONE];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, MINE_COUNT).sort((a, b) => a - b);
}

// The eight squares touching `idx`, clipped to the board.
export function neighbors(idx: number): number[] {
  const file = idx % 8;
  const row = Math.floor(idx / 8);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let df = -1; df <= 1; df++) {
      if (dr === 0 && df === 0) continue;
      const f = file + df;
      const r = row + dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      out.push(r * 8 + f);
    }
  }
  return out;
}

// How many *live* mines touch this square. Detonated mines are visible on the
// board and stop counting, so a revealed number always means "mines still out
// there next to me".
export function liveMineCount(state: GameState, idx: number): number {
  let n = 0;
  for (const nb of neighbors(idx)) {
    if (state.mines.includes(nb) && !state.detonated.includes(nb)) n++;
  }
  return n;
}

// True for squares close enough to the buried ranks that a mine could ever
// touch them (ranks 3–6). Anywhere else the count is trivially zero and
// showing it would just litter the board.
export function inSensorRange(idx: number): boolean {
  return neighbors(idx).some((n) => MINE_ZONE.includes(n));
}

// Revealed squares paired with their current count, for the board overlay.
// Squares whose mine already blew are skipped — they render a crater instead.
export function revealedCounts(state: GameState): { idx: number; count: number }[] {
  return state.revealed
    .filter((idx) => !state.detonated.includes(idx) && inSensorRange(idx))
    .map((idx) => ({ idx, count: liveMineCount(state, idx) }));
}

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

function boardOf(chess: Chess): (Piece | null)[] {
  const out: (Piece | null)[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) {
        out.push(null);
        continue;
      }
      const letter = (cell.color === 'w' ? cell.type.toUpperCase() : cell.type) as PieceLetter;
      out.push({ color: cell.color as SweeperColor, letter });
    }
  }
  return out;
}

// FEN minus the halfmove/fullmove counters — the repetition key.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function initialState(mines: number[]): GameState {
  const chess = new Chess();
  const fen = chess.fen();
  return {
    board: boardOf(chess),
    turn: 'w',
    fen,
    mines: [...mines],
    revealed: [],
    detonated: [],
    positionHistory: [positionKey(fen)],
    mineLoss: null,
  };
}

export function toFen(state: GameState): string {
  return state.fen;
}

export function legalMovesFrom(
  state: GameState,
  from: Square,
): { to: Square; isCapture: boolean; isMerge: boolean }[] {
  if (state.mineLoss) return [];
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
  if (state.mineLoss) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  const chess = new Chess(state.fen);
  let mv;
  try {
    mv = chess.move({ from, to, promotion: promotion ?? 'q' });
  } catch {
    return null;
  }
  if (!mv) return null;

  const toIdx = sqToIdx(to);
  const hitsMine = state.mines.includes(toIdx) && !state.detonated.includes(toIdx);
  const mover: SweeperColor = mv.color as SweeperColor;

  let destroyedLetter: PieceLetter | null = null;
  let mineLoss: SweeperColor | null = null;
  let kingBlownAt: number | null = null;

  if (hitsMine) {
    const victim = chess.get(to as never);
    if (victim) {
      destroyedLetter = (victim.color === 'w' ? victim.type.toUpperCase() : victim.type) as PieceLetter;
      if (victim.type === 'k') {
        // A king can't simply be lifted off — a kingless FEN won't load back
        // into chess.js. Leave it in the position, end the game, and clear it
        // from the display board below so the blast still reads as fatal.
        mineLoss = mover;
        kingBlownAt = toIdx;
      } else {
        chess.remove(to as never);
        // The blast can open a line onto the mover's own king (a piece that
        // slid along a pin onto a mine). That position is illegal to play on —
        // the opponent would just take the king — so it ends the game there.
        const kingSq = kingSquare(chess, mover);
        if (kingSq && chess.isAttacked(kingSq as never, (mover === 'w' ? 'b' : 'w') as never)) {
          mineLoss = mover;
        }
      }
    }
  }

  const fenAfter = chess.fen();
  const board = boardOf(chess);
  if (kingBlownAt != null) board[kingBlownAt] = null;

  const detonated = hitsMine ? [...state.detonated, toIdx] : state.detonated;
  const revealed = state.revealed.includes(toIdx) ? state.revealed : [...state.revealed, toIdx];

  const next: GameState = {
    board,
    turn: chess.turn() as SweeperColor,
    fen: fenAfter,
    mines: state.mines,
    revealed,
    detonated,
    // A detonation changes the material on the board, so a repeated key after
    // one is a genuine repetition of the new position — no special-casing.
    positionHistory: [...state.positionHistory, positionKey(fenAfter)],
    mineLoss,
  };

  const result: MoveResult = {
    uci,
    fenAfter,
    san: mv.san,
    captured: !!mv.captured,
    castled: !!mv.flags && (mv.flags.includes('k') || mv.flags.includes('q')),
    check: !mineLoss && chess.isCheck(),
    checkmate: !mineLoss && chess.isCheckmate(),
    stalemate: !mineLoss && chess.isStalemate(),
    revealedIdx: toIdx,
    mineIdx: hitsMine ? toIdx : null,
    destroyedLetter,
    mineLoss,
  };

  return { state: next, result };
}

function kingSquare(chess: Chess, color: SweeperColor): Square | null {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// Terminal-state queries
// ----------------------------------------------------------------------

export function isCheckmate(state: GameState): boolean {
  if (state.mineLoss) return false;
  return new Chess(state.fen).isCheckmate();
}

export function isStalemate(state: GameState): boolean {
  if (state.mineLoss) return false;
  return new Chess(state.fen).isStalemate();
}

export function isInCheck(state: GameState): boolean {
  if (state.mineLoss) return false;
  return new Chess(state.fen).isCheck();
}

export function isInsufficientMaterial(state: GameState): boolean {
  if (state.mineLoss) return false;
  return new Chess(state.fen).isInsufficientMaterial();
}

export function isFiftyMoveRule(state: GameState): boolean {
  if (state.mineLoss) return false;
  const halfmove = parseInt(state.fen.split(' ')[4] ?? '0', 10);
  return Number.isFinite(halfmove) && halfmove >= 100;
}

export function isThreefoldRepetition(state: GameState): boolean {
  if (state.mineLoss) return false;
  const key = state.positionHistory[state.positionHistory.length - 1];
  let n = 0;
  for (const k of state.positionHistory) if (k === key) n++;
  return n >= 3;
}
