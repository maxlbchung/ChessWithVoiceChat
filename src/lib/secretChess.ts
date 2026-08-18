// Secret Queen — standard chess, except each side secretly designates one of
// their 8 pawns as a hidden queen before play ("fake" piece, letter F/f in
// this engine's FEN). The fake piece moves like a queen from ply 1 — queen
// moves are a superset of pawn moves — but the opponent's UI renders it as an
// ordinary pawn until it is revealed.
//
// Reveal is a UI/state flag, never a rules change: for attack, check,
// checkmate and stalemate purposes the fake piece is ALWAYS a queen. The
// flag flips when:
//   - the fake makes its first move ('moved' — a pawn sliding like a queen
//     can't stay secret);
//   - the fake delivers check while still unmoved ('check' — lines can open
//     via a discovered position, and a check cannot stay secret: without the
//     reveal the opponent would unknowingly ignore a hidden attacker for
//     check/mate purposes);
//   - the fake is captured ('captured' — the capture strip shows the truth).
//
// Engine design: legality is delegated to chess.js (like sweeperChess /
// setupChess) with the fake piece substituted as a REAL queen — chess.js has
// no 'f' piece, and since the fake behaves exactly like a queen the
// substituted position is rules-identical. The per-side fake square (which
// follows the piece as it moves) and revealed flag live alongside, and the
// serialized FEN (`toFen`) swaps the letter back to F/f plus appends the
// fake metadata so state round-trips deterministically.
//
// Consequences that fall out for free from the queen substitution:
//   - no en passant for the fake (queens don't double-step or get ep-captured);
//   - reaching the last rank needs no promotion (it already is a queen);
//   - the enemy king can never step adjacent-diagonal to an unrevealed fake
//     "thinking it's a pawn" — chess.js forbids moving into a queen's attack.
//
// One information leak chess.js SAN would create: with two same-color queens
// on the board (real + unrevealed fake), SAN disambiguates the real queen's
// moves ("Qad1"), telling the opponent a second queen exists. `applyMove`
// re-derives SAN with the unrevealed fake removed so the move list stays
// innocent until the reveal.

import { Chess } from 'chess.js';
import type { Piece, PieceLetter, Square } from './mergeChess';

export type { Piece, PieceLetter, Square };
export type SecretColor = 'w' | 'b';

// Wall-clock budget for the simultaneous secret-pick phase. Independent from
// the main-game time control, which only starts ticking once play begins.
export const SECRET_PHASE_MS = 30_000;

export const WHITE_PAWN_SQUARES: Square[] = ['a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2'];
export const BLACK_PAWN_SQUARES: Square[] = ['a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7'];

export function pawnSquaresFor(color: SecretColor): Square[] {
  return color === 'w' ? WHITE_PAWN_SQUARES : BLACK_PAWN_SQUARES;
}

// True when `sq` is one of `color`'s 8 starting pawn squares — the only legal
// secret-queen picks. Both peers run this on the opponent's wire pick, so a
// tampered client can't nominate its king's neighbour.
export function isValidPickSquare(color: SecretColor, sq: string): sq is Square {
  return pawnSquaresFor(color).includes(sq);
}

export function randomPickSquare(color: SecretColor, rand: () => number = Math.random): Square {
  const squares = pawnSquaresFor(color);
  return squares[Math.min(squares.length - 1, Math.floor(rand() * squares.length))];
}

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
// State
// ----------------------------------------------------------------------

export type FakeInfo = {
  // Current square of the fake piece, or null once it has been captured.
  sq: Square | null;
  // True once the disguise has dropped (moved / gave check / was captured).
  revealed: boolean;
};

export type GameState = {
  // 64-square array, 0 = a8 … 63 = h1. The fake piece appears with its REAL
  // letter (Q/q) — it is a queen for every rules purpose; masking it as a
  // pawn to the opponent is the page's job, keyed off `fakes`.
  board: (Piece | null)[];
  turn: SecretColor;
  // Authoritative chess.js position (fake as a real queen) for legality.
  chessFen: string;
  // Position keys (chessFen minus the move counters) for threefold detection.
  positionHistory: string[];
  fakes: { w: FakeInfo; b: FakeInfo };
};

export type RevealCause = 'moved' | 'check' | 'captured';

