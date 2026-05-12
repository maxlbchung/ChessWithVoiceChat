import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { Piece, Square } from '../lib/mergeChess';
import { sqToIdx } from '../lib/mergeChess';
import { lettersToPieceKeys, renderPiece } from '../lib/pieceSvgs';

type Props = {
  board: (Piece | null)[];
  orientation: 'white' | 'black';
  selectedSquare?: Square | null;
  legalTargets?: { to: Square; isCapture: boolean; isMerge: boolean }[];
  onSquareClick?: (sq: Square) => void;
  // Called when a piece is dropped on `to` from `from`. Return true if the
  // drop should be applied (consumer is responsible for actually moving).
  onPieceDrop?: (from: Square, to: Square) => boolean;
  // Called when a drag begins — consumer can use it to populate legalTargets
  // (mirrors the click→select flow).
  onDragStartSquare?: (from: Square) => void;
  interactive?: boolean;
  draggable?: boolean;
  boardWidth?: number;
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export function MergeBoard({
  board,
  orientation,
  selectedSquare,
  legalTargets,
  onSquareClick,
  onPieceDrop,
  onDragStartSquare,
  interactive = true,
  draggable = true,
  boardWidth = 480,
}: Props) {
  const squarePx = boardWidth / 8;
  const [dragOver, setDragOver] = useState<Square | null>(null);
  const dragSourceRef = useRef<Square | null>(null);

  const targetMap = useMemo(() => {
    const m = new Map<Square, { isCapture: boolean; isMerge: boolean }>();
    for (const t of legalTargets ?? []) m.set(t.to, { isCapture: t.isCapture, isMerge: t.isMerge });
    return m;
  }, [legalTargets]);

  const ranksTopDown = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const filesLeftRight = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const handleDragStart = (e: DragEvent<HTMLDivElement>, sq: Square) => {
    if (!draggable || !interactive) {
      e.preventDefault();
      return;
    }
    dragSourceRef.current = sq;
    // Need *some* dataTransfer payload for Firefox to fire drop events.
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', sq); } catch {}
    onDragStartSquare?.(sq);
  };

  const handleDragEnd = () => {
    dragSourceRef.current = null;
    setDragOver(null);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, sq: Square) => {
    if (!dragSourceRef.current) return;
    e.preventDefault();  // allow drop
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== sq) setDragOver(sq);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, to: Square) => {
    e.preventDefault();
    const from = dragSourceRef.current;
    dragSourceRef.current = null;
    setDragOver(null);
    if (!from) return;
    if (from === to) return;
    onPieceDrop?.(from, to);
  };

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
          const isDragOver = dragOver === sq;

          const style: CSSProperties = {
            background: isLight ? '#dfe5f0' : '#5d6c89',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: interactive ? 'pointer' : 'default',
            boxShadow: isDragOver
              ? 'inset 0 0 1px 6px rgba(255,255,255,0.75)'
              : undefined,
          };

          let overlay: CSSProperties | null = null;
          if (isSelected) {
            overlay = {
              background:
                'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
            };
          } else if (target) {
            if (target.isMerge) {
              overlay = {
                background:
                  'radial-gradient(circle, transparent 55%, rgba(80,200,120,0.55) 56%, rgba(80,200,120,0.55) 65%, transparent 66%)',
              };
            } else if (target.isCapture) {
              overlay = {
                background:
                  'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
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
              onDragOver={(e) => handleDragOver(e, sq)}
              onDragLeave={() => { if (dragOver === sq) setDragOver(null); }}
              onDrop={(e) => handleDrop(e, sq)}
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
              {piece && (
                <PieceSprite
                  piece={piece}
                  squarePx={squarePx}
                  draggable={draggable && interactive}
                  onDragStart={(e) => handleDragStart(e, sq)}
                  onDragEnd={handleDragEnd}
                />
              )}
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

function PieceSprite({
  piece,
  squarePx,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  piece: Piece;
  squarePx: number;
  draggable: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const keys = lettersToPieceKeys(piece.letter);
  const isMerged = keys.length > 1;
  // Single piece fills the square; merged pieces render two pieces overlapped
  // (front-left + back-right) at ~70% scale so both shapes are legible.
  const fullSize = squarePx * 0.95;
  const pairSize = squarePx * 0.7;

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: draggable ? 'grab' : 'inherit',
        zIndex: 1,
      }}
    >
      {!isMerged ? (
        renderPiece(keys[0], fullSize)
      ) : (
        <>
          <div
            style={{
              position: 'absolute',
              left: squarePx * 0.03,
              top: squarePx * 0.18,
              filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.35))',
              pointerEvents: 'none',
            }}
          >
            {renderPiece(keys[0], pairSize)}
          </div>
          <div
            style={{
              position: 'absolute',
              right: squarePx * 0.03,
              bottom: squarePx * 0.02,
              filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.35))',
              pointerEvents: 'none',
            }}
          >
            {renderPiece(keys[1], pairSize)}
          </div>
        </>
      )}
    </div>
  );
}
