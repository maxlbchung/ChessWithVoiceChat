// Chess 2.0 — back-rank pieces follow new rules:
//   Q (queen)  → moves like a king (1 square any direction).
//   B (bishop) → moves 1 or 2 squares diagonally, blocked by pieces in the
//                path.
//   N (knight) → jumps over an adjacent piece (any of the 8 directions) and
//                lands directly on the square two away. The hopped piece, if
//                enemy, is captured checkers-style; the landing square may be
//                empty or hold an enemy (also captured). May not land on an
//                own piece. A single jump can capture both the hopped piece
//                and the landed-on piece.
//   R (rook)   → moves 1 square orthogonally. Captures adjacent enemy
//                pieces normally. If the destination holds an own piece, it
//                PUSHES the chain one square in the same direction. Push
//                fails only if the chain reaches the board edge — rooks can
//                shove other rooks along.
//   K (king)   → standard 1-square move (no castling in 2.0).
//   P (pawn)   → standard pawn rules (incl. en passant, promotion).
//
// Pieces are encoded with standard chess FEN letters (uppercase = white).
// UCI moves carry the same syntax as standard chess; the engine derives the
// special semantics (swap / push) from board state at apply time.

export type C2Color = 'w' | 'b';

export type PieceLetter =
  | 'P' | 'K' | 'R' | 'B' | 'N' | 'Q'
  | 'p' | 'k' | 'r' | 'b' | 'n' | 'q';

export type Piece = {
  color: C2Color;
  letter: PieceLetter;
};

export type Square = string;  // 'a1' .. 'h8'

export type GameState = {
  // 64-square array, idx 0 = a8, idx 63 = h1
  board: (Piece | null)[];
  turn: C2Color;
  enPassant: Square | null;
  halfmove: number;
  fullmove: number;
  positionHistory: string[];
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  pushed: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
};

// ------------------------------------------------------------------
// Square <-> index helpers
// ------------------------------------------------------------------
export function sqToIdx(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  return (7 - rank) * 8 + file;
}

