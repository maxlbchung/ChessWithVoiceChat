// Hero — standard chess but each side picks a "hero king" with a special
// ability. Pieces and king move normally (no castling for simplicity, since
// the king has its own special moves). Abilities use a turn and have either a
// cooldown (Frost / Knight / Necromancer) or are one-shot (Flight).
//
// Heroes:
//   Frost       — Freeze any non-king piece for the opponent's next move
//                 (immune to capture AND can't move).        cooldown: 5 turns
//   Knight      — Destroy one enemy piece adjacent to your king,
//                 your king does not move.                   cooldown: 10 turns
//   Necromancer — Spawn an own pawn on an empty square adjacent
//                 to your king.                              cooldown: 10 turns
//   Flight      — Move the king to any unoccupied square not attacked by
//                 the opponent.                              once per match
//
// Ability moves piggy-back on the existing signed-move pipeline by using
// pseudo-UCI strings:
//   !F<sq>  — Frost freeze
//   !K<sq>  — Knight destroy
//   !N<sq>  — Necromancer spawn
//   !L<sq>  — Flight teleport

export type C2Color = 'w' | 'b';

export type PieceLetter =
  | 'P' | 'K' | 'R' | 'B' | 'N' | 'Q'
  | 'p' | 'k' | 'r' | 'b' | 'n' | 'q';

export type Piece = { color: C2Color; letter: PieceLetter };
export type Square = string;

export type HeroKind = 'frost' | 'knight' | 'necromancer' | 'flight';
export const HERO_KINDS: HeroKind[] = ['frost', 'knight', 'necromancer', 'flight'];

export type HeroInfo = {
  kind: HeroKind;
  name: string;
  blurb: string;
  // Hex colour used for the king's glow.
  glowColor: string;
  // Cooldown in *turns*. A "turn" is one of your own moves; we convert to
  // plies internally by multiplying by 2. `null` = one-shot ability.
  cooldownTurns: number | null;
};

export const HERO_INFO: Record<HeroKind, HeroInfo> = {
  frost: {
    kind: 'frost',
    name: 'Frost',
    blurb: 'Freeze a piece for one of the opponent’s moves — can’t be captured or moved.',
    glowColor: '#2b6fb0',
    cooldownTurns: 5,
  },
  knight: {
    kind: 'knight',
    name: 'Knight',
    blurb: 'Destroy an enemy piece adjacent to your king without moving.',
    glowColor: '#c41e1e',
    cooldownTurns: 10,
  },
  necromancer: {
    kind: 'necromancer',
    name: 'Necromancer',
    blurb: 'Spawn a pawn on an empty square next to your king.',
    glowColor: '#9b4dca',
    cooldownTurns: 10,
  },
  flight: {
    kind: 'flight',
    name: 'Flight',
    blurb: 'Move your king to any safe, unoccupied square. Once per match.',
    glowColor: '#87ceeb',
    cooldownTurns: null,
  },
};

export type AbilitySide = {
  hero: HeroKind;
  // Ply at which this side's ability becomes available again (0 = ready).
  cooldownUntilPly: number;
  // True after Flight has been used (Flight is one-shot; other heroes ignore).
  flightUsed: boolean;
};

export type GameState = {
  board: (Piece | null)[];
  turn: C2Color;
  // Per-side castling rights. False once that side's king or that wing's
  // rook has moved (or been captured).
  castling: { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean };
  enPassant: Square | null;
  halfmove: number;
  fullmove: number;
  // Total plies played from the start position.
  ply: number;
  positionHistory: string[];
  heroes: { w: AbilitySide; b: AbilitySide };
  // The single currently-frozen piece, if any. Cleared once `ply` reaches
  // `expiresAtPly` (i.e. control returns to the freezer).
  frozen: { idx: number; expiresAtPly: number } | null;
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  // True when the move was a castle (king + rook in one move).
  castled: boolean;
  // Which ability was used, if any. null for normal moves.
  abilityUsed: HeroKind | null;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
};

