// Data model for the (DEV-only) chess move video editor. An EditProject is the
// full, serializable description of a clip: which game + ply range, how each
// move is timed, what effects sit on the board and when, and which music plays
// under it. This same shape is what gets written to / read from the project
// .json — so it must stay JSON-serializable and must NOT embed audio bytes
// (only a reference + offset; the file is re-attached on load).
import type { ExportedGame } from './gameExport';

export const VIDEO_PROJECT_FORMAT = 1;
export const VIDEO_PROJECT_APP = 'voice-chat-chess-video' as const;

export type GameVariant = ExportedGame['variant'];

// ---- Effects -------------------------------------------------------------

// Per-move animation style. 'normal' = the flat slide; '3d' = the piece spins
// once and arcs up out of frame and back down while moving; 'anticipation' =
// 3d but it hangs at the apex then snaps down to land.
export type MoveType = 'normal' | '3d' | 'anticipation';
export const MOVE_TYPES: MoveType[] = ['normal', '3d', 'anticipation'];
export const MOVE_TYPE_LABEL: Record<MoveType, string> = {
  normal: 'Normal',
  '3d': '3D',
  anticipation: 'Anticipation',
};

export type TokenKind =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder'
  // End-of-game badges (not offered in the move-quality dropdown).
  | 'checkmate'
  | 'draw';
export type EffectKind = 'highlight' | 'token' | 'arrow' | 'emoji';

type BaseEffect = {
  id: string;
  kind: EffectKind;
  startMs: number;
  durationMs: number;
  // Timeline lane this effect sits in. Lanes are display-only (the renderer
  // ignores row); effects pack into rows to avoid overlap and can be dragged
  // between rows. Undefined is treated as row 0.
  row?: number;
  // Optional: the move (ply) this effect was authored against. Purely
  // informational for the editor (e.g. "snap to this move's time"); the
  // renderer keys off startMs/durationMs only.
  anchorPly?: number;
};

export type HighlightEffect = BaseEffect & { kind: 'highlight'; square: string; color: string };
export type TokenEffect = BaseEffect & { kind: 'token'; square: string; token: TokenKind };
export type ArrowEffect = BaseEffect & { kind: 'arrow'; from: string; to: string; color: string };
export type EmojiEffect = BaseEffect & { kind: 'emoji'; square: string; emoji: string };

export type EffectEvent = HighlightEffect | TokenEffect | ArrowEffect | EmojiEffect;

// ---- Music ---------------------------------------------------------------

export type MusicRef = {
  // 'bundled' resolves `url` from the static manifest in videoMusic.ts; 'upload'
  // is re-attached from a local file matching `name` on project load.
  source: 'bundled' | 'upload';
  name: string;
  url?: string;
  // Where in the track playback begins (ms into the song), mapped to clip t=0.
  startOffsetMs: number;
};

// ---- Project -------------------------------------------------------------

export type EditProject = {
  formatVersion: number;
  app: typeof VIDEO_PROJECT_APP;
  createdAt: number;
  gameId: string;
  variant: GameVariant;
  // Inclusive ply range to feature. ply N = the board AFTER move N (1-based);
  // ply 0 = the starting position. The clip opens on board state (startPly-1)
  // and plays moves startPly..endPly.
  range: { startPly: number; endPly: number };
  orientation: 'white' | 'black';
  boardPx: number;
  fps: number;
  slideDurationMs: number;
  // One start time (ms) per move in the range, length = endPly - startPly + 1.
  // moveTimes[k] is when move (startPly + k) begins its slide.
  moveTimes: number[];
  // Animation style per move, aligned with moveTimes. Defaults to all 'normal'.
  moveTypes: MoveType[];
  effects: EffectEvent[];
  music: MusicRef | null;
  totalDurationMs: number;
  // The source game is embedded on save so a project file is self-contained
  // (the board can be rebuilt without separately re-importing the game). Left
  // undefined in memory; set at download time.
  game?: ExportedGame;
};

// ---- Token visuals -------------------------------------------------------

// Single source of truth for the move-quality badges. Used by both the canvas
// renderer (drawToken) and the inspector palette (CSS mirror). Colors chosen to
// echo familiar chess-site conventions without copying any one site exactly.
// The full move-classification set. `fill` is the color used to tint the
// token's square (sampled from each badge); `glyph` is only a fallback for the
// rare case the badge PNG in public/tokens/<kind>.png fails to load.
export const TOKEN_SPECS: Record<
  TokenKind,
  { label: string; fill: string; fg: string; glyph: string }
> = {
  brilliant: { label: 'Brilliant', fill: '#26b6a8', fg: '#ffffff', glyph: '!!' },
  great: { label: 'Great', fill: '#26b6a8', fg: '#ffffff', glyph: '!' },
  best: { label: 'Best', fill: '#8cb84f', fg: '#ffffff', glyph: '★' },
  excellent: { label: 'Excellent', fill: '#96ac82', fg: '#ffffff', glyph: '✓' },
  good: { label: 'Good', fill: '#7fbf4d', fg: '#ffffff', glyph: '✓' },
  book: { label: 'Book', fill: '#a8875f', fg: '#ffffff', glyph: '▤' },
  inaccuracy: { label: 'Inaccuracy', fill: '#f1c150', fg: '#ffffff', glyph: '?!' },
  mistake: { label: 'Mistake', fill: '#e58f2b', fg: '#ffffff', glyph: '?' },
  miss: { label: 'Miss', fill: '#cf4339', fg: '#ffffff', glyph: '✕' },
  blunder: { label: 'Blunder', fill: '#c93a30', fg: '#ffffff', glyph: '??' },
  checkmate: { label: 'Checkmate', fill: '#e0483a', fg: '#ffffff', glyph: '#' },
  draw: { label: 'Draw', fill: '#c8ccd2', fg: '#0c1e2c', glyph: '½' },
};

