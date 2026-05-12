// Cash Money — both sides start with K+Q + 6 pawns. Whenever it becomes a
// player's turn, that player gains 1 gold. Gold can be spent on the shop:
//   N = 3, B = 3, R = 5, Q = 9
// Buying counts as a turn. The bought piece is placed on a square adjacent to
// your own king. Only one queen per side may exist on the board at a time. No
// castling, no pawn purchases.
//
// State is similar to chess2 but adds `gold: { w, b }`. Buys are encoded as
// pseudo-UCI strings of the form `+<letter><square>` (e.g. `+Ne2`) so the
// existing move-signing / history / wire pipeline keeps working unchanged.

export type C2Color = 'w' | 'b';

export type PieceLetter =
  | 'P' | 'K' | 'R' | 'B' | 'N' | 'Q'
  | 'p' | 'k' | 'r' | 'b' | 'n' | 'q';

export type Piece = {
  color: C2Color;
  letter: PieceLetter;
};

export type Square = string;

export type ShopLetter = 'N' | 'B' | 'R' | 'Q';

export const SHOP_PRICES: Record<ShopLetter, number> = {
  N: 3,
  B: 3,
  R: 5,
  Q: 9,
};

export const SHOP_LETTERS: ShopLetter[] = ['N', 'B', 'R', 'Q'];

export type GameState = {
  board: (Piece | null)[];
  turn: C2Color;
  enPassant: Square | null;
  halfmove: number;
  fullmove: number;
  positionHistory: string[];
  // Gold available to each side. White starts the game with 0 — the first
  // gain happens when it becomes black's turn (i.e. after white's first move).
  gold: { w: number; b: number };
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  bought: boolean;
  // A pawn reached the opponent's back rank and was cashed in for gold.
  cashedIn: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
};

// Gold gained when a pawn reaches the opponent's back rank in Cash Money.
export const CASH_IN_REWARD = 10;

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
const KNIGHT_OFFSETS: [number, number][] = [
  [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
];

// ------------------------------------------------------------------
// Initial position
// Layout (white perspective):
//   rank 2: pawns on c, d, e, f
//   rank 1: pawn on b, Queen on d, King on e, pawn on g
// Black mirrors.
// ------------------------------------------------------------------
export function initialState(): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  const white: Array<[number, number, PieceLetter]> = [
    [1, 0, 'P'], [3, 0, 'Q'], [4, 0, 'K'], [6, 0, 'P'],
    [2, 1, 'P'], [3, 1, 'P'], [4, 1, 'P'], [5, 1, 'P'],
  ];
  const black: Array<[number, number, PieceLetter]> = [
    [1, 7, 'p'], [3, 7, 'q'], [4, 7, 'k'], [6, 7, 'p'],
    [2, 6, 'p'], [3, 6, 'p'], [4, 6, 'p'], [5, 6, 'p'],
  ];
  for (const [f, r, l] of white) board[idxFR(f, r)] = { color: 'w', letter: l };
  for (const [f, r, l] of black) board[idxFR(f, r)] = { color: 'b', letter: l };
  const state: GameState = {
    board,
    turn: 'w',
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    positionHistory: [],
    gold: { w: 0, b: 0 },
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

// ------------------------------------------------------------------
// Pseudo-move generation (standard chess moves; no castling)
// ------------------------------------------------------------------
type PseudoMove = {
  from: number;
  to: number;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  enPassantCapture?: boolean;
  doublePawn?: boolean;
};

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const p = state.board[from];
  if (!p) return [];
  const out: PseudoMove[] = [];
  const [ff, fr] = frOfIdx(from);
  const up = p.letter.toUpperCase();
  if (up === 'P') pseudoPawn(state, from, ff, fr, p, out);
  else if (up === 'K') pseudoKing(state, from, ff, fr, p, out);
  else if (up === 'Q') pseudoSliding(state, from, ff, fr, p, EIGHT_DIRS, out);
  else if (up === 'B') pseudoSliding(state, from, ff, fr, p, BISHOP_DIRS, out);
  else if (up === 'R') pseudoSliding(state, from, ff, fr, p, ROOK_DIRS, out);
  else if (up === 'N') pseudoKnight(state, from, ff, fr, p, out);
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
}

function pseudoSliding(
  state: GameState, from: number, ff: number, fr: number, p: Piece,
  dirs: [number, number][], out: PseudoMove[],
) {
  for (const [df, dr] of dirs) {
    let f = ff + df, r = fr + dr;
    while (onBoard(f, r)) {
      const t = idxFR(f, r);
      const dest = state.board[t];
      if (dest) {
        if (dest.color !== p.color) out.push({ from, to: t });
        break;
      }
      out.push({ from, to: t });
      f += df; r += dr;
    }
  }
}

function pseudoKnight(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
}

function pseudoPawn(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  const dir = p.color === 'w' ? 1 : -1;
  const startRank = p.color === 'w' ? 1 : 6;
  // No promotion in Cash Money — a pawn that lands on the last rank vanishes
  // and the owner gains 10 gold (see CASH_IN_REWARD / applyPseudo).

  const oneR = fr + dir;
  if (onBoard(ff, oneR) && !state.board[idxFR(ff, oneR)]) {
    out.push({ from, to: idxFR(ff, oneR) });
    const twoR = fr + 2 * dir;
    if (fr === startRank && onBoard(ff, twoR) && !state.board[idxFR(ff, twoR)]) {
      out.push({ from, to: idxFR(ff, twoR), doublePawn: true });
    }
  }

  for (const df of [-1, 1]) {
    const f = ff + df, r = fr + dir;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color !== p.color) {
      out.push({ from, to: t });
    } else if (state.enPassant && idxToSq(t) === state.enPassant) {
      out.push({ from, to: t, enPassantCapture: true });
    }
  }
}

