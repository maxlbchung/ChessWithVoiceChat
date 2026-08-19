// Secret Queen — standard chess, except each side secretly designates one of
// their 8 pawns as a hidden queen before play ("fake" piece, letter F/f in
// this engine's FEN). The fake piece moves like a queen from ply 1 — queen
// moves are a superset of pawn moves — but the opponent's UI renders it as an
// ordinary pawn until it is revealed.
//
// THE STEALTH RULE: the fake stays hidden as long as every move it makes is
// also a legal pawn move. While hidden it can advance one square, double-step
// from its home rank, capture diagonally forward, and capture EN PASSANT —
// all without revealing. Reveal is a UI/state flag, never a rules change (for
// attack, check, checkmate and stalemate the fake is ALWAYS a queen); the
// flag flips when:
//   - the fake makes a move a pawn could not make ('moved' — backward,
//     sideways, a long slide, a non-capture diagonal…);
//   - the fake steps onto the promotion rank ('moved' — a pawn there would
//     have to promote, so the disguise is impossible; it simply IS the queen
//     it always was, no promotion picker);
//   - the fake attacks the enemy king in a way a pawn on its square could not
//     ('check' — a discovered line opening behind it, or a pawn-shaped move
//     that lands it on a queen line to the king; a diagonal capture landing
//     forward-diagonal-adjacent to the king is a legitimate PAWN check and
//     stays hidden);
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
// Execution split (applyMove): a hidden fake's pawn-shaped move is executed
// in chess.js AS A PAWN (substitute queen→pawn, move, substitute the landed
// piece back to queen in the FEN string). That yields honest pawn SAN
// ("e4", "exd6" — no "Qe4" leak), makes the fake's own en-passant capture a
// native chess.js move, and sets the en-passant square naturally after a
// double-step so an adjacent enemy pawn can ep-capture the fake right back
// (chess.js generates and executes that capture off the ep field even though
// the piece standing there is a queen — verified against chess.js 1.4.0).
// Every other move — any non-pawn-shaped fake move, a revealed fake's move,
// and all normal pieces — executes on the queen position as before.
//
// One wrinkle chess.js can't carry: its fen() only emits the ep square when
// a REAL enemy pawn could capture, so an enemy double-step past our hidden
// fake (a queen in chess.js) would silently drop the fake's ep right.
// applyMove re-inserts the ep square into the stored chessFen in that case,
// and hiddenFakeEpMove() surfaces the capture to legality/mate/stalemate
// queries via the same pawn substitution.
//
// The fake's legal-move set is queen moves ∪ {en passant while hidden}. A
// revealed fake is an honest queen — no ep for it.
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
  // True once the disguise has dropped (made a non-pawn move / reached the
  // last rank / gave a non-pawn check / was captured).
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

// 'moved'    — the fake made a move a pawn could not make, or stepped onto
//              the promotion rank (where a pawn could not stay a pawn).
// 'check'    — the fake attacks the enemy king in a way a pawn on its square
//              could not (discovered line, or a pawn-shaped move landing on a
//              queen line). A pawn-pattern check (king forward-diagonal-
//              adjacent) does NOT reveal.
// 'captured' — the fake was captured (including en passant).
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