// Every token (for sprite loading + rendering).
export const ALL_TOKEN_KINDS = Object.keys(TOKEN_SPECS) as TokenKind[];
// Move-quality tokens offered in the Effects dropdown (excludes end-of-game).
export const TOKEN_KINDS: TokenKind[] = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder',
];

// ---- Defaults ------------------------------------------------------------

export const DEFAULT_BOARD_PX = 720;
export const DEFAULT_FPS = 30;
export const DEFAULT_SLIDE_MS = 260; // matches the live board's piece-slide
export const DEFAULT_MOVE_GAP_MS = 700; // spacing between successive moves
export const INTRO_HOLD_MS = 500; // beat on the opening position before move 1
export const OUTRO_HOLD_MS = 1200; // tail after the last move's slide settles
export const DEFAULT_EFFECT_MS = 900; // default duration when adding an effect

export const DEFAULT_HIGHLIGHT_COLOR = '#ffd34d';
export const DEFAULT_ARROW_COLOR = '#ffaa00';

// Evenly-spaced move timings for a clip with `count` moves.
export function defaultMoveTimes(count: number, gapMs = DEFAULT_MOVE_GAP_MS): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(INTRO_HOLD_MS + k * gapMs);
  return out;
}

// Total clip length implied by the move timings (last slide + outro tail).
export function durationForMoveTimes(moveTimes: number[], slideMs = DEFAULT_SLIDE_MS): number {
  const last = moveTimes.length ? moveTimes[moveTimes.length - 1] : 0;
  return Math.round(last + slideMs + OUTRO_HOLD_MS);
}

export function createProject(opts: {
  gameId: string;
  variant: GameVariant;
  totalPly: number;
  startPly?: number;
  endPly?: number;
  orientation?: 'white' | 'black';
}): EditProject {
  const startPly = Math.max(1, opts.startPly ?? 1);
  const endPly = Math.min(opts.totalPly, opts.endPly ?? opts.totalPly);
  const count = Math.max(0, endPly - startPly + 1);
  const moveTimes = defaultMoveTimes(count);
  return {
    formatVersion: VIDEO_PROJECT_FORMAT,
    app: VIDEO_PROJECT_APP,
    createdAt: Date.now(),
    gameId: opts.gameId,
    variant: opts.variant,
    range: { startPly, endPly },
    orientation: opts.orientation ?? 'white',
    boardPx: DEFAULT_BOARD_PX,
    fps: DEFAULT_FPS,
    slideDurationMs: DEFAULT_SLIDE_MS,
    moveTimes,
    moveTypes: new Array(count).fill('normal') as MoveType[],
    effects: [],
    music: null,
    totalDurationMs: durationForMoveTimes(moveTimes),
  };
}

export function newEffectId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return 'fx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ---- Serialize / parse ---------------------------------------------------

export class VideoProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProjectError';
  }
}

export function serializeVideoProject(p: EditProject): string {
  return JSON.stringify(p, null, 2);
}

export function parseVideoProject(text: string): EditProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VideoProjectError('Not valid JSON.');
  }
  if (!raw || typeof raw !== 'object') throw new VideoProjectError('Project must be an object.');
  const o = raw as Record<string, unknown>;
  if (o.app !== VIDEO_PROJECT_APP) {
    throw new VideoProjectError('This file is not a chess video project.');
  }
  if (typeof o.gameId !== 'string') throw new VideoProjectError('Missing gameId.');
  if (!o.range || typeof o.range !== 'object') throw new VideoProjectError('Missing ply range.');
  if (!Array.isArray(o.moveTimes)) throw new VideoProjectError('Missing move timings.');
  if (!Array.isArray(o.effects)) throw new VideoProjectError('Missing effects list.');
  const range = o.range as { startPly?: unknown; endPly?: unknown };
  if (typeof range.startPly !== 'number' || typeof range.endPly !== 'number') {
    throw new VideoProjectError('Ply range is malformed.');
  }
  // Trust the rest of the shape — it's our own format and the editor tolerates
  // missing optional fields by falling back to defaults below.
  const moveTimes = (o.moveTimes as unknown[]).map((n) => Number(n) || 0);
  return {
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : VIDEO_PROJECT_FORMAT,
    app: VIDEO_PROJECT_APP,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    gameId: o.gameId,
    variant: (o.variant as GameVariant) ?? 'normal',
    range: { startPly: range.startPly, endPly: range.endPly },
    orientation: o.orientation === 'black' ? 'black' : 'white',
    boardPx: typeof o.boardPx === 'number' ? o.boardPx : DEFAULT_BOARD_PX,
    fps: typeof o.fps === 'number' ? o.fps : DEFAULT_FPS,
    slideDurationMs: typeof o.slideDurationMs === 'number' ? o.slideDurationMs : DEFAULT_SLIDE_MS,
    moveTimes,
    moveTypes: Array.isArray(o.moveTypes)
      ? (o.moveTypes as MoveType[])
      : (moveTimes.map(() => 'normal') as MoveType[]),
    effects: o.effects as EffectEvent[],
    music: (o.music as MusicRef | null) ?? null,
    totalDurationMs:
      typeof o.totalDurationMs === 'number'
        ? o.totalDurationMs
        : durationForMoveTimes(moveTimes),
    game: o.game as ExportedGame | undefined,
  };
}

export function downloadVideoProject(p: EditProject): void {
  const blob = new Blob([serializeVideoProject(p)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vcc-video-${p.gameId || 'clip'}.vccvid.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
