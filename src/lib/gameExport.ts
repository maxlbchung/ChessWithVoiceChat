// Game export / import. Captures everything needed to replay a game in the
// Review page: the variant, the time control, both players' info, and the
// move list (UCI strings — already what GameRecord stores). Hero matches add
// the W/B hero kinds so the initial board can be rebuilt.
//
// In-progress exports during a live match leave outcome/reason/endedAt null;
// the Review page treats those as "no final result, replay what you have".

import { Chess } from 'chess.js';
import {
  applyMove as mergeApply,
  initialState as mergeInitial,
  type GameState as MergeState,
  type MoveResult as MergeResult,
} from './mergeChess';
import {
  applyMove as twoApply,
  initialState as twoInitial,
  type GameState as TwoState,
  type MoveResult as TwoResult,
} from './chess2';
import {
  applyMove as cashApply,
  initialState as cashInitial,
  type GameState as CashState,
  type MoveResult as CashResult,
} from './cashChess';
import {
  applyMove as heroApply,
  initialState as heroInitial,
  normalizeHeroKind,
  type GameState as HeroState,
  type MoveResult as HeroResult,
  type HeroKind,
} from './heroChess';
import {
  applyMove as sweeperApply,
  initialState as sweeperInitial,
  minesForGame,
  type GameState as SweeperState,
  type MoveResult as SweeperResult,
} from './sweeperChess';
import {
  applyMove as setupApply,
  initialStateFromStrings as setupInitial,
  parsePlacement as parseSetupPlacement,
  type GameState as SetupState,
  type MoveResult as SetupResult,
} from './setupChess';
import type {
  GameEndReason,
  GameOutcome,
  Move,
  PlayerInfo,
} from './types';
import type { GameVariant } from './timeControls';
import { getTimeControl } from './timeControls';
import { APP_VERSION } from './version';

export const EXPORT_FORMAT_VERSION = 1;

// Exported moves carry only what's needed to replay the game: the UCI string
// (engine input) and each side's post-move clock. `fenAfter` and `ply` from
// the wire-protocol Move are dropped — fenAfter is regenerable by replaying
// UCI through the variant engine, and ply is just (index + 1). Halves the
// JSON size for typical games.
export type ExportedMove = {
  uci: string;
  whiteClockMs: number;
  blackClockMs: number;
};

export type ExportedGame = {
  formatVersion: number;
  app: 'voice-chat-chess';
  appVersion: string;
  exportedAt: number;
  variant: GameVariant;
  gameId: string;
  timeControlId: string;
  white: PlayerInfo;
  black: PlayerInfo;
  startedAt: number;
  // null when the game is still in progress
  endedAt: number | null;
  outcome: GameOutcome | null;
  reason: GameEndReason | null;
  moves: ExportedMove[];
  // Required when variant === 'hero'
  heroes?: { w: HeroKind; b: HeroKind };
  // Hero matches only — per-side back-rank overrides (Twin-Jutsu starts
  // shuffled). Absent means the standard arrangement for both sides.
  heroBackRanks?: { w?: string; b?: string };
  // Required when variant === 'setup' — the two finalized placement strings
  // (setupChess.ts `placementToString`) that rebuild the starting position.
  setupPlacements?: { w: string; b: string };
};

export type BuildExportInput = {
  variant: GameVariant;
  gameId: string;
  timeControlId: string;
  white: PlayerInfo;
  black: PlayerInfo;
  startedAt: number;
  endedAt: number | null;
  outcome: GameOutcome | null;
  reason: GameEndReason | null;
  moves: Move[];
  heroes?: { w: HeroKind; b: HeroKind };
  heroBackRanks?: { w?: string; b?: string };
  setupPlacements?: { w: string; b: string };
};

export function buildGameExport(input: BuildExportInput): ExportedGame {
  const compactMoves: ExportedMove[] = input.moves.map((m) => ({
    uci: m.uci,
    whiteClockMs: m.whiteClockMs,
    blackClockMs: m.blackClockMs,
  }));
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    app: 'voice-chat-chess',
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    variant: input.variant,
    gameId: input.gameId,
    timeControlId: input.timeControlId,
    white: input.white,
    black: input.black,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    outcome: input.outcome,
    reason: input.reason,
    moves: compactMoves,
    ...(input.heroes ? { heroes: input.heroes } : {}),
    ...(input.heroBackRanks && (input.heroBackRanks.w || input.heroBackRanks.b)
      ? { heroBackRanks: input.heroBackRanks }
      : {}),
    ...(input.setupPlacements ? { setupPlacements: input.setupPlacements } : {}),
  };
}

