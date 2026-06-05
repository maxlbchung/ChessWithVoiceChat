// Farmer - queen versus a full row of pawns.
//
// White is the queen side and starts with one queen on d1.
// Black is the farmer side and starts with pawns on a7-h7.
//
// Win conditions:
//   - a black pawn reaches rank 1: farmer side wins immediately
//   - white captures every pawn: queen side wins immediately
//   - a pawn captures the queen: farmer side wins immediately

export type FarmerColor = 'w' | 'b';

export type PieceLetter = 'Q' | 'p';

export type Piece = {
  color: FarmerColor;
  letter: PieceLetter;
};

export type Square = string;

export type GameState = {
  board: (Piece | null)[];
  turn: FarmerColor;
  halfmove: number;
  fullmove: number;
  positionHistory: string[];
};

export type FarmerWinReason = 'promotion' | 'pawns-cleared' | 'queen-captured';

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  promoted: boolean;
  pawnsCleared: boolean;
  queenCaptured: boolean;
  winner: FarmerColor | null;
  winReason: FarmerWinReason | null;
  stalemate: boolean;
};

type PseudoMove = {
  from: number;
  to: number;
  doublePawn?: boolean;
};

const ROOK_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS: [number, number][] = [...ROOK_DIRS, ...BISHOP_DIRS];

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

export function initialState(): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  board[idxFR(3, 0)] = { color: 'w', letter: 'Q' };
  for (let f = 0; f < 8; f++) {
    board[idxFR(f, 6)] = { color: 'b', letter: 'p' };
  }
  const state: GameState = {
    board,
    turn: 'w',
    halfmove: 0,
    fullmove: 1,
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const piece = state.board[from];
  if (!piece) return [];
  const [ff, fr] = frOfIdx(from);
  if (piece.letter === 'Q') return pseudoQueen(state, from, ff, fr);
  return pseudoPawn(state, from, ff, fr);
}

function pseudoQueen(state: GameState, from: number, ff: number, fr: number): PseudoMove[] {
  const out: PseudoMove[] = [];
  for (const [df, dr] of QUEEN_DIRS) {
    let f = ff + df;
    let r = fr + dr;
    while (onBoard(f, r)) {
      const t = idxFR(f, r);
      const dest = state.board[t];
      if (dest) {
        if (dest.color === 'b') out.push({ from, to: t });
        break;
      }
      out.push({ from, to: t });
      f += df;
      r += dr;
    }
  }
  return out;
}

function pseudoPawn(state: GameState, from: number, ff: number, fr: number): PseudoMove[] {
  const out: PseudoMove[] = [];
  const oneR = fr - 1;
  if (onBoard(ff, oneR) && !state.board[idxFR(ff, oneR)]) {
    out.push({ from, to: idxFR(ff, oneR) });
    const twoR = fr - 2;
    if (fr === 6 && onBoard(ff, twoR) && !state.board[idxFR(ff, twoR)]) {
      out.push({ from, to: idxFR(ff, twoR), doublePawn: true });
    }
  }

  for (const df of [-1, 1]) {
    const f = ff + df;
    const r = fr - 1;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    if (dest && dest.color === 'w') out.push({ from, to: t });
  }

  return out;
}

function applyPseudo(state: GameState, mv: PseudoMove): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    positionHistory: state.positionHistory,
  };

  const mover = next.board[mv.from]!;
  const dest = next.board[mv.to];
  if (dest || mover.letter === 'p') next.halfmove = 0;
  next.board[mv.to] = mover;
  next.board[mv.from] = null;

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;
  return next;
}

export type LegalMove = {
  to: Square;
  isCapture: boolean;
  isSpecial: boolean;
};

export function legalMovesFrom(state: GameState, from: Square): LegalMove[] {
  if (winnerOf(state)) return [];
  const idx = sqToIdx(from);
  const piece = state.board[idx];
  if (!piece || piece.color !== state.turn) return [];
  return pseudoMoves(state, idx).map((mv) => ({
    to: idxToSq(mv.to),
    isCapture: !!state.board[mv.to],
    isSpecial: false,
  }));
}

