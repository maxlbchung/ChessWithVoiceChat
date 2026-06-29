// Pre-rasterizes the Cburnett piece SVGs (the same artwork the live board uses)
// into HTMLImageElements once, so the canvas video renderer can drawImage them
// per frame instead of re-serializing SVG every frame. Keyed by PieceKey plus a
// 'neutralK' entry for the Juggernaut boss king.
//
// react-dom/server is only imported here; because the video editor page is
// DEV-gated and lazy-loaded, this module (and renderToStaticMarkup) is
// code-split out of the production bundle.
import { renderToStaticMarkup } from 'react-dom/server';
import { renderNeutralKing, renderPiece, type PieceKey } from './pieceSvgs';

export type SpriteKey = PieceKey | 'neutralK';

export const PIECE_KEYS: PieceKey[] = [
  'wP', 'wR', 'wN', 'wB', 'wQ', 'wK',
  'bP', 'bR', 'bN', 'bB', 'bQ', 'bK',
];

// Rasterization resolution. drawImage scales this down to the board's square
// size; oversampling keeps pieces crisp on larger boards / retina.
const SRC_PX = 96;

export type SpriteCache = Map<SpriteKey, HTMLImageElement>;

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    // Resolve on either path; a failed decode still resolves so one bad glyph
    // can't hang the whole load (it just renders blank).
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = url;
  });
}

export async function loadAllSprites(srcPx = SRC_PX): Promise<SpriteCache> {
  const specs: [SpriteKey, string][] = PIECE_KEYS.map((k) => [
    k,
    renderToStaticMarkup(renderPiece(k, srcPx)),
  ]);
  specs.push(['neutralK', renderToStaticMarkup(renderNeutralKing(srcPx))]);

  const cache: SpriteCache = new Map();
  await Promise.all(
    specs.map(async ([k, svg]) => {
      cache.set(k, await svgToImage(svg));
    }),
  );
  return cache;
}
