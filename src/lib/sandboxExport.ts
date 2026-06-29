// Sandbox export helpers. The Sandbox is a freeform position editor (no move
// history), so it doesn't fit the move-based ExportedGame format in
// gameExport.ts. Instead we capture the current position as a self-describing
// JSON snapshot, and render a still PNG of whatever is on the board right now.
//
// The PNG path reuses the canvas scene renderer that drives the video editor
// (one frame, no slide), so the exported image matches the live board's
// squares, pieces, and Hero/Slime/Juggernaut overlays. Both that renderer and
// its piece-sprite rasterizer pull in react-dom/server, so they're loaded via
// dynamic import() here — keeping them out of the eagerly-bundled Sandbox page
// and only fetched when the user actually clicks Export PNG.

import type { Piece as MergePiece } from './mergeChess';
import type { HeroKind } from './heroChess';
import type { DisplaySnapshot } from './replayView';
import type { SceneModel } from './videoRenderer';
import { APP_VERSION } from './version';

export type SandboxVariant = 'normal' | 'merge' | 'two' | 'cash' | 'hero';

export const SANDBOX_EXPORT_VERSION = 1;

// Full position snapshot — enough to reconstruct the board exactly. Hero-only
// fields (heroes / jugTier / frozen / stunned / masked) are omitted for the
// other variants so a Normal export stays terse.
export type SandboxExport = {
  format: 'voice-chat-chess-sandbox';
  formatVersion: number;
  appVersion: string;
  exportedAt: number;
  variant: SandboxVariant;
  orientation: 'white' | 'black';
  // Flat 64-square board, idx 0 = a8 … 63 = h1 (the layout the engines use).
  board: ({ color: 'w' | 'b'; letter: string } | null)[];
  heroes?: { w: HeroKind; b: HeroKind };
  jugTier?: { w: number; b: number };
  frozenIdxs?: number[];
  stunnedIdxs?: number[];
  maskedIdxs?: number[];
  enPassant?: string | null;
};

export type BuildSandboxExportInput = {
  variant: SandboxVariant;
  orientation: 'white' | 'black';
  board: (MergePiece | null)[];
  heroW: HeroKind;
  heroB: HeroKind;
  jugTierW: number;
  jugTierB: number;
  frozenIdxs: number[];
  stunnedIdxs: number[];
  masked: boolean[];
  enPassant: string | null;
};

export function buildSandboxExport(input: BuildSandboxExportInput): SandboxExport {
  const exp: SandboxExport = {
    format: 'voice-chat-chess-sandbox',
    formatVersion: SANDBOX_EXPORT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    variant: input.variant,
    orientation: input.orientation,
    board: input.board.map((p) => (p ? { color: p.color, letter: p.letter } : null)),
  };
  if (input.variant === 'hero') {
    exp.heroes = { w: input.heroW, b: input.heroB };
    if (input.heroW === 'juggernaut' || input.heroB === 'juggernaut') {
      exp.jugTier = { w: input.jugTierW, b: input.jugTierB };
    }
    if (input.frozenIdxs.length) exp.frozenIdxs = input.frozenIdxs.slice();
    if (input.stunnedIdxs.length) exp.stunnedIdxs = input.stunnedIdxs.slice();
    const maskedIdxs: number[] = [];
    for (let i = 0; i < input.masked.length; i++) if (input.masked[i]) maskedIdxs.push(i);
    if (maskedIdxs.length) exp.maskedIdxs = maskedIdxs;
  }
  if (input.enPassant) exp.enPassant = input.enPassant;
  return exp;
}

export function serializeSandboxExport(exp: SandboxExport): string {
  return JSON.stringify(exp, null, 2);
}

// Trigger a browser download of the position JSON.
export function downloadSandboxJson(exp: SandboxExport): void {
  const blob = new Blob([serializeSandboxExport(exp)], { type: 'application/json' });
  triggerDownload(blob, `${baseName(exp.variant, exp.exportedAt)}.json`);
}

// Render the current board to a PNG and download it. Reuses the video-editor
// scene renderer with a single static frame (no move in flight). The renderer
// + sprite loader are dynamically imported so react-dom/server never lands in
// the main Sandbox chunk.
export async function downloadSandboxPng(opts: {
  snapshot: DisplaySnapshot;
  orientation: 'white' | 'black';
  variant: SandboxVariant;
  // Board edge length in CSS px before the renderer's margin frame. Larger =
  // crisper export; 1024 gives a 128px square, plenty for sharing.
  boardPx?: number;
}): Promise<void> {
  const boardPx = opts.boardPx ?? 1024;
  const [{ renderScene, canvasSize }, { loadAllSprites }] = await Promise.all([
    import('./videoRenderer'),
    import('./pieceSprites'),
  ]);
  // Rasterize the piece SVGs at 1.5× the export square size so they stay crisp
  // (the renderer's default 96px source would upscale on a 1024px board).
  const sprites = await loadAllSprites(Math.round((boardPx / 8) * 1.5));
  const full = canvasSize(boardPx);
  const canvas = document.createElement('canvas');
  canvas.width = full;
  canvas.height = full;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const model: SceneModel = {
    boardPx,
    orientation: opts.orientation,
    frames: [opts.snapshot],
    moveTimes: [],
    slideDurationMs: 1,
    effects: [],
    totalDurationMs: 0,
  };
  renderScene(ctx, model, 0, sprites);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Failed to encode PNG');
  triggerDownload(blob, `${baseName(opts.variant, Date.now())}.png`);
}

// vcc-sandbox-<variant>-YYYYMMDD-HHMM
function baseName(variant: SandboxVariant, at: number): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `vcc-sandbox-${variant}-${stamp}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
