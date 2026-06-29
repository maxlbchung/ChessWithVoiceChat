// The single, time-parameterized scene renderer. renderScene(ctx, model, tMs,
// sprites) draws one complete frame to a 2D canvas purely as a function of the
// clip time `tMs` — no DOM, no CSS keyframes. This same function drives both the
// live preview (rAF loop) and the export (captureStream + MediaRecorder), so
// what you preview is exactly what you export.
import type { Piece as MergePiece } from './mergeChess';
import { lettersToPieceKeys } from './pieceSvgs';
import type { SpriteCache } from './pieceSprites';
import type { TokenSpriteCache } from './tokenSprites';
import type { DisplaySnapshot } from './replayView';
import { TOKEN_SPECS, type EffectEvent } from './videoProject';

// ---- Geometry ------------------------------------------------------------

export type Orientation = 'white' | 'black';

const LIGHT = '#dfe5f0';
const DARK = '#5d6c89';
const LAST_MOVE_TINT = 'rgba(140, 220, 150, 0.45)';
const BORDER_COLOR = '#0c1e2c'; // frame around the board (also fills the export edges)

// The board is drawn inset by a margin so corner tokens can overhang into the
// frame instead of being clamped toward the center. The canvas is sized to
// board + 2·margin; geometry stays in board coordinates (the renderer
// translates by the margin).
export function boardMargin(boardPx: number): number {
  return Math.round((boardPx / 8) * 0.42);
}
export function canvasSize(boardPx: number): number {
  return boardPx + 2 * boardMargin(boardPx);
}
// Effects animate in (pop/grow) and out (fade/shrink); the body stays opaque.
const EFFECT_IN_MS = 170;
const EFFECT_OUT_MS = 220;
const HIGHLIGHT_ALPHA = 0.9; // vivid, drawn UNDER pieces so they stay visible
const TOKEN_TINT_ALPHA = 0.5; // square tint under a move-quality token, in its color

function idxToSquare(idx: number): string {
  const file = idx % 8;
  const rank = 7 - Math.floor(idx / 8);
  return String.fromCharCode(97 + file) + (rank + 1);
}

// Top-left pixel of a square, honoring orientation.
function topLeft(sq: string, squarePx: number, orientation: Orientation): { x: number; y: number } {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  return { x: col * squarePx, y: row * squarePx };
}

// Pixel center of a square (effects + slide interpolation anchor here).
export function center(sq: string, squarePx: number, orientation: Orientation): { x: number; y: number } {
  const tl = topLeft(sq, squarePx, orientation);
  return { x: tl.x + squarePx / 2, y: tl.y + squarePx / 2 };
}

// Inverse of topLeft — which square does a board-local pixel land on? Used for
// click-to-select in the editor preview.
export function squareAtPoint(
  px: number,
  py: number,
  boardPx: number,
  orientation: Orientation,
  margin = 0,
): string | null {
  const x = px - margin;
  const y = py - margin;
  if (x < 0 || y < 0 || x >= boardPx || y >= boardPx) return null;
  const squarePx = boardPx / 8;
  const col = Math.floor(x / squarePx);
  const row = Math.floor(y / squarePx);
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return String.fromCharCode(97 + file) + (rank + 1);
}

// ---- Math helpers --------------------------------------------------------

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
export function easeInCubic(t: number): number {
  return t * t * t;
}

// Peak scale at the apex of the 3D arc. The board is a birds-eye view, so
// "up toward the viewer" reads as the piece EXPANDING toward the camera, not
// translating up the screen. ~1.5× = a subtle pop, not a screen-filling zoom.
const EXPAND_PEAK = 1.5;

