// Compute captured-piece summaries from a board diff.
//
// Used by the CapturedPieces strip above/below each MergeBoard. Works
// uniformly across every variant in the codebase: the engine-specific
// initial board is supplied by the caller, and the diff vs the current
// board tells us which pieces are missing.
//
// Merged pieces (Merge mode / hero promotions) are decomposed into their
// atomic components so a Q+N fusion (`Z`) counts as 1 queen + 1 knight of
// material on the owning side — that way merges don't falsely show up as
// captures of the original pieces.
//
// Slime big-king tiles (`S`) are decomposed to a single king atom so a
// blob's extra tiles don't inflate the king count. Pawns flown to the back
// rank via Flight or auto-promotion are treated by their current letter, so
// e.g. a promoted queen counts as a queen — not as a missing pawn.

import type { Piece } from './mergeChess';

export type CaptureAtom = 'P' | 'N' | 'B' | 'R' | 'Q';

// Material value per atom — used for the small material advantage badge.
const ATOM_VALUE: Record<CaptureAtom, number> = {
  P: 1,
  N: 3,
  B: 3,
  R: 5,
  Q: 9,
};

// Render order: pawns first (most numerous), then minor, then major.
export const ATOM_ORDER: CaptureAtom[] = ['P', 'N', 'B', 'R', 'Q'];

export type CaptureSummary = {
  // Pieces captured BY white (i.e. black pieces missing from the board
  // relative to the starting position), keyed by atom.
  byWhite: Record<CaptureAtom, number>;
  // Pieces captured BY black.
  byBlack: Record<CaptureAtom, number>;
  // Material advantage in favour of white (positive = white ahead).
  // Computed against the starting army so unusual setups don't pretend one
  // side is "down material" at move 1.
  advantage: number;
};

const EMPTY_COUNTS = (): Record<CaptureAtom, number> => ({ P: 0, N: 0, B: 0, R: 0, Q: 0 });

// Decompose a piece letter into its atom contributions. Case is ignored
// here — the caller already knows the colour.
function atomsForLetter(letter: string): CaptureAtom[] {
  switch (letter.toUpperCase()) {
    case 'P': return ['P'];
    case 'N': return ['N'];
    case 'B': return ['B'];
    case 'R': return ['R'];
    case 'Q': return ['Q'];
    // Merge fusions — single letter expands to multiple atoms.
    case 'C': return ['R', 'N']; // rook + knight
    case 'A': return ['B', 'N']; // bishop + knight
    case 'Z': return ['Q', 'N']; // queen + knight
    // Kings (and Slime tiles) carry no capturable material — they're tracked
    // by their own win condition, not by the captures bar.
    case 'K':
    case 'S':
    default:
      return [];
  }
}

function countAtoms(board: ReadonlyArray<Piece | null>): { w: Record<CaptureAtom, number>; b: Record<CaptureAtom, number> } {
  const out = { w: EMPTY_COUNTS(), b: EMPTY_COUNTS() };
  for (const cell of board) {
    if (!cell) continue;
    const atoms = atomsForLetter(cell.letter);
    for (const a of atoms) out[cell.color][a]++;
  }
  return out;
}

export function computeCaptures(
  currentBoard: ReadonlyArray<Piece | null>,
  initialBoard: ReadonlyArray<Piece | null>,
): CaptureSummary {
  const start = countAtoms(initialBoard);
  const curr = countAtoms(currentBoard);
  const byWhite = EMPTY_COUNTS(); // black pieces missing
  const byBlack = EMPTY_COUNTS(); // white pieces missing
  let advantage = 0;
  for (const a of ATOM_ORDER) {
    const lostByBlack = Math.max(0, start.b[a] - curr.b[a]);
    const lostByWhite = Math.max(0, start.w[a] - curr.w[a]);
    byWhite[a] = lostByBlack;
    byBlack[a] = lostByWhite;
    advantage += (lostByBlack - lostByWhite) * ATOM_VALUE[a];
  }
  return { byWhite, byBlack, advantage };
}
