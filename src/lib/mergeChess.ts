// Merge Chess — a chess variant where pieces can capture their own R/N/B/Q
// pieces to fuse their movement patterns. Kings and pawns can't merge and
// can't be captured by their own team.
//
// Piece encoding (single letter, casing for color):
//   P — pawn
//   K — king
//   R — rook       (abilities: R)
//   B — bishop     (abilities: B)
//   N — knight     (abilities: N)
//   Q — queen      (abilities: R+B)
//   C — chancellor (abilities: R+N) — rook + knight
//   A — archbishop (abilities: B+N) — bishop + knight
//   Z — amazon     (abilities: R+B+N) — queen + knight
//
// Move encoding: same UCI style as standard chess (e2e4, e7e8q). Self-captures
// (merges) use the same encoding — engine recognises the target piece colour.

export type MergeColor = 'w' | 'b';

// Single-letter codes (uppercase = white, lowercase = black)
export type PieceLetter =
  | 'P' | 'K' | 'R' | 'B' | 'N' | 'Q' | 'C' | 'A' | 'Z'
  | 'p' | 'k' | 'r' | 'b' | 'n' | 'q' | 'c' | 'a' | 'z';

export type Abilities = {
  R: boolean;  // rook (orthogonal slide)
  B: boolean;  // bishop (diagonal slide)
  N: boolean;  // knight (L-shape jump)
};

export type Piece = {
  color: MergeColor;
  letter: PieceLetter;  // canonical uppercase or lowercase letter
};

export type Square = string;  // 'a1' .. 'h8'

export type CastlingRights = {
  K: boolean;  // white king-side
  Q: boolean;  // white queen-side
  k: boolean;  // black king-side
  q: boolean;  // black queen-side
};

export type GameState = {
  // 64-square array, indexed 0..63 where 0 = a8, 7 = h8, 56 = a1, 63 = h1
  board: (Piece | null)[];
  turn: MergeColor;
  castling: CastlingRights;
  enPassant: Square | null;
  halfmove: number;  // for 50-move rule
  fullmove: number;
  // position history for repetition detection (board+turn+castling+ep keyed)
  positionHistory: string[];
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  merged: boolean;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
};

// ----------------------------------------------------------------------
// Letter <-> abilities mapping
// ----------------------------------------------------------------------

const LETTER_TO_ABILITIES: Record<string, Abilities> = {
  R: { R: true,  B: false, N: false },
  B: { R: false, B: true,  N: false },
  N: { R: false, B: false, N: true  },
  Q: { R: true,  B: true,  N: false },
  C: { R: true,  B: false, N: true  },
  A: { R: false, B: true,  N: true  },
  Z: { R: true,  B: true,  N: true  },
};

function abilitiesToLetter(a: Abilities): 'R' | 'B' | 'N' | 'Q' | 'C' | 'A' | 'Z' {
  if (a.R && a.B && a.N) return 'Z';
  if (a.R && a.B)        return 'Q';
  if (a.R && a.N)        return 'C';
  if (a.B && a.N)        return 'A';
  if (a.R)               return 'R';
  if (a.B)               return 'B';
  if (a.N)               return 'N';
  throw new Error('empty abilities');
}

export function pieceAbilities(p: Piece): Abilities | null {
  const up = p.letter.toUpperCase();
  return LETTER_TO_ABILITIES[up] ?? null;
}

export function isMergeable(p: Piece): boolean {
  // Pawns and kings cannot merge / be captured by own team.
  const up = p.letter.toUpperCase();
  return up !== 'P' && up !== 'K';
}

export function mergeAbilities(a: Abilities, b: Abilities): Abilities {
  return { R: a.R || b.R, B: a.B || b.B, N: a.N || b.N };
}

// ----------------------------------------------------------------------
// Square <-> index helpers
// ----------------------------------------------------------------------

