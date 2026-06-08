import type { HeroKind } from './heroChess';

export type Color = 'white' | 'black';

export type GameOutcome = 'white' | 'black' | 'draw';

export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'threefold'
  | 'insufficient'
  | 'fifty-move'
  | 'resignation'
  | 'timeout'
  | 'draw-agreed'
  | 'disconnect';

export type PlayerInfo = {
  handle: string;
  rating: number;
};

export type Move = {
  // Move in UCI form, e.g. "e2e4" or "e7e8q"
  uci: string;
  // FEN after the move (used for resync)
  fenAfter: string;
  // Ply number, starting at 1
  ply: number;
  // White's clock ms after this move
  whiteClockMs: number;
  // Black's clock ms after this move
  blackClockMs: number;
};

export type GameRecord = {
  gameId: string;
  timeControlId: string;
  white: PlayerInfo;
  black: PlayerInfo;
  startedAt: number;
  endedAt: number;
  outcome: GameOutcome;
  reason: GameEndReason;
  moves: Move[];
  // Hero matches only — the W/B hero picks, needed to rebuild the starting
  // position when replaying or exporting from local history. Absent on
  // non-hero records and on hero records saved before this field existed.
  heroes?: { w: HeroKind; b: HeroKind };
  // Hero matches only — per-side back-rank overrides (Twin-Jutsu starts
  // shuffled). Absent for games where neither side shuffled and on records
  // from before the shuffle existed; both mean the standard arrangement.
  heroBackRanks?: { w?: string; b?: string };
};

export type LocalGameSummary = {
  gameId: string;
  timeControlId: string;
  opponentHandle: string;
  myColor: Color;
  outcome: GameOutcome;
  reason: GameEndReason;
  ratingBefore: number;
  ratingAfter: number;
  endedAt: number;
};

export type WireMessage =
  | { type: 'hello'; handle: string; rating: number }
  | { type: 'hero-pick'; hero: HeroKind }
  | {
      type: 'lobby-confirm';
      gameId: string;
      iAmWhite: boolean;
      timeControlId: string;
      hostHandle: string;
      hostRating: number;
    }
  | { type: 'ready' }
  | { type: 'move'; move: Move }
  | { type: 'resign' }
  | { type: 'draw-offer' }
  | { type: 'draw-accept' }
  | { type: 'draw-decline' }
  | { type: 'timeout-claim'; loserColor: Color }
  | { type: 'chat'; text: string }
  | { type: 'emoji'; emoji: string }
  | { type: 'avatar'; dataUrl: string }
  | { type: 'voice-state'; voiceActive: boolean; micOn: boolean }
  // Rematch handshake: offerer proposes a fresh gameId for the next game,
  // colors swap from the previous game. Either side may decline; either may
  // re-offer after declining.
  | { type: 'rematch-offer'; gameId: string }
  | { type: 'rematch-accept' }
  | { type: 'rematch-decline' };