export function serializeExport(exp: ExportedGame): string {
  return JSON.stringify(exp, null, 2);
}

// Trigger a browser download for the export. Filename includes variant +
// short gameId so an export folder is easy to scan.
export function downloadGameExport(exp: ExportedGame): void {
  const json = serializeExport(exp);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFor(exp);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filenameFor(exp: ExportedGame): string {
  const short = exp.gameId.slice(0, 8) || 'game';
  const date = new Date(exp.startedAt || exp.exportedAt);
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `vcc-${exp.variant}-${stamp}-${short}.json`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export class GameImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameImportError';
  }
}

// Parses + validates an exported game. Throws GameImportError with a
// user-readable message on failure (caller surfaces it in the Review UI).
export function parseGameImport(text: string): ExportedGame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GameImportError('That doesn’t look like JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GameImportError('JSON must be an object.');
  }
  const o = raw as Record<string, unknown>;

  const variant = o.variant;
  if (
    variant !== 'normal' && variant !== 'merge' && variant !== 'two' &&
    variant !== 'cash' && variant !== 'hero' && variant !== 'sweeper' &&
    variant !== 'setup'
  ) {
    throw new GameImportError('Missing or unknown variant.');
  }

  if (typeof o.gameId !== 'string') throw new GameImportError('Missing gameId.');
  if (typeof o.timeControlId !== 'string') throw new GameImportError('Missing timeControlId.');
  if (typeof o.startedAt !== 'number') throw new GameImportError('Missing startedAt.');

  const rawMoves = o.moves;
  if (!Array.isArray(rawMoves)) throw new GameImportError('Missing moves array.');
  const moves: ExportedMove[] = [];
  for (let i = 0; i < rawMoves.length; i++) {
    const m = rawMoves[i];
    if (!m || typeof m !== 'object') throw new GameImportError(`Move #${i + 1} is not an object.`);
    const mm = m as Record<string, unknown>;
    if (typeof mm.uci !== 'string') throw new GameImportError(`Move #${i + 1} is missing uci.`);
    // Accept both compact (new) and legacy full-Move exports — drop the extra
    // wire-protocol fields and keep only what replay needs.
    moves.push({
      uci: mm.uci,
      whiteClockMs: typeof mm.whiteClockMs === 'number' ? mm.whiteClockMs : 0,
      blackClockMs: typeof mm.blackClockMs === 'number' ? mm.blackClockMs : 0,
    });
  }

  if (!isPlayerInfo(o.white)) throw new GameImportError('Missing or invalid white player.');
  if (!isPlayerInfo(o.black)) throw new GameImportError('Missing or invalid black player.');

  let heroes: { w: HeroKind; b: HeroKind } | undefined;
  if (variant === 'hero') {
    const h = o.heroes;
    if (!h || typeof h !== 'object') throw new GameImportError('Hero match is missing heroes.');
    const hh = h as Record<string, unknown>;
    // normalizeHeroKind also maps the pre-rename 'twin-jitsu' id forward, so
    // exports from before the Twin-Jutsu rename still import.
    const w = normalizeHeroKind(hh.w);
    const b = normalizeHeroKind(hh.b);
    if (!w || !b) {
      throw new GameImportError('Hero match has unknown hero kind.');
    }
    heroes = { w, b };
  }

  // Optional shuffled-start back ranks (Twin-Jutsu). Reject malformed values
  // outright — replaying on the wrong arrangement would just fail later with
  // a confusing "illegal move" error.
  let heroBackRanks: { w?: string; b?: string } | undefined;
  if (variant === 'hero' && o.heroBackRanks != null) {
    if (typeof o.heroBackRanks !== 'object') throw new GameImportError('Hero match has an invalid starting back rank.');
    const hb = o.heroBackRanks as Record<string, unknown>;
    const w = parseBackRank(hb.w);
    const b = parseBackRank(hb.b);
    if (w || b) heroBackRanks = { w, b };
  }

  // Setup matches can't replay without their placements — reject exports
  // missing or corrupting them rather than failing later with a confusing
  // "illegal move".
  let setupPlacements: { w: string; b: string } | undefined;
  if (variant === 'setup') {
    const sp = o.setupPlacements;
    if (!sp || typeof sp !== 'object') throw new GameImportError('Setup match is missing its placements.');
    const spp = sp as Record<string, unknown>;
    if (
      typeof spp.w !== 'string' || typeof spp.b !== 'string' ||
      !parseSetupPlacement('w', spp.w) || !parseSetupPlacement('b', spp.b)
    ) {
      throw new GameImportError('Setup match has invalid placements.');
    }
    setupPlacements = { w: spp.w, b: spp.b };
  }

  return {
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : 1,
    app: typeof o.app === 'string' ? (o.app as 'voice-chat-chess') : 'voice-chat-chess',
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : '',
    exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : Date.now(),
    variant,
    gameId: o.gameId,
    timeControlId: o.timeControlId,
    white: o.white as PlayerInfo,
    black: o.black as PlayerInfo,
    startedAt: o.startedAt,
    endedAt: typeof o.endedAt === 'number' ? o.endedAt : null,
    outcome: isOutcome(o.outcome) ? o.outcome : null,
    reason: isReason(o.reason) ? o.reason : null,
    moves,
    heroes,
    heroBackRanks,
    setupPlacements,
  };
}