// Locate the king of `color` on a given board. Returns null if missing
// (shouldn't happen during legal play but kept defensive). Used by ability
// animations to know where the king is (Flight from-square, Knight pivot).
export function kingSquareOf(board: (Piece | null)[], color: C2Color): Square | null {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return idxToSq(i);
  }
  return null;
}

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
// Initial position — standard chess. Heroes are picked outside the engine and
// passed in.
// ------------------------------------------------------------------
export function initialState(heroW: HeroKind, heroB: HeroKind): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  const backRank: PieceLetter[] = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (let f = 0; f < 8; f++) {
    board[idxFR(f, 7)] = { color: 'b', letter: backRank[f].toLowerCase() as PieceLetter };
    board[idxFR(f, 6)] = { color: 'b', letter: 'p' };
    board[idxFR(f, 1)] = { color: 'w', letter: 'P' };
    board[idxFR(f, 0)] = { color: 'w', letter: backRank[f] };
  }
  const state: GameState = {
    board,
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    ply: 0,
    positionHistory: [],
    heroes: {
      w: { hero: heroW, cooldownUntilPly: 0, flightUsed: false },
      b: { hero: heroB, cooldownUntilPly: 0, flightUsed: false },
    },
    frozen: null,
  };
  state.positionHistory.push(positionKey(state));
  return state;
}

// ------------------------------------------------------------------
// Pseudo-move generation (standard chess; no castling)
// ------------------------------------------------------------------
type PseudoMove = {
  from: number;
  to: number;
  promotion?: 'Q' | 'R' | 'B' | 'N';
  enPassantCapture?: boolean;
  doublePawn?: boolean;
  // Castling side, when this move is a castle. The rook from the matching
  // corner gets swung to the square the king crossed.
  castle?: 'K' | 'Q';
};

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const p = state.board[from];
  if (!p) return [];
  // Frozen pieces can't move.
  if (state.frozen && state.frozen.idx === from && state.ply < state.frozen.expiresAtPly) return [];
  const out: PseudoMove[] = [];
  const [ff, fr] = frOfIdx(from);
  const up = p.letter.toUpperCase();
  if (up === 'P') pseudoPawn(state, from, ff, fr, p, out);
  else if (up === 'K') pseudoKing(state, from, ff, fr, p, out);
  else if (up === 'Q') pseudoSliding(state, from, ff, fr, p, EIGHT_DIRS, out);
  else if (up === 'B') pseudoSliding(state, from, ff, fr, p, BISHOP_DIRS, out);
  else if (up === 'R') pseudoSliding(state, from, ff, fr, p, ROOK_DIRS, out);
  else if (up === 'N') pseudoKnight(state, from, ff, fr, p, out);
  // A frozen piece (own or enemy) cannot be captured.
  if (state.frozen && state.ply < state.frozen.expiresAtPly) {
    const f = state.frozen.idx;
    return out.filter((m) => m.to !== f);
  }
  return out;
}