export type MoveResult = {
  uci: string;
  // Extended FEN (see toFen) — travels on the wire for resync comparison.
  fenAfter: string;
  san: string;
  captured: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
  // Every fake this move flipped from hidden to revealed, in flip order —
  // drives the unmask moment (sfx + pop) in the UI. Usually 0 or 1 entries,
  // but a hidden fake capturing the opponent's hidden fake carries two:
  // 'captured' for the victim, then 'moved' (or 'check') for the mover.
  reveals: { side: SecretColor; cause: RevealCause }[];
  // The last (most significant) entry of `reveals`, or null — the mover's
  // own reveal when both happened. Kept as a single-slot convenience for
  // consumers that show one cue (e.g. the Review replay).
  reveal: { side: SecretColor; cause: RevealCause } | null;
  // Side whose fake piece this move captured, or null.
  fakeCaptured: SecretColor | null;
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
      out.push({ color: cell.color as SecretColor, letter });
    }
  }
  return out;
}

// chessFen minus the halfmove/fullmove counters — the repetition key. Which
// of the two same-color queens is the fake doesn't matter here: the two
// positions are rules-identical.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// The standard starting board, for the pick-phase display (before either
// fake exists).
export function startingBoard(): (Piece | null)[] {
  return boardOf(new Chess());
}

// Builds the real starting position: standard chess with each side's picked
// pawn substituted by a queen. Throws on invalid picks — callers validated
// the squares at exchange time.
export function initialState(whitePick: Square, blackPick: Square): GameState {
  if (!isValidPickSquare('w', whitePick) || !isValidPickSquare('b', blackPick)) {
    throw new Error('invalid secret-queen pick');
  }
  const chess = new Chess();
  chess.remove(whitePick as never);
  chess.put({ type: 'q', color: 'w' }, whitePick as never);
  chess.remove(blackPick as never);
  chess.put({ type: 'q', color: 'b' }, blackPick as never);
  const chessFen = chess.fen();
  return {
    board: boardOf(chess),
    turn: 'w',
    chessFen,
    positionHistory: [positionKey(chessFen)],
    fakes: {
      w: { sq: whitePick, revealed: false },
      b: { sq: blackPick, revealed: false },
    },
  };
}

// ----------------------------------------------------------------------
// FEN (extended). Placement letters swap the fake queens to F/f; a suffix
// carries the fake metadata so revealed flags and captured fakes survive a
// round trip:  "<placement> <turn> <castle> <ep> <half> <full> | w:e2h b:xr"
// where the per-side token is "<square|x><h|r>" (x = captured, h = hidden,
// r = revealed).
// ----------------------------------------------------------------------

function fakeToken(f: FakeInfo): string {
  return (f.sq ?? 'x') + (f.revealed ? 'r' : 'h');
}

function parseFakeToken(tok: string): FakeInfo | null {
  const m = /^([a-h][1-8]|x)([hr])$/.exec(tok);
  if (!m) return null;
  return { sq: m[1] === 'x' ? null : m[1], revealed: m[2] === 'r' };
}

export function toFen(state: GameState): string {
  const fields = state.chessFen.split(' ');
  const rows = fields[0].split('/');
  for (const c of ['w', 'b'] as const) {
    const sq = state.fakes[c].sq;
    if (!sq) continue;
    const file = sq.charCodeAt(0) - 97;
    const rank = sq.charCodeAt(1) - 49; // 0-based from rank 1
    const rowIdx = 7 - rank;
    rows[rowIdx] = replaceInFenRow(rows[rowIdx], file, c === 'w' ? 'F' : 'f');
  }
  fields[0] = rows.join('/');
  return `${fields.join(' ')} | w:${fakeToken(state.fakes.w)} b:${fakeToken(state.fakes.b)}`;
}

// Replaces the piece at 0-based `file` within one FEN row with `letter`,
// re-collapsing the empty runs around it.
function replaceInFenRow(row: string, file: number, letter: string): string {
  const cells: (string | null)[] = [];
  for (const ch of row) {
    if (/\d/.test(ch)) {
      for (let i = 0; i < Number(ch); i++) cells.push(null);
    } else {
      cells.push(ch);
    }
  }
  cells[file] = letter;
  let out = '';
  let empty = 0;
  for (const cell of cells) {
    if (cell == null) {
      empty++;
    } else {
      if (empty > 0) { out += empty; empty = 0; }
      out += cell;
    }
  }
  if (empty > 0) out += empty;
  return out;
}