// The mover's transform for a given move type at slide progress `phase` (0..1).
// `tx` is horizontal progress from→to; `scale` zooms the piece toward the camera
// (peaks at the apex, off-frame); `flipX` drives a once-around Y-axis spin (cos
// goes 1→0→-1→0→1, mirroring the sprite). `dy` stays 0 (no vertical drift).
function moverTransform(
  type: string,
  phase: number,
): { tx: number; dy: number; scale: number; flipX: number } {
  if (type === '3d' || type === 'anticipation') {
    let tx: number;
    let lift: number;
    let spin: number;
    if (type === 'anticipation') {
      const RISE = 0.28;
      const HANG_END = 0.72;
      if (phase < RISE) {
        const e = easeOutCubic(phase / RISE);
        lift = e;
        tx = 0.42 * e;
      } else if (phase < HANG_END) {
        const u = (phase - RISE) / (HANG_END - RISE);
        lift = 1 - 0.05 * u; // hangs near the top
        tx = 0.42 + 0.13 * u; // creeps forward during the hang
      } else {
        const e = easeInCubic((phase - HANG_END) / (1 - HANG_END));
        lift = 0.95 * (1 - e); // quick drop
        tx = 0.55 + 0.45 * e; // quick finish
      }
      spin = tx; // spin tracks horizontal progress, so it lingers at the apex
    } else {
      tx = easeInOutCubic(phase);
      lift = Math.sin(Math.PI * phase);
      spin = phase;
    }
    return {
      tx,
      dy: 0,
      scale: 1 + (EXPAND_PEAK - 1) * lift,
      flipX: Math.cos(2 * Math.PI * spin),
    };
  }
  return { tx: easeInOutCubic(phase), dy: 0, scale: 1, flipX: 1 };
}

// ---- Scene model ---------------------------------------------------------

// A frame is exactly the per-ply display snapshot Review computes (board +
// last move + every variant overlay), so the renderer can reproduce all modes.
export type Frame = DisplaySnapshot;

export type SceneModel = {
  boardPx: number;
  orientation: Orientation;
  // frames[0] = board at the start of the clip (before the first featured move).
  // frames[k] (k>=1) = board after the k-th featured move.
  // length = (number of featured moves) + 1.
  frames: Frame[];
  // Start time (ms) of each featured move's slide. length = frames.length - 1.
  moveTimes: number[];
  // Animation style per featured move ('normal' | '3d' | 'anticipation').
  moveTypes?: string[];
  slideDurationMs: number;
  effects: EffectEvent[];
  totalDurationMs: number;
  // SFX keys to play when each featured move starts (e.g. ['capture','check']).
  // Aligned with moveTimes. Optional — empty/missing means silent moves.
  moveSounds?: string[][];
};

// ---- Piece drawing -------------------------------------------------------

function drawPiece(
  ctx: CanvasRenderingContext2D,
  letter: string,
  x: number,
  y: number,
  squarePx: number,
  sprites: SpriteCache,
): void {
  const keys = lettersToPieceKeys(letter);
  if (keys.length === 1) {
    const img = sprites.get(keys[0]);
    if (img) ctx.drawImage(img, x, y, squarePx, squarePx);
    return;
  }
  if (keys.length >= 2) {
    // Merged piece: stack the two glyphs in opposite corners (approximation of
    // the live board's composed sprite — good enough for the merge variant,
    // which is a v1 follow-up anyway).
    const s = squarePx * 0.66;
    const a = sprites.get(keys[0]);
    const b = sprites.get(keys[1]);
    if (a) ctx.drawImage(a, x, y, s, s);
    if (b) ctx.drawImage(b, x + squarePx - s, y + squarePx - s, s, s);
  }
}

// ---- Effect drawing ------------------------------------------------------

