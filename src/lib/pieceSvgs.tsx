// Chess piece artwork — "Sketchbook" style: ink line art over watercolor.
// Geometry is Cburnett (CC BY-SA 3.0, via Wikimedia), redrawn as layers:
//   1. bleed  — the body shapes in a watercolor tint, nudged off-register so
//               the paint runs a little outside the lines;
//   2. body   — the flat wash that gives the piece its side (paper / indigo);
//   3. ink    — sepia outline + detail lines (details turn paper-colored on
//               the dark side, as Cburnett's black set does with white);
//   4. sketch — a second, fainter pass over the outline with its points
//               jittered, like a quick double-stroked pencil line.
// Deliberately NO SVG filters: pieces repaint on every move and animation,
// and filter rasterization was the cause of the theme's frame drops (see
// "Procedural watercolor" in docs/ARCHITECTURE.md). Everything here is plain
// fills and strokes. The jitter is seeded per piece, so a piece always looks
// the same.

import type { ReactElement } from 'react';

type PieceKey = 'wP' | 'wR' | 'wN' | 'wB' | 'wQ' | 'wK' | 'bP' | 'bR' | 'bN' | 'bB' | 'bQ' | 'bK';

type Shape = { d: string } | { cx: number; cy: number; r: number };
type Glyph = {
  // Closed shapes that take the side's wash and the ink outline.
  bodies: Shape[];
  // Open detail strokes drawn over the body (bands) — ink on light, paper
  // on dark.
  lines?: string[];
  // Open strokes that stand clear of the body (the king's cross) — always
  // ink, or they'd vanish against light squares on the dark side.
  strokes?: string[];
  // Small solid marks (the knight's eye and nostril).
  dots?: Shape[];
};

const KING_BODIES: Shape[] = [
  { d: 'M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25 z' },
  { d: 'M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37 z' },
];
const KING_CROSS = ['M 22.5,11.63 L 22.5,6', 'M 20,8 L 25,8'];
const KING_LINES = [
  'M 12.5,30 C 18,27 27,27 32.5,30',
  'M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5',
  'M 12.5,37 C 18,34 27,34 32.5,37',
];

const GLYPHS: Record<'P' | 'R' | 'N' | 'B' | 'Q' | 'K', Glyph> = {
  P: {
    bodies: [{ d: 'm 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z' }],
  },
  R: {
    bodies: [
      { d: 'M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z' },
      { d: 'M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z' },
      { d: 'M 12.5,32 L 14,29.5 L 31,29.5 L 32.5,32 L 12.5,32 z' },
      { d: 'M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 L 14,29.5 z' },
      { d: 'M 14,16.5 L 11,14 L 34,14 L 31,16.5 L 14,16.5 z' },
      { d: 'M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14 L 11,14 z' },
    ],
  },
  N: {
    bodies: [
      { d: 'M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18' },
      { d: 'M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10' },
    ],
    dots: [
      { cx: 9, cy: 25.5, r: 0.6 },
      { cx: 14.5, cy: 15.5, r: 1 },
    ],
  },
  B: {
    bodies: [
      { d: 'M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z' },
      { d: 'M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z' },
      { cx: 22.5, cy: 8, r: 2.5 },
    ],
    lines: ['M 17.5,26 L 27.5,26', 'M 15,30 L 30,30', 'M 22.5,15.5 L 22.5,20.5', 'M 20,18 L 25,18'],
  },
  Q: {
    bodies: [
      { d: 'M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z' },
      { d: 'M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z' },
      { cx: 6, cy: 12, r: 2 },
      { cx: 14, cy: 9, r: 2 },
      { cx: 22.5, cy: 8, r: 2 },
      { cx: 31, cy: 9, r: 2 },
      { cx: 39, cy: 12, r: 2 },
    ],
    lines: ['M 11.5,30 C 15,29 30,29 33.5,30', 'M 12,33.5 C 18,32.5 27,32.5 33,33.5'],
  },
  K: { bodies: KING_BODIES, lines: KING_LINES, strokes: KING_CROSS },
};

type Palette = { id: string; body: string; settle: string; bleed: string; bleedOpacity: number; ink: string; detail: string; dot: string };

const INK = '#2a221c';
const PAPER = '#f6eedd';
const PALETTES: Record<'w' | 'b' | 'neutral', Palette> = {
  // Light side: near-paper body with a warm ochre bleed.
  w: { id: 'w', body: '#fdf8ec', settle: '#f0d9a8', bleed: '#e2b45f', bleedOpacity: 0.7, ink: INK, detail: INK, dot: INK },
  // Dark side: an indigo-ink wash with a brighter indigo bleed; details are
  // drawn back out in paper color.
  b: { id: 'b', body: '#34445e', settle: '#1f2a3d', bleed: '#4f7aa8', bleedOpacity: 0.75, ink: INK, detail: PAPER, dot: PAPER },
  // Juggernaut (no side): stone grey wash.
  neutral: { id: 'n', body: '#a39c90', settle: '#7f786d', bleed: '#6f8a7e', bleedOpacity: 0.6, ink: INK, detail: INK, dot: INK },
};