export function fromFen(extended: string): GameState | null {
  const [fenPart, fakePart] = extended.split(' | ');
  if (!fenPart || !fakePart) return null;
  const fm = /^w:(\S+) b:(\S+)$/.exec(fakePart.trim());
  if (!fm) return null;
  const w = parseFakeToken(fm[1]);
  const b = parseFakeToken(fm[2]);
  if (!w || !b) return null;
  // Swap F/f back to real queens for chess.js.
  const fields = fenPart.trim().split(' ');
  if (fields.length !== 6) return null;
  fields[0] = fields[0].replace(/F/g, 'Q').replace(/f/g, 'q');
  const chessFen = fields.join(' ');
  let chess: Chess;
  try {
    chess = new Chess(chessFen);
  } catch {
    return null;
  }
  // Sanity: each live fake square must actually hold that side's queen.
  for (const [color, info] of [['w', w], ['b', b]] as const) {
    if (!info.sq) continue;
    const p = chess.get(info.sq as never) as { type: string; color: string } | null;
    if (!p || p.type !== 'q' || p.color !== color) return null;
  }
  // LIMITATION: the extended FEN carries no repetition history, so a state
  // rebuilt here restarts positionHistory at the current position — a
  // threefold claim after a rebuild would undercount repetitions that
  // happened before it. fromFen is currently unused by the app (moves carry
  // extended FENs only for mismatch detection, never for resync); if a real
  // resync path is ever wired through here, serialize the history (or a
  // running repetition count) alongside the fake tokens first.
  return {
    board: boardOf(chess),
    turn: chess.turn() as SecretColor,
    chessFen,
    positionHistory: [positionKey(chessFen)],
    fakes: { w, b },
  };
}

// ----------------------------------------------------------------------
// Attack helper — does a queen standing on fromIdx attack toIdx on this
// board? Used for the hidden-check auto-reveal.
// ----------------------------------------------------------------------

export function queenAttacks(board: (Piece | null)[], fromIdx: number, toIdx: number): boolean {
  if (fromIdx === toIdx) return false;
  const ff = fromIdx % 8, fr = Math.floor(fromIdx / 8);
  const tf = toIdx % 8, tr = Math.floor(toIdx / 8);
  const df = Math.sign(tf - ff);
  const dr = Math.sign(tr - fr);
  const straight = ff === tf || fr === tr;
  const diagonal = Math.abs(tf - ff) === Math.abs(tr - fr);
  if (!straight && !diagonal) return false;
  let f = ff + df, r = fr + dr;
  while (f !== tf || r !== tr) {
    if (board[r * 8 + f]) return false;
    f += df;
    r += dr;
  }
  return true;
}

// ----------------------------------------------------------------------
// Moves
// ----------------------------------------------------------------------

