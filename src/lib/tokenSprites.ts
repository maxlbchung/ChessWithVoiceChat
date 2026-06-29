// Loads move-quality token badges as HTMLImageElements for canvas drawing.
// Prefers user-supplied files at public/tokens/<kind>.png (or .svg) — drop the
// exact classification icons there to use them — and falls back to the bundled
// SVG recreations in tokenSvgs.ts otherwise.
import { ALL_TOKEN_KINDS, type TokenKind } from './videoProject';
import { tokenSvg } from './tokenSvgs';

export type TokenSpriteCache = Map<TokenKind, HTMLImageElement>;

const SRC_PX = 128;

function imgFrom(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = url;
  });
}

function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function loadOne(kind: TokenKind): Promise<HTMLImageElement> {
  const base = import.meta.env.BASE_URL + 'tokens/' + kind;
  for (const url of [base + '.png', base + '.svg']) {
    try {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '';
      // Vite's dev server falls back to index.html for unknown paths (200 +
      // text/html), so gate on an image content-type to detect a real asset.
      if (res.ok && /image\/|svg/.test(ct)) {
        return await imgFrom(URL.createObjectURL(await res.blob()));
      }
    } catch {
      /* fall through to the bundled badge */
    }
  }
  return imgFrom(svgDataUrl(tokenSvg(kind, SRC_PX)));
}

export async function loadTokenSprites(): Promise<TokenSpriteCache> {
  const cache: TokenSpriteCache = new Map();
  await Promise.all(
    ALL_TOKEN_KINDS.map(async (k) => {
      cache.set(k, await loadOne(k));
    }),
  );
  return cache;
}
