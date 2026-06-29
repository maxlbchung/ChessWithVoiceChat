// Standard-chess attack detection over a flat board (the shared 64-cell
// (Piece|null)[] every variant's snapshot uses). Used to visualize a checkmate:
// which enemy pieces give check and which control the king's escape squares.
// Exact for normal chess; an approximation for variants whose pieces move
// unusually (merged C/A/Z and the slime king are handled; bespoke hero movement
// is treated as its base piece).
import type { Piece } from './mergeChess';

function sqAt(file: number, rank: number): string {
  return String.fromCharCode(97 + file) + (rank + 1);
}
function idxToSq(idx: number): string {
  return sqAt(idx % 8, 7 - Math.floor(idx / 8));
}
function fileOf(sq: string): number {
  return sq.charCodeAt(0) - 97;
}
function rankOf(sq: string): number {
  return parseInt(sq[1], 10) - 1;
}
function pieceAt(board: (Piece | null)[], file: number, rank: number): Piece | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return board[(7 - rank) * 8 + file];
}

export function kingSquareOf(board: (Piece | null)[], color: 'w' | 'b'): string | null {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return idxToSq(i);
  }
  return null;
}

function clearPath(board: (Piece | null)[], ff: number, fr: number, tf: number, tr: number): boolean {
  const stepF = Math.sign(tf - ff);
  const stepR = Math.sign(tr - fr);
  let f = ff + stepF;
  let r = fr + stepR;
  while (f !== tf || r !== tr) {
    if (pieceAt(board, f, r)) return false;
    f += stepF;
    r += stepR;
  }
  return true;
}

function attacksAs(type: string, ff: number, fr: number, tf: number, tr: number, color: 'w' | 'b', board: (Piece | null)[]): boolean {
  const df = tf - ff;
  const dr = tr - fr;
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  switch (type) {
    case 'P': return adf === 1 && dr === (color === 'w' ? 1 : -1);
    case 'N': return (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
    case 'K': return Math.max(adf, adr) === 1;
    case 'S': return Math.max(adf, adr) === 1; // slime king
    case 'B': return adf === adr && adf > 0 && clearPath(board, ff, fr, tf, tr);
    case 'R': return df === 0 !== (dr === 0) && clearPath(board, ff, fr, tf, tr);
    case 'Q': return ((adf === adr && adf > 0) || (df === 0) !== (dr === 0)) && clearPath(board, ff, fr, tf, tr);
    case 'C': return attacksAs('R', ff, fr, tf, tr, color, board) || attacksAs('N', ff, fr, tf, tr, color, board);
    case 'A': return attacksAs('B', ff, fr, tf, tr, color, board) || attacksAs('N', ff, fr, tf, tr, color, board);
    case 'Z': return attacksAs('Q', ff, fr, tf, tr, color, board) || attacksAs('N', ff, fr, tf, tr, color, board);
    default: return false;
  }
}

// Squares of `byColor` pieces that attack `target`.
export function attackersOf(board: (Piece | null)[], target: string, byColor: 'w' | 'b'): string[] {
  const tf = fileOf(target);
  const tr = rankOf(target);
  const out: string[] = [];
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.color !== byColor) continue;
    const sq = idxToSq(i);
    if (attacksAs(p.letter.toUpperCase(), fileOf(sq), rankOf(sq), tf, tr, byColor, board)) out.push(sq);
  }
  return out;
}

function neighbors(sq: string): string[] {
  const f = fileOf(sq);
  const r = rankOf(sq);
  const out: string[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      out.push(sqAt(nf, nr));
    }
  }
  return out;
}

// Line-of-sight arrows that explain a checkmate: each checking piece → the king,
// plus, for every escape square around the king (empty or capturable), each
// enemy piece that controls it → that square.
export function checkmateArrows(board: (Piece | null)[], kingSq: string, matedColor: 'w' | 'b'): { from: string; to: string }[] {
  const enemy: 'w' | 'b' = matedColor === 'w' ? 'b' : 'w';
  const arrows: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const k = from + '>' + to;
    if (!seen.has(k)) {
      seen.add(k);
      arrows.push({ from, to });
    }
  };
  for (const sq of attackersOf(board, kingSq, enemy)) add(sq, kingSq);
  for (const nb of neighbors(kingSq)) {
    const occupant = pieceAt(board, fileOf(nb), rankOf(nb));
    if (occupant && occupant.color === matedColor) continue; // own piece blocks escape
    for (const sq of attackersOf(board, nb, enemy)) add(sq, nb);
  }
  return arrows;
}