export function idxToSq(idx: number): Square {
  const file = idx % 8;
  const rankFromTop = Math.floor(idx / 8);
  const rank = 7 - rankFromTop;
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function idxFR(file: number, rank: number): number {
  return (7 - rank) * 8 + file;
}

function frOfIdx(idx: number): [number, number] {
  const file = idx % 8;
  const rank = 7 - Math.floor(idx / 8);
  return [file, rank];
}

const ROOK_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const EIGHT_DIRS: [number, number][] = [...ROOK_DIRS, ...BISHOP_DIRS];

// ------------------------------------------------------------------
// Initial position
// ------------------------------------------------------------------
export function initialState(): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  // Guerrilla back rank: queen on d, king on e. Corner squares (a/h) are
  // empty — the four rooks live next to the bishops instead (see below).
  board[idxFR(3, 0)] = { color: 'w', letter: 'Q' };
  board[idxFR(4, 0)] = { color: 'w', letter: 'K' };
  board[idxFR(3, 7)] = { color: 'b', letter: 'q' };
  board[idxFR(4, 7)] = { color: 'b', letter: 'k' };
  // Bishops on c1/f1 (and mirror), tucked beside the royal couple.
  board[idxFR(2, 0)] = { color: 'w', letter: 'B' };
  board[idxFR(5, 0)] = { color: 'w', letter: 'B' };
  board[idxFR(2, 7)] = { color: 'b', letter: 'b' };
  board[idxFR(5, 7)] = { color: 'b', letter: 'b' };
  // Four rooks per side — above the bishops (c2/f2) and beside them
  // (b1/g1).
  board[idxFR(2, 1)] = { color: 'w', letter: 'R' };
  board[idxFR(5, 1)] = { color: 'w', letter: 'R' };
  board[idxFR(1, 0)] = { color: 'w', letter: 'R' };
  board[idxFR(6, 0)] = { color: 'w', letter: 'R' };
  board[idxFR(2, 6)] = { color: 'b', letter: 'r' };
  board[idxFR(5, 6)] = { color: 'b', letter: 'r' };
  board[idxFR(1, 7)] = { color: 'b', letter: 'r' };
  board[idxFR(6, 7)] = { color: 'b', letter: 'r' };
  // Knights directly above the queen and king (d2/e2 and mirror).
  board[idxFR(3, 1)] = { color: 'w', letter: 'N' };
  board[idxFR(4, 1)] = { color: 'w', letter: 'N' };
  board[idxFR(3, 6)] = { color: 'b', letter: 'n' };
  board[idxFR(4, 6)] = { color: 'b', letter: 'n' };
  // Guerrilla pawns: b- and g-file pawns sit on their usual rank; the four
  // centre files (c, d, e, f) start one square pushed up. a- and h-files
  // are empty.
  for (const f of [1, 6]) {
    board[idxFR(f, 6)] = { color: 'b', letter: 'p' };
    board[idxFR(f, 1)] = { color: 'w', letter: 'P' };
  }
  for (const f of [2, 3, 4, 5]) {
    board[idxFR(f, 5)] = { color: 'b', letter: 'p' };
    board[idxFR(f, 2)] = { color: 'w', letter: 'P' };
  }
  const state: GameState = {
    board,
    turn: 'w',
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

// ------------------------------------------------------------------
// Pseudo-move generation
// ------------------------------------------------------------------
type PseudoMove = {
  from: number;
  to: number;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  enPassantCapture?: boolean;
  doublePawn?: boolean;
  // Rook push: direction the chain shifts.
  push?: { df: number; dr: number };
  // Knight jump: square index of an enemy piece the knight hopped over,
  // captured checkers-style. Undefined if the hopped piece was friendly.
  knightHopCapture?: number;
};

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const p = state.board[from];
  if (!p) return [];
  const out: PseudoMove[] = [];
  const [ff, fr] = frOfIdx(from);
  const up = p.letter.toUpperCase();
  if (up === 'P') pseudoPawn(state, from, ff, fr, p, out);
  else if (up === 'K') pseudoKing(state, from, ff, fr, p, out);
  else if (up === 'Q') pseudoQueen(state, from, ff, fr, p, out);
  else if (up === 'B') pseudoBishop(state, from, ff, fr, p, out);
  else if (up === 'N') pseudoKnight(state, from, ff, fr, p, out);
  else if (up === 'R') pseudoRook(state, from, ff, fr, p, out);
  return out;
}

function pseudoKing(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of EIGHT_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
  // No castling in 2.0.
}

function pseudoQueen(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of EIGHT_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
}

function pseudoBishop(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of BISHOP_DIRS) {
    for (let step = 1; step <= 2; step++) {
      const f = ff + df * step, r = fr + dr * step;
      if (!onBoard(f, r)) break;
      const t = idxFR(f, r);
      const dest = state.board[t];
      if (dest) {
        if (dest.color !== p.color) out.push({ from, to: t });
        break;
      }
      out.push({ from, to: t });
    }
  }
}

function pseudoKnight(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of EIGHT_DIRS) {
    const af = ff + df, ar = fr + dr;          // adjacent (hopped) square
    if (!onBoard(af, ar)) continue;
    const hoppedIdx = idxFR(af, ar);
    const hopped = state.board[hoppedIdx];
    if (!hopped) continue;                      // need a piece to hop over
    const lf = ff + 2 * df, lr = fr + 2 * dr;   // landing square
    if (!onBoard(lf, lr)) continue;
    const t = idxFR(lf, lr);
    const dest = state.board[t];
    if (dest && dest.color === p.color) continue;  // can't land on own piece
    out.push({
      from,
      to: t,
      knightHopCapture: hopped.color !== p.color ? hoppedIdx : undefined,
    });
  }
}

function pseudoRook(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of ROOK_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (!dest) {
      out.push({ from, to: t });
    } else if (dest.color !== p.color) {
      // Adjacent enemy — capture normally (no push).
      out.push({ from, to: t });
    } else if (canPush(state, t, df, dr)) {
      // Adjacent own piece — push the chain.
      out.push({ from, to: t, push: { df, dr } });
    }
  }
}