// mulberry32 seeded from the piece key — stable art per piece.
function rng(seedText: string): () => number {
  let a = 0;
  for (let i = 0; i < seedText.length; i++) a = (Math.imul(a, 31) + seedText.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nudge every coordinate of a path by up to ±amp. Paths are absolute or use
// relative segments whose drift stays tiny at this amplitude, which reads as
// a hand that didn't quite retrace the line.
function jitterPath(d: string, r: () => number, amp: number): string {
  return d.replace(/-?\d*\.?\d+/g, (n) => (parseFloat(n) + (r() - 0.5) * 2 * amp).toFixed(2));
}

function shapeEl(s: Shape, k: string | number, props: Record<string, unknown> = {}): ReactElement {
  return 'd' in s ? <path key={k} d={s.d} {...props} /> : <circle key={k} cx={s.cx} cy={s.cy} r={s.r} {...props} />;
}

function drawGlyph(g: Glyph, pal: Palette, seed: string, size: number): ReactElement {
  const r = rng(seed);
  const bx = 1 + r() * 0.8, by = 0.6 + r() * 0.7;
  const sketch = (s: Shape, i: number) =>
    'd' in s
      ? <path key={i} d={jitterPath(s.d, r, 0.45)} />
      : <circle key={i} cx={s.cx + (r() - 0.5) * 0.6} cy={s.cy + (r() - 0.5) * 0.6} r={s.r + (r() - 0.5) * 0.3} />;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 45 45" width={size} height={size}>
      {/* Gravity wash: pigment settles toward the base as it dries. Same id
          for every piece of a palette — the definitions are identical, so a
          duplicate id in the document is harmless. */}
      <defs>
        <linearGradient id={`vcc-pc-${pal.id}`} x1="0" y1="0" x2="0.25" y2="1">
          <stop offset="0.3" stopColor={pal.body} />
          <stop offset="1" stopColor={pal.settle} />
        </linearGradient>
      </defs>
      <g fill={pal.bleed} opacity={pal.bleedOpacity} transform={`translate(${bx.toFixed(2)} ${by.toFixed(2)}) rotate(${(r() * 2 - 1).toFixed(2)} 22.5 24)`}>
        {g.bodies.map((s, i) => shapeEl(s, i))}
      </g>
      <g fill={`url(#vcc-pc-${pal.id})`} fillRule="evenodd">
        {g.bodies.map((s, i) => shapeEl(s, i))}
      </g>
      {/* Pooled edge: pigment collecting along the inside of the outline as
          the wash dries — a wide, faint bleed-colored stroke under the ink. */}
      <g fill="none" stroke={pal.bleed} strokeWidth={3.2} strokeLinejoin="round" opacity={0.4}>
        {g.bodies.map((s, i) => shapeEl(s, i))}
      </g>
      <g fill="none" stroke={pal.ink} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        {g.bodies.map((s, i) => shapeEl(s, i))}
        {g.strokes?.map((d, i) => <path key={`s${i}`} d={d} />)}
      </g>
      {g.lines && (
        <g fill="none" stroke={pal.detail} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
          {g.lines.map((d, i) => <path key={i} d={d} />)}
        </g>
      )}
      <g fill="none" stroke={pal.ink} strokeWidth={0.75} strokeLinecap="round" strokeLinejoin="round" opacity={0.55}>
        {g.bodies.map(sketch)}
        {pal.detail === pal.ink && g.lines?.map((d, i) => <path key={`l${i}`} d={jitterPath(d, r, 0.35)} />)}
        {g.strokes?.map((d, i) => <path key={`s${i}`} d={jitterPath(d, r, 0.35)} />)}
      </g>
      {g.dots && <g fill={pal.dot}>{g.dots.map((s, i) => shapeEl(s, i))}</g>}
    </svg>
  );
}

export function renderPiece(key: PieceKey, size: number): ReactElement {
  const side = key[0] as 'w' | 'b';
  const kind = key[1] as keyof typeof GLYPHS;
  return drawGlyph(GLYPHS[kind], PALETTES[side], key, size);
}

// Neutral "no color" king — the Juggernaut. Same king geometry, stone-grey
// wash so it reads as belonging to neither side.
export function renderNeutralKing(size: number): ReactElement {
  return drawGlyph(GLYPHS.K, PALETTES.neutral, 'neutralK', size);
}

// Map merge-engine piece letter → list of standard piece codes whose SVG
// glyphs we stack to depict the merged piece.
export function lettersToPieceKeys(letter: string): PieceKey[] {
  const isWhite = letter === letter.toUpperCase();
  const c: 'w' | 'b' = isWhite ? 'w' : 'b';
  const up = letter.toUpperCase();
  switch (up) {
    case 'P': return [`${c}P` as PieceKey];
    case 'K': return [`${c}K` as PieceKey];
    case 'S': return [`${c}K` as PieceKey];  // Slime big-king tile — king glyph
    case 'R': return [`${c}R` as PieceKey];
    case 'N': return [`${c}N` as PieceKey];
    case 'B': return [`${c}B` as PieceKey];
    case 'Q': return [`${c}Q` as PieceKey];
    case 'C': return [`${c}R` as PieceKey, `${c}N` as PieceKey];  // rook + knight
    case 'A': return [`${c}B` as PieceKey, `${c}N` as PieceKey];  // bishop + knight
    case 'Z': return [`${c}Q` as PieceKey, `${c}N` as PieceKey];  // queen + knight
    default:  return [];
  }
}

export type { PieceKey };