export function allLegalMoves(state: GameState): { from: Square; to: Square }[] {
  if (winnerOf(state)) return [];
  const out: { from: Square; to: Square }[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece || piece.color !== state.turn) continue;
    const from = idxToSq(i);
    for (const m of legalMovesFrom(state, from)) out.push({ from, to: m.to });
  }
  return out;
}

export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  if (winnerOf(state)) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (!/^[a-h][1-8][a-h][1-8]$/.test(from + to)) return null;

  const fromIdx = sqToIdx(from);
  const toIdx = sqToIdx(to);
  const mover = state.board[fromIdx];
  if (!mover || mover.color !== state.turn) return null;
  const chosen = pseudoMoves(state, fromIdx).find((mv) => mv.to === toIdx);
  if (!chosen) return null;

  const capturedPiece = state.board[toIdx];
  const next = applyPseudo(state, chosen);
  const [, toRank] = frOfIdx(toIdx);
  const promoted = mover.letter === 'p' && toRank === 0;
  const queenCaptured = capturedPiece?.letter === 'Q' || !hasQueen(next);
  const pawnsCleared = countPawns(next) === 0;
  let winner: FarmerColor | null = null;
  let winReason: FarmerWinReason | null = null;

  if (promoted) {
    winner = 'b';
    winReason = 'promotion';
  } else if (queenCaptured) {
    winner = 'b';
    winReason = 'queen-captured';
  } else if (pawnsCleared) {
    winner = 'w';
    winReason = 'pawns-cleared';
  }

  const stalemate = !winner && allLegalMoves(next).length === 0;

  return {
    state: next,
    result: {
      uci,
      fenAfter: toFen(next),
      captured: !!capturedPiece,
      promoted,
      pawnsCleared,
      queenCaptured,
      winner,
      winReason,
      stalemate,
    },
  };
}

export function winnerOf(state: GameState): { winner: FarmerColor; reason: FarmerWinReason } | null {
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (piece?.letter === 'p') {
      const [, rank] = frOfIdx(i);
      if (rank === 0) return { winner: 'b', reason: 'promotion' };
    }
  }
  if (!hasQueen(state)) return { winner: 'b', reason: 'queen-captured' };
  if (countPawns(state) === 0) return { winner: 'w', reason: 'pawns-cleared' };
  return null;
}

function hasQueen(state: GameState): boolean {
  return state.board.some((piece) => piece?.letter === 'Q');
}

function countPawns(state: GameState): number {
  let count = 0;
  for (const piece of state.board) {
    if (piece?.letter === 'p') count++;
  }
  return count;
}

export function isStalemate(state: GameState): boolean {
  return !winnerOf(state) && allLegalMoves(state).length === 0;
}

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
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += p.letter;
      }
    }
    if (empty > 0) row += empty;
    parts.push(row);
  }
  return `${parts.join('/')} ${state.turn} - - ${state.halfmove} ${state.fullmove}`;
}

export function fromFen(fen: string): GameState {
  const [boardPart, turnPart, _castlingPart, _epPart, hmPart, fmPart] = fen.split(/\s+/);
  void _castlingPart;
  void _epPart;
  const board: (Piece | null)[] = new Array(64).fill(null);
  const ranks = boardPart.split('/');
  for (let i = 0; i < 8; i++) {
    const r = 7 - i;
    const row = ranks[i] ?? '8';
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        f += parseInt(ch, 10);
      } else if (ch === 'Q' || ch === 'p') {
        board[idxFR(f, r)] = { color: ch === 'Q' ? 'w' : 'b', letter: ch };
        f++;
      }
    }
  }
  const state: GameState = {
    board,
    turn: turnPart === 'b' ? 'b' : 'w',
    halfmove: parseInt(hmPart || '0', 10),
    fullmove: parseInt(fmPart || '1', 10),
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

function positionKey(state: GameState): string {
  const parts = toFen(state).split(/\s+/);
  return parts.slice(0, 4).join(' ');
}
