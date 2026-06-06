// Captured-piece readout. Renders one glyph per piece taken — no counts,
// no clustering math, just a flat row or column the eye can scan.
//
// Two usage shapes:
//   1. Inside PlayerCard (orientation='row'): horizontal strip under the
//      handle/rating line, packs tightly with a small overlap so a near-
//      complete crush still fits within the card width.
//   2. Beside the free-play board (orientation='column'): vertical pillar
//      of glyphs, top-to-bottom in the same atom order, so the player can
//      scan a side's captures the way they'd scan their own piece pool.

import type { CaptureSummary } from '../lib/captures';
import { ATOM_ORDER } from '../lib/captures';
import { renderPiece, type PieceKey } from '../lib/pieceSvgs';

type Props = {
  // The full capture summary — the component picks the right side off it.
  summary: CaptureSummary;
  // Which side this strip belongs to. "w" means "show pieces white has
  // captured" (= black material lost).
  side: 'w' | 'b';
  // Pixel height of each glyph. Defaults to a comfortable 22px.
  glyphSize?: number;
  // Layout direction. 'row' is the in-line PlayerCard strip; 'column' is the
  // tall pillar shown next to the free-play board. Defaults to 'row'.
  orientation?: 'row' | 'column';
};

export function CapturedPieces({ summary, side, glyphSize = 22, orientation = 'row' }: Props) {
  const captured = side === 'w' ? summary.byWhite : summary.byBlack;
  // The captured pieces belong to the OPPOSITE colour — we draw them in
  // that colour so the strip reads as "trophies taken from the other side".
  const pieceColor: 'w' | 'b' = side === 'w' ? 'b' : 'w';
  const totalCount = ATOM_ORDER.reduce((acc, a) => acc + captured[a], 0);
  // Show the advantage badge only on the side that's currently ahead.
  const shownAdvantage = side === 'w' ? summary.advantage : -summary.advantage;
  const hasAdvantage = shownAdvantage > 0;

  // Flatten the per-atom counts into a single ordered glyph list so the
  // render loop is dead-simple. Atoms come out in P, N, B, R, Q order.
  const glyphs: { key: string; atom: string }[] = [];
  for (const atom of ATOM_ORDER) {
    for (let i = 0; i < captured[atom]; i++) glyphs.push({ key: `${atom}-${i}`, atom });
  }

  const isColumn = orientation === 'column';
  // Horizontal layout (PlayerCard strip): tight overlap so 8+ glyphs still
  // fit within a slim card. Vertical layout (free-play column): looser, just
  // a small kiss-overlap, since the board height has plenty of room to grow
  // and every piece should be clearly distinguishable.
  const overlap = isColumn ? Math.round(glyphSize * 0.2) : Math.round(glyphSize * 0.55);

  return (
    <div
      className="captured-pieces"
      data-side={side}
      data-orientation={orientation}
      aria-label={side === 'w' ? 'White captures' : 'Black captures'}
      style={{
        display: 'flex',
        flexDirection: isColumn ? 'column' : 'row',
        alignItems: 'center',
        gap: isColumn ? 2 : 4,
        fontSize: Math.max(11, glyphSize * 0.55),
        color: 'var(--muted)',
        lineHeight: 1,
      }}
    >
      {totalCount === 0 ? (
        <span style={{ opacity: 0.45, fontStyle: 'italic' }}>—</span>
      ) : (
        glyphs.map(({ key, atom }, i) => {
          const pieceKey = `${pieceColor}${atom}` as PieceKey;
          // Overlap each glyph onto the previous one. The first glyph has
          // no offset; every subsequent glyph slides back along the layout
          // axis by `overlap`px to compact the strip.
          const offset = i === 0 ? 0 : -overlap;
          return (
            <span
              key={key}
              style={{
                width: glyphSize,
                height: glyphSize,
                marginLeft: isColumn ? 0 : offset,
                marginTop: isColumn ? offset : 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                // Soft drop-shadow per glyph so overlap reads as depth, not mush.
                filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.35))',
              }}
            >
              {renderPiece(pieceKey, glyphSize)}
            </span>
          );
        })
      )}
      {hasAdvantage && (
        <span
          className="capture-advantage"
          style={{
            marginLeft: isColumn ? 0 : 6,
            marginTop: isColumn ? 4 : 0,
            fontWeight: 700,
            color: 'var(--accent, #ffd28a)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          +{shownAdvantage}
        </span>
      )}
    </div>
  );
}