// ------------------------------------------------------------------
// Attack detection
// ------------------------------------------------------------------
export function isSquareAttacked(state: GameState, target: number, byColor: C2Color): boolean {
  const [tf, tr] = frOfIdx(target);

  // Pawn
  const pawnDir = byColor === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const f = tf - df, r = tr - pawnDir;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'P') return true;
  }

  // King
  for (const [df, dr] of EIGHT_DIRS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'K') return true;
  }

  // Knight
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const p = state.board[idxFR(f, r)];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'N') return true;
  }

  // Rook / Queen on orthogonal rays
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = state.board[idxFR(f, r)];
      if (p) {
        if (p.color === byColor) {
          const up = p.letter.toUpperCase();
          if (up === 'R' || up === 'Q') return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }

  // Bishop / Queen on diagonals
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = state.board[idxFR(f, r)];
      if (p) {
        if (p.color === byColor) {
          const up = p.letter.toUpperCase();
          if (up === 'B' || up === 'Q') return true;
        }
        break;
      }
      f += df; r += dr;
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

function hasQueen(state: GameState, color: C2Color): boolean {
  for (const p of state.board) {
    if (p && p.color === color && p.letter.toUpperCase() === 'Q') return true;
  }
  return false;
}

// Squares adjacent to the active player's king that are empty.
export function adjacentEmptySquares(state: GameState, color: C2Color): number[] {
  const k = findKing(state, color);
  if (k === -1) return [];
  const [kf, kr] = frOfIdx(k);
  const out: number[] = [];
  for (const [df, dr] of EIGHT_DIRS) {
    const f = kf + df, r = kr + dr;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    if (state.board[idx] == null) out.push(idx);
  }
  return out;
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
    gold: { ...state.gold },
  };

  const mover = next.board[mv.from]!;
  const moverUp = mover.letter.toUpperCase();
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

  // Cash-in: a pawn that lands on the opponent's back rank disappears and
  // the mover gains gold. If it captured into the back rank, the captured
  // piece is still gone (the dest square is just cleared along with the pawn).
  const [, tr] = frOfIdx(mv.to);
  const backRank = mover.color === 'w' ? 7 : 0;
  const isCashIn = moverUp === 'P' && tr === backRank;
  if (isCashIn) {
    next.board[mv.to] = null;
    next.gold[mover.color] += CASH_IN_REWARD;
  } else {
    next.board[mv.to] = resultPiece;
  }
  next.board[mv.from] = null;

  if (moverUp === 'P') next.halfmove = 0;

  if (mv.doublePawn) {
    const [tf, tr] = frOfIdx(mv.to);
    const epRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.enPassant = idxToSq(idxFR(tf, epRank));
  }

  // Whoever's turn it is *now* gains 1 gold (because the turn just changed
  // to them). This matches the rule "whenever turn changes, the player who's
  // turn it is to move gains one gold".
  next.gold[next.turn] += 1;

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;

  return next;
}