// Walk the chain starting at startIdx in direction (df, dr). The chain is
// valid (pushable) only if it terminates at an empty square inside the
// board. Rooks may be part of the chain — they shove each other along.
function canPush(state: GameState, startIdx: number, df: number, dr: number): boolean {
  let idx = startIdx;
  let [f, r] = frOfIdx(idx);
  while (true) {
    const piece = state.board[idx];
    if (!piece) return true;
    f += df; r += dr;
    if (!onBoard(f, r)) return false;
    idx = idxFR(f, r);
  }
}

function pseudoPawn(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  const dir = p.color === 'w' ? 1 : -1;
  const promoRank = p.color === 'w' ? 7 : 0;
  // Guerrilla has no double pawn move — pawns always advance one square.

  const oneR = fr + dir;
  if (onBoard(ff, oneR) && !state.board[idxFR(ff, oneR)]) {
    if (oneR === promoRank) {
      for (const promo of ['Q', 'R', 'B', 'N'] as const) {
        out.push({ from, to: idxFR(ff, oneR), promotion: promo });
      }
    } else {
      out.push({ from, to: idxFR(ff, oneR) });
    }
  }

  for (const df of [-1, 1]) {
    const f = ff + df, r = fr + dir;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color !== p.color) {
      if (r === promoRank) {
        for (const promo of ['Q', 'R', 'B', 'N'] as const) {
          out.push({ from, to: t, promotion: promo });
        }
      } else {
        out.push({ from, to: t });
      }
    } else if (state.enPassant && idxToSq(t) === state.enPassant) {
      out.push({ from, to: t, enPassantCapture: true });
    }
  }
}

// ------------------------------------------------------------------
// Attack detection (for check). Rooks DO NOT attack — they only push.
// ------------------------------------------------------------------
export function isSquareAttacked(state: GameState, target: number, byColor: C2Color): boolean {
  const [tf, tr] = frOfIdx(target);

  // Pawn (diagonal forward)
  const pawnDir = byColor === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const f = tf - df, r = tr - pawnDir;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'P') return true;
  }

  // King (1 sq any dir)
  for (const [df, dr] of EIGHT_DIRS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'K') return true;
  }

  // Queen (1 sq any dir, king-like)
  for (const [df, dr] of EIGHT_DIRS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'Q') return true;
  }

  // Rook (1 sq orthogonal — can capture adjacent enemies in 2.0)
  for (const [df, dr] of ROOK_DIRS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'R') return true;
  }

  // Bishop (1 to 2 sq diagonally, blocked by intervening pieces)
  for (const [df, dr] of BISHOP_DIRS) {
    for (let step = 1; step <= 2; step++) {
      const f = tf - df * step, r = tr - dr * step;
      if (!onBoard(f, r)) break;
      const p = state.board[idxFR(f, r)];
      if (p) {
        if (p.color === byColor && p.letter.toUpperCase() === 'B') return true;
        break;
      }
    }
  }

  // Knight (jump rules): attacks the target by either landing on it or by
  // hopping directly over it (checkers-style).
  for (const [df, dr] of EIGHT_DIRS) {
    // Case A: knight lands on T. Knight sits at T - 2*(df,dr); the hopped
    // square at T - (df,dr) just needs *some* piece on it.
    const kf = tf - 2 * df, kr = tr - 2 * dr;
    const hf = tf - df, hr = tr - dr;
    if (onBoard(kf, kr) && onBoard(hf, hr) && state.board[idxFR(hf, hr)]) {
      const k = state.board[idxFR(kf, kr)];
      if (k && k.color === byColor && k.letter.toUpperCase() === 'N') return true;
    }
    // Case B: knight hops over T. Knight at T - (df,dr), lands at T + (df,dr);
    // the landing square must not hold one of the knight's own pieces.
    const kf2 = tf - df, kr2 = tr - dr;
    const lf = tf + df, lr = tr + dr;
    if (onBoard(kf2, kr2) && onBoard(lf, lr)) {
      const k = state.board[idxFR(kf2, kr2)];
      if (k && k.color === byColor && k.letter.toUpperCase() === 'N') {
        const land = state.board[idxFR(lf, lr)];
        if (!land || land.color !== byColor) return true;
      }
    }
  }

  return false;
}

function findKing(state: GameState, color: C2Color): number {
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return i;
  }
  return -1;
}