// A stored back rank is 8 of RNBQK with exactly one king. Absent → standard.
function parseBackRank(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string' || !/^[RNBQK]{8}$/.test(v) || v.split('K').length !== 2) {
    throw new GameImportError('Hero match has an invalid starting back rank.');
  }
  return v;
}

function isPlayerInfo(v: unknown): v is PlayerInfo {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.handle === 'string' && typeof o.rating === 'number';
}

function isOutcome(v: unknown): v is GameOutcome {
  return v === 'white' || v === 'black' || v === 'draw';
}

function isReason(v: unknown): v is GameEndReason {
  return (
    v === 'checkmate' || v === 'stalemate' || v === 'threefold' ||
    v === 'insufficient' || v === 'fifty-move' || v === 'resignation' ||
    v === 'timeout' || v === 'draw-agreed' || v === 'disconnect' || v === 'mine' ||
    v === 'king-capture'
  );
}

// ------------------------------------------------------------------
// Replay helpers. Each variant produces a sequence of (state, result) pairs
// indexed 0..moves.length: index 0 is the starting position with no move
// applied, index N is the position after moves[N-1]. The Review page uses
// these to scrub through history.
// ------------------------------------------------------------------

export type ReplayNormal = {
  variant: 'normal';
  // Snapshot Chess instances are mutable; the Review page replays moves on
  // a fresh instance and tracks `viewPly` instead of storing per-ply copies.
  initial: Chess;
  // SAN strings for the move list panel.
  san: string[];
};

export type ReplayMerge = {
  variant: 'merge';
  states: MergeState[];
  results: MergeResult[];
};

export type ReplayTwo = {
  variant: 'two';
  states: TwoState[];
  results: TwoResult[];
};

export type ReplayCash = {
  variant: 'cash';
  states: CashState[];
  results: CashResult[];
};

export type ReplayHero = {
  variant: 'hero';
  states: HeroState[];
  results: HeroResult[];
  heroes: { w: HeroKind; b: HeroKind };
};

export type ReplaySweeper = {
  variant: 'sweeper';
  states: SweeperState[];
  results: SweeperResult[];
};

export type ReplaySetup = {
  variant: 'setup';
  states: SetupState[];
  results: SetupResult[];
};

export type Replay = ReplayNormal | ReplayMerge | ReplayTwo | ReplayCash | ReplayHero | ReplaySweeper | ReplaySetup;

