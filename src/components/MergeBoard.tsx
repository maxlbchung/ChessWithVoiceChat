import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Piece, Square } from '../lib/mergeChess';
import { sqToIdx } from '../lib/mergeChess';
import { lettersToPieceKeys, renderPiece } from '../lib/pieceSvgs';

type Props = {
  board: (Piece | null)[];
  orientation: 'white' | 'black';
  selectedSquare?: Square | null;
  legalTargets?: { to: Square; isCapture: boolean; isMerge: boolean }[];
  onSquareClick?: (sq: Square) => void;
  onPieceDrop?: (from: Square, to: Square) => boolean;
  onDragStartSquare?: (from: Square) => void;
  interactive?: boolean;
  draggable?: boolean;
  // When set, the board is a fixed pixel size. When omitted, the board fills
  // its container width (1:1 aspect ratio) and measures itself so pieces and
  // arrows scale to the actual rendered size.
  boardWidth?: number;
};

type Arrow = { from: Square; to: Square };

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
// Match react-chessboard's default arrow color so both boards feel the same.
const ARROW_COLOR = 'rgb(255,170,0)';
const HIGHLIGHT_COLOR = 'rgba(255,170,0,0.45)';

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
  boardWidth,
}: Props) {
  // Measure the container when boardWidth isn't fixed, so pieces and arrows
  // can scale to whatever the parent gives us.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number>(boardWidth ?? 480);
  useEffect(() => {
    if (boardWidth != null) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setMeasured(rect.width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setMeasured(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [boardWidth]);
  const effectiveSize = boardWidth ?? measured;
  const squarePx = effectiveSize / 8;
  const [dragOver, setDragOver] = useState<Square | null>(null);
  const dragSourceRef = useRef<Square | null>(null);

  // Annotation state — orange arrows and highlighted squares are purely visual,
  // not persisted, and shared across both players is intentionally out of scope.
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [highlights, setHighlights] = useState<Set<Square>>(new Set());
  const [previewArrow, setPreviewArrow] = useState<Arrow | null>(null);
  const rightDownSqRef = useRef<Square | null>(null);

  const targetMap = useMemo(() => {
    const m = new Map<Square, { isCapture: boolean; isMerge: boolean }>();
    for (const t of legalTargets ?? []) m.set(t.to, { isCapture: t.isCapture, isMerge: t.isMerge });
    return m;
  }, [legalTargets]);

  const ranksTopDown = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const filesLeftRight = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  // ------------------------------------------------------------------
  // Drag-and-drop (left button)
  // ------------------------------------------------------------------
  const handleDragStart = (e: DragEvent<HTMLDivElement>, sq: Square) => {
    if (!draggable || !interactive) {
      e.preventDefault();
      return;
    }
    dragSourceRef.current = sq;
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
    e.preventDefault();
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

  // ------------------------------------------------------------------
  // Arrow drawing & square highlighting (right button)
  // ------------------------------------------------------------------
  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>, sq: Square) => {
    if (e.button === 2) {
      e.preventDefault();
      rightDownSqRef.current = sq;
      setPreviewArrow({ from: sq, to: sq });
    } else if (e.button === 0) {
      // Any left-click clears annotations, mirroring chess.com / lichess.
      if (arrows.length > 0) setArrows([]);
      if (highlights.size > 0) setHighlights(new Set());
    }
  };

  const handleMouseEnter = (sq: Square) => {
    if (rightDownSqRef.current) {
      setPreviewArrow({ from: rightDownSqRef.current, to: sq });
    }
  };

  // Track right-button release globally so releasing outside the board still
  // cancels the in-progress arrow.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const from = rightDownSqRef.current;
      rightDownSqRef.current = null;
      if (!from) { setPreviewArrow(null); return; }
      // The target the user released on (find a [data-sq] ancestor).
      let el: HTMLElement | null = e.target as HTMLElement | null;
      let to: Square | null = null;
      while (el && !to) {
        const attr = el.getAttribute?.('data-sq');
        if (attr) to = attr as Square;
        el = el.parentElement;
      }
      setPreviewArrow(null);
      if (!to) return;
      if (from === to) {
        // Single right-click → toggle highlight
        setHighlights((prev) => {
          const next = new Set(prev);
          if (next.has(to as Square)) next.delete(to as Square);
          else next.add(to as Square);
          return next;
        });
      } else {
        // Drag → toggle arrow
        setArrows((prev) => {
          const exists = prev.some((a) => a.from === from && a.to === to);
          if (exists) return prev.filter((a) => !(a.from === from && a.to === to));
          return [...prev, { from, to: to as Square }];
        });
      }
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // Suppress the browser context menu over the board so right-click is free
  // for arrow/highlight gestures.
  const suppressContext = (e: ReactMouseEvent<HTMLDivElement>) => e.preventDefault();

  // Pixel coords of a square center, given current orientation.
  const center = (sq: Square): { x: number; y: number } => {
    const file = sq.charCodeAt(0) - 97;          // 0..7
    const rank = parseInt(sq[1], 10) - 1;        // 0..7
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    return { x: col * squarePx + squarePx / 2, y: row * squarePx + squarePx / 2 };
  };

  // All arrows to render — committed + the in-progress preview at half opacity.
  const renderedArrows = useMemo<Array<Arrow & { preview?: boolean }>>(
    () => {
      const list: Array<Arrow & { preview?: boolean }> = arrows.map((a) => ({ ...a }));
      if (previewArrow && previewArrow.from !== previewArrow.to) {
        list.push({ ...previewArrow, preview: true });
      }
      return list;
    },
    [arrows, previewArrow],
  );

  return (
    <div
      ref={containerRef}
      className="merge-board"
      onContextMenu={suppressContext}
      style={{
        width: boardWidth ?? '100%',
        height: boardWidth,
        aspectRatio: boardWidth == null ? '1 / 1' : undefined,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gridTemplateRows: 'repeat(8, 1fr)',
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
          const isHighlighted = highlights.has(sq);

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
              onMouseDown={(e) => handleMouseDown(e, sq)}
              onMouseEnter={() => handleMouseEnter(sq)}
              onDragOver={(e) => handleDragOver(e, sq)}
              onDragLeave={() => { if (dragOver === sq) setDragOver(null); }}
              onDrop={(e) => handleDrop(e, sq)}
              style={style}
            >
              {isHighlighted && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: HIGHLIGHT_COLOR,
                    pointerEvents: 'none',
                  }}
                />
              )}
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

      {/* Arrow overlay — drawn on top of pieces, ignored by mouse. */}
      {renderedArrows.length > 0 && (
        <svg
          width={effectiveSize}
          height={effectiveSize}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          {renderedArrows.map((a, i) => {
            const from = center(a.from);
            const to = center(a.to);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const r = Math.hypot(dx, dy);
            if (r === 0) return null;
            const reducer = effectiveSize / 32;
            const end = {
              x: from.x + (dx * (r - reducer)) / r,
              y: from.y + (dy * (r - reducer)) / r,
            };
            const markerId = `mb-arrow-${i}`;
            return (
              <g key={`${a.from}-${a.to}-${a.preview ? 'p' : 'c'}`}>
                <marker
                  id={markerId}
                  markerWidth="2"
                  markerHeight="2.5"
                  refX="1.25"
                  refY="1.25"
                  orient="auto"
                >
                  <polygon points="0.3 0, 2 1.25, 0.3 2.5" fill={ARROW_COLOR} />
                </marker>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={end.x}
                  y2={end.y}
                  opacity={a.preview ? 0.5 : 0.65}
                  stroke={ARROW_COLOR}
                  strokeWidth={a.preview ? (0.9 * effectiveSize) / 40 : effectiveSize / 40}
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            );
          })}
        </svg>
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