export function isInCheck(state: GameState, color: C2Color): boolean {
  const k = findKing(state, color);
  if (k === -1) return false;
  return isSquareAttacked(state, k, color === 'w' ? 'b' : 'w');
}

// ------------------------------------------------------------------
// Apply pseudo-move
// ------------------------------------------------------------------
function applyPseudo(state: GameState, mv: PseudoMove): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    positionHistory: state.positionHistory,
  };

  const mover = next.board[mv.from]!;
  const moverUp = mover.letter.toUpperCase();

  if (mv.push) {
    // Collect the chain of contiguous occupied squares starting at mv.to.
    const { df, dr } = mv.push;
    let [f, r] = frOfIdx(mv.to);
    const chain: number[] = [];
    while (onBoard(f, r) && next.board[idxFR(f, r)]) {
      chain.push(idxFR(f, r));
      f += df; r += dr;
    }
    // Shift each piece one square in (df, dr), back-to-front so we don't
    // overwrite the next piece's source.
    for (let i = chain.length - 1; i >= 0; i--) {
      const srcIdx = chain[i];
      const [sf, sr] = frOfIdx(srcIdx);
      const dstIdx = idxFR(sf + df, sr + dr);
      next.board[dstIdx] = next.board[srcIdx];
      next.board[srcIdx] = null;
    }
    // Move the rook onto the now-empty mv.to square.
    next.board[mv.to] = next.board[mv.from];
    next.board[mv.from] = null;
  } else {
    // Standard / capture move.
    const dest = next.board[mv.to];
    if (dest) next.halfmove = 0;

    let resultPiece: Piece = mover;
    if (mv.promotion) {
      const letter = mv.promotion;
      resultPiece = {
        color: mover.color,
        letter: mover.color === 'w' ? letter : (letter.toLowerCase() as PieceLetter),
      };
    }
    if (mv.enPassantCapture) {
      const [tf, tr] = frOfIdx(mv.to);
      const capRank = mover.color === 'w' ? tr - 1 : tr + 1;
      next.board[idxFR(tf, capRank)] = null;
      next.halfmove = 0;
    }
    next.board[mv.to] = resultPiece;
    next.board[mv.from] = null;

    if (mv.knightHopCapture != null) {
      next.board[mv.knightHopCapture] = null;
      next.halfmove = 0;
    }
  }

  if (moverUp === 'P') next.halfmove = 0;

  if (mv.doublePawn) {
    const [tf, tr] = frOfIdx(mv.to);
    const epRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.enPassant = idxToSq(idxFR(tf, epRank));
  }

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;

  return next;
}

// ------------------------------------------------------------------
// Legal move generation
// ------------------------------------------------------------------
export function legalMovesFrom(state: GameState, from: Square): {
  to: Square;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  isCapture: boolean;
  isSpecial: boolean;  // rook push (own-piece interaction)
}[] {
  const idx = sqToIdx(from);
  const p = state.board[idx];
  if (!p || p.color !== state.turn) return [];
  const pseudos = pseudoMoves(state, idx);
  const moverColor = p.color;
  const out: { to: Square; promotion?: 'Q' | 'R' | 'B' | 'N'; isCapture: boolean; isSpecial: boolean }[] = [];
  for (const pm of pseudos) {
    const next = applyPseudo(state, pm);
    if (isInCheck(next, moverColor)) continue;
    const dest = state.board[pm.to];
    const isCapture = !pm.push && (!!dest || !!pm.enPassantCapture || pm.knightHopCapture != null);
    const isSpecial = !!pm.push;
    out.push({ to: idxToSq(pm.to), promotion: pm.promotion, isCapture, isSpecial });
  }
  return out;
}