// Apply a buy (already validated by the caller, see legalBuys).
function applyBuy(state: GameState, letter: ShopLetter, toIdx: number): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    positionHistory: state.positionHistory,
    gold: { ...state.gold },
  };
  const color = state.turn;
  const pieceLetter: PieceLetter = (color === 'w' ? letter : letter.toLowerCase()) as PieceLetter;
  next.board[toIdx] = { color, letter: pieceLetter };
  next.gold[color] -= SHOP_PRICES[letter];
  // Gold tick for the new active player.
  next.gold[next.turn] += 1;

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;
  return next;
}

// ------------------------------------------------------------------
// Legal move generation
// ------------------------------------------------------------------
export type LegalMove = {
  to: Square;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  isCapture: boolean;
  // No 'special' interactions in Cash (no merge / push). Kept for board UI parity.
  isSpecial: boolean;
};

export function legalMovesFrom(state: GameState, from: Square): LegalMove[] {
  const idx = sqToIdx(from);
  const p = state.board[idx];
  if (!p || p.color !== state.turn) return [];
  const pseudos = pseudoMoves(state, idx);
  const moverColor = p.color;
  const out: LegalMove[] = [];
  for (const pm of pseudos) {
    const next = applyPseudo(state, pm);
    if (isInCheck(next, moverColor)) continue;
    const dest = state.board[pm.to];
    const isCapture = !!dest || !!pm.enPassantCapture;
    out.push({ to: idxToSq(pm.to), promotion: pm.promotion, isCapture, isSpecial: false });
  }
  return out;
}

export function allLegalBoardMoves(state: GameState): { from: Square; to: Square; promotion?: 'Q' | 'R' | 'B' | 'N' }[] {
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

// Letters the active player can legally buy *some* placement for, given gold
// and queen-uniqueness. (Doesn't account for self-check from the placement —
// individual squares get filtered by legalBuyTargets.)
export function affordableLetters(state: GameState): ShopLetter[] {
  const out: ShopLetter[] = [];
  const goldAvail = state.gold[state.turn];
  for (const L of SHOP_LETTERS) {
    if (SHOP_PRICES[L] > goldAvail) continue;
    if (L === 'Q' && hasQueen(state, state.turn)) continue;
    out.push(L);
  }
  return out;
}

// Squares (adjacent to own king, empty) where the given letter can be placed
// without leaving the mover in check.
export function legalBuyTargets(state: GameState, letter: ShopLetter): Square[] {
  if (SHOP_PRICES[letter] > state.gold[state.turn]) return [];
  if (letter === 'Q' && hasQueen(state, state.turn)) return [];
  const candidates = adjacentEmptySquares(state, state.turn);
  const out: Square[] = [];
  const moverColor = state.turn;
  for (const idx of candidates) {
    const next = applyBuy(state, letter, idx);
    if (isInCheck(next, moverColor)) continue;
    out.push(idxToSq(idx));
  }
  return out;
}

// Any legal buy at all, for any letter — used in mate detection.
function anyLegalBuy(state: GameState): boolean {
  for (const L of affordableLetters(state)) {
    if (legalBuyTargets(state, L).length > 0) return true;
  }
  return false;
}

// ------------------------------------------------------------------
// Apply move (UCI-ish). Buys are encoded as `+<L><sq>` (e.g. `+Ne2`).
// ------------------------------------------------------------------
export function isBuyUci(uci: string): boolean {
  return uci.length >= 4 && uci[0] === '+';
}

export function parseBuy(uci: string): { letter: ShopLetter; to: Square } | null {
  if (!isBuyUci(uci)) return null;
  const L = uci[1].toUpperCase();
  if (!SHOP_LETTERS.includes(L as ShopLetter)) return null;
  const to = uci.slice(2, 4);
  if (to.length !== 2) return null;
  return { letter: L as ShopLetter, to };
}

export function buyUci(letter: ShopLetter, to: Square): string {
  return `+${letter}${to}`;
}

export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  if (isBuyUci(uci)) {
    const parsed = parseBuy(uci);
    if (!parsed) return null;
    if (!legalBuyTargets(state, parsed.letter).includes(parsed.to)) return null;
    const next = applyBuy(state, parsed.letter, sqToIdx(parsed.to));
    const moverColor = state.turn;
    if (isInCheck(next, moverColor)) return null;
    const check = isInCheck(next, next.turn);
    const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalBuy(next);
    const checkmate = check && !oppHasMoves;
    const stalemate = !check && !oppHasMoves;
    return {
      state: next,
      result: {
        uci,
        fenAfter: toFen(next),
        captured: false,
        bought: true,
        cashedIn: false,
        check,
        checkmate,
        stalemate,
      },
    };
  }

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
  const captured = !!dest || !!chosen.enPassantCapture;
  const mover = state.board[fromIdx]!;
  const moverUp = mover.letter.toUpperCase();
  const [, toRank] = frOfIdx(toIdx);
  const backRank = mover.color === 'w' ? 7 : 0;
  const cashedIn = moverUp === 'P' && toRank === backRank;
  const check = isInCheck(next, next.turn);
  const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalBuy(next);
  const checkmate = check && !oppHasMoves;
  const stalemate = !check && !oppHasMoves;

  return {
    state: next,
    result: {
      uci,
      fenAfter: toFen(next),
      captured,
      bought: false,
      cashedIn,
      check,
      checkmate,
      stalemate,
    },
  };
}