// Replaces the piece letter at `sq` in a full FEN string (placement field
// only; the other five fields ride along untouched).
function substPieceInFen(fen: string, sq: Square, letter: string): string {
  const fields = fen.split(' ');
  const rows = fields[0].split('/');
  const file = sq.charCodeAt(0) - 97;
  const rowIdx = 7 - (sq.charCodeAt(1) - 49);
  rows[rowIdx] = replaceInFenRow(rows[rowIdx], file, letter);
  fields[0] = rows.join('/');
  return fields.join(' ');
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

// True when a queen on fromIdx attacks kingIdx the way a `color` PAWN on
// fromIdx would: king forward-diagonal-adjacent. Such a check keeps the
// disguise; any other queen attack on the king reveals.
function isPawnCheckSquare(fromIdx: number, kingIdx: number, color: SecretColor): boolean {
  const df = (kingIdx % 8) - (fromIdx % 8);
  const dr = Math.floor(kingIdx / 8) - Math.floor(fromIdx / 8);
  // Rows grow downward (row 0 = rank 8): white pawns attack row-1, black row+1.
  return Math.abs(df) === 1 && dr === (color === 'w' ? -1 : 1);
}

// Executes `from`→`to` as a PAWN move for `mover` in a copy of `chessFen`
// with the fake (a queen there) substituted to a real pawn. Returns null when
// the move is not a legal pawn move — the caller falls back to the queen
// path. On success the returned FEN has the landed piece substituted back to
// a queen; the ep field is whatever chess.js emitted for the pawn position
// (i.e. after a double-step, set exactly when a real enemy pawn could
// capture — the enemy hidden-fake case is patched up by the caller).
// Legality is identical under either substitution: only the mover's own
// square changes, and a piece's own type never bears on its own king's
// safety after it moves away.
function tryPawnExec(
  chessFen: string,
  mover: SecretColor,
  from: Square,
  to: Square,
): {
  chessFenAfter: string;
  sanBase: string;
  captured: boolean;
  epCapturedSq: Square | null;
  doubleStep: boolean;
} | null {
  let chess: Chess;
  try {
    chess = new Chess(substPieceInFen(chessFen, from, mover === 'w' ? 'P' : 'p'));
  } catch {
    return null;
  }
  let mv;
  try {
    mv = chess.move({ from, to });
  } catch {
    return null;
  }
  if (!mv) return null;
  return {
    chessFenAfter: substPieceInFen(chess.fen(), to, mover === 'w' ? 'Q' : 'q'),
    // Check/mate suffix is re-derived from the queen truth by the caller.
    sanBase: mv.san.replace(/[+#]+$/, ''),
    captured: !!mv.captured,
    // En passant removes the pawn BEHIND the landing square (same rank the
    // capturer came from).
    epCapturedSq: mv.flags.includes('e') ? ((to[0] + from[1]) as Square) : null,
    doubleStep: mv.flags.includes('b'),
  };
}

// The side-to-move's hidden fake's en-passant capture, if one exists — the
// one legal move of the fake that is NOT a queen move, so chess.js's queen
// position can't see it. Validated (self-check included) via the same
// pawn substitution applyMove executes it with.
function hiddenFakeEpMove(state: GameState): { from: Square; to: Square } | null {
  const f = state.fakes[state.turn];
  if (!f.sq || f.revealed) return null;
  const ep = state.chessFen.split(' ')[3];
  if (!ep || ep === '-') return null;
  // Geometry: capture one file over onto the ep square, moving forward.
  const dir = state.turn === 'w' ? 1 : -1;
  if (Number(f.sq[1]) + dir !== Number(ep[1])) return null;
  if (Math.abs(f.sq.charCodeAt(0) - ep.charCodeAt(0)) !== 1) return null;
  return tryPawnExec(state.chessFen, state.turn, f.sq, ep as Square)
    ? { from: f.sq, to: ep as Square }
    : null;
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
    // The hidden fake's en-passant capture is invisible to the queen position.
    // The same from→to may also exist as a queen slide onto the empty square;
    // applyMove prefers the pawn execution, so the move IS the ep capture —
    // flag it as one (the queen-slide reading is unreachable that turn).
    const ep = hiddenFakeEpMove(state);
    if (ep && ep.from === from) {
      const existing = out.find((m) => m.to === ep.to);
      if (existing) existing.isCapture = true;
      else out.push({ to: ep.to, isCapture: true, isMerge: false });
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
    const out = moves.map((m) => ({ from: m.from, to: m.to }));
    const ep = hiddenFakeEpMove(state);
    if (ep && !out.some((m) => m.from === ep.from && m.to === ep.to)) out.push(ep);
    return out;
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

// SAN base (no check/mate suffix — the caller appends the truth's) with the
// mover's unrevealed fake queen removed, so queen-move disambiguation
// ("Qad1") can't leak that a second queen exists. Falls back to the real SAN
// base when the fake-less position rejects the move (e.g. the fake was
// shielding its own king).
function sanitizedSan(
  chessFenBefore: string,
  uci: string,
  realSanBase: string,
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
    if (!mv) return realSanBase;
    return mv.san.replace(/[+#]+$/, '');
  } catch {
    return realSanBase;
  }
}

export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  const mover = state.turn;
  const opp: SecretColor = mover === 'w' ? 'b' : 'w';

  const myFake: FakeInfo = { ...state.fakes[mover] };
  const oppFake: FakeInfo = { ...state.fakes[opp] };
  const isHiddenFakeMove = !!myFake.sq && myFake.sq === from && !myFake.revealed;
  const lastRank = mover === 'w' ? '8' : '1';

  // Execution split. A hidden fake's pawn-shaped move runs through chess.js
  // AS A PAWN — pawn SAN, native en passant in both directions. Everything
  // else (queen-only fake moves, which reveal; a step onto the promotion
  // rank, which reveals; revealed fakes; every normal piece) runs on the
  // queen position. A move that both paths reject is illegal.
  let chessFenAfter: string;
  let sanBase: string;
  let captured: boolean;
  let epCapturedSq: Square | null = null;
  let doubleStep = false;
  let executedAsPawn = false;
  let queenPiece: string | null = null;

  const pawnExec = isHiddenFakeMove && to[1] !== lastRank
    ? tryPawnExec(state.chessFen, mover, from, to)
    : null;
  if (pawnExec) {
    ({ chessFenAfter, sanBase, captured, epCapturedSq, doubleStep } = pawnExec);
    executedAsPawn = true;
  } else {
    const chess = new Chess(state.chessFen);
    let mv;
    try {
      mv = chess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return null;
    }
    if (!mv) return null;
    chessFenAfter = chess.fen();
    sanBase = mv.san.replace(/[+#]+$/, '');
    captured = !!mv.captured;
    queenPiece = mv.piece;
    // A real pawn's ep capture can remove the opponent's hidden fake — the
    // fake double-steps like a pawn, so it dies like one too.
    if (mv.flags.includes('e')) epCapturedSq = (to[0] + from[1]) as Square;
    doubleStep = mv.piece === 'p' && mv.flags.includes('b');
  }

  // Preserve the ep right chess.js drops: fen() only emits the ep square
  // when a REAL enemy pawn could capture, but the opponent's hidden fake is
  // a queen in chess.js — its ep right would silently vanish. Re-insert the
  // square whenever a double-step lands beside a hidden enemy fake.
  if (doubleStep && oppFake.sq && !oppFake.revealed) {
    const fields = chessFenAfter.split(' ');
    const sameRank = oppFake.sq[1] === to[1];
    const adjFile = Math.abs(oppFake.sq.charCodeAt(0) - to.charCodeAt(0)) === 1;
    if (fields[3] === '-' && sameRank && adjFile) {
      fields[3] = to[0] + (mover === 'w' ? '3' : '6');
      chessFenAfter = fields.join(' ');
    }
  }

  // Queen-truth position after the move (the fake is a queen for every
  // check/mate/stalemate purpose regardless of how the move executed).
  const after = new Chess(chessFenAfter);
  const boardAfter = boardOf(after);

  const reveals: { side: SecretColor; cause: RevealCause }[] = [];
  let fakeCaptured: SecretColor | null = null;

  // Capture of the opponent's fake — on its square, or en passant behind it.
  if (oppFake.sq && (oppFake.sq === to || oppFake.sq === epCapturedSq)) {
    fakeCaptured = opp;
    oppFake.sq = null;
    if (!oppFake.revealed) {
      oppFake.revealed = true;
      reveals.push({ side: opp, cause: 'captured' });
    }
  }

  // The fake follows its piece. A queen-path move by a hidden fake is by
  // construction one a pawn could not make (or a step onto the promotion
  // rank) — the disguise drops. Pawn-shaped moves keep it.
  if (myFake.sq && myFake.sq === from) {
    myFake.sq = to;
    if (!myFake.revealed && !executedAsPawn) {
      myFake.revealed = true;
      reveals.push({ side: mover, cause: 'moved' });
    }
  }

  // Hidden-check auto-reveal: after any move by this side, a hidden fake
  // attacking the enemy king in a way a pawn on its square could not (a
  // discovered line opening behind it, or its own pawn-shaped move landing
  // it on a queen line) cannot stay secret — without the reveal the opponent
  // would unknowingly ignore a hidden attacker for check/mate purposes. A
  // pawn-pattern check (king forward-diagonal-adjacent) keeps the disguise.
  // Only the mover's fake can newly attack the enemy king — the opponent's
  // fake attacking the mover's king would have made this move illegal.
  if (myFake.sq && !myFake.revealed) {
    const oppKing = kingIdxOf(boardAfter, opp);
    if (
      oppKing != null &&
      queenAttacks(boardAfter, sqToIdx(myFake.sq), oppKing) &&
      !isPawnCheckSquare(sqToIdx(myFake.sq), oppKing, mover)
    ) {
      myFake.revealed = true;
      reveals.push({ side: mover, cause: 'check' });
    }
  }

  // SAN sanitization: only needed when the mover moved their REAL queen
  // while their fake was still hidden (pawn-shaped fake moves already carry
  // pawn SAN, and queen-path fake moves reveal themselves).
  const movedRealQueen = queenPiece === 'q' && state.fakes[mover].sq !== from;
  if (movedRealQueen && state.fakes[mover].sq && !state.fakes[mover].revealed) {
    sanBase = sanitizedSan(state.chessFen, uci, sanBase, state.fakes[mover].sq!);
  }

  const next: GameState = {
    board: boardAfter,
    turn: after.turn() as SecretColor,
    chessFen: chessFenAfter,
    positionHistory: [...state.positionHistory, positionKey(chessFenAfter)],
    fakes: mover === 'w' ? { w: myFake, b: oppFake } : { w: oppFake, b: myFake },
  };
  // Mate/stalemate through the exported queries so a hidden fake's ep escape
  // counts as a legal reply; the check/mate suffix follows the same truth.
  const checkmate = isCheckmate(next);
  const stalemate = isStalemate(next);
  const check = after.isCheck();
  const result: MoveResult = {
    uci,
    fenAfter: toFen(next),
    san: sanBase + (checkmate ? '#' : check ? '+' : ''),
    captured,
    check,
    checkmate,
    stalemate,
    reveals,
    reveal: reveals.length > 0 ? reveals[reveals.length - 1] : null,
    fakeCaptured,
  };
  return { state: next, result };
}

// ----------------------------------------------------------------------
// Terminal-state queries (mirror sweeperChess / setupChess)
// ----------------------------------------------------------------------

// Both no-legal-move verdicts must also consider the one legal move the
// queen position can't see: the hidden fake's en-passant capture.
export function isCheckmate(state: GameState): boolean {
  return new Chess(state.chessFen).isCheckmate() && !hiddenFakeEpMove(state);
}

export function isStalemate(state: GameState): boolean {
  return new Chess(state.chessFen).isStalemate() && !hiddenFakeEpMove(state);
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