export function sqToIdx(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;        // 'a' .. 'h' → 0..7
  const rank = sq.charCodeAt(1) - 49;        // '1' .. '8' → 0..7
  // idx 0 = a8 (top-left in our array), 63 = h1
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

// ----------------------------------------------------------------------
// Initial position
// ----------------------------------------------------------------------

export function initialState(): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'] as const;
  for (let f = 0; f < 8; f++) {
    board[idxFR(f, 7)] = { color: 'b', letter: backRank[f].toLowerCase() as PieceLetter };
    board[idxFR(f, 6)] = { color: 'b', letter: 'p' };
    board[idxFR(f, 1)] = { color: 'w', letter: 'P' };
    board[idxFR(f, 0)] = { color: 'w', letter: backRank[f] };
  }
  const state: GameState = {
    board,
    turn: 'w',
    castling: { K: true, Q: true, k: true, q: true },
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

// ----------------------------------------------------------------------
// Move generation
// ----------------------------------------------------------------------

const ROOK_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KNIGHT_OFFSETS: [number, number][] = [
  [1, 2], [2, 1], [-1, 2], [-2, 1],
  [1, -2], [2, -1], [-1, -2], [-2, -1],
];
const KING_OFFSETS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Generate pseudo-legal destinations for a piece on `from` (not filtered for check).
// Returns an array of target indices (with metadata: special flags for castling/ep/promo).
type PseudoMove = {
  from: number;
  to: number;
  promotion?: 'Q' | 'R' | 'B' | 'N';  // pawn promotion target letter (always uppercase, color applied later)
  castling?: 'K' | 'Q' | 'k' | 'q';
  enPassantCapture?: boolean;
  doublePawn?: boolean;  // pawn moved two squares — sets new ep target
};

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const p = state.board[from];
  if (!p) return [];
  const out: PseudoMove[] = [];
  const up = p.letter.toUpperCase();
  const [ff, fr] = frOfIdx(from);

  if (up === 'P') {
    pseudoPawn(state, from, ff, fr, p, out);
    return out;
  }
  if (up === 'K') {
    pseudoKing(state, from, ff, fr, p, out);
    return out;
  }

  // R/N/B/Q/C/A/Z — use ability set
  const ab = pieceAbilities(p)!;
  if (ab.R) pseudoSlider(state, from, ff, fr, p, ROOK_DIRS, out);
  if (ab.B) pseudoSlider(state, from, ff, fr, p, BISHOP_DIRS, out);
  if (ab.N) pseudoKnight(state, from, ff, fr, p, out);
  return out;
}

function canLandOn(state: GameState, from: number, target: number): 'empty' | 'capture' | 'merge' | 'blocked' {
  const dest = state.board[target];
  if (!dest) return 'empty';
  const mover = state.board[from]!;
  if (dest.color !== mover.color) return 'capture';
  // Same color — only allowed if BOTH pieces are mergeable (not pawn/king)
  if (isMergeable(mover) && isMergeable(dest)) return 'merge';
  return 'blocked';
}

function pseudoSlider(
  state: GameState, from: number, ff: number, fr: number, p: Piece,
  dirs: [number, number][], out: PseudoMove[],
) {
  for (const [df, dr] of dirs) {
    let f = ff + df, r = fr + dr;
    while (onBoard(f, r)) {
      const t = idxFR(f, r);
      const status = canLandOn(state, from, t);
      if (status === 'empty') {
        out.push({ from, to: t });
      } else if (status === 'capture' || status === 'merge') {
        out.push({ from, to: t });
        break;
      } else {
        // blocked (own pawn/king)
        break;
      }
      void p;
      f += df; r += dr;
    }
  }
}

function pseudoKnight(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  void p;
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const status = canLandOn(state, from, t);
    if (status !== 'blocked') out.push({ from, to: t });
  }
}