export function legalMovesFrom(
  state: GameState,
  from: Square,
): { to: Square; isCapture: boolean; isMerge: boolean }[] {
  try {
    const chess = new Chess(state.chessFen);
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

export function allLegalMoves(state: GameState): { from: Square; to: Square }[] {
  try {
    const chess = new Chess(state.chessFen);
    const moves = chess.moves({ verbose: true }) as Array<{ from: string; to: string }>;
    return moves.map((m) => ({ from: m.from, to: m.to }));
  } catch {
    return [];
  }
}

function kingIdxOf(board: (Piece | null)[], color: SecretColor): number | null {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return i;
  }
  return null;
}

// SAN with the mover's unrevealed fake queen removed, so queen-move
// disambiguation ("Qad1") can't leak that a second queen exists. Falls back
// to the real SAN when the fake-less position rejects the move (e.g. the
// fake was shielding its own king). Check/mate suffixes are re-applied from
// the real position — the fake still participates in checks.
function sanitizedSan(
  chessFenBefore: string,
  uci: string,
  realSan: string,
  fakeSq: Square,
): string {
  try {
    const chess = new Chess(chessFenBefore);
    chess.remove(fakeSq as never);
    const mv = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length >= 5 ? uci[4] : undefined,
    });
    if (!mv) return realSan;
    const base = mv.san.replace(/[+#]+$/, '');
    const suffix = /[+#]+$/.exec(realSan)?.[0] ?? '';
    return base + suffix;
  } catch {
    return realSan;
  }
}

export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  const mover = state.turn;
  const opp: SecretColor = mover === 'w' ? 'b' : 'w';

  const chess = new Chess(state.chessFen);
  let mv;
  try {
    mv = chess.move({ from, to, promotion: promotion ?? 'q' });
  } catch {
    return null;
  }
  if (!mv) return null;

  const chessFenAfter = chess.fen();
  const boardAfter = boardOf(chess);

  // Track the fakes across the move.
  const myFake: FakeInfo = { ...state.fakes[mover] };
  const oppFake: FakeInfo = { ...state.fakes[opp] };
  const reveals: { side: SecretColor; cause: RevealCause }[] = [];
  let fakeCaptured: SecretColor | null = null;

  // Capture of the opponent's fake (a queen can't be ep-captured, so a plain
  // destination check suffices).
  if (oppFake.sq && oppFake.sq === to) {
    fakeCaptured = opp;
    oppFake.sq = null;
    if (!oppFake.revealed) {
      oppFake.revealed = true;
      reveals.push({ side: opp, cause: 'captured' });
    }
  }

  // The fake follows its piece; its first move drops the disguise.
  if (myFake.sq && myFake.sq === from) {
    myFake.sq = to;
    if (!myFake.revealed) {
      myFake.revealed = true;
      reveals.push({ side: mover, cause: 'moved' });
    }
  }

  // Hidden-check auto-reveal: an unmoved fake whose line to the enemy king
  // just opened (discovered position) cannot stay secret. Only the mover's
  // fake can newly attack the enemy king — the opponent's fake attacking the
  // mover's king would have made this move illegal (moving into check).
  if (myFake.sq && !myFake.revealed) {
    const oppKing = kingIdxOf(boardAfter, opp);
    if (oppKing != null && queenAttacks(boardAfter, sqToIdx(myFake.sq), oppKing)) {
      myFake.revealed = true;
      reveals.push({ side: mover, cause: 'check' });
    }
  }

  // SAN sanitization: only needed when the mover moved their REAL queen
  // while their fake was still hidden (fake moves reveal themselves).
  let san = mv.san;
  const movedRealQueen = mv.piece === 'q' && state.fakes[mover].sq !== from;
  if (movedRealQueen && state.fakes[mover].sq && !state.fakes[mover].revealed) {
    san = sanitizedSan(state.chessFen, uci, mv.san, state.fakes[mover].sq!);
  }

  const next: GameState = {
    board: boardAfter,
    turn: chess.turn() as SecretColor,
    chessFen: chessFenAfter,
    positionHistory: [...state.positionHistory, positionKey(chessFenAfter)],
    fakes: mover === 'w' ? { w: myFake, b: oppFake } : { w: oppFake, b: myFake },
  };
  const result: MoveResult = {
    uci,
    fenAfter: toFen(next),
    san,
    captured: !!mv.captured,
    check: chess.isCheck(),
    checkmate: chess.isCheckmate(),
    stalemate: chess.isStalemate(),
    reveals,
    reveal: reveals.length > 0 ? reveals[reveals.length - 1] : null,
    fakeCaptured,
  };
  return { state: next, result };
}

// ----------------------------------------------------------------------
// Terminal-state queries (mirror sweeperChess / setupChess)
// ----------------------------------------------------------------------

export function isCheckmate(state: GameState): boolean {
  return new Chess(state.chessFen).isCheckmate();
}

export function isStalemate(state: GameState): boolean {
  return new Chess(state.chessFen).isStalemate();
}

export function isInCheck(state: GameState): boolean {
  return new Chess(state.chessFen).isCheck();
}

export function isInsufficientMaterial(state: GameState): boolean {
  return new Chess(state.chessFen).isInsufficientMaterial();
}

export function isFiftyMoveRule(state: GameState): boolean {
  const halfmove = parseInt(state.chessFen.split(' ')[4] ?? '0', 10);
  return Number.isFinite(halfmove) && halfmove >= 100;
}

export function isThreefoldRepetition(state: GameState): boolean {
  const key = state.positionHistory[state.positionHistory.length - 1];
  let n = 0;
  for (const k of state.positionHistory) if (k === key) n++;
  return n >= 3;
}