function pseudoKing(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  for (const [df, dr] of EIGHT_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
  // Castling. Only emitted from the original king square (e1/e8), only with
  // the appropriate right still standing, only when the squares between are
  // empty AND none of the king's transit squares (start / pass-through /
  // landing) are attacked. A frozen rook can't castle either.
  const isWhite = p.color === 'w';
  const homeKingIdx = isWhite ? 60 : 4;            // e1 or e8
  if (from !== homeKingIdx) return;
  const enemy: C2Color = isWhite ? 'b' : 'w';
  const kRook = isWhite ? 63 : 7;                  // h1 or h8
  const qRook = isWhite ? 56 : 0;                  // a1 or a8
  const frozenIdx = s.frozen && s.ply < s.frozen.expiresAtPly ? s.frozen.idx : -1;
  const kRight = isWhite ? s.castling.wK : s.castling.bK;
  const qRight = isWhite ? s.castling.wQ : s.castling.bQ;

  const tryCastle = (rookIdx: number, betweenIdxs: number[], transitIdxs: number[], landIdx: number, side: 'K' | 'Q') => {
    if (frozenIdx === rookIdx) return;
    const rook = s.board[rookIdx];
    if (!rook || rook.color !== p.color || rook.letter.toUpperCase() !== 'R') return;
    for (const idx of betweenIdxs) if (s.board[idx] != null) return;
    if (isSquareAttacked(s, homeKingIdx, enemy)) return;
    for (const idx of transitIdxs) if (isSquareAttacked(s, idx, enemy)) return;
    out.push({ from: homeKingIdx, to: landIdx, castle: side });
  };
  if (kRight) {
    // Kingside: between = f1/f8, g1/g8; king transit = f, g; land = g.
    const fSq = isWhite ? 61 : 5;
    const gSq = isWhite ? 62 : 6;
    tryCastle(kRook, [fSq, gSq], [fSq, gSq], gSq, 'K');
  }
  if (qRight) {
    // Queenside: between = d, c, b; king transit = d, c; land = c.
    const dSq = isWhite ? 59 : 3;
    const cSq = isWhite ? 58 : 2;
    const bSq = isWhite ? 57 : 1;
    tryCastle(qRook, [dSq, cSq, bSq], [dSq, cSq], cSq, 'Q');
  }
}

function pseudoSliding(
  s: GameState, from: number, ff: number, fr: number, p: Piece,
  dirs: [number, number][], out: PseudoMove[],
) {
  for (const [df, dr] of dirs) {
    let f = ff + df, r = fr + dr;
    while (onBoard(f, r)) {
      const t = idxFR(f, r);
      const dest = s.board[t];
      if (dest) {
        if (dest.color !== p.color) out.push({ from, to: t });
        break;
      }
      out.push({ from, to: t });
      f += df; r += dr;
    }
  }
}

function pseudoKnight(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
}

function pseudoPawn(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  const dir = p.color === 'w' ? 1 : -1;
  const startRank = p.color === 'w' ? 1 : 6;
  const promoRank = p.color === 'w' ? 7 : 0;
  const oneR = fr + dir;
  if (onBoard(ff, oneR) && !s.board[idxFR(ff, oneR)]) {
    if (oneR === promoRank) {
      for (const promo of ['Q', 'R', 'B', 'N'] as const) {
        out.push({ from, to: idxFR(ff, oneR), promotion: promo });
      }
    } else {
      out.push({ from, to: idxFR(ff, oneR) });
      const twoR = fr + 2 * dir;
      if (fr === startRank && onBoard(ff, twoR) && !s.board[idxFR(ff, twoR)]) {
        out.push({ from, to: idxFR(ff, twoR), doublePawn: true });
      }
    }
  }
  for (const df of [-1, 1]) {
    const f = ff + df, r = fr + dir;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color !== p.color) {
      if (r === promoRank) {
        for (const promo of ['Q', 'R', 'B', 'N'] as const) {
          out.push({ from, to: t, promotion: promo });
        }
      } else {
        out.push({ from, to: t });
      }
    } else if (s.enPassant && idxToSq(t) === s.enPassant) {
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

// ------------------------------------------------------------------
// Ability target listings
// ------------------------------------------------------------------
function squaresAdjacentToKing(state: GameState, color: C2Color): number[] {
  const k = findKing(state, color);
  if (k === -1) return [];
  const [kf, kr] = frOfIdx(k);
  const out: number[] = [];
  for (const [df, dr] of EIGHT_DIRS) {
    const f = kf + df, r = kr + dr;
    if (!onBoard(f, r)) continue;
    out.push(idxFR(f, r));
  }
  return out;
}

export function abilityReady(state: GameState, color: C2Color): boolean {
  const side = state.heroes[color];
  if (side.hero === 'flight') return !side.flightUsed;
  return state.ply >= side.cooldownUntilPly;
}

export function turnsUntilReady(state: GameState, color: C2Color): number {
  const side = state.heroes[color];
  if (side.hero === 'flight') return side.flightUsed ? Infinity : 0;
  // Cooldown is stored in plies; round up to "your turns" remaining (2 plies per turn).
  const pliesLeft = Math.max(0, side.cooldownUntilPly - state.ply);
  return Math.ceil(pliesLeft / 2);
}

// Squares (as indices) on which the active side can target their ability.
export function abilityTargets(state: GameState): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  const hero = state.heroes[color].hero;
  const out: number[] = [];
  if (hero === 'frost') {
    // Any non-king piece on the board, except a piece that's already frozen.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p) continue;
      if (p.letter.toUpperCase() === 'K') continue;
      if (state.frozen && state.frozen.idx === i && state.ply < state.frozen.expiresAtPly) continue;
      out.push(i);
    }
  } else if (hero === 'knight') {
    // Enemy non-king pieces adjacent to my king.
    for (const idx of squaresAdjacentToKing(state, color)) {
      const p = state.board[idx];
      if (!p) continue;
      if (p.color === color) continue;
      if (p.letter.toUpperCase() === 'K') continue;
      out.push(idx);
    }
  } else if (hero === 'necromancer') {
    // Empty squares adjacent to my king.
    for (const idx of squaresAdjacentToKing(state, color)) {
      if (state.board[idx] == null) out.push(idx);
    }
  } else {
    // Flight: any empty square not attacked by the enemy.
    const enemy: C2Color = color === 'w' ? 'b' : 'w';
    for (let i = 0; i < 64; i++) {
      if (state.board[i] != null) continue;
      if (isSquareAttacked(state, i, enemy)) continue;
      out.push(i);
    }
  }
  // Filter to targets that leave the mover not in check.
  return out.filter((idx) => {
    const next = applyAbility(state, hero, idx);
    return !isInCheck(next, color);
  });
}

// ------------------------------------------------------------------
// Apply a (validated) ability action.
// ------------------------------------------------------------------
function applyAbility(state: GameState, hero: HeroKind, targetIdx: number): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    ply: state.ply + 1,
    positionHistory: state.positionHistory,
    heroes: {
      w: { ...state.heroes.w },
      b: { ...state.heroes.b },
    },
    frozen: state.frozen,
  };
  const color = state.turn;
  const info = HERO_INFO[hero];

  if (hero === 'frost') {
    next.frozen = { idx: targetIdx, expiresAtPly: next.ply + 1 };
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'knight') {
    next.board[targetIdx] = null;
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'necromancer') {
    const pieceLetter: PieceLetter = color === 'w' ? 'P' : 'p';
    next.board[targetIdx] = { color, letter: pieceLetter };
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'flight') {
    const k = findKing(state, color);
    if (k !== -1) {
      next.board[targetIdx] = next.board[k];
      next.board[k] = null;
    }
    next.heroes[color].flightUsed = true;
    // The king moved — castling rights for this side are gone.
    if (color === 'w') { next.castling.wK = false; next.castling.wQ = false; }
    else { next.castling.bK = false; next.castling.bQ = false; }
  }

  // Expire any active freeze whose lifetime has now ended.
  if (next.frozen && next.ply >= next.frozen.expiresAtPly) {
    next.frozen = null;
  }

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;
  return next;
}