function pseudoKing(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  for (const [df, dr] of KING_OFFSETS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = state.board[t];
    // King cannot merge (and cannot land on own piece at all)
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
  // Castling — pseudo-only here; check-test happens in legality filter
  const homeRank = p.color === 'w' ? 0 : 7;
  if (fr === homeRank && ff === 4) {
    // King-side
    const kRight = p.color === 'w' ? state.castling.K : state.castling.k;
    if (kRight) {
      const f5 = idxFR(5, homeRank);
      const f6 = idxFR(6, homeRank);
      const rookSq = idxFR(7, homeRank);
      const rookPiece = state.board[rookSq];
      if (
        !state.board[f5] && !state.board[f6] &&
        rookPiece && rookPiece.color === p.color &&
        // must still have rook ability and not have moved (castling right tracks both)
        (pieceAbilities(rookPiece)?.R ?? false)
      ) {
        out.push({ from, to: f6, castling: p.color === 'w' ? 'K' : 'k' });
      }
    }
    // Queen-side
    const qRight = p.color === 'w' ? state.castling.Q : state.castling.q;
    if (qRight) {
      const f1 = idxFR(1, homeRank);
      const f2 = idxFR(2, homeRank);
      const f3 = idxFR(3, homeRank);
      const rookSq = idxFR(0, homeRank);
      const rookPiece = state.board[rookSq];
      if (
        !state.board[f1] && !state.board[f2] && !state.board[f3] &&
        rookPiece && rookPiece.color === p.color &&
        (pieceAbilities(rookPiece)?.R ?? false)
      ) {
        out.push({ from, to: idxFR(2, homeRank), castling: p.color === 'w' ? 'Q' : 'q' });
      }
    }
  }
}

function pseudoPawn(
  state: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[],
) {
  const dir = p.color === 'w' ? 1 : -1;
  const startRank = p.color === 'w' ? 1 : 6;
  const promoRank = p.color === 'w' ? 7 : 0;

  const oneR = fr + dir;
  if (onBoard(ff, oneR) && !state.board[idxFR(ff, oneR)]) {
    if (oneR === promoRank) {
      for (const promo of ['Q', 'R', 'B', 'N'] as const) {
        out.push({ from, to: idxFR(ff, oneR), promotion: promo });
      }
    } else {
      out.push({ from, to: idxFR(ff, oneR) });
      // Double pawn from start rank
      const twoR = fr + 2 * dir;
      if (fr === startRank && onBoard(ff, twoR) && !state.board[idxFR(ff, twoR)]) {
        out.push({ from, to: idxFR(ff, twoR), doublePawn: true });
      }
    }
  }

  // Diagonal captures (incl. en passant). Pawns CANNOT capture own pieces.
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

// ----------------------------------------------------------------------
// Attack detection (for check / castling-through-check)
// ----------------------------------------------------------------------

// Is `target` square (index) attacked by `byColor` in the given state?
export function isSquareAttacked(state: GameState, target: number, byColor: MergeColor): boolean {
  const [tf, tr] = frOfIdx(target);

  // Pawn attacks (only diagonal, only forward for that color)
  const pawnDir = byColor === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const f = tf - df, r = tr - pawnDir;
    if (onBoard(f, r)) {
      const idx = idxFR(f, r);
      const p = state.board[idx];
      if (p && p.color === byColor && p.letter.toUpperCase() === 'P') return true;
    }
  }

  // Knight-ability attacks
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    const p = state.board[idx];
    if (!p || p.color !== byColor) continue;
    const ab = pieceAbilities(p);
    if (ab?.N) return true;
  }

  // King attacks (king has no abilities map — handle separately)
  for (const [df, dr] of KING_OFFSETS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    const p = state.board[idx];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'K') return true;
  }

  // Rook-ability slides
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const idx = idxFR(f, r);
      const p = state.board[idx];
      if (p) {
        if (p.color === byColor) {
          const ab = pieceAbilities(p);
          if (ab?.R) return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }

  // Bishop-ability slides
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const idx = idxFR(f, r);
      const p = state.board[idx];
      if (p) {
        if (p.color === byColor) {
          const ab = pieceAbilities(p);
          if (ab?.B) return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }

  return false;
}

function findKing(state: GameState, color: MergeColor): number {
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return i;
  }
  return -1;
}

export function isInCheck(state: GameState, color: MergeColor): boolean {
  const k = findKing(state, color);
  if (k === -1) return false;
  return isSquareAttacked(state, k, color === 'w' ? 'b' : 'w');
}

// ----------------------------------------------------------------------
// Apply a move (mutating)
// ----------------------------------------------------------------------

