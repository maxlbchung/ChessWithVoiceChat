import { useEffect } from 'react';
import { renderPiece, lettersToPieceKeys, type PieceKey } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';

// Letters this picker can offer. Q/R/B/N for plain chess; Z/C/A are the
// Mutation-hero +knight fusions (queen+N, rook+N, bishop+N) and are only
// surfaced when `options` includes them.
export type PromotionLetter = 'Q' | 'R' | 'B' | 'N' | 'Z' | 'C' | 'A';

type Props = {
  // Promotion destination square ("e8" / "e1" / etc.). Drives where the tile
  // column anchors against the board.
  square: string;
  // Side that's promoting — determines tile piece colour.
  color: 'w' | 'b';
  // Board orientation so we can flip file/rank coords for the viewer.
  orientation: 'white' | 'black';
  // Pieces to offer, top→bottom. Defaults to ['Q','R','B','N'].
  options?: PromotionLetter[];
  onPick: (letter: PromotionLetter) => void;
  onCancel: () => void;
};

const DEFAULT_OPTIONS: PromotionLetter[] = ['Q', 'R', 'B', 'N'];

export function PromotionPicker({
  square,
  color,
  orientation,
  options = DEFAULT_OPTIONS,
  onPick,
  onCancel,
}: Props) {
  // Esc cancels — natural for any modal-style overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Board file (0..7 from white's left) and rank (0 = rank 1) of the square.
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;

  // Translate to viewer-space column (0 = left of viewer) and decide whether
  // the tile column should stack downward from the top edge or upward from
  // the bottom. Promotion always lands on rank 1 or 8, so the destination
  // sits on a board edge from the viewer's perspective.
  const viewerCol = orientation === 'white' ? file : 7 - file;
  const destAtViewerTop =
    (orientation === 'white' && rank === 7) ||
    (orientation === 'black' && rank === 0);

  const pct = (n: number) => `${(n * 100) / 8}%`;

  // Tile column position: anchored at the destination edge, growing inward.
  const columnStyle: React.CSSProperties = {
    position: 'absolute',
    left: pct(viewerCol),
    width: pct(1),
    zIndex: 30,
    display: 'flex',
    flexDirection: destAtViewerTop ? 'column' : 'column-reverse',
    pointerEvents: 'auto',
    ...(destAtViewerTop ? { top: 0 } : { bottom: 0 }),
  };

  return (
    <div
      className="promotion-picker-backdrop"
      onClick={(e) => {
        // Only cancel when the user clicked the backdrop itself, not a tile.
        if (e.target === e.currentTarget) onCancel();
      }}
      onContextMenu={(e) => { e.preventDefault(); onCancel(); }}
    >
      <div style={columnStyle}>
        {options.map((L) => (
          <button
            key={L}
            type="button"
            className="promotion-picker-tile"
            data-no-sfx
            onClick={() => { sfx.playSelect(); onPick(L); }}
            title={L}
          >
            <PromotionPiece letter={color === 'w' ? L : (L.toLowerCase() as string)} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Render a single promotion option, using the merged-piece composite when
// the letter is a Z/C/A fusion (mirrors the sandbox palette button).
function PromotionPiece({ letter }: { letter: string }) {
  const keys: PieceKey[] = lettersToPieceKeys(letter);
  if (keys.length === 1) return renderPiece(keys[0], 44);
  return (
    <div className="promotion-picker-merged">
      <div style={{ position: 'absolute', left: 0, top: 4 }}>{renderPiece(keys[0], 32)}</div>
      <div style={{ position: 'absolute', right: 0, bottom: 0 }}>{renderPiece(keys[1], 32)}</div>
    </div>
  );
}