// ------------------------------------------------------------------
// Apply a (validated) board move.
// ------------------------------------------------------------------
function applyPseudo(state: GameState, mv: PseudoMove): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    ply: state.ply + 1,
    positionHistory: state.positionHistory,
    heroes: {
      w: { ...state.heroes.w },
      b: { ...state.heroes.b },
    },
    frozen: state.frozen,
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
  next.board[mv.to] = resultPiece;
  next.board[mv.from] = null;
  if (moverUp === 'P') next.halfmove = 0;
  if (mv.doublePawn) {
    const [tf, tr] = frOfIdx(mv.to);
    const epRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.enPassant = idxToSq(idxFR(tf, epRank));
  }

  // Castling: swing the rook over the king onto the transit square.
  if (mv.castle) {
    const isWhite = mover.color === 'w';
    if (mv.castle === 'K') {
      const rookFrom = isWhite ? 63 : 7;
      const rookTo = isWhite ? 61 : 5;
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
    } else {
      const rookFrom = isWhite ? 56 : 0;
      const rookTo = isWhite ? 59 : 3;
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
    }
  }

  // Castling rights: lose them when the king moves (board move or implicit
  // via castle) and when a rook moves off / is captured on its home corner.
  if (moverUp === 'K') {
    if (mover.color === 'w') { next.castling.wK = false; next.castling.wQ = false; }
    else { next.castling.bK = false; next.castling.bQ = false; }
  }
  // From-corner clears the right tied to that rook.
  if (mv.from === 56) next.castling.wQ = false;
  if (mv.from === 63) next.castling.wK = false;
  if (mv.from === 0)  next.castling.bQ = false;
  if (mv.from === 7)  next.castling.bK = false;
  // Capture lands on a corner — that rook is gone.
  if (mv.to === 56) next.castling.wQ = false;
  if (mv.to === 63) next.castling.wK = false;
  if (mv.to === 0)  next.castling.bQ = false;
  if (mv.to === 7)  next.castling.bK = false;

  if (next.frozen && next.ply >= next.frozen.expiresAtPly) {
    next.frozen = null;
  }

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

function anyLegalAbility(state: GameState): boolean {
  return abilityTargets(state).length > 0;
}

// ------------------------------------------------------------------
// UCI parsing for ability moves
// ------------------------------------------------------------------
const ABILITY_PREFIX_TO_HERO: Record<string, HeroKind> = {
  F: 'frost', K: 'knight', N: 'necromancer', L: 'flight',
};
const HERO_TO_ABILITY_PREFIX: Record<HeroKind, string> = {
  frost: 'F', knight: 'K', necromancer: 'N', flight: 'L',
};