export function buildReplay(exp: ExportedGame): Replay {
  if (exp.variant === 'normal') {
    const chess = new Chess();
    const san: string[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const uci = exp.moves[i].uci;
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length >= 5 ? uci[4] : undefined;
      let mv;
      try {
        mv = chess.move({ from, to, promotion: promotion ?? 'q' });
      } catch {
        throw new GameImportError(`Illegal move at ply ${i + 1} (${uci}).`);
      }
      if (!mv) throw new GameImportError(`Illegal move at ply ${i + 1} (${uci}).`);
      san.push(mv.san);
    }
    // Rewind chess.js back to the start so the Review page can scrub forward.
    while (chess.history().length > 0) chess.undo();
    return { variant: 'normal', initial: chess, san };
  }
  if (exp.variant === 'merge') {
    const states: MergeState[] = [mergeInitial()];
    const results: MergeResult[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const res = mergeApply(states[states.length - 1], exp.moves[i].uci);
      if (!res) throw new GameImportError(`Illegal merge move at ply ${i + 1} (${exp.moves[i].uci}).`);
      states.push(res.state);
      results.push(res.result);
    }
    return { variant: 'merge', states, results };
  }
  if (exp.variant === 'two') {
    const states: TwoState[] = [twoInitial()];
    const results: TwoResult[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const res = twoApply(states[states.length - 1], exp.moves[i].uci);
      if (!res) throw new GameImportError(`Illegal guerrilla move at ply ${i + 1} (${exp.moves[i].uci}).`);
      states.push(res.state);
      results.push(res.result);
    }
    return { variant: 'two', states, results };
  }
  if (exp.variant === 'cash') {
    const states: CashState[] = [cashInitial()];
    const results: CashResult[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const res = cashApply(states[states.length - 1], exp.moves[i].uci);
      if (!res) throw new GameImportError(`Illegal cash move at ply ${i + 1} (${exp.moves[i].uci}).`);
      states.push(res.state);
      results.push(res.result);
    }
    return { variant: 'cash', states, results };
  }
  if (exp.variant === 'sweeper') {
    // The minefield is a pure function of the gameId, so nothing about it
    // needs storing — an exported game rebuilds the same board it was played on.
    const states: SweeperState[] = [sweeperInitial(minesForGame(exp.gameId))];
    const results: SweeperResult[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const res = sweeperApply(states[states.length - 1], exp.moves[i].uci);
      if (!res) throw new GameImportError(`Illegal chesssweeper move at ply ${i + 1} (${exp.moves[i].uci}).`);
      states.push(res.state);
      results.push(res.result);
    }
    return { variant: 'sweeper', states, results };
  }
  if (exp.variant === 'setup') {
    // The starting position is rebuilt from the two stored placement strings
    // (parseGameImport already validated them).
    if (!exp.setupPlacements) throw new GameImportError('Setup match is missing its placements.');
    const states: SetupState[] = [setupInitial(exp.setupPlacements.w, exp.setupPlacements.b)];
    const results: SetupResult[] = [];
    for (let i = 0; i < exp.moves.length; i++) {
      const res = setupApply(states[states.length - 1], exp.moves[i].uci);
      if (!res) throw new GameImportError(`Illegal setup-chess move at ply ${i + 1} (${exp.moves[i].uci}).`);
      states.push(res.state);
      results.push(res.result);
    }
    return { variant: 'setup', states, results };
  }
  if (!exp.heroes) throw new GameImportError('Hero match is missing heroes.');
  // heroBackRanks rebuilds a shuffled Twin-Jutsu start; absent → standard.
  const states: HeroState[] = [heroInitial(exp.heroes.w, exp.heroes.b, exp.heroBackRanks)];
  const results: HeroResult[] = [];
  for (let i = 0; i < exp.moves.length; i++) {
    const res = heroApply(states[states.length - 1], exp.moves[i].uci);
    if (!res) throw new GameImportError(`Illegal hero move at ply ${i + 1} (${exp.moves[i].uci}).`);
    states.push(res.state);
    results.push(res.result);
  }
  return { variant: 'hero', states, results, heroes: exp.heroes };
}

// Convenience: derive the variant from a time-control ID (mirrors the
// dispatch logic in GameRoute) so callers don't have to pull in timeControls.
export function variantOfTimeControl(timeControlId: string): GameVariant {
  return getTimeControl(timeControlId)?.variant ?? 'normal';
}