export function drawToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  token: keyof typeof TOKEN_SPECS,
): void {
  const spec = TOKEN_SPECS[token];
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = spec.fill;
  ctx.fill();
  ctx.fillStyle = spec.fg;
  ctx.font = `bold ${Math.round(r * (spec.glyph.length > 1 ? 0.95 : 1.25))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.glyph, cx, cy + r * 0.06);
}

function sqStr(file: number, rank: number): string {
  return String.fromCharCode(97 + file) + (rank + 1);
}

// Polyline from→to in pixels. A knight move (1×2 / 2×1) bends through an elbow
// so the arrow is L-shaped (long leg first, like the on-board move arrows);
// everything else is a straight two-point line.
function arrowPolyline(from: string, to: string, squarePx: number, orientation: Orientation): { x: number; y: number }[] {
  const a = center(from, squarePx, orientation);
  const b = center(to, squarePx, orientation);
  const ff = from.charCodeAt(0) - 97;
  const fr = parseInt(from[1], 10) - 1;
  const tf = to.charCodeAt(0) - 97;
  const tr = parseInt(to[1], 10) - 1;
  const df = tf - ff;
  const dr = tr - fr;
  const knight = (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
  if (knight) {
    const elbow = Math.abs(dr) === 2 ? sqStr(ff, fr + dr) : sqStr(ff + df, fr);
    return [a, center(elbow, squarePx, orientation), b];
  }
  return [a, b];
}

// Draws an arrow along a polyline, growing in to fraction `frac` of its total
// length (for the draw-on animation), with the head at the growing tip.
function drawPolyArrow(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  width: number,
  color: string,
  frac: number,
): void {
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    lens.push(l);
    total += l;
  }
  if (total <= 0) return;
  const head = width * 2.4;
  const targetLen = total * clamp01(frac);

  // Find the point + direction at a given distance along the path.
  const at = (dist: number): { x: number; y: number; ux: number; uy: number } => {
    let rem = Math.max(0, Math.min(dist, total));
    for (let i = 0; i < lens.length; i++) {
      const ux = (pts[i + 1].x - pts[i].x) / (lens[i] || 1);
      const uy = (pts[i + 1].y - pts[i].y) / (lens[i] || 1);
      if (rem <= lens[i] || i === lens.length - 1) {
        return { x: pts[i].x + ux * rem, y: pts[i].y + uy * rem, ux, uy };
      }
      rem -= lens[i];
    }
    return { x: pts[0].x, y: pts[0].y, ux: 1, uy: 0 };
  };

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shaft: from start, through any intermediate vertices, up to (target - head).
  const shaftLen = Math.max(0, targetLen - head * 0.8);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] <= shaftLen) {
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      acc += lens[i];
    } else {
      const p = at(shaftLen);
      ctx.lineTo(p.x, p.y);
      break;
    }
  }
  ctx.stroke();

  // Arrowhead at the growing tip.
  const tip = at(targetLen);
  const px = -tip.uy;
  const py = tip.ux;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - tip.ux * head + px * head * 0.6, tip.y - tip.uy * head + py * head * 0.6);
  ctx.lineTo(tip.x - tip.ux * head - px * head * 0.6, tip.y - tip.uy * head - py * head * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Appearance envelope for highlight/token/arrow: pop+grow in, fade+shrink out.
// Returns null outside the effect's [start, start+duration) window.
function envelope(start: number, duration: number, tMs: number): { alpha: number; scale: number } | null {
  const local = tMs - start;
  if (local < 0 || local > duration) return null;
  if (local < EFFECT_IN_MS) {
    const p = clamp01(local / EFFECT_IN_MS);
    return { alpha: p, scale: 0.3 + 0.7 * easeOutBack(p) };
  }
  if (local > duration - EFFECT_OUT_MS) {
    const p = clamp01((duration - local) / EFFECT_OUT_MS);
    return { alpha: p, scale: 0.86 + 0.14 * p };
  }
  return { alpha: 1, scale: 1 };
}

// Reproduces the in-game king-emoji bubble keyframes (opacity / scale / drift)
// over the effect's lifetime. p is 0..1 across the duration.
function emojiBubbleAnim(p: number): { opacity: number; scale: number; drift: number } {
  if (p < 0.16) {
    const u = p / 0.16;
    return { opacity: u, scale: 0.72 + (1.08 - 0.72) * u, drift: 0.25 * (1 - u) };
  }
  if (p < 0.3) {
    const u = (p - 0.16) / 0.14;
    return { opacity: 1, scale: 1.08 + (1 - 1.08) * u, drift: 0 };
  }
  if (p < 0.74) {
    return { opacity: 1, scale: 1, drift: 0 };
  }
  const u = clamp01((p - 0.74) / 0.26);
  return { opacity: 1 - u, scale: 1 + (0.86 - 1) * u, drift: -0.35 * u };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Draws the in-game speech bubble (rounded card + tail pointing at the square)
// with the emoji glyph, matching MergeBoard's geometry and animation.
function drawEmojiBubble(
  ctx: CanvasRenderingContext2D,
  sq: string,
  emoji: string,
  squarePx: number,
  boardPx: number,
  orientation: Orientation,
  p: number,
): void {
  const c = center(sq, squarePx, orientation);
  const bubbleW = squarePx * 0.82;
  const bubbleH = squarePx * 0.82;
  const pad = squarePx * 0.08;
  const gap = squarePx * 0.34;
  const horizontalDir = c.x <= boardPx / 2 ? 1 : -1;
  const placement: 'above' | 'below' = c.y >= boardPx / 2 ? 'above' : 'below';
  const rawX = c.x + horizontalDir * squarePx * 0.48 - bubbleW / 2;
  const x = Math.max(pad, Math.min(boardPx - bubbleW - pad, rawX));
  const rawY = placement === 'above' ? c.y - bubbleH - gap : c.y + gap;
  const y = Math.max(pad, Math.min(boardPx - bubbleH - pad, rawY));

  const baseLocalX = x + bubbleW / 2 >= c.x ? bubbleW * 0.28 : bubbleW * 0.72;
  const baseHalf = squarePx * 0.12;
  const baseY = placement === 'above' ? y + bubbleH - 1 : y + 1;

  const anim = emojiBubbleAnim(p);
  const driftPx = anim.drift * squarePx * 0.2 * (placement === 'above' ? 1 : -1);
  // transform-origin: center-bottom for 'above', center-top for 'below'.
  const ox = x + bubbleW / 2;
  const oy = placement === 'above' ? y + bubbleH : y;

  ctx.save();
  ctx.globalAlpha = anim.opacity;
  ctx.translate(0, driftPx);
  ctx.translate(ox, oy);
  ctx.scale(anim.scale, anim.scale);
  ctx.translate(-ox, -oy);

  // Tail (pointing at the square) — drawn first so the card overlaps its base.
  ctx.beginPath();
  ctx.moveTo(x + baseLocalX - baseHalf, baseY);
  ctx.lineTo(x + baseLocalX + baseHalf, baseY);
  ctx.lineTo(c.x, c.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fill();

  // Card.
  ctx.shadowColor = 'rgba(10,22,35,0.28)';
  ctx.shadowBlur = squarePx * 0.12;
  ctx.shadowOffsetY = squarePx * 0.05;
  roundRect(ctx, x, y, bubbleW, bubbleH, squarePx * 0.18);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Glyph.
  ctx.fillStyle = '#000';
  ctx.font = `${Math.round(squarePx * 0.43)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, x + bubbleW / 2, y + bubbleH / 2);
  ctx.restore();
}