export function isAbilityUci(uci: string): boolean {
  return uci.length >= 4 && uci[0] === '!';
}
export function parseAbility(uci: string): { hero: HeroKind; to: Square } | null {
  if (!isAbilityUci(uci)) return null;
  const hero = ABILITY_PREFIX_TO_HERO[uci[1]];
  if (!hero) return null;
  const to = uci.slice(2, 4);
  if (to.length !== 2) return null;
  return { hero, to };
}
export function abilityUci(hero: HeroKind, to: Square): string {
  return `!${HERO_TO_ABILITY_PREFIX[hero]}${to}`;
}

// ------------------------------------------------------------------
// Apply move (board or ability)
// ------------------------------------------------------------------
export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  if (isAbilityUci(uci)) {
    const parsed = parseAbility(uci);
    if (!parsed) return null;
    const color = state.turn;
    if (state.heroes[color].hero !== parsed.hero) return null;
    if (!abilityReady(state, color)) return null;
    const targetIdx = sqToIdx(parsed.to);
    if (!abilityTargets(state).includes(targetIdx)) return null;
    const next = applyAbility(state, parsed.hero, targetIdx);
    if (isInCheck(next, color)) return null;
    const check = isInCheck(next, next.turn);
    const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalAbility(next);
    const checkmate = check && !oppHasMoves;
    const stalemate = !check && !oppHasMoves;
    return {
      state: next,
      result: {
        uci,
        fenAfter: toFen(next),
        captured: parsed.hero === 'knight',
        castled: false,
        abilityUsed: parsed.hero,
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
  const check = isInCheck(next, next.turn);
  const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalAbility(next);
  const checkmate = check && !oppHasMoves;
  const stalemate = !check && !oppHasMoves;

  return {
    state: next,
    result: {
      uci,
      fenAfter: toFen(next),
      captured,
      castled: !!chosen.castle,
      abilityUsed: null,
      check,
      checkmate,
      stalemate,
    },
  };
}

// ------------------------------------------------------------------
// FEN serialization. Standard fields + a final whitespace token encoding
// hero/cooldown/frozen state: hW=<hero>:<cd>:<flight>,hB=...,fr=<idx>:<exp>
// ------------------------------------------------------------------
export function toFen(state: GameState): string {
  const parts: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[idxFR(f, r)];
      if (!p) { empty++; continue; }
      if (empty > 0) { row += empty; empty = 0; }
      row += p.letter;
    }
    if (empty > 0) row += empty;
    parts.push(row);
  }
  const board = parts.join('/');
  const ep = state.enPassant ?? '-';
  const wH = state.heroes.w;
  const bH = state.heroes.b;
  const hero = `${wH.hero}:${wH.cooldownUntilPly}:${wH.flightUsed ? 1 : 0}|${bH.hero}:${bH.cooldownUntilPly}:${bH.flightUsed ? 1 : 0}`;
  const frozen = state.frozen ? `${state.frozen.idx}:${state.frozen.expiresAtPly}` : '-';
  let cas = '';
  if (state.castling.wK) cas += 'K';
  if (state.castling.wQ) cas += 'Q';
  if (state.castling.bK) cas += 'k';
  if (state.castling.bQ) cas += 'q';
  if (cas === '') cas = '-';
  return `${board} ${state.turn} ${cas} ${ep} ${state.halfmove} ${state.fullmove} ${state.ply} ${hero} ${frozen}`;
}

function positionKey(state: GameState): string {
  // Include hero / cooldown / freeze so threefold doesn't get tricked by
  // identical-looking boards that diverge in ability state.
  return toFen(state);
}

// ------------------------------------------------------------------
// End-state checks
// ------------------------------------------------------------------
export function isCheckmate(state: GameState): boolean {
  if (!isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalAbility(state);
}
export function isStalemate(state: GameState): boolean {
  if (isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalAbility(state);
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
// K-vs-K is the only auto-draw — heroes can revive material via Necromancer
// so other "insufficient material" cases aren't really insufficient.
export function isInsufficientMaterial(state: GameState): boolean {
  for (const p of state.board) {
    if (p && p.letter.toUpperCase() !== 'K') return false;
  }
  // If either side could still spawn or freeze meaningfully, don't auto-draw.
  if (state.heroes.w.hero === 'necromancer' && state.ply >= state.heroes.w.cooldownUntilPly) return false;
  if (state.heroes.b.hero === 'necromancer' && state.ply >= state.heroes.b.cooldownUntilPly) return false;
  return true;
}