function applyPseudo(state: GameState, mv: PseudoMove): GameState {
  // Returns a NEW state (immutable-ish: shallow clones what's needed)
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    positionHistory: state.positionHistory,
  };

  const mover = next.board[mv.from]!;
  const dest = next.board[mv.to];
  const moverUp = mover.letter.toUpperCase();

  // Capture handling — pawn capture or non-merge capture clears the dest piece.
  // Merge handling — combine abilities into a new piece on the dest square.
  let resultPiece: Piece = mover;

  if (dest) {
    if (dest.color === mover.color) {
      // Self-capture → merge (only reachable for mergeable mover+dest, see canLandOn)
      const ma = pieceAbilities(mover)!;
      const da = pieceAbilities(dest)!;
      const combined = mergeAbilities(ma, da);
      const letter = abilitiesToLetter(combined);
      resultPiece = {
        color: mover.color,
        letter: mover.color === 'w' ? letter : (letter.toLowerCase() as PieceLetter),
      };
    } else {
      // Enemy capture — captured piece simply removed
      next.halfmove = 0;
    }
  }

  // En passant capture
  if (mv.enPassantCapture) {
    // The captured pawn sits "behind" the move target
    const [tf, tr] = frOfIdx(mv.to);
    const capRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.board[idxFR(tf, capRank)] = null;
    next.halfmove = 0;
  }

  // Pawn promotion
  if (mv.promotion) {
    const letter = mv.promotion;
    resultPiece = {
      color: mover.color,
      letter: mover.color === 'w' ? letter : (letter.toLowerCase() as PieceLetter),
    };
  }

  // Pawn move resets halfmove clock
  if (moverUp === 'P') next.halfmove = 0;

  // Castling: also move the rook
  if (mv.castling) {
    const homeRank = mover.color === 'w' ? 0 : 7;
    if (mv.castling === 'K' || mv.castling === 'k') {
      const rookFrom = idxFR(7, homeRank);
      const rookTo   = idxFR(5, homeRank);
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
    } else {
      const rookFrom = idxFR(0, homeRank);
      const rookTo   = idxFR(3, homeRank);
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
    }
  }

  // Move the piece
  next.board[mv.to] = resultPiece;
  next.board[mv.from] = null;

  // Double pawn → set en passant
  if (mv.doublePawn) {
    const [tf, tr] = frOfIdx(mv.to);
    const epRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.enPassant = idxToSq(idxFR(tf, epRank));
  }

  // Update castling rights when relevant squares are touched
  updateCastlingRights(next, mv.from, mv.to);

  // Append position to history for repetition detection
  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;

  return next;
}

function updateCastlingRights(state: GameState, from: number, to: number) {
  // If the king moved, lose that side's castling rights
  // If a rook square is touched (left or arrived-at via capture), lose that flank
  const W_K = idxFR(4, 0);
  const W_RK = idxFR(7, 0);
  const W_RQ = idxFR(0, 0);
  const B_K = idxFR(4, 7);
  const B_RK = idxFR(7, 7);
  const B_RQ = idxFR(0, 7);

  if (from === W_K) { state.castling.K = false; state.castling.Q = false; }
  if (from === B_K) { state.castling.k = false; state.castling.q = false; }
  if (from === W_RK || to === W_RK) state.castling.K = false;
  if (from === W_RQ || to === W_RQ) state.castling.Q = false;
  if (from === B_RK || to === B_RK) state.castling.k = false;
  if (from === B_RQ || to === B_RQ) state.castling.q = false;
}

// ----------------------------------------------------------------------
// Legal move generation (filters pseudo-moves that leave own king in check)
// ----------------------------------------------------------------------