// ------------------------------------------------------------------
// FEN serialization. Standard chess FEN with castling field set to '-' and
// gold appended as a final whitespace-separated `gW/B` token, so the fen
// fully captures cash state.
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
  return `${board} ${state.turn} - ${ep} ${state.halfmove} ${state.fullmove} ${state.gold.w}/${state.gold.b}`;
}

export function fromFen(fen: string): GameState {
  const tokens = fen.split(/\s+/);
  const [boardPart, turnPart, _castlingPart, epPart, hmPart, fmPart, goldPart] = tokens;
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
  let goldW = 0, goldB = 0;
  if (goldPart && goldPart.includes('/')) {
    const [a, b] = goldPart.split('/');
    goldW = parseInt(a, 10) || 0;
    goldB = parseInt(b, 10) || 0;
  }
  const state: GameState = {
    board,
    turn: turnPart === 'w' ? 'w' : 'b',
    enPassant: epPart === '-' ? null : epPart,
    halfmove: parseInt(hmPart || '0', 10),
    fullmove: parseInt(fmPart || '1', 10),
    positionHistory: [],
    gold: { w: goldW, b: goldB },
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

function positionKey(state: GameState): string {
  const fen = toFen(state);
  const parts = fen.split(/\s+/);
  // Include gold in the position key so threefold treats different gold totals
  // as different positions (otherwise pure-king shuffles could falsely repeat).
  return parts.slice(0, 4).join(' ') + ' ' + (parts[6] ?? '0/0');
}

// ------------------------------------------------------------------
// End-state checks
// ------------------------------------------------------------------
export function isCheckmate(state: GameState): boolean {
  if (!isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalBuy(state);
}

export function isStalemate(state: GameState): boolean {
  if (isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalBuy(state);
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

// In Cash Money the K-vs-K endgame is decided by gold rather than by material
// alone: the side with more gold wins, ties draw. So the standard
// "insufficient material" auto-draw is never reached — callers should use
// kingsOnlyOutcome to detect and resolve the K-vs-K position instead.
export function isInsufficientMaterial(_state: GameState): boolean {
  void _state;
  return false;
}

// Returns 'w' | 'b' if a side wins on gold in a K-vs-K position, 'draw' if
// gold is equal, or null if at least one non-king piece remains on the board.
export function kingsOnlyOutcome(state: GameState): 'w' | 'b' | 'draw' | null {
  for (const p of state.board) {
    if (p && p.letter.toUpperCase() !== 'K') return null;
  }
  if (state.gold.w > state.gold.b) return 'w';
  if (state.gold.b > state.gold.w) return 'b';
  return 'draw';
}