// ---- Variant overlays (Hero / Slime / Juggernaut / Frost / ICBM …) -------
// These mirror what MergeBoard draws in Review: per-ply state, not the live
// game's transient ability animations. Light time-based motion is added where
// it reads as "alive" (orbiting stun stars, slime wobble, quake shake).

function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function kingSquareOf(board: (MergePiece | null)[], color: 'w' | 'b'): string | null {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return idxToSquare(i);
  }
  return null;
}

function drawKingGlow(ctx: CanvasRenderingContext2D, sq: string, color: string, squarePx: number, orientation: Orientation): void {
  const c = center(sq, squarePx, orientation);
  const r = squarePx * 0.62;
  const g = ctx.createRadialGradient(c.x, c.y, squarePx * 0.1, c.x, c.y, r);
  g.addColorStop(0, withAlpha(color, 0.8));
  g.addColorStop(0.3, withAlpha(color, 0.5));
  g.addColorStop(0.6, withAlpha(color, 0.25));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGoo(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tMs: number): void {
  const wob = Math.sin(tMs / 600);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = (w / 2) * (1 + 0.03 * wob);
  const ry = (h / 2) * (1 - 0.03 * wob);
  const g = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.4, rx * 0.1, cx, cy, Math.max(rx, ry));
  g.addColorStop(0, 'rgba(220,255,200,0.5)');
  g.addColorStop(0.38, 'rgba(126,217,87,0.4)');
  g.addColorStop(0.75, 'rgba(70,160,60,0.36)');
  g.addColorStop(1, 'rgba(40,110,45,0.4)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx - rx * 0.3, cy - ry * 0.35, rx * 0.28, ry * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFrozen(ctx: CanvasRenderingContext2D, sq: string, squarePx: number, orientation: Orientation): void {
  const { x, y } = topLeft(sq, squarePx, orientation);
  const g = ctx.createLinearGradient(x, y, x + squarePx, y + squarePx);
  g.addColorStop(0, 'rgba(180,230,255,0.62)');
  g.addColorStop(1, 'rgba(80,160,220,0.5)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(x, y, squarePx, squarePx);
  ctx.strokeStyle = 'rgba(220,240,255,0.85)';
  ctx.lineWidth = Math.max(1.5, squarePx * 0.025);
  ctx.strokeRect(x + 1.5, y + 1.5, squarePx - 3, squarePx - 3);
  ctx.fillStyle = 'rgba(240,250,255,0.95)';
  ctx.font = `bold ${Math.round(squarePx * 0.34)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('❄', x + squarePx / 2, y + squarePx / 2);
  ctx.restore();
}

function drawMissile(ctx: CanvasRenderingContext2D, sq: string, pliesLeft: number, firedBy: 'w' | 'b', squarePx: number, orientation: Orientation): void {
  const c = center(sq, squarePx, orientation);
  const r = squarePx * 0.36;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();
  ctx.lineWidth = Math.max(2, squarePx * 0.03);
  ctx.strokeStyle = '#ff5a5a';
  ctx.stroke();
  const tick = firedBy === 'w' ? squarePx * 0.18 : squarePx * 0.32;
  const ang0 = firedBy === 'w' ? 0 : Math.PI / 4;
  for (let i = 0; i < 4; i++) {
    const a = ang0 + (i * Math.PI) / 2;
    const ix = Math.cos(a);
    const iy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(c.x + ix * (r - tick), c.y + iy * (r - tick));
    ctx.lineTo(c.x + ix * r, c.y + iy * r);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(squarePx * 0.34)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(pliesLeft), c.x, c.y);
  ctx.restore();
}

function drawStun(ctx: CanvasRenderingContext2D, sq: string, squarePx: number, orientation: Orientation, tMs: number): void {
  const c = center(sq, squarePx, orientation);
  const cy = c.y - squarePx * 0.26;
  ctx.save();
  ctx.fillStyle = '#ffd84d';
  ctx.font = `${Math.round(squarePx * 0.2)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 3; i++) {
    const a = (tMs / 1300) * Math.PI * 2 + (i * Math.PI * 2) / 3;
    ctx.fillText('✶', c.x + Math.cos(a) * squarePx * 0.3, cy + Math.sin(a) * squarePx * 0.12);
  }
  ctx.restore();
}

function drawEarthquake(ctx: CanvasRenderingContext2D, sq: string, df: number, dr: number, squarePx: number, orientation: Orientation, tMs: number): void {
  const c = center(sq, squarePx, orientation);
  const shx = Math.sin(tMs / 40) * squarePx * 0.015;
  const shy = Math.cos(tMs / 37) * squarePx * 0.015;
  ctx.save();
  ctx.translate(c.x + shx, c.y + shy);
  ctx.fillStyle = 'rgba(80,50,22,0.22)';
  ctx.fillRect(-squarePx * 0.45, -squarePx * 0.45, squarePx * 0.9, squarePx * 0.9);
  ctx.strokeStyle = '#2a1808';
  ctx.lineWidth = Math.max(2, squarePx * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-squarePx * 0.4, 0);
  ctx.lineTo(-squarePx * 0.1, -squarePx * 0.08);
  ctx.lineTo(squarePx * 0.1, squarePx * 0.06);
  ctx.lineTo(squarePx * 0.4, -squarePx * 0.02);
  ctx.stroke();
  if (df || dr) {
    const len = Math.hypot(df, dr) || 1;
    const ux = (orientation === 'white' ? df : -df) / len;
    const uy = (orientation === 'white' ? -dr : dr) / len;
    ctx.strokeStyle = '#cfa874';
    ctx.lineWidth = Math.max(2, squarePx * 0.035);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ux * squarePx * 0.32, uy * squarePx * 0.32);
    ctx.stroke();
  }
  ctx.restore();
}

function drawJugPips(ctx: CanvasRenderingContext2D, sq: string, tier: number, squarePx: number, orientation: Orientation): void {
  const { x, y } = topLeft(sq, squarePx, orientation);
  const w = squarePx * 0.12;
  const gap = squarePx * 0.09;
  const total = tier * w + (tier - 1) * gap;
  let px = x + squarePx / 2 - total / 2 + w / 2;
  const py = y + squarePx * 0.9;
  for (let i = 0; i < tier; i++) {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#e0913f';
    ctx.shadowColor = 'rgba(224,145,63,0.85)';
    ctx.shadowBlur = squarePx * 0.06;
    ctx.fillRect(-w / 2, -w / 2, w, w);
    ctx.restore();
    px += w + gap;
  }
}

// ---- Main render ---------------------------------------------------------

export function renderScene(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  tMs: number,
  sprites: SpriteCache,
  tokens?: TokenSpriteCache,
): void {
  const { boardPx, orientation, frames, moveTimes, slideDurationMs } = model;
  const squarePx = boardPx / 8;
  const margin = boardMargin(boardPx);
  const full = boardPx + 2 * margin;
  const count = Math.max(0, frames.length - 1);

  // High-quality downscaling for the piece + token sprites (default is 'low').
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Border frame fills the whole canvas; then shift into board coordinates so
  // every helper below keeps working in [0, boardPx] and corner tokens overhang
  // into the frame.
  ctx.clearRect(0, 0, full, full);
  ctx.fillStyle = BORDER_COLOR;
  ctx.fillRect(0, 0, full, full);
  ctx.save();
  ctx.translate(margin, margin);

  // 1) Board squares.
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = String.fromCharCode(97 + file) + (rank + 1);
      const { x, y } = topLeft(sq, squarePx, orientation);
      ctx.fillStyle = (file + rank) % 2 === 0 ? DARK : LIGHT;
      ctx.fillRect(x, y, squarePx, squarePx);
    }
  }

  // 2) Resolve the active move + slide phase from time alone.
  let activeMove = 0; // highest 1-based move index whose slide has started
  for (let m = 1; m <= count; m++) {
    if (moveTimes[m - 1] <= tMs) activeMove = m;
  }
  // Per-move animation style + an effective slide duration (the dramatic 3D
  // styles want longer than the flat slide, but never longer than the gap to
  // the next move so they always finish before it starts).
  const moveType = activeMove >= 1 ? model.moveTypes?.[activeMove - 1] ?? 'normal' : 'normal';
  const curStart = activeMove >= 1 ? moveTimes[activeMove - 1] : 0;
  const nextStart =
    activeMove >= 1 && activeMove < moveTimes.length ? moveTimes[activeMove] : model.totalDurationMs;
  const wantDur = moveType === 'normal' ? slideDurationMs : moveType === '3d' ? Math.max(slideDurationMs, 650) : Math.max(slideDurationMs, 850);
  const slideDur = activeMove >= 1 ? Math.min(wantDur, Math.max(120, nextStart - curStart - 20)) : slideDurationMs;
  const sliding = activeMove >= 1 && tMs - curStart < slideDur;
  const phase = sliding ? clamp01((tMs - curStart) / slideDur) : 1;
  const baseIndex = sliding ? activeMove - 1 : activeMove;
  const baseFrame = frames[baseIndex] ?? frames[0];
  const movingMove = sliding ? frames[activeMove] : null;
  const moverFromSq = movingMove?.lastMove?.from ?? null;

  // 3) Last-move tint (the move currently shown / animating).
  const tintMove = frames[activeMove]?.lastMove ?? null;
  if (tintMove) {
    ctx.fillStyle = LAST_MOVE_TINT;
    for (const sq of new Set([tintMove.from, tintMove.to])) {
      const { x, y } = topLeft(sq, squarePx, orientation);
      ctx.fillRect(x, y, squarePx, squarePx);
    }
  }

  // 3b) Square tints drawn UNDER the pieces (so pieces stay visible): explicit
  // highlights, plus a token's square tinted in the token's own color.
  for (const e of model.effects) {
    let sq: string | null = null;
    let color: string | null = null;
    let alphaMul = 0;
    if (e.kind === 'highlight') {
      sq = e.square;
      color = e.color;
      alphaMul = HIGHLIGHT_ALPHA;
    } else if (e.kind === 'token') {
      sq = e.square;
      color = TOKEN_SPECS[e.token].fill;
      alphaMul = TOKEN_TINT_ALPHA;
    } else {
      continue;
    }
    const env = envelope(e.startMs, e.durationMs, tMs);
    if (!env) continue;
    const { x, y } = topLeft(sq, squarePx, orientation);
    ctx.save();
    ctx.globalAlpha = env.alpha * alphaMul;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, squarePx, squarePx);
    ctx.restore();
  }

  // 3c) Variant overlays drawn UNDER the pieces: hero king glows + earthquakes.
  const maskedSet = new Set(baseFrame?.maskedAsKingSquares ?? []);
  const jugMap = new Map((baseFrame?.juggernauts ?? []).map((j) => [j.sq, j.tier] as const));
  const slimeTileSet = new Set((baseFrame?.slimeBigKings ?? []).flatMap((b) => b.tiles));
  if (baseFrame?.kingGlows) {
    for (const color of ['w', 'b'] as const) {
      const glow = baseFrame.kingGlows[color];
      if (!glow) continue;
      const sq = kingSquareOf(baseFrame.board, color);
      if (!sq || maskedSet.has(sq)) continue; // masked kings hide their aura
      drawKingGlow(ctx, sq, glow, squarePx, orientation);
    }
  }
  for (const eq of baseFrame?.earthquakes ?? []) {
    drawEarthquake(ctx, eq.sq, eq.df, eq.dr, squarePx, orientation, tMs);
  }

  // 4) Static pieces (skip the mover's source square while it's in transit).
  // Variant overrides: masked pieces render as a king of their color; the
  // Juggernaut king renders as a neutral stone king; Slime big-king tiles are
  // suppressed here and drawn as one stretched sprite below.
  if (baseFrame) {
    for (let idx = 0; idx < baseFrame.board.length; idx++) {
      const piece = baseFrame.board[idx];
      if (!piece) continue;
      const sq = idxToSquare(idx);
      if (sliding && sq === moverFromSq) continue;
      if (slimeTileSet.has(sq)) continue;
      const { x, y } = topLeft(sq, squarePx, orientation);
      if (jugMap.has(sq)) {
        const neutral = sprites.get('neutralK');
        if (neutral) ctx.drawImage(neutral, x, y, squarePx, squarePx);
        else drawPiece(ctx, piece.letter, x, y, squarePx, sprites);
      } else if (maskedSet.has(sq)) {
        drawPiece(ctx, piece.color === 'w' ? 'K' : 'k', x, y, squarePx, sprites);
      } else {
        drawPiece(ctx, piece.letter, x, y, squarePx, sprites);
      }
    }
    // Slime big-kings: one stretched king sprite spanning each blob's 2×2 tiles.
    for (const blob of baseFrame.slimeBigKings ?? []) {
      let minX = Infinity;
      let minY = Infinity;
      for (const t of blob.tiles) {
        const tl = topLeft(t, squarePx, orientation);
        minX = Math.min(minX, tl.x);
        minY = Math.min(minY, tl.y);
      }
      const size = squarePx * 2;
      const img = sprites.get(blob.color === 'w' ? 'wK' : 'bK');
      if (img) ctx.drawImage(img, minX, minY, size, size);
    }
  }

  // 5) The sliding piece, interpolated from→to.
  if (sliding && movingMove?.lastMove) {
    const { from, to } = movingMove.lastMove;
    const fromIdx = sqIndex(from);
    const moverLetter =
      (baseFrame && fromIdx >= 0 ? baseFrame.board[fromIdx]?.letter : undefined) ??
      // Fall back to the post-move piece at the destination (e.g. promotions).
      frames[activeMove]?.board[sqIndex(to)]?.letter;
    if (moverLetter) {
      const a = center(from, squarePx, orientation);
      const b = center(to, squarePx, orientation);
      const mt = moverTransform(moveType, phase);
      const cx = lerp(a.x, b.x, mt.tx);
      const cy = lerp(a.y, b.y, mt.tx) + mt.dy;
      ctx.save();
      ctx.translate(cx, cy);
      // flipX (cos of the spin) scales X through 0 to -1 → an edge-on then
      // mirrored sprite, faking a 3D Y-axis spin. scale fakes perspective.
      ctx.scale(mt.scale * mt.flipX, mt.scale);
      drawPiece(ctx, moverLetter, -squarePx / 2, -squarePx / 2, squarePx, sprites);
      ctx.restore();
    }
  }

  // 5b) Variant overlays drawn OVER the pieces: slime goo, frost, missiles,
  // stun stars, juggernaut tier pips.
  if (baseFrame) {
    for (const blob of baseFrame.slimeBigKings ?? []) {
      let minX = Infinity;
      let minY = Infinity;
      for (const t of blob.tiles) {
        const tl = topLeft(t, squarePx, orientation);
        minX = Math.min(minX, tl.x);
        minY = Math.min(minY, tl.y);
      }
      const size = squarePx * 2;
      drawGoo(ctx, minX + size * 0.03, minY + size * 0.03, size * 0.94, size * 0.94, tMs);
    }
    for (const sq of baseFrame.slimeKingSquares ?? []) {
      const { x, y } = topLeft(sq, squarePx, orientation);
      drawGoo(ctx, x + squarePx * 0.09, y + squarePx * 0.09, squarePx * 0.82, squarePx * 0.82, tMs);
    }
    for (const sq of baseFrame.frozenSquares ?? []) {
      drawFrozen(ctx, sq, squarePx, orientation);
    }
    for (const m of baseFrame.missiles ?? []) {
      drawMissile(ctx, m.sq, m.pliesLeft, m.firedBy, squarePx, orientation);
    }
    for (const sq of baseFrame.stunnedSquares ?? []) {
      drawStun(ctx, sq, squarePx, orientation, tMs);
    }
    for (const [sq, tier] of jugMap) {
      drawJugPips(ctx, sq, tier, squarePx, orientation);
    }
  }

  // 6) Over-piece effects: arrows, tokens, emoji bubbles.
  for (const e of model.effects) {
    if (e.kind === 'emoji') {
      // Emoji uses the in-game bubble animation across its whole duration.
      const local = tMs - e.startMs;
      if (local < 0 || local > e.durationMs) continue;
      drawEmojiBubble(ctx, e.square, e.emoji, squarePx, boardPx, orientation, clamp01(local / e.durationMs));
      continue;
    }
    if (e.kind === 'highlight') continue; // already drawn under the pieces
    const env = envelope(e.startMs, e.durationMs, tMs);
    if (!env) continue;
    ctx.save();
    ctx.globalAlpha = env.alpha;
    if (e.kind === 'arrow') {
      // Draw-on along the (possibly L-shaped) polyline as it appears.
      const grow = clamp01((tMs - e.startMs) / EFFECT_IN_MS);
      const pts = arrowPolyline(e.from, e.to, squarePx, orientation);
      drawPolyArrow(ctx, pts, squarePx * 0.16, e.color, grow);
    } else if (e.kind === 'token') {
      const c = center(e.square, squarePx, orientation);
      const r = squarePx * 0.26 * env.scale;
      // Centered exactly on the square's top-right corner; edge-square badges
      // overhang into the board's margin frame (no clamping toward the center).
      const cx = c.x + squarePx * 0.5;
      const cy = c.y - squarePx * 0.5;
      const img = tokens?.get(e.token);
      if (img && img.width > 0) {
        ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
      } else {
        drawToken(ctx, cx, cy, r, e.token);
      }
    }
    ctx.restore();
  }

  ctx.restore(); // undo the board-margin translate
}

function sqIndex(sq: string): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return (7 - rank) * 8 + file;
}