export function allLegalMoves(state: GameState): { from: Square; to: Square; promotion?: 'Q' | 'R' | 'B' | 'N' }[] {
  const out: { from: Square; to: Square; promotion?: 'Q' | 'R' | 'B' | 'N' }[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.color !== state.turn) continue;
    const from = idxToSq(i);
    for (const m of legalMovesFrom(state, from)) {
      out.push({ from, to: m.to, promotion: m.promotion });
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Apply a move
// ------------------------------------------------------------------
export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promoChar = uci.length >= 5 ? uci[4].toUpperCase() : undefined;
  const fromIdx = sqToIdx(from);
  const toIdx = sqToIdx(to);
  const pseudos = pseudoMoves(state, fromIdx).filter((m) => m.to === toIdx);
  if (pseudos.length === 0) return null;
  const moverColor = state.board[fromIdx]?.color;
  if (!moverColor || moverColor !== state.turn) return null;

  let chosen: PseudoMove | null = null;
  for (const pm of pseudos) {
    if (pm.promotion) {
      if (promoChar && pm.promotion === promoChar) { chosen = pm; break; }
    } else if (!promoChar) {
      chosen = pm; break;
    }
  }
  if (!chosen) return null;

  const next = applyPseudo(state, chosen);
  if (isInCheck(next, moverColor)) return null;

  const dest = state.board[toIdx];
  const captured = !chosen.push && (!!dest || !!chosen.enPassantCapture || chosen.knightHopCapture != null);
  const pushed = !!chosen.push;
  const check = isInCheck(next, next.turn);
  const oppHasMoves = allLegalMoves(next).length > 0;
  const checkmate = check && !oppHasMoves;
  const stalemate = !check && !oppHasMoves;

  return {
    state: next,
    result: {
      uci,
      fenAfter: toFen(next),
      captured,
      pushed,
      check,
      checkmate,
      stalemate,
    },
  };
}

// ------------------------------------------------------------------
// FEN serialization (standard chess FEN, no castling field in 2.0)
// ------------------------------------------------------------------
export function toFen(state: GameState): string {
  const parts: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[idxFR(f, r)];
      if (!p) {
        empty++;
      } else {
        if (empty > 0) { row += empty; empty = 0; }
        row += p.letter;
      }
    }
    if (empty > 0) row += empty;
    parts.push(row);
  }
  const board = parts.join('/');
  const ep = state.enPassant ?? '-';
  return `${board} ${state.turn} - ${ep} ${state.halfmove} ${state.fullmove}`;
}

export function fromFen(fen: string): GameState {
  const [boardPart, turnPart, _castlingPart, epPart, hmPart, fmPart] = fen.split(/\s+/);
  void _castlingPart;
  const board: (Piece | null)[] = new Array(64).fill(null);
  const ranks = boardPart.split('/');
  for (let i = 0; i < 8; i++) {
    const r = 7 - i;
    const row = ranks[i];
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        f += parseInt(ch, 10);
      } else {
        const color: C2Color = ch === ch.toUpperCase() ? 'w' : 'b';
        board[idxFR(f, r)] = { color, letter: ch as PieceLetter };
        f++;
      }
    }
  }
  const state: GameState = {
    board,
    turn: turnPart === 'w' ? 'w' : 'b',
    enPassant: epPart === '-' ? null : epPart,
    halfmove: parseInt(hmPart || '0', 10),
    fullmove: parseInt(fmPart || '1', 10),
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

function positionKey(state: GameState): string {
  const fen = toFen(state);
  const parts = fen.split(/\s+/);
  return parts.slice(0, 4).join(' ');
}

// ------------------------------------------------------------------
// End-state checks
// ------------------------------------------------------------------
export function isCheckmate(state: GameState): boolean {
  if (!isInCheck(state, state.turn)) return false;
  return allLegalMoves(state).length === 0;
}

export function isStalemate(state: GameState): boolean {
  if (isInCheck(state, state.turn)) return false;
  return allLegalMoves(state).length === 0;
}

export function isThreefoldRepetition(state: GameState): boolean {
  const key = positionKey(state);
  let count = 0;
  for (const k of state.positionHistory) if (k === key) count++;
  return count >= 3;
}

export function isFiftyMoveRule(state: GameState): boolean {
  return state.halfmove >= 100;
}

// 2.0 pieces are non-standard, so we keep insufficient-material narrow:
// only king-vs-king is declared a draw automatically.
export function isInsufficientMaterial(state: GameState): boolean {
  for (const p of state.board) {
    if (p && p.letter.toUpperCase() !== 'K') return false;
  }
  return true;
}