export function legalMovesFrom(state: GameState, from: Square): {
  to: Square;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  isCapture: boolean;
  isMerge: boolean;
}[] {
  const idx = sqToIdx(from);
  const p = state.board[idx];
  if (!p || p.color !== state.turn) return [];
  const pseudos = pseudoMoves(state, idx);
  const moverColor = p.color;
  const result: { to: Square; promotion?: 'Q' | 'R' | 'B' | 'N'; isCapture: boolean; isMerge: boolean }[] = [];
  for (const pm of pseudos) {
    if (pm.castling) {
      // Castling through/into check must be validated
      if (isInCheck(state, moverColor)) continue;
      const homeRank = moverColor === 'w' ? 0 : 7;
      const passSq = (pm.castling === 'K' || pm.castling === 'k') ? idxFR(5, homeRank) : idxFR(3, homeRank);
      if (isSquareAttacked(state, passSq, moverColor === 'w' ? 'b' : 'w')) continue;
    }
    const next = applyPseudo(state, pm);
    if (isInCheck(next, moverColor)) continue;
    const destPiece = state.board[pm.to];
    const isMerge = !!(destPiece && destPiece.color === moverColor);
    const isCapture = !!destPiece || !!pm.enPassantCapture;
    result.push({
      to: idxToSq(pm.to),
      promotion: pm.promotion,
      isCapture,
      isMerge,
    });
  }
  return result;
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

// ----------------------------------------------------------------------
// Apply a move (validated; throws on illegal)
// ----------------------------------------------------------------------

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

  // Pick the matching pseudo (handling promotion choice)
  let chosen: PseudoMove | null = null;
  for (const pm of pseudos) {
    if (pm.promotion) {
      if (promoChar && pm.promotion === promoChar) { chosen = pm; break; }
    } else if (!promoChar) {
      chosen = pm; break;
    }
  }
  if (!chosen) return null;

  // Castling-through-check validation
  if (chosen.castling) {
    if (isInCheck(state, moverColor)) return null;
    const homeRank = moverColor === 'w' ? 0 : 7;
    const passSq = (chosen.castling === 'K' || chosen.castling === 'k') ? idxFR(5, homeRank) : idxFR(3, homeRank);
    if (isSquareAttacked(state, passSq, moverColor === 'w' ? 'b' : 'w')) return null;
  }

  const next = applyPseudo(state, chosen);
  if (isInCheck(next, moverColor)) return null;

  const destPiece = state.board[toIdx];
  const captured = !!destPiece || !!chosen.enPassantCapture;
  const merged = !!(destPiece && destPiece.color === moverColor);
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
      merged,
      check,
      checkmate,
      stalemate,
    },
  };
}

// ----------------------------------------------------------------------
// FEN-style serialization (using extended piece letters)
// ----------------------------------------------------------------------

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
  const turn = state.turn;
  const c = state.castling;
  const castling =
    (c.K ? 'K' : '') + (c.Q ? 'Q' : '') + (c.k ? 'k' : '') + (c.q ? 'q' : '') || '-';
  const ep = state.enPassant ?? '-';
  return `${board} ${turn} ${castling} ${ep} ${state.halfmove} ${state.fullmove}`;
}

export function fromFen(fen: string): GameState {
  const [boardPart, turnPart, castlingPart, epPart, hmPart, fmPart] = fen.split(/\s+/);
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
        const color: MergeColor = ch === ch.toUpperCase() ? 'w' : 'b';
        board[idxFR(f, r)] = { color, letter: ch as PieceLetter };
        f++;
      }
    }
  }
  const castling: CastlingRights = {
    K: castlingPart.includes('K'),
    Q: castlingPart.includes('Q'),
    k: castlingPart.includes('k'),
    q: castlingPart.includes('q'),
  };
  const state: GameState = {
    board,
    turn: turnPart === 'w' ? 'w' : 'b',
    castling,
    enPassant: epPart === '-' ? null : epPart,
    halfmove: parseInt(hmPart || '0', 10),
    fullmove: parseInt(fmPart || '1', 10),
    positionHistory: [],
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

// A compact position key — used for threefold-repetition detection.
function positionKey(state: GameState): string {
  const fen = toFen(state);
  // strip halfmove + fullmove
  const parts = fen.split(/\s+/);
  return parts.slice(0, 4).join(' ');
}

// ----------------------------------------------------------------------
// End-state checks
// ----------------------------------------------------------------------

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

// Insufficient material in merge mode is rare; we only call it if both sides
// have only kings left.
export function isInsufficientMaterial(state: GameState): boolean {
  for (const p of state.board) {
    if (p && p.letter.toUpperCase() !== 'K') return false;
  }
  return true;
}
