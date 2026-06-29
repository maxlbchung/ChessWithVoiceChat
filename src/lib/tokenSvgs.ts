// Move-quality badges drawn in the familiar online-chess classification style:
// a flat colored disc with a white symbol, no outline. Colors/glyphs come from
// TOKEN_SPECS so there's one source of truth. To use exact assets, drop
// PNG/SVG files into public/tokens/<kind>.png (or .svg) — tokenSprites.ts
// prefers those.
import { TOKEN_SPECS, type TokenKind } from './videoProject';

export function tokenSvg(kind: TokenKind, px: number): string {
  const s = TOKEN_SPECS[kind];
  const fontSize = s.glyph.length > 1 ? 46 : 62;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">` +
    `<circle cx="50" cy="50" r="49" fill="${s.fill}"/>` +
    `<text x="50" y="53" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontSize}" ` +
    `fill="${s.fg}">${s.glyph}</text>` +
    `</svg>`
  );
}
