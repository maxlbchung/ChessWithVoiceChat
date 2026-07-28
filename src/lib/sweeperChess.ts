// Chesssweeper — standard chess played over a hidden minefield. Four
// landmines are buried in the middle two ranks (4 and 5). Moving a piece onto
// a square reveals how many live mines sit in the eight squares around it.
// A piece detonates any live mine it *travels over*, not just the one it lands
// on: the first mine on its path takes it there and the move never completes.
// Knights are the exception — they jump, so only their landing square counts.
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
  // Square the mover stopped on — newly revealed by this move. That's the
  // destination normally, or the mine square when the move died in transit.
  revealedIdx: number;
  // Index of the mine this move set off, or null for a quiet move. May sit
  // short of the destination — see `abortedAt`.
  mineIdx: number | null;
  // Set when a mine went off *under way*: the mover never reached `to`, so
  // nothing was captured there. Equals `mineIdx` in that case, else null.
  abortedAt: number | null;
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

// Squares a piece slides across on its way from `from` to `to`, excluding both
// ends. Only rank/file/diagonal moves have any — a knight's jump is never
// aligned, which is precisely why knights trip nothing but the mine they land
// on.
export function transitSquares(fromIdx: number, toIdx: number): number[] {
  const fromFile = fromIdx % 8;
  const fromRow = Math.floor(fromIdx / 8);
  const df = (toIdx % 8) - fromFile;
  const dr = Math.floor(toIdx / 8) - fromRow;
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return [];
  const stepF = Math.sign(df);
  const stepR = Math.sign(dr);
  const steps = Math.max(Math.abs(df), Math.abs(dr));
  const out: number[] = [];
  for (let i = 1; i < steps; i++) out.push((fromRow + stepR * i) * 8 + (fromFile + stepF * i));
  return out;
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

  const fromIdx = sqToIdx(from);
  const toIdx = sqToIdx(to);
  const mover: SweeperColor = mv.color as SweeperColor;
  const opp: SweeperColor = mover === 'w' ? 'b' : 'w';
  const isLive = (idx: number) => state.mines.includes(idx) && !state.detonated.includes(idx);

  // The first live mine under the piece's path stops it dead there. Knight
  // jumps have no path, so they only ever set off what they land on.
  const abortedAt = transitSquares(fromIdx, toIdx).find(isLive) ?? null;
  const mineIdx = abortedAt ?? (isLive(toIdx) ? toIdx : null);

  let destroyedLetter: PieceLetter | null = null;
  let mineLoss: SweeperColor | null = null;
  let kingBlownAt: number | null = null;
  let fenAfter: string;
  let board: (Piece | null)[];
  let turnAfter: SweeperColor;
  // The position the opponent receives, for check/mate queries. Left null when
  // the blast already decided the game — a position with the mover's king en
  // prise won't load back into chess.js, and the flags are moot anyway.
  let after: Chess | null = null;

  if (abortedAt != null) {
    // The move never happened: rewind to the position before it and lift the
    // traveller off its starting square instead. Nothing on `to` is captured.
    const aborted = new Chess(state.fen);
    const traveller = aborted.get(from as never);
    if (traveller) destroyedLetter = letterOf(traveller);
    aborted.remove(from as never);
    // `aborted` still has the mover to move, which is exactly what the king
    // safety test wants: the piece that was going to block or capture died on
    // the way, so its own king can be left hanging.
    const kingSq = kingSquare(aborted, mover);
    if (!kingSq || aborted.isAttacked(kingSq as never, opp as never)) mineLoss = mover;
    // Hand the position over: chess.js already fixed up castling rights when
    // the piece was removed, an en-passant square can't outlive the pawn that
    // made it, and losing a piece resets the fifty-move clock like a capture.
    const fields = aborted.fen().split(' ');
    // Only the move counter is borrowed from the position the move *would*
    // have produced; the rest of it describes an arrival that never happened.
    const post = chess.fen().split(' ');
    fields[1] = opp;
    fields[3] = '-';
    fields[4] = '0';
    fields[5] = post[5];
    fenAfter = fields.join(' ');
    board = boardOf(aborted);
    turnAfter = opp;
    if (!mineLoss) after = new Chess(fenAfter);
  } else {
    if (mineIdx != null) {
      const victim = chess.get(to as never);
      if (victim) {
        destroyedLetter = letterOf(victim);
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
          if (kingSq && chess.isAttacked(kingSq as never, opp as never)) mineLoss = mover;
        }
      }
    }
    fenAfter = chess.fen();
    board = boardOf(chess);
    if (kingBlownAt != null) board[kingBlownAt] = null;
    turnAfter = chess.turn() as SweeperColor;
    if (!mineLoss) after = chess;
  }

  // Only the square the piece actually stopped on is learned — a move cut
  // short in transit tells you nothing about where it was headed.
  const stoppedIdx = abortedAt ?? toIdx;
  const detonated = mineIdx != null ? [...state.detonated, mineIdx] : state.detonated;
  const revealed = state.revealed.includes(stoppedIdx)
    ? state.revealed
    : [...state.revealed, stoppedIdx];

  const next: GameState = {
    board,
    turn: turnAfter,
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
    captured: abortedAt == null && !!mv.captured,
    castled: abortedAt == null && !!mv.flags && (mv.flags.includes('k') || mv.flags.includes('q')),
    check: !!after && after.isCheck(),
    checkmate: !!after && after.isCheckmate(),
    stalemate: !!after && after.isStalemate(),
    revealedIdx: stoppedIdx,
    mineIdx,
    abortedAt,
    destroyedLetter,
    mineLoss,
  };

  return { state: next, result };
}

function letterOf(piece: { color: string; type: string }): PieceLetter {
  return (piece.color === 'w' ? piece.type.toUpperCase() : piece.type) as PieceLetter;
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
