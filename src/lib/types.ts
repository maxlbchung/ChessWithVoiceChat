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
  publicKeyHex: string;
  handle: string;
  rating: number;
};

export type SignedMove = {
  // Move in UCI form, e.g. "e2e4" or "e7e8q"
  uci: string;
  // FEN after the move (used for resync / verification)
  fenAfter: string;
  // Ply number, starting at 1
  ply: number;
  // White's clock ms after this move
  whiteClockMs: number;
  // Black's clock ms after this move
  blackClockMs: number;
  // hex signature by mover's keypair over the canonical move payload
  signature: string;
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
  moves: SignedMove[];
  // signatures by both players over the canonical record-end payload
  whiteSignature: string;
  blackSignature: string;
};

export type LocalGameSummary = {
  gameId: string;
  timeControlId: string;
  opponentHandle: string;
  opponentPubKey: string;
  myColor: Color;
  outcome: GameOutcome;
  reason: GameEndReason;
  ratingBefore: number;
  ratingAfter: number;
  endedAt: number;
};

export type WireMessage =
  | { type: 'hello'; publicKeyHex: string; handle: string; rating: number }
  | { type: 'hero-pick'; hero: 'frost' | 'knight' | 'necromancer' | 'flight' }
  | {
      type: 'lobby-confirm';
      gameId: string;
      iAmWhite: boolean;
      timeControlId: string;
      hostPubKey: string;
      hostHandle: string;
      hostRating: number;
    }
  | { type: 'ready' }
  | { type: 'move'; move: SignedMove }
  | { type: 'resign' }
  | { type: 'draw-offer' }
  | { type: 'draw-accept' }
  | { type: 'draw-decline' }
  | { type: 'timeout-claim'; loserColor: Color }
  | { type: 'chat'; text: string }
  | { type: 'avatar'; dataUrl: string }
  | { type: 'voice-state'; voiceActive: boolean; micOn: boolean };
