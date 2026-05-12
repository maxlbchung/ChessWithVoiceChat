import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Piece, PieceLetter, Square } from '../lib/mergeChess';
import { sqToIdx } from '../lib/mergeChess';

type Props = {
  board: (Piece | null)[];
  orientation: 'white' | 'black';
  selectedSquare?: Square | null;
  legalTargets?: { to: Square; isCapture: boolean; isMerge: boolean }[];
  onSquareClick?: (sq: Square) => void;
  interactive?: boolean;
  boardWidth?: number;  // px
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// Per-letter glyph sequence to render. Unicode has distinct "outlined" (white)
// and "solid" (black) chess glyphs; we use the outlined ones and rely on CSS
// fill + text-shadow stroke to render either color clearly on both squares.
const PIECE_GLYPHS: Record<string, string[]> = {
  P: ['♙'],
  K: ['♔'],
  R: ['♖'],
  N: ['♘'],
  B: ['♗'],
  Q: ['♕'],
  C: ['♖', '♘'],      // R+N
  A: ['♗', '♘'],      // B+N
  Z: ['♕', '♘'],      // R+B+N (queen encodes R+B; add knight for the N)
};

function pieceGlyphs(p: Piece): string[] {
  const up = p.letter.toUpperCase();
  return PIECE_GLYPHS[up] ?? ['?'];
}

export function MergeBoard({
  board,
  orientation,
  selectedSquare,
  legalTargets,
  onSquareClick,
  interactive = true,
  boardWidth = 480,
}: Props) {
  const squarePx = boardWidth / 8;

  const targetMap = useMemo(() => {
    const m = new Map<Square, { isCapture: boolean; isMerge: boolean }>();
    for (const t of legalTargets ?? []) m.set(t.to, { isCapture: t.isCapture, isMerge: t.isMerge });
    return m;
  }, [legalTargets]);

  // Build the order of squares to render based on orientation. Top-left visual
  // square = a8 (white at bottom) or h1 (black at bottom).
  const ranksTopDown = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const filesLeftRight = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  return (
    <div
      className="merge-board"
      style={{
        width: boardWidth,
        height: boardWidth,
        display: 'grid',
        gridTemplateColumns: `repeat(8, ${squarePx}px)`,
        gridTemplateRows: `repeat(8, ${squarePx}px)`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        userSelect: 'none',
      }}
    >
      {ranksTopDown.map((r) =>
        filesLeftRight.map((f) => {
          const isLight = (f + r) % 2 === 1;
          const sq: Square = `${FILES[f]}${r + 1}`;
          const idx = sqToIdx(sq);
          const piece = board[idx];
          const isSelected = selectedSquare === sq;
          const target = targetMap.get(sq);
          const style: CSSProperties = {
            background: isLight ? '#dfe5f0' : '#5d6c89',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: interactive ? 'pointer' : 'default',
          };

          // Selection + target overlays (radial gradients matching the standard board)
          let overlay: CSSProperties | null = null;
          if (isSelected) {
            overlay = {
              background:
                'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
            };
          } else if (target) {
            if (target.isCapture || target.isMerge) {
              overlay = {
                background: target.isMerge
                  ? 'radial-gradient(circle, transparent 55%, rgba(80,200,120,0.55) 56%, rgba(80,200,120,0.55) 65%, transparent 66%)'
                  : 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
              };
            } else {
              overlay = {
                background:
                  'radial-gradient(circle, rgba(0,0,0,0.35) 22%, transparent 24%)',
              };
            }
          }

          return (
            <div
              key={sq}
              data-sq={sq}
              onClick={() => interactive && onSquareClick?.(sq)}
              style={style}
            >
              {overlay && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    ...overlay,
                  }}
                />
              )}
              {piece && <PieceGlyph piece={piece} squarePx={squarePx} />}
              {/* file / rank coords on edges */}
              {f === filesLeftRight[0] && (
                <span
                  style={{
                    position: 'absolute',
                    left: 3,
                    top: 1,
                    fontSize: Math.max(9, squarePx * 0.18),
                    color: isLight ? '#5d6c89' : '#dfe5f0',
                    fontWeight: 600,
                    pointerEvents: 'none',
                  }}
                >
                  {r + 1}
                </span>
              )}
              {r === ranksTopDown[ranksTopDown.length - 1] && (
                <span
                  style={{
                    position: 'absolute',
                    right: 3,
                    bottom: 0,
                    fontSize: Math.max(9, squarePx * 0.18),
                    color: isLight ? '#5d6c89' : '#dfe5f0',
                    fontWeight: 600,
                    pointerEvents: 'none',
                  }}
                >
                  {FILES[f]}
                </span>
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}

function PieceGlyph({ piece, squarePx }: { piece: Piece; squarePx: number }) {
  const glyphs = pieceGlyphs(piece);
  const isWhite = piece.color === 'w';
  // For multi-glyph (merged) pieces, render side-by-side and scale to fit.
  const baseFont = squarePx * 0.85;
  const fontSize = glyphs.length === 1 ? baseFont : baseFont * 0.7;
  // Stroke trick: white-piece glyphs are rendered as black-outlined-white using
  // CSS text-shadow so they read on both square colors.
  const fill = isWhite ? '#f8f9fb' : '#1a1d24';
  const stroke = isWhite ? '#1a1d24' : '#f8f9fb';
  const textShadow = `
    -1px -1px 0 ${stroke},
     1px -1px 0 ${stroke},
    -1px  1px 0 ${stroke},
     1px  1px 0 ${stroke},
     0    0    2px rgba(0,0,0,0.3)
  `;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        position: 'relative',
        zIndex: 1,
      }}
    >
      {glyphs.map((g, i) => (
        <span
          key={i}
          style={{
            fontSize,
            color: fill,
            textShadow,
            fontFamily:
              "'Segoe UI Symbol', 'DejaVu Sans', 'Apple Color Emoji', sans-serif",
            // Tiny visual offset so overlapping glyphs read as a pair
            marginLeft: i === 0 ? 0 : -squarePx * 0.18,
          }}
        >
          {g}
        </span>
      ))}
    </div>
  );
}

// Re-export for use sites that want to format a piece letter standalone.
export function pieceLetterToGlyphs(letter: PieceLetter): string[] {
  return PIECE_GLYPHS[letter.toUpperCase()] ?? ['?'];
}
