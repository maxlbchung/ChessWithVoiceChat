// Hero — standard chess but each side picks a "hero king" with a special
// ability. Pieces and king move normally (no castling for simplicity, since
// the king has its own special moves). Abilities use a turn and recharge on
// a per-hero cooldown.
//
// Heroes:
//   Frost       — Freeze any non-king piece for the opponent's next move
//                 (immune to capture AND can't move).        cooldown: 5 turns
//   Knight      — Destroy one enemy piece adjacent to your king,
//                 your king does not move.                   cooldown: 10 turns
//   Necromancer — Spawn an own pawn on an empty square adjacent
//                 to your king.                              cooldown: 10 turns
//   Flight      — Fly any of your pieces to any unoccupied
//                 square (pawns promote on the back rank).   cooldown: 5 turns
//
// Ability moves piggy-back on the existing signed-move pipeline by using
// pseudo-UCI strings:
//   !F<sq>            — Frost freeze
//   !K<sq>            — Knight destroy
//   !N<sq>            — Necromancer spawn
//   !L<from><to>[<p>] — Flight teleport (optional promotion letter)
//   !S<from><to>      — Slime expand (mini king at <from> grows into the 2×2
//                       quadrant whose far corner is <to>)
//   !J<sq>            — Juggernaut ability (tier-dependent: convert an
//                       adjacent enemy / quake-leap to <sq> / rampage to the
//                       rank edge at <sq>)

export type C2Color = 'w' | 'b';

// A/C/Z are the merge-chess fused glyphs used by Mutation hero outputs:
//   A = bishop + knight, C = rook + knight, Z = queen + knight.
// S is a Slime big-king tile — one square of a 2×2 blob king. The four tiles
// of a blob are grouped in GameState.slimes.
export type PieceLetter =
  | 'P' | 'K' | 'R' | 'B' | 'N' | 'Q' | 'A' | 'C' | 'Z' | 'S'
  | 'p' | 'k' | 'r' | 'b' | 'n' | 'q' | 'a' | 'c' | 'z' | 's';

export type Piece = { color: C2Color; letter: PieceLetter };
export type Square = string;

export type HeroKind = 'frost' | 'warlord' | 'necromancer' | 'flight' | 'harem' | 'mutation' | 'icbm' | 'goofball' | 'twin-jutsu' | 'slime' | 'juggernaut';
export const HERO_KINDS: HeroKind[] = ['frost', 'warlord', 'necromancer', 'flight', 'harem', 'mutation', 'icbm', 'goofball', 'twin-jutsu', 'slime', 'juggernaut'];

// 'twin-jutsu' was misspelled 'twin-jitsu' before the rename. Old saved
// records, exported JSON files, and stale peers can still carry the old id —
// run anything from those boundaries through here. Returns null for values
// that aren't a hero kind at all.
export function normalizeHeroKind(v: unknown): HeroKind | null {
  if (v === 'twin-jitsu') return 'twin-jutsu';
  return typeof v === 'string' && (HERO_KINDS as string[]).includes(v) ? (v as HeroKind) : null;
}

// Online matches present a randomized subset of size POOL_SIZE so the roster
// stays fresh. Free-play / sandbox use the full HERO_KINDS list.
export const ONLINE_POOL_SIZE = 4;

// FNV-1a 32-bit string hash -> Mulberry32 PRNG. Kept as the single seeded
// randomness path for online hero pools and Twin-Jutsu back-rank shuffles.
function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const rand = seededRandom(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deterministic per-game pool: both players hash the shared gameId to the
// same seed, so a Fisher-Yates shuffle picks identical heroes on both ends.
export function heroPoolForGame(gameId: string, size: number = ONLINE_POOL_SIZE): HeroKind[] {
  if (size >= HERO_KINDS.length) return HERO_KINDS.slice();
  const arr = seededShuffle(HERO_KINDS, gameId);
  return arr.slice(0, size);
}

// Twin-Jutsu starts with a shuffled back rank: with every piece masked as a
// king, the standard arrangement would give each piece's identity away by its
// starting square. Deterministic from the seed — online play hashes the
// shared gameId so both peers build the same board; local play passes a
// fresh random seed. Bishops are re-rolled onto opposite square colors,
// Chess960-style. A shuffled side loses castling (see initialState).
export function shuffledBackRank(seed: string): string {
  const rand = seededRandom(seed);
  const arr = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  // Re-shuffle until the bishops sit on opposite square colors. The PRNG
  // stream continues across attempts, so the result stays deterministic
  // per seed.
  do {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } while (arr.indexOf('B') % 2 === arr.lastIndexOf('B') % 2);
  return arr.join('');
}

// Per-side back-rank overrides for initialState. Online hero games derive
// these from the shared gameId; finished games persist them on the record so
// replays rebuild the same start — old records without the field replay on
// the standard arrangement.
export type BackRanks = { w?: string; b?: string };

// Back ranks for a fresh game: generate one Twin-Jutsu rank from the same
// game-level seed both players use for the hero pool. If both sides pick
// Twin-Jutsu, they receive the same arrangement.
export function backRanksForGame(heroW: HeroKind, heroB: HeroKind, seed: string): BackRanks {
  const rank = heroW === 'twin-jutsu' || heroB === 'twin-jutsu'
    ? shuffledBackRank(seed)
    : undefined;
  return {
    w: heroW === 'twin-jutsu' ? rank : undefined,
    b: heroB === 'twin-jutsu' ? rank : undefined,
  };
}

export type HeroInfo = {
  kind: HeroKind;
  name: string;
  blurb: string;
  // Hex colour used for the king's glow.
  glowColor: string;
  // Cooldown in *turns*. A "turn" is one of your own moves; we convert to
  // plies internally by multiplying by 2. `null` = one-shot ability.
  cooldownTurns: number | null;
  // Optional warmup before the ability can first be used (in turns). Heroes
  // without this start usable on turn 1. ICBM uses this to model arming.
  initialCooldownTurns?: number;
};

export const HERO_INFO: Record<HeroKind, HeroInfo> = {
  frost: {
    kind: 'frost',
    name: 'Frost',
    blurb: 'Freeze a piece for two of the opponent’s moves — can’t be captured or moved.',
    glowColor: '#2b6fb0',
    cooldownTurns: 2,
  },
  warlord: {
    kind: 'warlord',
    name: 'Warlord',
    blurb: 'Destroy an enemy piece adjacent to your king without moving. Starts with an extra row of pawns but no queen.',
    glowColor: '#c41e1e',
    cooldownTurns: 1,
  },
  necromancer: {
    kind: 'necromancer',
    name: 'Necromancer',
    blurb: 'Spawn a pawn on an empty square next to your king.',
    glowColor: '#9b4dca',
    cooldownTurns: 3,
  },
  flight: {
    kind: 'flight',
    name: 'Flight',
    blurb: 'Fly one of your pieces to any empty square. Pawns landing on the back rank promote.',
    glowColor: '#87ceeb',
    cooldownTurns: 5,
  },
  harem: {
    kind: 'harem',
    name: 'Harem',
    // Passive — no active ability. Cooldown shown as "passive" in the picker.
    blurb: 'No active ability. Your bishops and rooks start as queens.',
    glowColor: '#ff4fa3',
    cooldownTurns: null,
  },
  mutation: {
    kind: 'mutation',
    name: 'Mutation',
    blurb: 'Mutate a bishop / rook / queen to also move like a knight. Promotions can fuse with a knight too.',
    glowColor: '#1f7a44',
    cooldownTurns: 5,
  },
  icbm: {
    kind: 'icbm',
    name: 'ICBM',
    blurb: 'Launch a missile at any square. Lands 5 plies later — demolishes whatever is there. Frost can’t stop it.',
    glowColor: '#ff6a00',
    // 5-turn arming (warming) period before the first launch, then a short
    // 1-turn cooldown between launches.
    cooldownTurns: 1,
    initialCooldownTurns: 5,
  },
  goofball: {
    kind: 'goofball',
    name: 'Goofball',
    blurb: 'Make a legal move for your opponent on their behalf.',
    glowColor: '#f7d000',
    cooldownTurns: 0,
  },
  'twin-jutsu': {
    kind: 'twin-jutsu',
    name: 'Twin-Jutsu',
    blurb: 'All your pieces look like kings to the opponent until they move, and your back rank starts shuffled (no castling). Active swap shuffles two of your pieces and re-masks both.',
    glowColor: '#000000',
    cooldownTurns: 3,
  },
  slime: {
    kind: 'slime',
    name: 'Slime',
    blurb: 'Starts with normal pieces. Active: grow your king into a giant 2×2 king that slides one square, crushing what it lands on. Capturing one of its tiles splits it into three mini kings — you can’t be checked until a single king remains. Active: grow a mini king back into a big king.',
    glowColor: '#7ed957',
    cooldownTurns: 5,
  },
  juggernaut: {
    kind: 'juggernaut',
    name: 'Juggernaut',
    blurb: 'Fields only a lone colorless king with three lives. Capturing it kills the attacker and only enrages it — it tiers up, swapping its active ability each time, and it can’t be checked until tier 3, where the next hit finally fells it. Walks one square in any direction at every tier; the tier abilities carry the reach.',
    glowColor: '#b08d57',
    cooldownTurns: 3,
  },
};

// Per-tier Juggernaut kit — movement passive + active ability. Indexed by
// GameState.jugTier (1-3). The picker/abilities panel renders these so the
// player always sees what their current tier does.
export const JUG_TIER_INFO: Record<number, { name: string; move: string; blurb: string }> = {
  1: { name: 'Earthquake',      move: 'moves like a king', blurb: 'Spawn a quake on an adjacent square — it creeps one tile every time you walk the Juggernaut, all the way to the edge, killing every enemy in its path. Quake tiles are impassable terrain: sliders, pawns and kings can\'t cross them and nothing lands on them. Only knights can jump over.' },
  2: { name: 'Edge Charge',     move: 'moves like a king', blurb: 'Charge in any queen direction to the board edge, destroying everything in the path.' },
  3: { name: 'Slam',            move: 'moves like a king', blurb: 'Jump in place — destroy every piece within one tile and stun every non-king piece at exactly two tiles.' },
};

export type AbilitySide = {
  hero: HeroKind;
  // Ply at which this side's ability becomes available again (0 = ready).
  cooldownUntilPly: number;
  // Legacy one-shot-Flight flag. Flight is cooldown-based now, but the field
  // stays (always false) because it rides the serialized position key.
  flightUsed: boolean;
};

export type GameState = {
  board: (Piece | null)[];
  turn: C2Color;
  // Per-side castling rights. False once that side's king or that wing's
  // rook has moved (or been captured).
  castling: { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean };
  enPassant: Square | null;
  halfmove: number;
  fullmove: number;
  // Total plies played from the start position.
  ply: number;
  positionHistory: string[];
  heroes: { w: AbilitySide; b: AbilitySide };
  // Currently-frozen pieces. Each entry tracks one piece and clears
  // once `ply` reaches its `expiresAtPly`. Multiple freezes can coexist
  // — e.g. white freezes a black piece, then black freezes a white piece
  // while the first is still locked.
  frozen: { idx: number; expiresAtPly: number }[];
  // Queued ICBM strikes — both sides see them. Each fires (and is removed)
  // when state.ply reaches landsAtPly. Multiple may be in flight at once.
  missiles: Missile[];
  // Twin-Jutsu mask flags per board square. True iff the piece on that square
  // is hidden from the opponent (rendered as a king icon on the opponent's
  // screen). Set at game start for every piece of a Twin-Jutsu side; cleared
  // when a piece moves off / arrives on a square; re-set on both endpoints of
  // a Twin-Jutsu swap. Empty for games where neither side is Twin-Jutsu.
  masked: boolean[];
  // Slime big kings — each entry groups the four board squares (holding 'S'
  // tiles) that form one 2×2 blob. Tile colour comes from the board pieces.
  // A side can field several blobs at once (split, then expand two minis).
  slimes: SlimeGroup[];
  // Juggernaut tier per side (1-3). Only meaningful while that side's hero is
  // 'juggernaut'; stays at 1 otherwise. Rises when an enemy spends a piece
  // capturing the Juggernaut (the attacker dies, the Juggernaut powers up).
  jugTier: { w: number; b: number };
  // Stunned pieces (Juggernaut slam). Like frozen but capturable: a stunned
  // piece can't move and doesn't attack, but CAN be taken.
  stunned: { idx: number; expiresAtPly: number }[];
  // Travelling earthquakes (Juggernaut tier-1 ability). Each one creeps one
  // tile per ply in the direction it was launched, killing the first enemy
  // it lands on and dissipating at the board edge.
  earthquakes: Earthquake[];
};

export type SlimeGroup = { tiles: number[] };

export type Earthquake = {
  idx: number;
  df: number;
  dr: number;
  // Side that spawned the wave — its own pieces ride it out untouched.
  color: C2Color;
  // Ply on which the wave was spawned; it sits still until ply advances
  // past this value so its first move feels like "next turn".
  spawnedAtPly: number;
};

export type Missile = {
  idx: number;
  landsAtPly: number;
  firedBy: C2Color;
};

export type MoveResult = {
  uci: string;
  fenAfter: string;
  captured: boolean;
  // True when the move was a castle (king + rook in one move).
  castled: boolean;
  // Which ability was used, if any. null for normal moves.
  abilityUsed: HeroKind | null;
  check: boolean;
  checkmate: boolean;
  stalemate: boolean;
  // Set when an ICBM landing demolished a king on this move. The named color
  // is the LOSER (their king was destroyed). HeroGame treats this as a
  // checkmate-style end.
  kingDestroyed?: C2Color | null;
  // Slime blobs that split on this move (a tile was captured / blasted /
  // crushed). `tiles` are the squares that were destroyed; `minis` are the
  // squares where the surviving tiles regrouped as mini kings. Drives the
  // split animation + SFX.
  slimeSplits?: { tiles: Square[]; minis: Square[] }[];
  // True when the side now to move is a sub-tier-3 Juggernaut that WOULD be
  // in check under normal rules. The Juggernaut is immune (check=false), but
  // the idea calls for the check sound to still play as a flavor cue.
  jugPhantomCheck?: boolean;
};

// True if `idx` currently has an active freeze entry that hasn't expired.
// Centralised so the array-vs-single representation doesn't leak everywhere.
export function isFrozen(state: GameState, idx: number): boolean {
  for (const f of state.frozen) {
    if (f.idx === idx && state.ply < f.expiresAtPly) return true;
  }
  return false;
}

// True if `idx` currently has an active stun entry (Juggernaut quake leap).
// Stunned pieces can't move and don't attack, but remain capturable.
export function isStunned(state: GameState, idx: number): boolean {
  for (const s of state.stunned) {
    if (s.idx === idx && state.ply < s.expiresAtPly) return true;
  }
  return false;
}

// Tier of the Juggernaut king sitting on `idx`, or 0 if the square doesn't
// hold a Juggernaut (not a king, or its side didn't pick the hero).
function jugTierAt(state: GameState, idx: number): number {
  const p = state.board[idx];
  if (!p || p.letter.toUpperCase() !== 'K') return 0;
  if (state.heroes[p.color].hero !== 'juggernaut') return 0;
  return state.jugTier[p.color];
}

// Current Juggernaut tier for `color`, or 0 when that side isn't playing
// the Juggernaut. Exported for the UI (tier pips, panel labels, SFX cues).
export function jugTierOf(state: GameState, color: C2Color): number {
  return state.heroes[color].hero === 'juggernaut' ? state.jugTier[color] : 0;
}

// Locate the king of `color` on a given board. Returns null if missing
// (shouldn't happen during legal play but kept defensive). Used by ability
// animations to know where the king is (Flight from-square, Knight pivot)
// and by HeroGame's end-of-game check (a Slime side counts its big-king
// tiles as king material, so the first 'S' tile qualifies too).
export function kingSquareOf(board: (Piece | null)[], color: C2Color): Square | null {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== color) continue;
    const up = p.letter.toUpperCase();
    if (up === 'K' || up === 'S') return idxToSq(i);
  }
  return null;
}

// ------------------------------------------------------------------
// Square <-> index helpers
// ------------------------------------------------------------------
export function sqToIdx(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  return (7 - rank) * 8 + file;
}
export function idxToSq(idx: number): Square {
  const file = idx % 8;
  const rankFromTop = Math.floor(idx / 8);
  const rank = 7 - rankFromTop;
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}
function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}
function idxFR(file: number, rank: number): number {
  return (7 - rank) * 8 + file;
}
function frOfIdx(idx: number): [number, number] {
  const file = idx % 8;
  const rank = 7 - Math.floor(idx / 8);
  return [file, rank];
}

const ROOK_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const EIGHT_DIRS: [number, number][] = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_OFFSETS: [number, number][] = [
  [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
];

// ------------------------------------------------------------------
// Initial position — standard chess. Heroes are picked outside the engine and
// passed in.
// ------------------------------------------------------------------
export function initialState(heroW: HeroKind, heroB: HeroKind, backRanks?: BackRanks): GameState {
  const board: (Piece | null)[] = new Array(64).fill(null);
  // Harem swaps every R and B on that side's back rank for queens. Castling
  // is impossible for a Harem side anyway (no rook on a/h), so we drop the
  // castling rights below to keep state honest.
  // Mutation swaps both knights for bishops — the hero ability can then turn
  // those bishops back into knight-movement-fused pieces over the game.
  // Warlord drops the queen (the slot is empty) and gets an extra rank of
  // pawns in front of the existing pawn line.
  const standardBackRank: (PieceLetter | null)[] = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  const haremBackRank: (PieceLetter | null)[]    = ['Q', 'N', 'Q', 'Q', 'K', 'Q', 'N', 'Q'];
  const mutationBackRank: (PieceLetter | null)[] = ['R', 'B', 'B', 'Q', 'K', 'B', 'B', 'R'];
  const warlordBackRank: (PieceLetter | null)[]  = ['R', 'N', 'B', null, 'K', 'B', 'N', 'R'];
  // Juggernaut fields ONLY its king — no pawns either (cleared below).
  const jugBackRank: (PieceLetter | null)[]      = [null, null, null, null, 'K', null, null, null];
  const backRankFor = (hero: HeroKind): (PieceLetter | null)[] => {
    if (hero === 'harem') return haremBackRank;
    if (hero === 'mutation') return mutationBackRank;
    if (hero === 'warlord') return warlordBackRank;
    if (hero === 'juggernaut') return jugBackRank;
    return standardBackRank;
  };
  // A caller-supplied back rank (Twin-Jutsu shuffle) overrides the hero's
  // standard arrangement for that side.
  const whiteBack = backRanks?.w ? (backRanks.w.split('') as PieceLetter[]) : backRankFor(heroW);
  const blackBack = backRanks?.b ? (backRanks.b.split('') as PieceLetter[]) : backRankFor(heroB);
  for (let f = 0; f < 8; f++) {
    const bp = blackBack[f];
    if (bp != null) board[idxFR(f, 7)] = { color: 'b', letter: bp.toLowerCase() as PieceLetter };
    board[idxFR(f, 6)] = { color: 'b', letter: 'p' };
    board[idxFR(f, 1)] = { color: 'w', letter: 'P' };
    const wp = whiteBack[f];
    if (wp != null) board[idxFR(f, 0)] = { color: 'w', letter: wp };
  }
  // Warlord's extra rank of pawns: one row in front of the standard pawn line
  // on each side that chose Warlord (rank 2 for white, rank 5 for black).
  if (heroW === 'warlord') {
    for (let f = 0; f < 8; f++) board[idxFR(f, 2)] = { color: 'w', letter: 'P' };
  }
  if (heroB === 'warlord') {
    for (let f = 0; f < 8; f++) board[idxFR(f, 5)] = { color: 'b', letter: 'p' };
  }
  // Slime starts with a standard back rank and king — the player grows the
  // king into a 2×2 blob via the active ability.
  const startSlimes: SlimeGroup[] = [];
  // Juggernaut: a lone king and nothing else — clear that side's pawn line
  // (the back rank is already empty apart from the king).
  if (heroW === 'juggernaut') {
    for (let f = 0; f < 8; f++) board[idxFR(f, 1)] = null;
  }
  if (heroB === 'juggernaut') {
    for (let f = 0; f < 8; f++) board[idxFR(f, 6)] = null;
  }
  // A side on a non-standard back rank (Harem's all-queens row, a Twin-Jutsu
  // shuffle, or Juggernaut's empty rank) can't castle — its king/rooks aren't
  // on the squares the castling rules assume. Old replays without an override
  // keep their standard rank, so their castling moves stay legal.
  const wStandard = !backRanks?.w || backRanks.w === 'RNBQKBNR';
  const bStandard = !backRanks?.b || backRanks.b === 'RNBQKBNR';
  const wCastles = heroW !== 'harem' && heroW !== 'juggernaut' && wStandard;
  const bCastles = heroB !== 'harem' && heroB !== 'juggernaut' && bStandard;
  const state: GameState = {
    board,
    turn: 'w',
    castling: {
      wK: wCastles, wQ: wCastles,
      bK: bCastles, bQ: bCastles,
    },
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    ply: 0,
    positionHistory: [],
    heroes: {
      // Apply each hero's `initialCooldownTurns` warmup (in plies) so abilities
      // that need to arm — e.g. ICBM — aren't fireable from move 1.
      w: { hero: heroW, cooldownUntilPly: (HERO_INFO[heroW].initialCooldownTurns ?? 0) * 2, flightUsed: false },
      b: { hero: heroB, cooldownUntilPly: (HERO_INFO[heroB].initialCooldownTurns ?? 0) * 2, flightUsed: false },
    },
    frozen: [],
    missiles: [],
    masked: new Array(64).fill(false),
    slimes: startSlimes,
    jugTier: { w: 1, b: 1 },
    stunned: [],
    earthquakes: [],
  };
  // Twin-Jutsu: mask every piece of that side at game-start. Pieces unmask
  // when they move (or are captured); the swap ability re-masks both endpoints.
  if (heroW === 'twin-jutsu') {
    for (let i = 0; i < 64; i++) if (board[i]?.color === 'w') state.masked[i] = true;
  }
  if (heroB === 'twin-jutsu') {
    for (let i = 0; i < 64; i++) if (board[i]?.color === 'b') state.masked[i] = true;
  }
  state.positionHistory.push(positionKey(state));
  return state;
}

// True if `color` still has any king material — a normal/mini king OR a
// Slime big-king tile. "Out of kings" is what loses a Slime side, since its
// individual kings are capturable while it has more than one.
function hasAnyKingSquare(state: GameState, color: C2Color): boolean {
  for (const p of state.board) {
    if (!p || p.color !== color) continue;
    const up = p.letter.toUpperCase();
    if (up === 'K' || up === 'S') return true;
  }
  return false;
}

// A Slime big-king tile at `capturedIdx` was just captured / blasted /
// crushed: the blob's surviving tiles regroup as mini kings and the group
// dissolves. Mutates `next` in place. Sequential multi-tile damage works
// naturally — the first hit splits the group (survivors become 'K' minis),
// so a second hit in the same event captures a plain mini.
function splitSlimeGroupAt(next: GameState, capturedIdx: number) {
  const gi = next.slimes.findIndex((g) => g.tiles.includes(capturedIdx));
  if (gi === -1) return;
  const group = next.slimes[gi];
  for (const tIdx of group.tiles) {
    if (tIdx === capturedIdx) continue;
    const p = next.board[tIdx];
    if (p && p.letter.toUpperCase() === 'S') {
      next.board[tIdx] = { color: p.color, letter: p.color === 'w' ? 'K' : 'k' };
    }
  }
  next.slimes = next.slimes.filter((_, i) => i !== gi);
}

// Detonate any missile whose landing ply has arrived. Mutates `next` in
// place: removes detonated missiles from next.missiles, clears the target
// square (Frost provides no protection — explosions bypass it), and reports
// whether a side lost its last king material.
function processMissileLandings(next: GameState): { kingDestroyed: C2Color | null } {
  if (next.missiles.length === 0) return { kingDestroyed: null };
  const hadW = hasAnyKingSquare(next, 'w');
  const hadB = hasAnyKingSquare(next, 'b');
  const surviving: Missile[] = [];
  for (const m of next.missiles) {
    if (next.ply >= m.landsAtPly) {
      const target = next.board[m.idx];
      // A sub-tier-3 Juggernaut shrugs the blast off — and gets ANGRIER.
      // The missile is spent (counts as a capture attempt: tier +1) but the
      // square is not cleared. At tier 3 the blast kills it like any king.
      const jt = jugTierAt(next, m.idx);
      if (jt >= 1 && jt < 3) {
        next.jugTier[target!.color] = jt + 1;
        continue;
      }
      // A blasted big-king tile splits the blob just like a capture would.
      if (target && target.letter.toUpperCase() === 'S') {
        splitSlimeGroupAt(next, m.idx);
      }
      next.board[m.idx] = null;
      // Also clear any freeze / stun on the impacted square — the piece is
      // gone, the reference would be a dangling index otherwise.
      next.frozen = next.frozen.filter((f) => f.idx !== m.idx);
      next.stunned = next.stunned.filter((s) => s.idx !== m.idx);
      // Mask flag on a now-empty square is meaningless; clear it.
      if (next.masked) next.masked[m.idx] = false;
    } else {
      surviving.push(m);
    }
  }
  next.missiles = surviving;
  // Only losing the LAST king square counts as destruction — a Slime side
  // shrugs off losing one king of many (and a blasted blob tile just splits).
  let kingDestroyed: C2Color | null = null;
  if (hadW && !hasAnyKingSquare(next, 'w')) kingDestroyed = 'w';
  else if (hadB && !hasAnyKingSquare(next, 'b')) kingDestroyed = 'b';
  return { kingDestroyed };
}

// Advance every live earthquake one tile in its direction — but ONLY for
// waves whose owner just moved their Juggernaut. The wave is the Jug's
// quake; it pulses one tile each time the Jug stomps. Waves owned by a
// side that didn't move their Jug this ply just sit still.
//
// Waves dissipate only at the board edge — enemy pieces in the path die
// but the wave keeps rolling. Friendly pieces ride out untouched. A sub-
// tier-3 Juggernaut absorbs the wave (tiers up and the wave dies, same
// as an ICBM hit). Newly-spawned waves sit still on the ply they were
// created — their first move happens on the next jug move.
function processEarthquakes(
  next: GameState,
  advanceColor: C2Color | null,
): { kingDestroyed: C2Color | null } {
  if (next.earthquakes.length === 0) return { kingDestroyed: null };
  const hadW = hasAnyKingSquare(next, 'w');
  const hadB = hasAnyKingSquare(next, 'b');
  const surviving: Earthquake[] = [];
  for (const eq of next.earthquakes) {
    // Wave only advances when its owner's Juggernaut just moved.
    if (eq.color !== advanceColor) {
      surviving.push(eq);
      continue;
    }
    if (eq.spawnedAtPly >= next.ply) {
      surviving.push(eq);
      continue;
    }
    const [f, r] = frOfIdx(eq.idx);
    const nf = f + eq.df, nr = r + eq.dr;
    if (!onBoard(nf, nr)) continue;
    const newIdx = idxFR(nf, nr);
    const victim = next.board[newIdx];
    let absorbed = false;
    if (victim && victim.color !== eq.color) {
      const jt = jugTierAt(next, newIdx);
      if (jt >= 1 && jt < 3) {
        // Sub-tier-3 Juggernaut absorbs the wave — wave dies, jug tiers up.
        next.jugTier[victim.color] = jt + 1;
        absorbed = true;
      } else {
        const up = victim.letter.toUpperCase();
        if (up === 'S') splitSlimeGroupAt(next, newIdx);
        next.board[newIdx] = null;
        next.frozen = next.frozen.filter((fz) => fz.idx !== newIdx);
        next.stunned = next.stunned.filter((s) => s.idx !== newIdx);
        if (newIdx === 56) next.castling.wQ = false;
        if (newIdx === 63) next.castling.wK = false;
        if (newIdx === 0)  next.castling.bQ = false;
        if (newIdx === 7)  next.castling.bK = false;
        if (next.masked) next.masked[newIdx] = false;
      }
    }
    if (absorbed) continue;
    surviving.push({ ...eq, idx: newIdx });
  }
  next.earthquakes = surviving;
  let kingDestroyed: C2Color | null = null;
  if (hadW && !hasAnyKingSquare(next, 'w')) kingDestroyed = 'w';
  else if (hadB && !hasAnyKingSquare(next, 'b')) kingDestroyed = 'b';
  return { kingDestroyed };
}

// ------------------------------------------------------------------
// Pseudo-move generation (standard chess; no castling)
// ------------------------------------------------------------------
// Mutation hero adds Z/C/A as promotion options (Q+N, R+N, B+N — fused with
// knight movement). At apply time these decompose to the base letter plus the
// mutated flag.
type PromoLetter = 'Q' | 'R' | 'B' | 'N' | 'Z' | 'C' | 'A';

type PseudoMove = {
  from: number;
  to: number;
  promotion?: PromoLetter;
  enPassantCapture?: boolean;
  doublePawn?: boolean;
  // Castling side, when this move is a castle. The rook from the matching
  // corner gets swung to the square the king crossed.
  castle?: 'K' | 'Q';
  // Slime big-king shift: the whole 2×2 blob containing `from` slides one
  // square in the from→to direction. slimeCrushes lists the enemy-occupied
  // squares the blob lands on (destroyed by the shift) so capture flags
  // survive the uci round-trip.
  slimeShift?: boolean;
  slimeCrushes?: number[];
};

function pseudoMoves(state: GameState, from: number): PseudoMove[] {
  const p = state.board[from];
  if (!p) return [];
  // Frozen and stunned pieces can't move.
  if (isFrozen(state, from)) return [];
  if (isStunned(state, from)) return [];
  const out: PseudoMove[] = [];
  const [ff, fr] = frOfIdx(from);
  const up = p.letter.toUpperCase();
  if (up === 'P') pseudoPawn(state, from, ff, fr, p, out);
  else if (up === 'K') {
    // Juggernaut passive: the king walks one square at all tiers. The
    // tier abilities (Earthquake, Edge Charge, Slam) carry the
    // extra reach. A Juggernaut side has no castling rights, so
    // pseudoKing's castle block stays dormant.
    pseudoKing(state, from, ff, fr, p, out);
  }
  // Slime big-king tile — shifts the whole 2×2 blob one square.
  else if (up === 'S') pseudoSlimeShift(state, from, ff, fr, p, out);
  else if (up === 'Q') pseudoSliding(state, from, ff, fr, p, EIGHT_DIRS, out);
  else if (up === 'B') pseudoSliding(state, from, ff, fr, p, BISHOP_DIRS, out);
  else if (up === 'R') pseudoSliding(state, from, ff, fr, p, ROOK_DIRS, out);
  else if (up === 'N') pseudoKnight(state, from, ff, fr, p, out);
  // Mutation hero outputs: A = bishop+knight, C = rook+knight, Z = queen+knight.
  else if (up === 'A') { pseudoSliding(state, from, ff, fr, p, BISHOP_DIRS, out); pseudoKnight(state, from, ff, fr, p, out); }
  else if (up === 'C') { pseudoSliding(state, from, ff, fr, p, ROOK_DIRS, out); pseudoKnight(state, from, ff, fr, p, out); }
  else if (up === 'Z') { pseudoSliding(state, from, ff, fr, p, EIGHT_DIRS, out); pseudoKnight(state, from, ff, fr, p, out); }
  // Frozen pieces (own or enemy) cannot be captured.
  if (state.frozen.length > 0) {
    return out.filter((m) => !isFrozen(state, m.to));
  }
  return out;
}

function pseudoKing(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  for (const [df, dr] of EIGHT_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
  // Castling. Only emitted from the original king square (e1/e8), only with
  // the appropriate right still standing, only when the squares between are
  // empty AND none of the king's transit squares (start / pass-through /
  // landing) are attacked. A frozen rook can't castle either.
  const isWhite = p.color === 'w';
  const homeKingIdx = isWhite ? 60 : 4;            // e1 or e8
  if (from !== homeKingIdx) return;
  const enemy: C2Color = isWhite ? 'b' : 'w';
  const kRook = isWhite ? 63 : 7;                  // h1 or h8
  const qRook = isWhite ? 56 : 0;                  // a1 or a8
  const kRight = isWhite ? s.castling.wK : s.castling.bK;
  const qRight = isWhite ? s.castling.wQ : s.castling.bQ;

  const tryCastle = (rookIdx: number, betweenIdxs: number[], transitIdxs: number[], landIdx: number, side: 'K' | 'Q') => {
    if (isFrozen(s, rookIdx)) return;
    const rook = s.board[rookIdx];
    if (!rook || rook.color !== p.color || rook.letter.toUpperCase() !== 'R') return;
    for (const idx of betweenIdxs) if (s.board[idx] != null) return;
    if (isSquareAttacked(s, homeKingIdx, enemy)) return;
    for (const idx of transitIdxs) if (isSquareAttacked(s, idx, enemy)) return;
    out.push({ from: homeKingIdx, to: landIdx, castle: side });
  };
  if (kRight) {
    // Kingside: between = f1/f8, g1/g8; king transit = f, g; land = g.
    const fSq = isWhite ? 61 : 5;
    const gSq = isWhite ? 62 : 6;
    tryCastle(kRook, [fSq, gSq], [fSq, gSq], gSq, 'K');
  }
  if (qRight) {
    // Queenside: between = d, c, b; king transit = d, c; land = c.
    const dSq = isWhite ? 59 : 3;
    const cSq = isWhite ? 58 : 2;
    const bSq = isWhite ? 57 : 1;
    tryCastle(qRook, [dSq, cSq, bSq], [dSq, cSq], cSq, 'Q');
  }
}

// Can the blob `group` legally shift one square by (df, dr)? Every shifted
// tile must stay on the board and land on an empty square, another tile of
// the same blob, or a crushable enemy piece (own pieces and frozen pieces
// block).
function slimeShiftValid(s: GameState, group: SlimeGroup, df: number, dr: number, color: C2Color): boolean {
  for (const tIdx of group.tiles) {
    const [f, r] = frOfIdx(tIdx);
    const nf = f + df, nr = r + dr;
    if (!onBoard(nf, nr)) return false;
    const n = idxFR(nf, nr);
    if (group.tiles.includes(n)) continue;
    const occ = s.board[n];
    if (!occ) continue;
    if (occ.color === color) return false;
    if (isFrozen(s, n)) return false;
    // A sub-tier-3 Juggernaut can't be crushed — any capture attempt on it
    // costs the attacker its life, and a blob has no single piece to spend.
    // The slide is simply blocked. (At tier 3 it crushes like anything else.)
    const jt = jugTierAt(s, n);
    if (jt >= 1 && jt < 3) return false;
  }
  return true;
}

// Pseudo-moves for one big-king tile: each of the 8 directions whose shift
// is valid, expressed as this tile stepping onto the adjacent EXTERIOR
// square (interior steps are skipped — the same shift is reachable from the
// blob's leading tile, and a move onto an own-blob square would fight the
// click-to-select UI).
function pseudoSlimeShift(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  const group = s.slimes.find((g) => g.tiles.includes(from));
  if (!group) return;
  for (const [df, dr] of EIGHT_DIRS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    if (group.tiles.includes(t)) continue;
    if (!slimeShiftValid(s, group, df, dr, p.color)) continue;
    const crushes: number[] = [];
    for (const tIdx of group.tiles) {
      const [gf, gr] = frOfIdx(tIdx);
      const n = idxFR(gf + df, gr + dr);
      if (group.tiles.includes(n)) continue;
      if (s.board[n]) crushes.push(n);
    }
    out.push({ from, to: t, slimeShift: true, slimeCrushes: crushes });
  }
}

// One legal whole-blob shift, summarised per direction. Pages use these to
// drive the blob's arrow UI: clicking any tile of the blob surfaces every
// direction the blob can slide (not just the directions exterior to that
// tile), the entered squares are the clickable affordance, and `uci` is a
// canonical from→to the engine accepts for the shift.
export type SlimeShiftOption = {
  // Board-coordinate direction (file delta / rank delta, each -1 | 0 | 1).
  df: number;
  dr: number;
  uci: string;
  // Exterior squares the blob slides onto.
  entered: number[];
  // True when any entered square holds a (crushable) enemy piece.
  isCapture: boolean;
};

export function slimeShiftOptions(state: GameState, tileIdx: number): SlimeShiftOption[] {
  const p = state.board[tileIdx];
  if (!p || p.color !== state.turn || p.letter.toUpperCase() !== 'S') return [];
  const group = state.slimes.find((g) => g.tiles.includes(tileIdx));
  if (!group) return [];
  const out: SlimeShiftOption[] = [];
  for (const [df, dr] of EIGHT_DIRS) {
    if (!slimeShiftValid(state, group, df, dr, p.color)) continue;
    const entered: number[] = [];
    let isCapture = false;
    let fromTile = -1;
    for (const t of group.tiles) {
      const [f, r] = frOfIdx(t);
      const n = idxFR(f + df, r + dr);
      if (group.tiles.includes(n)) continue;
      entered.push(n);
      if (state.board[n]) isCapture = true;
      // Any tile whose step lands exterior works as the canonical mover —
      // pseudoSlimeShift emits exactly those from→to pairs.
      if (fromTile === -1) fromTile = t;
    }
    if (fromTile === -1) continue;
    const [cf, cr] = frOfIdx(fromTile);
    out.push({
      df,
      dr,
      uci: idxToSq(fromTile) + idxToSq(idxFR(cf + df, cr + dr)),
      entered,
      isCapture,
    });
  }
  return out;
}

// Resolve a click (or drop) on `clickedIdx` against the blob's shift options.
// Entered squares shared between an orthogonal and a diagonal shift resolve
// to the orthogonal one — each diagonal stays reachable through its unique
// far-corner square.
export function resolveSlimeShiftClick(
  options: SlimeShiftOption[],
  clickedIdx: number,
): SlimeShiftOption | null {
  const hits = options.filter((o) => o.entered.includes(clickedIdx));
  if (hits.length === 0) return null;
  return hits.find((o) => o.df === 0 || o.dr === 0) ?? hits[0];
}

function pseudoSliding(
  s: GameState, from: number, ff: number, fr: number, p: Piece,
  dirs: [number, number][], out: PseudoMove[],
) {
  for (const [df, dr] of dirs) {
    let f = ff + df, r = fr + dr;
    while (onBoard(f, r)) {
      const t = idxFR(f, r);
      // Earthquake tiles are impassable terrain — they block the ray
      // exactly like a piece would (and the slider can't land on the
      // quake itself either).
      if (s.earthquakes.some((eq) => eq.idx === t)) break;
      const dest = s.board[t];
      if (dest) {
        if (dest.color !== p.color) out.push({ from, to: t });
        break;
      }
      out.push({ from, to: t });
      f += df; r += dr;
    }
  }
}

function pseudoKnight(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = ff + df, r = fr + dr;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color === p.color) continue;
    out.push({ from, to: t });
  }
}

function pseudoPawn(s: GameState, from: number, ff: number, fr: number, p: Piece, out: PseudoMove[]) {
  const dir = p.color === 'w' ? 1 : -1;
  const startRank = p.color === 'w' ? 1 : 6;
  const promoRank = p.color === 'w' ? 7 : 0;
  // Mutation-hero side gets +knight-fused promotion options (Z=Q+N, C=R+N,
  // A=B+N). Plain N is in the base list — the Z/C/A variants add a knight
  // component on top of a sliding piece.
  const isMutation = s.heroes[p.color].hero === 'mutation';
  const promos: PromoLetter[] = isMutation
    ? ['Q', 'R', 'B', 'N', 'Z', 'C', 'A']
    : ['Q', 'R', 'B', 'N'];
  const oneR = fr + dir;
  // Earthquake tiles block pawn pushes the same way another piece does —
  // can't push onto the wave, and a double push can't hop over one.
  const hasQuakeAt = (idx: number) => s.earthquakes.some((eq) => eq.idx === idx);
  if (onBoard(ff, oneR) && !s.board[idxFR(ff, oneR)] && !hasQuakeAt(idxFR(ff, oneR))) {
    if (oneR === promoRank) {
      for (const promo of promos) {
        out.push({ from, to: idxFR(ff, oneR), promotion: promo });
      }
    } else {
      out.push({ from, to: idxFR(ff, oneR) });
      const twoR = fr + 2 * dir;
      if (
        fr === startRank &&
        onBoard(ff, twoR) &&
        !s.board[idxFR(ff, twoR)] &&
        !hasQuakeAt(idxFR(ff, twoR))
      ) {
        out.push({ from, to: idxFR(ff, twoR), doublePawn: true });
      }
    }
  }
  for (const df of [-1, 1]) {
    const f = ff + df, r = fr + dir;
    if (!onBoard(f, r)) continue;
    const t = idxFR(f, r);
    const dest = s.board[t];
    if (dest && dest.color !== p.color) {
      if (r === promoRank) {
        for (const promo of promos) {
          out.push({ from, to: t, promotion: promo });
        }
      } else {
        out.push({ from, to: t });
      }
    } else if (s.enPassant && idxToSq(t) === s.enPassant) {
      out.push({ from, to: t, enPassantCapture: true });
    }
  }
}

// ------------------------------------------------------------------
// Attack detection
// ------------------------------------------------------------------
export function isSquareAttacked(state: GameState, target: number, byColor: C2Color): boolean {
  const [tf, tr] = frOfIdx(target);
  // Frozen and stunned pieces can't capture or move, so they don't attack
  // anything. Their square still BLOCKS sliding rays — the piece is
  // physically there.
  const inert = (idx: number) => isFrozen(state, idx) || isStunned(state, idx);
  // Pawn
  const pawnDir = byColor === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const f = tf - df, r = tr - pawnDir;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    const p = state.board[idx];
    if (p && p.color === byColor && p.letter.toUpperCase() === 'P' && !inert(idx)) return true;
  }
  // King — plus Slime big-king tiles. A blob tile attacks an adjacent square
  // only if the whole blob can actually shift onto it (own pieces / frozen
  // pieces / the board edge can block the crush). A Juggernaut king attacks
  // adjacently only at tier 1 — tiers 2/3 use the knight / queen patterns
  // handled in the sections below.
  for (const [df, dr] of EIGHT_DIRS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    const p = state.board[idx];
    if (!p || p.color !== byColor || inert(idx)) continue;
    const up = p.letter.toUpperCase();
    if (up === 'K') {
      // Every king (Juggernaut or not) threatens its 8 adjacent squares.
      return true;
    }
    if (up === 'S') {
      const group = state.slimes.find((g) => g.tiles.includes(idx));
      // Shift direction that carries this tile onto the target is the
      // reverse of the tile's offset from the target.
      if (group && !group.tiles.includes(target) && slimeShiftValid(state, group, -df, -dr, byColor)) {
        return true;
      }
    }
  }
  // Knight — N plus the merged forms (A/C/Z all carry knight movement).
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const f = tf + df, r = tr + dr;
    if (!onBoard(f, r)) continue;
    const idx = idxFR(f, r);
    const p = state.board[idx];
    if (!p || p.color !== byColor) continue;
    if (inert(idx)) continue;
    const up = p.letter.toUpperCase();
    if (up === 'N' || up === 'A' || up === 'C' || up === 'Z') return true;
  }
  // Orthogonal rays — R / Q plus merged C (rook+N), Z (queen+N).
  // Earthquake tiles block the ray exactly like a piece would.
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const idx = idxFR(f, r);
      if (state.earthquakes.some((eq) => eq.idx === idx)) break;
      const p = state.board[idx];
      if (p) {
        if (p.color === byColor && !inert(idx)) {
          const up = p.letter.toUpperCase();
          if (up === 'R' || up === 'Q' || up === 'C' || up === 'Z') return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }
  // Diagonal rays — B / Q plus merged A (bishop+N), Z (queen+N).
  // Earthquakes block here too.
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const idx = idxFR(f, r);
      if (state.earthquakes.some((eq) => eq.idx === idx)) break;
      const p = state.board[idx];
      if (p) {
        if (p.color === byColor && !inert(idx)) {
          const up = p.letter.toUpperCase();
          if (up === 'B' || up === 'Q' || up === 'A' || up === 'Z') return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }
  return false;
}

function findKing(state: GameState, color: C2Color): number {
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === color && p.letter.toUpperCase() === 'K') return i;
  }
  return -1;
}

export function isInCheck(state: GameState, color: C2Color): boolean {
  // A sub-tier-3 Juggernaut can't be checked at all — it strolls through
  // attacked squares unbothered. Normal check rules switch on at tier 3
  // (its final life), which is also when checkmate becomes possible.
  const jt = jugTierOf(state, color);
  if (jt >= 1 && jt < 3) return false;
  // A Slime side can field multiple kings (mini kings and big-king tiles).
  // While it has more than one king square it can't be checked at all — its
  // kings are simply capturable pieces. Check resumes once it's down to a
  // single king. Non-Slime sides always have exactly one 'K', so this is the
  // standard rule for them.
  let only = -1;
  let count = 0;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.color !== color) continue;
    const up = p.letter.toUpperCase();
    if (up !== 'K' && up !== 'S') continue;
    count++;
    if (count > 1) return false;
    only = i;
  }
  if (count !== 1) return false;
  return isSquareAttacked(state, only, color === 'w' ? 'b' : 'w');
}

// Would the side to move be in check if Juggernaut immunity didn't exist?
// Only meaningful (and only true) for a sub-tier-3 Juggernaut — used to play
// the check SOUND as a flavor cue even though no actual check is in force.
function jugWouldBeInCheck(state: GameState): boolean {
  const color = state.turn;
  const jt = jugTierOf(state, color);
  if (jt < 1 || jt >= 3) return false;
  const k = findKing(state, color);
  if (k === -1) return false;
  return isSquareAttacked(state, k, color === 'w' ? 'b' : 'w');
}

// ------------------------------------------------------------------
// Ability target listings
// ------------------------------------------------------------------
function squaresAdjacentToKing(state: GameState, color: C2Color): number[] {
  const k = findKing(state, color);
  if (k === -1) return [];
  const [kf, kr] = frOfIdx(k);
  const out: number[] = [];
  for (const [df, dr] of EIGHT_DIRS) {
    const f = kf + df, r = kr + dr;
    if (!onBoard(f, r)) continue;
    out.push(idxFR(f, r));
  }
  return out;
}

export function abilityReady(state: GameState, color: C2Color): boolean {
  const side = state.heroes[color];
  // Harem is passive — no firable ability.
  if (side.hero === 'harem') return false;
  return state.ply >= side.cooldownUntilPly;
}

export function turnsUntilReady(state: GameState, color: C2Color): number {
  const side = state.heroes[color];
  if (side.hero === 'harem') return Infinity;
  // Cooldown is stored in plies; round up to "your turns" remaining (2 plies per turn).
  const pliesLeft = Math.max(0, side.cooldownUntilPly - state.ply);
  return Math.ceil(pliesLeft / 2);
}

// Squares (as indices) on which the active side can target their ability.
export function abilityTargets(state: GameState): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  const hero = state.heroes[color].hero;
  const out: number[] = [];
  if (hero === 'frost') {
    // Any non-king piece on the board, except a piece that's already frozen.
    // Slime big-king tiles count as kings — they can't be frozen either.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p) continue;
      const up = p.letter.toUpperCase();
      if (up === 'K' || up === 'S') continue;
      if (isFrozen(state, i)) continue;
      out.push(i);
    }
  } else if (hero === 'warlord') {
    // Enemy non-king pieces adjacent to my king. Slime big-king tiles count
    // as kings — the blade can't carve the blob.
    for (const idx of squaresAdjacentToKing(state, color)) {
      const p = state.board[idx];
      if (!p) continue;
      if (p.color === color) continue;
      const up = p.letter.toUpperCase();
      if (up === 'K' || up === 'S') continue;
      out.push(idx);
    }
  } else if (hero === 'necromancer') {
    // Empty squares adjacent to my king.
    for (const idx of squaresAdjacentToKing(state, color)) {
      if (state.board[idx] == null) out.push(idx);
    }
  } else if (hero === 'flight') {
    // Flight is two-click. First-click list: any of your own (unfrozen)
    // pieces with at least one empty square to fly to that doesn't leave
    // you in check. Second-click filtering is in flightLegalDestinations.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color !== color) continue;
      if (isFrozen(state, i)) continue;
      if (flightLegalDestinations(state, i).length > 0) out.push(i);
    }
    return out;
  } else if (hero === 'mutation') {
    // Only B / R / Q can be mutated. Knights already have knight movement;
    // pawns and kings are excluded by design; A / C / Z are merged forms.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color !== color) continue;
      const up = p.letter.toUpperCase();
      if (up !== 'B' && up !== 'R' && up !== 'Q') continue;
      out.push(i);
    }
  } else if (hero === 'icbm') {
    // Any square. No restrictions — including own pieces or empty squares.
    for (let i = 0; i < 64; i++) out.push(i);
  } else if (hero === 'twin-jutsu') {
    // First-click list: any of your pieces that has at least one valid
    // partner (and the resulting swap doesn't leave you in check). The
    // second-click filtering is in twinJutsuLegalDestinations.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color !== color) continue;
      if (twinJutsuLegalDestinations(state, i).length > 0) out.push(i);
    }
    return out;
  } else if (hero === 'slime') {
    // Two-click. First-click list: any of your mini kings with at least one
    // open 2×2 quadrant to expand into. (No mini kings exist until the big
    // king splits, so the ability idles until then.) Expansion always
    // produces an uncheckable blob, so no post-state check filter is needed.
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color !== color) continue;
      if (p.letter.toUpperCase() !== 'K') continue;
      if (slimeLegalDestinations(state, i).length > 0) out.push(i);
    }
    return out;
  } else if (hero === 'juggernaut') {
    // Tier-dependent, all single-click. Tier 1: pick an adjacent square to
    // spawn an earthquake heading that direction. Tier 2: pick a diagonal
    // edge corner to charge into. Tier 3: click the king itself to slam.
    const tier = state.jugTier[color];
    const k = findKing(state, color);
    if (k === -1) return [];
    const [kf, kr] = frOfIdx(k);
    if (tier === 1) {
      // Earthquake direction picker — every on-board adjacent square.
      for (const [df, dr] of EIGHT_DIRS) {
        const f = kf + df, r = kr + dr;
        if (!onBoard(f, r)) continue;
        out.push(idxFR(f, r));
      }
    } else if (tier === 2) {
      // Edge charge: walk every queen direction (8 total — rook + bishop
      // rays) to the board edge and surface that edge-most square as the
      // target.
      for (const [df, dr] of EIGHT_DIRS) {
        let f = kf + df, r = kr + dr;
        if (!onBoard(f, r)) continue;
        while (onBoard(f + df, r + dr)) { f += df; r += dr; }
        out.push(idxFR(f, r));
      }
    } else {
      // Slam fires from the king's own square — clicking it confirms.
      out.push(k);
    }
  } else if (hero === 'goofball') {
    // Goofball picks an OPPONENT'S piece to force-move. The "targets"
    // here are the from-squares: every enemy piece that has at least one
    // legal move from their perspective. The UI then asks
    // `goofballLegalDestinations` for the second click's allowed squares.
    const oppState: GameState = { ...state, turn: color === 'w' ? 'b' : 'w' };
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color === color) continue;
      if (legalMovesFrom(oppState, idxToSq(i)).length > 0) out.push(i);
    }
    // Goofball doesn't pre-filter for self-check here — the second click
    // (destination) is what gets check-filtered in applyMove.
    return out;
  }
  // Filter to targets that leave the mover not in check.
  return out.filter((idx) => {
    const next = applyAbility(state, hero, idx);
    return !isInCheck(next, color);
  });
}

// Given the user has armed Twin-Jutsu and picked their own piece at `fromIdx`,
// which other own-piece squares are legal swap partners? Rules:
//  - Both endpoints belong to the active side.
//  - At least one endpoint must be currently masked OR the real king (a king
//    counts whether or not it's still masked).
//  - The post-swap position must not leave the mover in check.
export function twinJutsuLegalDestinations(state: GameState, fromIdx: number): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  if (state.heroes[color].hero !== 'twin-jutsu') return [];
  const fromPiece = state.board[fromIdx];
  if (!fromPiece || fromPiece.color !== color) return [];
  const fromIsKing = fromPiece.letter.toUpperCase() === 'K';
  const fromMasked = state.masked[fromIdx];
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (i === fromIdx) continue;
    const p = state.board[i];
    if (!p || p.color !== color) continue;
    const isKing = p.letter.toUpperCase() === 'K';
    const isMasked = state.masked[i];
    if (!fromMasked && !fromIsKing && !isMasked && !isKing) continue;
    const after = applyAbility(state, 'twin-jutsu', i, fromIdx);
    if (isInCheck(after, color)) continue;
    out.push(i);
  }
  return out;
}

// Given the user has armed Goofball and picked an enemy `fromIdx`, which
// destination squares are legal? Reuses the standard legal-move generator
// from the opponent's POV. The final filter rejects moves that would leave
// the Goofball user (i.e. the side currently to move) in check after the
// forced opponent move — protects against accidentally giving yourself
// mate.
export function goofballLegalDestinations(state: GameState, fromIdx: number): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  if (state.heroes[color].hero !== 'goofball') return [];
  const p = state.board[fromIdx];
  if (!p || p.color === color) return [];
  const oppState: GameState = { ...state, turn: color === 'w' ? 'b' : 'w' };
  const moves = legalMovesFrom(oppState, idxToSq(fromIdx));
  const out: number[] = [];
  for (const m of moves) {
    const toIdx = sqToIdx(m.to);
    // Simulate the forced move and reject any that leave the user in check.
    const after = applyAbility(state, 'goofball', toIdx, fromIdx, m.promotion);
    if (isInCheck(after, color)) continue;
    out.push(toIdx);
  }
  return out;
}

// Given the user has armed Flight and picked their own piece at `fromIdx`,
// which destination squares are legal? Any empty square, as long as the
// teleport doesn't leave the mover in check (which also covers the king
// itself: it can't fly onto an attacked square).
export function flightLegalDestinations(state: GameState, fromIdx: number): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  if (state.heroes[color].hero !== 'flight') return [];
  const p = state.board[fromIdx];
  if (!p || p.color !== color) return [];
  if (isFrozen(state, fromIdx)) return [];
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (state.board[i] != null) continue;
    const after = applyAbility(state, 'flight', i, fromIdx);
    if (isInCheck(after, color)) continue;
    out.push(i);
  }
  return out;
}

// Given the user has armed Slime and picked one of their mini kings at
// `fromIdx`, which diagonal-corner squares define a legal expansion? The
// king becomes one corner of a new 2×2 blob; the clicked square is the far
// corner. All three new squares must be on the board and empty. Expanding
// is always check-safe — the resulting blob can't be checked.
export function slimeLegalDestinations(state: GameState, fromIdx: number): number[] {
  const color = state.turn;
  if (!abilityReady(state, color)) return [];
  if (state.heroes[color].hero !== 'slime') return [];
  const p = state.board[fromIdx];
  if (!p || p.color !== color || p.letter.toUpperCase() !== 'K') return [];
  const [f, r] = frOfIdx(fromIdx);
  const out: number[] = [];
  for (const df of [-1, 1]) {
    for (const dr of [-1, 1]) {
      if (!onBoard(f + df, r + dr)) continue;
      const others = [idxFR(f + df, r), idxFR(f, r + dr), idxFR(f + df, r + dr)];
      if (others.some((i) => state.board[i] != null)) continue;
      out.push(idxFR(f + df, r + dr));
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Apply a (validated) ability action.
// ------------------------------------------------------------------
function applyAbility(
  state: GameState,
  hero: HeroKind,
  targetIdx: number,
  fromIdx?: number,
  promo?: string,
): GameState {
  const color = state.turn;
  const info = HERO_INFO[hero];

  // Goofball: replay the opponent's chosen move on the board, but leave
  // the turn pointing at the opponent so they still get to play their
  // normal move next. applyPseudo flips opp→user; we flip back to opp.
  // Net effect: White spends their ply to force one Black move, then
  // Black still moves on their own turn.
  if (hero === 'goofball') {
    if (fromIdx == null) return state;
    const oppColor: C2Color = color === 'w' ? 'b' : 'w';
    const oppState: GameState = { ...state, turn: oppColor };
    const pseudos = pseudoMoves(oppState, fromIdx).filter((m) => m.to === targetIdx);
    let chosen: PseudoMove | null = null;
    for (const pm of pseudos) {
      if (pm.promotion) {
        if (promo && pm.promotion === promo.toUpperCase()) { chosen = pm; break; }
      } else if (!promo) {
        chosen = pm; break;
      }
    }
    if (!chosen) {
      // Fallback when caller forgot to specify promotion: pick the first
      // pseudo that matches the to-square.
      chosen = pseudos[0] ?? null;
    }
    if (!chosen) return state;
    const moved = applyPseudo(oppState, chosen);
    moved.heroes = {
      w: { ...state.heroes.w },
      b: { ...state.heroes.b },
    };
    moved.heroes[color].cooldownUntilPly = moved.ply + (info.cooldownTurns! * 2);
    // Don't skip the opponent's normal turn — leave it pointing at them.
    moved.turn = oppColor;
    // applyPseudo wrote the post-move position key with turn=user; fix the
    // last entry so threefold-repetition tracking sees the right turn.
    if (moved.positionHistory.length > 0) {
      moved.positionHistory = moved.positionHistory.slice(0, -1);
      moved.positionHistory.push(positionKey(moved));
    }
    return moved;
  }

  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    ply: state.ply + 1,
    positionHistory: state.positionHistory,
    heroes: {
      w: { ...state.heroes.w },
      b: { ...state.heroes.b },
    },
    frozen: state.frozen.slice(),
    missiles: state.missiles.slice(),
    masked: state.masked.slice(),
    slimes: state.slimes.map((g) => ({ tiles: g.tiles.slice() })),
    jugTier: { ...state.jugTier },
    stunned: state.stunned.slice(),
    earthquakes: state.earthquakes.slice(),
  };

  if (hero === 'frost') {
    // Lifetime: opp move +1 (frozen), my move +2 (frozen still — only the
    // square is locked, my own pieces are unaffected), opp move +3 (frozen),
    // my move +4 (clears via the expire check below). Pushed onto the array
    // so a concurrent freeze from the other side doesn't overwrite it.
    next.frozen.push({ idx: targetIdx, expiresAtPly: next.ply + 3 });
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'warlord') {
    next.board[targetIdx] = null;
    next.masked[targetIdx] = false;
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'necromancer') {
    const pieceLetter: PieceLetter = color === 'w' ? 'P' : 'p';
    next.board[targetIdx] = { color, letter: pieceLetter };
    next.masked[targetIdx] = false;
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'mutation') {
    // B → A, R → C, Q → Z (preserve case). Mutated rook loses the side's
    // castling because the castle code only recognises 'R' on the corner —
    // a tradeoff the player accepts when they choose to mutate a rook.
    const p = next.board[targetIdx];
    if (p) {
      const up = p.letter.toUpperCase();
      const merged = up === 'B' ? 'A' : up === 'R' ? 'C' : 'Z';
      const wasLower = p.letter !== up;
      next.board[targetIdx] = {
        color: p.color,
        letter: (wasLower ? merged.toLowerCase() : merged) as PieceLetter,
      };
    }
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'flight') {
    // Two-click teleport: fly the piece at fromIdx to the (empty) target.
    if (fromIdx == null) return state;
    const flyer = next.board[fromIdx];
    if (flyer) {
      next.board[targetIdx] = flyer;
      next.board[fromIdx] = null;
      next.masked[fromIdx] = false;
      next.masked[targetIdx] = false;
      // A pawn flown onto its promotion rank promotes. The player picks the
      // piece in the UI; the chosen letter rides the UCI as `promo`.
      // Default to queen if none provided.
      if (flyer.letter.toUpperCase() === 'P') {
        const rankFromTop = Math.floor(targetIdx / 8);
        const onPromoRank = flyer.color === 'w' ? rankFromTop === 0 : rankFromTop === 7;
        if (onPromoRank) {
          const promoLetter = (promo ? promo.toUpperCase() : 'Q') as PieceLetter;
          next.board[targetIdx] = {
            color: flyer.color,
            letter: (flyer.color === 'w' ? promoLetter : promoLetter.toLowerCase()) as PieceLetter,
          };
        }
      }
      // Castling rights as if the flyer had moved normally: a king flight
      // forfeits both wings; a rook leaving (or landing on) a home corner
      // forfeits that wing.
      if (flyer.letter.toUpperCase() === 'K') {
        if (color === 'w') { next.castling.wK = false; next.castling.wQ = false; }
        else { next.castling.bK = false; next.castling.bQ = false; }
      }
      for (const idx of [fromIdx, targetIdx]) {
        if (idx === 56) next.castling.wQ = false;
        if (idx === 63) next.castling.wK = false;
        if (idx === 0)  next.castling.bQ = false;
        if (idx === 7)  next.castling.bK = false;
      }
    }
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'twin-jutsu') {
    // Two-click swap: swap the pieces at fromIdx and targetIdx (both must be
    // the active side's pieces; at least one must be masked or be the real
    // king — enforced by twinJutsuLegalDestinations). After the swap, both
    // endpoints are re-masked so the opponent loses identity information
    // even on pieces that had previously been revealed.
    if (fromIdx == null) return state;
    const a = next.board[fromIdx];
    const b = next.board[targetIdx];
    next.board[fromIdx] = b;
    next.board[targetIdx] = a;
    next.masked[fromIdx] = true;
    next.masked[targetIdx] = true;
    // A pawn swapped onto its promotion rank promotes. The player picks the
    // promotion piece in the UI; the chosen letter rides the UCI as `promo`.
    // Default to queen if none provided (e.g. legacy callers or a swap that
    // ends in stalemate filtering).
    const promoLetter = (promo ? promo.toUpperCase() : 'Q') as PieceLetter;
    for (const idx of [fromIdx, targetIdx]) {
      const piece = next.board[idx];
      if (!piece) continue;
      const up = piece.letter.toUpperCase();
      if (up !== 'P') continue;
      const rankFromTop = Math.floor(idx / 8);
      const onPromoRank = piece.color === 'w' ? rankFromTop === 0 : rankFromTop === 7;
      if (!onPromoRank) continue;
      next.board[idx] = {
        color: piece.color,
        letter: (piece.color === 'w' ? promoLetter : promoLetter.toLowerCase()) as PieceLetter,
      };
    }
    // Castling rights lost as if either endpoint had been "moved":
    // king-involving swap forfeits both sides; rook-on-home-corner swap
    // forfeits that wing.
    const involvesWhiteKing =
      (a && a.color === 'w' && a.letter.toUpperCase() === 'K') ||
      (b && b.color === 'w' && b.letter.toUpperCase() === 'K');
    const involvesBlackKing =
      (a && a.color === 'b' && a.letter.toUpperCase() === 'K') ||
      (b && b.color === 'b' && b.letter.toUpperCase() === 'K');
    if (involvesWhiteKing) { next.castling.wK = false; next.castling.wQ = false; }
    if (involvesBlackKing) { next.castling.bK = false; next.castling.bQ = false; }
    for (const idx of [fromIdx, targetIdx]) {
      if (idx === 56) next.castling.wQ = false;
      if (idx === 63) next.castling.wK = false;
      if (idx === 0)  next.castling.bQ = false;
      if (idx === 7)  next.castling.bK = false;
    }
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'icbm') {
    // Queue the strike; 1-turn cooldown means the side can't fire again on
    // their immediate next turn (2 plies away).
    next.missiles.push({ idx: targetIdx, landsAtPly: next.ply + 5, firedBy: color });
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'slime') {
    // Two-click expansion: the mini king at fromIdx grows into a 2×2 blob
    // whose far corner is targetIdx. The three new squares were validated
    // empty by slimeLegalDestinations.
    if (fromIdx == null) return state;
    const [kf, kr] = frOfIdx(fromIdx);
    const [cf, cr] = frOfIdx(targetIdx);
    const tiles = [fromIdx, idxFR(cf, kr), idxFR(kf, cr), targetIdx];
    const letter: PieceLetter = color === 'w' ? 'S' : 's';
    for (const tIdx of tiles) {
      next.board[tIdx] = { color, letter };
      next.masked[tIdx] = false;
    }
    next.slimes = [...next.slimes, { tiles }];
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  } else if (hero === 'juggernaut') {
    // Tier-dependent kit. Targets were validated by abilityTargets.
    const tier = state.jugTier[color];
    const k = findKing(next, color);
    if (k !== -1) {
      if (tier === 1) {
        // Earthquake: spawn a creeping wave on the adjacent square in the
        // chosen direction. If an enemy is already there it dies on the
        // spot; the wave still spawns and starts rolling on the next
        // Jug move. Spawning ON a sub-tier-3 enemy Juggernaut consumes
        // the wave as its first hit — same as a wave absorbed mid-
        // travel: the Jug tiers up by one and no wave persists.
        const [kf, kr] = frOfIdx(k);
        const [tf, tr] = frOfIdx(targetIdx);
        const df = Math.sign(tf - kf);
        const dr = Math.sign(tr - kr);
        const victim = next.board[targetIdx];
        const victimJugTier = victim && victim.color !== color ? jugTierAt(next, targetIdx) : 0;
        if (victimJugTier >= 1 && victimJugTier < 3) {
          next.jugTier[victim!.color] = victimJugTier + 1;
          next.halfmove = 0;
          // Wave fizzles on contact with a sub-3 Jug — same as absorbed
          // mid-travel. Cooldown still spent; that was the player's call.
        } else {
          if (victim && victim.color !== color) {
            const up = victim.letter.toUpperCase();
            if (up === 'S') splitSlimeGroupAt(next, targetIdx);
            next.board[targetIdx] = null;
            next.frozen = next.frozen.filter((fz) => fz.idx !== targetIdx);
            next.stunned = next.stunned.filter((s) => s.idx !== targetIdx);
            if (targetIdx === 56) next.castling.wQ = false;
            if (targetIdx === 63) next.castling.wK = false;
            if (targetIdx === 0)  next.castling.bQ = false;
            if (targetIdx === 7)  next.castling.bK = false;
            next.masked[targetIdx] = false;
            next.halfmove = 0;
          }
          next.earthquakes = [
            ...next.earthquakes,
            { idx: targetIdx, df, dr, color, spawnedAtPly: next.ply },
          ];
        }
      } else if (tier === 2) {
        // Edge charge: slide to the chosen edge corner, destroying
        // everything in the path (and, like ICBM, the charge ignores
        // Frost). A sub-tier-3 enemy Juggernaut tiers up by one but
        // isn't killed and doesn't block the slide — the charger
        // passes through it and parks at the edge as normal. The only
        // exception is when the edge corner IS the surviving Jug: the
        // charger parks one square short instead of sharing a tile.
        // A destroyed king ends the game via the king-destroyed pathway.
        const [kf, kr] = frOfIdx(k);
        const [tf, tr] = frOfIdx(targetIdx);
        // Math.sign yields -1/0/+1 so the charge works for both cardinal
        // (one delta is 0) and diagonal (both ±1) edge targets.
        const df = Math.sign(tf - kf);
        const dr = Math.sign(tr - kr);
        const jug = next.board[k]!;
        next.board[k] = null;
        next.masked[k] = false;
        let survivorIdx = -1;
        let lastClearIdx = k;
        let f = kf + df, r = kr + dr;
        while (onBoard(f, r)) {
          const idx = idxFR(f, r);
          const victim = next.board[idx];
          let surviving = false;
          if (victim && victim.color !== color) {
            const jt = jugTierAt(next, idx);
            if (jt >= 1 && jt < 3) {
              next.jugTier[victim.color] = jt + 1;
              next.halfmove = 0;
              survivorIdx = idx;
              surviving = true;
            }
          }
          if (!surviving) {
            if (victim) {
              if (victim.letter.toUpperCase() === 'S') splitSlimeGroupAt(next, idx);
              next.board[idx] = null;
              next.halfmove = 0;
              next.frozen = next.frozen.filter((fz) => fz.idx !== idx);
              next.stunned = next.stunned.filter((s) => s.idx !== idx);
              if (idx === 56) next.castling.wQ = false;
              if (idx === 63) next.castling.wK = false;
              if (idx === 0)  next.castling.bQ = false;
              if (idx === 7)  next.castling.bK = false;
            }
            next.masked[idx] = false;
            lastClearIdx = idx;
          }
          if (idx === targetIdx) break;
          f += df; r += dr;
        }
        // Charger lands at targetIdx if it's clear, otherwise the last
        // cleared square (one before the surviving Jug that occupied
        // the edge corner).
        const landingIdx = survivorIdx === targetIdx ? lastClearIdx : targetIdx;
        next.board[landingIdx] = jug;
      } else {
        // Slam: jump in place. Pieces at chebyshev distance 1 are
        // destroyed (both sides — even the jug's own), except a sub-
        // tier-3 enemy Juggernaut, which absorbs the slam by tiering up
        // by one. Pieces at distance 2 are stunned for the next
        // opponent + own move.
        const [kf, kr] = frOfIdx(k);
        let hit = false;
        for (let df = -2; df <= 2; df++) {
          for (let dr = -2; dr <= 2; dr++) {
            if (df === 0 && dr === 0) continue;
            const f = kf + df, r = kr + dr;
            if (!onBoard(f, r)) continue;
            const idx = idxFR(f, r);
            const dist = Math.max(Math.abs(df), Math.abs(dr));
            if (dist === 1) {
              const victim = next.board[idx];
              if (victim) {
                const enemyJt = victim.color !== color ? jugTierAt(next, idx) : 0;
                if (enemyJt >= 1 && enemyJt < 3) {
                  next.jugTier[victim.color] = enemyJt + 1;
                  hit = true;
                } else {
                  const up = victim.letter.toUpperCase();
                  if (up === 'S') splitSlimeGroupAt(next, idx);
                  next.board[idx] = null;
                  next.frozen = next.frozen.filter((fz) => fz.idx !== idx);
                  next.stunned = next.stunned.filter((s) => s.idx !== idx);
                  if (idx === 56) next.castling.wQ = false;
                  if (idx === 63) next.castling.wK = false;
                  if (idx === 0)  next.castling.bQ = false;
                  if (idx === 7)  next.castling.bK = false;
                  hit = true;
                }
              }
              next.masked[idx] = false;
            } else if (dist === 2) {
              const v = next.board[idx];
              // Kings (regular 'K' and Slime big-king tiles 'S') shrug
              // off the shockwave — only the lesser pieces get dizzy.
              if (v && !isStunned(next, idx)) {
                const up = v.letter.toUpperCase();
                if (up !== 'K' && up !== 'S') {
                  next.stunned.push({ idx, expiresAtPly: next.ply + 2 });
                }
              }
            }
          }
        }
        if (hit) next.halfmove = 0;
      }
    }
    next.heroes[color].cooldownUntilPly = next.ply + (info.cooldownTurns! * 2);
  }

  // Resolve any missile landings now that ply has advanced. ICBM is the
  // only path that mutates board this way; it bypasses Frost (the freeze
  // applies to capture/move, not to explosions).
  processMissileLandings(next);
  // Same beat for earthquakes — but waves only advance when their owner's
  // Juggernaut just moved. Any of the Jug's tier abilities (earthquake
  // spawn, edge charge, slam) count as the Jug acting.
  const abilityJugColor = state.heroes[color].hero === 'juggernaut' ? color : null;
  processEarthquakes(next, abilityJugColor);

  // Expire any active freezes / stuns whose lifetime has now ended.
  next.frozen = next.frozen.filter((f) => next.ply < f.expiresAtPly);
  next.stunned = next.stunned.filter((s) => next.ply < s.expiresAtPly);

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;
  return next;
}

// ------------------------------------------------------------------
// Apply a (validated) board move.
// ------------------------------------------------------------------
function applyPseudo(state: GameState, mv: PseudoMove): GameState {
  const next: GameState = {
    board: state.board.slice(),
    turn: state.turn === 'w' ? 'b' : 'w',
    castling: { ...state.castling },
    enPassant: null,
    halfmove: state.halfmove + 1,
    fullmove: state.turn === 'b' ? state.fullmove + 1 : state.fullmove,
    ply: state.ply + 1,
    positionHistory: state.positionHistory,
    heroes: {
      w: { ...state.heroes.w },
      b: { ...state.heroes.b },
    },
    frozen: state.frozen.slice(),
    missiles: state.missiles.slice(),
    masked: state.masked.slice(),
    slimes: state.slimes.map((g) => ({ tiles: g.tiles.slice() })),
    jugTier: { ...state.jugTier },
    stunned: state.stunned.slice(),
    earthquakes: state.earthquakes.slice(),
  };

  // Slime big-king shift: the whole 2×2 blob containing mv.from slides one
  // square in the from→to direction, crushing any enemy pieces on the
  // squares it enters (validated crushable in pseudoSlimeShift).
  if (mv.slimeShift) {
    const group = next.slimes.find((g) => g.tiles.includes(mv.from));
    const blobPiece = next.board[mv.from]!;
    if (group) {
      const [ff, fr] = frOfIdx(mv.from);
      const [tf, tr] = frOfIdx(mv.to);
      const df = tf - ff, dr = tr - fr;
      const oldTiles = group.tiles.slice();
      const newTiles = oldTiles.map((tIdx) => {
        const [f, r] = frOfIdx(tIdx);
        return idxFR(f + df, r + dr);
      });
      let crushed = false;
      for (const tIdx of newTiles) {
        if (oldTiles.includes(tIdx)) continue;
        const victim = next.board[tIdx];
        if (victim) {
          crushed = true;
          // Crushing an enemy big-king tile splits THAT blob before the
          // square clears.
          if (victim.letter.toUpperCase() === 'S') splitSlimeGroupAt(next, tIdx);
          next.board[tIdx] = null;
          next.stunned = next.stunned.filter((s) => s.idx !== tIdx);
        }
        // Crushing a rook on its home corner forfeits that wing.
        if (tIdx === 56) next.castling.wQ = false;
        if (tIdx === 63) next.castling.wK = false;
        if (tIdx === 0)  next.castling.bQ = false;
        if (tIdx === 7)  next.castling.bK = false;
      }
      for (const tIdx of oldTiles) {
        if (!newTiles.includes(tIdx)) {
          next.board[tIdx] = null;
          next.masked[tIdx] = false;
        }
      }
      for (const tIdx of newTiles) {
        next.board[tIdx] = { color: blobPiece.color, letter: blobPiece.letter };
        next.masked[tIdx] = false;
      }
      group.tiles = newTiles;
      if (crushed) next.halfmove = 0;
    }
    processMissileLandings(next);
    // Slime shift — no Juggernaut moved on this ply (each side picks one
    // hero), so no waves advance.
    processEarthquakes(next, null);
    next.frozen = next.frozen.filter((f) => next.ply < f.expiresAtPly);
    next.stunned = next.stunned.filter((s) => next.ply < s.expiresAtPly);
    const hist = state.positionHistory.slice();
    hist.push(positionKey(next));
    next.positionHistory = hist;
    return next;
  }

  const mover = next.board[mv.from]!;
  const moverUp = mover.letter.toUpperCase();
  const dest = next.board[mv.to];
  if (dest) next.halfmove = 0;

  // Juggernaut absorb: capturing a sub-tier-3 Juggernaut never completes.
  // The attacker dies on the spot and the Juggernaut — unmoved — rises a
  // tier. (At tier 3 the capture resolves normally below and the missing
  // king ends the game via the king-destroyed pathway.) The enemy KING can
  // never legally do this: spending your last king square is filtered out
  // like a move into check.
  if (dest && dest.color !== mover.color) {
    const jt = jugTierAt(next, mv.to);
    if (jt >= 1 && jt < 3) {
      next.board[mv.from] = null;
      next.masked[mv.from] = false;
      next.jugTier[dest.color] = jt + 1;
      next.halfmove = 0;
      // A rook that died charging off its home corner still forfeits that
      // castling wing.
      if (mv.from === 56) next.castling.wQ = false;
      if (mv.from === 63) next.castling.wK = false;
      if (mv.from === 0)  next.castling.bQ = false;
      if (mv.from === 7)  next.castling.bK = false;
      processMissileLandings(next);
      // The attacking piece was just absorbed by a Juggernaut. If that
      // attacker happened to be the OTHER side's Juggernaut making a
      // suicide rush, their waves advance as part of that final stomp.
      const absorbJugColor = (
        mover.letter.toUpperCase() === 'K' &&
        state.heroes[mover.color].hero === 'juggernaut'
      ) ? mover.color : null;
      processEarthquakes(next, absorbJugColor);
      next.frozen = next.frozen.filter((f) => next.ply < f.expiresAtPly);
      next.stunned = next.stunned.filter((s) => next.ply < s.expiresAtPly);
      const hist = state.positionHistory.slice();
      hist.push(positionKey(next));
      next.positionHistory = hist;
      return next;
    }
  }

  // Capturing one tile of a Slime blob splits the rest into mini kings.
  if (dest && dest.letter.toUpperCase() === 'S') splitSlimeGroupAt(next, mv.to);
  // A captured stunned piece takes its stun entry with it.
  if (dest) next.stunned = next.stunned.filter((s) => s.idx !== mv.to);

  let resultPiece: Piece = mover;
  if (mv.promotion) {
    const letter: PieceLetter = mover.color === 'w'
      ? mv.promotion
      : (mv.promotion.toLowerCase() as PieceLetter);
    resultPiece = { color: mover.color, letter };
  }
  if (mv.enPassantCapture) {
    const [tf, tr] = frOfIdx(mv.to);
    const capRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.board[idxFR(tf, capRank)] = null;
    next.halfmove = 0;
  }
  next.board[mv.to] = resultPiece;
  next.board[mv.from] = null;
  if (moverUp === 'P') next.halfmove = 0;
  if (mv.doublePawn) {
    const [tf, tr] = frOfIdx(mv.to);
    const epRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.enPassant = idxToSq(idxFR(tf, epRank));
  }

  // Castling: swing the rook over the king onto the transit square.
  if (mv.castle) {
    const isWhite = mover.color === 'w';
    if (mv.castle === 'K') {
      const rookFrom = isWhite ? 63 : 7;
      const rookTo = isWhite ? 61 : 5;
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
      next.masked[rookFrom] = false;
      next.masked[rookTo] = false;
    } else {
      const rookFrom = isWhite ? 56 : 0;
      const rookTo = isWhite ? 59 : 3;
      next.board[rookTo] = next.board[rookFrom];
      next.board[rookFrom] = null;
      next.masked[rookFrom] = false;
      next.masked[rookTo] = false;
    }
  }

  // Twin-Jutsu unmask: the moving piece reveals at its destination, and the
  // origin square (now empty) carries no mask either. En-passant capture
  // also clears the captured pawn's square.
  next.masked[mv.from] = false;
  next.masked[mv.to] = false;
  if (mv.enPassantCapture) {
    const [tf, tr] = frOfIdx(mv.to);
    const capRank = mover.color === 'w' ? tr - 1 : tr + 1;
    next.masked[idxFR(tf, capRank)] = false;
  }

  // Castling rights: lose them when the king moves (board move or implicit
  // via castle) and when a rook moves off / is captured on its home corner.
  if (moverUp === 'K') {
    if (mover.color === 'w') { next.castling.wK = false; next.castling.wQ = false; }
    else { next.castling.bK = false; next.castling.bQ = false; }
  }
  // From-corner clears the right tied to that rook.
  if (mv.from === 56) next.castling.wQ = false;
  if (mv.from === 63) next.castling.wK = false;
  if (mv.from === 0)  next.castling.bQ = false;
  if (mv.from === 7)  next.castling.bK = false;
  // Capture lands on a corner — that rook is gone.
  if (mv.to === 56) next.castling.wQ = false;
  if (mv.to === 63) next.castling.wK = false;
  if (mv.to === 0)  next.castling.bQ = false;
  if (mv.to === 7)  next.castling.bK = false;

  // Process any missile landings before freeze expiration so a missile that
  // demolishes a frozen piece also clears the freeze entry.
  processMissileLandings(next);
  // Earthquakes only creep when their owner's Juggernaut piece itself just
  // moved — so a player can stockpile waves and trigger advancement
  // intentionally by walking the Jug forward.
  const moverJugColor = (
    mover.letter.toUpperCase() === 'K' &&
    state.heroes[mover.color].hero === 'juggernaut'
  ) ? mover.color : null;
  processEarthquakes(next, moverJugColor);

  next.frozen = next.frozen.filter((f) => next.ply < f.expiresAtPly);
  next.stunned = next.stunned.filter((s) => next.ply < s.expiresAtPly);

  const hist = state.positionHistory.slice();
  hist.push(positionKey(next));
  next.positionHistory = hist;
  return next;
}

// ------------------------------------------------------------------
// Legal move generation
// ------------------------------------------------------------------
export type LegalMove = {
  to: Square;
  promotion?: PromoLetter;
  isCapture: boolean;
  isSpecial: boolean;
};

export function legalMovesFrom(state: GameState, from: Square): LegalMove[] {
  const idx = sqToIdx(from);
  const p = state.board[idx];
  if (!p || p.color !== state.turn) return [];
  const pseudos = pseudoMoves(state, idx);
  const moverColor = p.color;
  // Juggernaut sides field a lone king that walks one square at every tier
  // — but it should refuse to walk into attacked squares the same way a
  // normal king does at every tier. `isInCheck` only fires at tier 3, so
  // this extra filter covers tiers 1 and 2 (and is a redundant no-op at
  // tier 3). The destination check naturally also bans capturing a
  // defended piece, since the defender still attacks the square the
  // Juggernaut would land on.
  const isJugMover =
    state.heroes[moverColor].hero === 'juggernaut' && p.letter.toUpperCase() === 'K';
  const enemy: C2Color = moverColor === 'w' ? 'b' : 'w';
  // Squares currently occupied by ANY earthquake are impassable terrain
  // (rocks + cracked floor — nothing walks through). Lookup keyed by tile
  // index so the per-pseudo-move check is O(1).
  const quakeTiles = new Set<number>();
  for (const eq of state.earthquakes) quakeTiles.add(eq.idx);
  const out: LegalMove[] = [];
  for (const pm of pseudos) {
    if (quakeTiles.has(pm.to)) continue;
    const next = applyPseudo(state, pm);
    if (isInCheck(next, moverColor)) continue;
    if (isJugMover && isSquareAttacked(next, pm.to, enemy)) continue;
    // Capturing a sub-tier-3 Juggernaut costs the attacker its life. A move
    // that would spend the mover's LAST king square (the king itself
    // charging in) is illegal, same as moving into check. A multi-king
    // Slime side may legally sacrifice one of its spares.
    if (hasAnyKingSquare(state, moverColor) && !hasAnyKingSquare(next, moverColor)) continue;
    const dest = state.board[pm.to];
    const isCapture = !!dest || !!pm.enPassantCapture || (pm.slimeCrushes != null && pm.slimeCrushes.length > 0);
    out.push({ to: idxToSq(pm.to), promotion: pm.promotion, isCapture, isSpecial: false });
  }
  return out;
}

export function allLegalBoardMoves(state: GameState): { from: Square; to: Square; promotion?: PromoLetter }[] {
  const out: { from: Square; to: Square; promotion?: PromoLetter }[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.color !== state.turn) continue;
    const from = idxToSq(i);
    for (const m of legalMovesFrom(state, from)) {
      out.push({ from, to: m.to, promotion: m.promotion });
    }
  }
  return out;
}

function anyLegalAbility(state: GameState): boolean {
  return abilityTargets(state).length > 0;
}

// ------------------------------------------------------------------
// UCI parsing for ability moves
// ------------------------------------------------------------------
// Harem is passive — no entry. Mutation uses M; ICBM uses I; Goofball uses G.
const ABILITY_PREFIX_TO_HERO: Record<string, HeroKind> = {
  F: 'frost', W: 'warlord', N: 'necromancer', L: 'flight', M: 'mutation', I: 'icbm', G: 'goofball', T: 'twin-jutsu', S: 'slime', J: 'juggernaut',
};
const HERO_TO_ABILITY_PREFIX: Partial<Record<HeroKind, string>> = {
  frost: 'F', warlord: 'W', necromancer: 'N', flight: 'L', mutation: 'M', icbm: 'I', goofball: 'G', 'twin-jutsu': 'T', slime: 'S', juggernaut: 'J',
};

export function isAbilityUci(uci: string): boolean {
  return uci.length >= 4 && uci[0] === '!';
}
// Most abilities carry just a `to` square. Goofball, Twin-Jutsu and Flight
// additionally carry a `from` square (the piece being moved / swapped) and
// an optional promotion letter.
export function parseAbility(
  uci: string,
): { hero: HeroKind; to: Square; from?: Square; promo?: string } | null {
  if (!isAbilityUci(uci)) return null;
  const hero = ABILITY_PREFIX_TO_HERO[uci[1]];
  if (!hero) return null;
  if (hero === 'goofball' || hero === 'twin-jutsu' || hero === 'flight' || hero === 'slime') {
    // !G/!T/!L<from><to>[<promo>] — 6 or 7 chars total. Goofball forces an
    // opponent move; Twin-Jutsu swaps two own pieces (symmetric, order is
    // arbitrary); Flight teleports an own piece. The promo letter applies
    // when a pawn lands on its back rank. !S<from><to> is the Slime
    // expansion: <from> is the mini king, <to> the far corner (no promo).
    if (uci.length < 6) return null;
    const from = uci.slice(2, 4);
    const to = uci.slice(4, 6);
    const promo = uci.length >= 7 ? uci[6].toUpperCase() : undefined;
    if (from.length !== 2 || to.length !== 2) return null;
    return { hero, from, to, promo };
  }
  const to = uci.slice(2, 4);
  if (to.length !== 2) return null;
  return { hero, to };
}
export function abilityUci(hero: HeroKind, to: Square, from?: Square, promo?: string): string {
  if (hero === 'goofball' || hero === 'twin-jutsu' || hero === 'flight' || hero === 'slime') {
    return `!${HERO_TO_ABILITY_PREFIX[hero]}${from ?? ''}${to}${promo ? promo.toLowerCase() : ''}`;
  }
  return `!${HERO_TO_ABILITY_PREFIX[hero]}${to}`;
}

// What piece would be sitting on `impactIdx` after `uci` was applied to
// `state`, but BEFORE the missile-landing pass cleared it. Used by the
// renderer so a piece that just moved onto an impact square stays visible
// during the explosion animation instead of vanishing the instant it
// arrives. Returns null if the square was empty at that moment.
export function pieceAtImpactBeforeBlast(
  state: GameState,
  uci: string,
  impactIdx: number,
): Piece | null {
  if (isAbilityUci(uci)) {
    const parsed = parseAbility(uci);
    if (!parsed) return state.board[impactIdx] ?? null;
    // Goofball moves an opponent piece from `from` to `to`; Flight moves an
    // own piece the same way. We have to look at BOTH squares — `from`
    // empties out, `to` gets the moved (optionally promoted) piece — so the
    // renderer sees the right doomed sprite when a missile lands on either.
    if ((parsed.hero === 'goofball' || parsed.hero === 'flight') && parsed.from) {
      const fromIdx = sqToIdx(parsed.from);
      const toIdx = sqToIdx(parsed.to);
      if (fromIdx === impactIdx) return null;
      if (toIdx === impactIdx) {
        const mover = state.board[fromIdx];
        if (!mover) return null;
        if (parsed.promo) {
          const letter = (mover.color === 'w'
            ? parsed.promo.toUpperCase()
            : parsed.promo.toLowerCase()) as PieceLetter;
          return { color: mover.color, letter };
        }
        return mover;
      }
      return state.board[impactIdx] ?? null;
    }
    // Twin-Jutsu swaps two of the active side's pieces. A missile that lands
    // on either endpoint hits whatever just swapped INTO that square.
    if (parsed.hero === 'twin-jutsu' && parsed.from) {
      const fromIdx = sqToIdx(parsed.from);
      const toIdx = sqToIdx(parsed.to);
      if (fromIdx === impactIdx) return state.board[toIdx] ?? null;
      if (toIdx === impactIdx) return state.board[fromIdx] ?? null;
      return state.board[impactIdx] ?? null;
    }
    // Slime expansion fills the 2×2 quadrant with big-king tiles — a missile
    // landing on any of them hits a fresh 'S' tile.
    if (parsed.hero === 'slime' && parsed.from) {
      const fromIdx = sqToIdx(parsed.from);
      const toIdx = sqToIdx(parsed.to);
      const [kf, kr] = frOfIdx(fromIdx);
      const [cf, cr] = frOfIdx(toIdx);
      const tiles = [fromIdx, idxFR(cf, kr), idxFR(kf, cr), toIdx];
      if (tiles.includes(impactIdx)) {
        const mover = state.board[fromIdx];
        if (mover) {
          return { color: mover.color, letter: (mover.color === 'w' ? 'S' : 's') as PieceLetter };
        }
      }
      return state.board[impactIdx] ?? null;
    }
    // Juggernaut: tier 1 (Earthquake) spawns a wave on the adjacent square,
    // possibly killing whatever's there. Tier 2 charges diagonally. Tier 3
    // slams in place (radius-1 destroyed, radius-2 stunned but still alive).
    if (parsed.hero === 'juggernaut') {
      const color = state.turn;
      const tier = state.heroes[color].hero === 'juggernaut' ? state.jugTier[color] : 0;
      const jugIdx = findKing(state, color);
      const targetIdx2 = sqToIdx(parsed.to);
      if (tier === 3 && jugIdx !== -1) {
        const [kf, kr] = frOfIdx(jugIdx);
        const [pf, pr] = frOfIdx(impactIdx);
        const dist = Math.max(Math.abs(pf - kf), Math.abs(pr - kr));
        if (dist === 1) return null;
        return state.board[impactIdx] ?? null;
      }
      if (tier === 1 && jugIdx !== -1) {
        // Earthquake spawn: the spawn square changes only if it held an
        // enemy (the wave kills on contact, then dies). A sub-tier-3
        // enemy Juggernaut on the spawn square is unkilled — it just
        // tiers up — so it stays visible.
        if (impactIdx === targetIdx2) {
          const p = state.board[impactIdx];
          if (p && p.color !== color) {
            const jt = jugTierAt(state, impactIdx);
            if (jt >= 1 && jt < 3) return p;
            return null;
          }
        }
        return state.board[impactIdx] ?? null;
      }
      if (tier === 2 && jugIdx !== -1) {
        const [kf, kr] = frOfIdx(jugIdx);
        const [tf, tr] = frOfIdx(targetIdx2);
        const df = Math.sign(tf - kf);
        const dr = Math.sign(tr - kr);
        // Mirror the engine: walk to targetIdx2, clearing each square
        // except a sub-tier-3 enemy Jug (it survives in place). Charger
        // lands at targetIdx2 unless that square IS the surviving Jug —
        // then on the last cleared square before it.
        let f = kf + df, r = kr + dr;
        let survivorIdx = -1;
        let lastClearIdx = jugIdx;
        const cleared: number[] = [];
        while (true) {
          const idx = idxFR(f, r);
          const v = state.board[idx];
          let surviving = false;
          if (v && v.color !== state.turn) {
            const jt = jugTierAt(state, idx);
            if (jt >= 1 && jt < 3) { survivorIdx = idx; surviving = true; }
          }
          if (!surviving) {
            cleared.push(idx);
            lastClearIdx = idx;
          }
          if (idx === targetIdx2) break;
          f += df; r += dr;
        }
        const landIdx = survivorIdx === targetIdx2 ? lastClearIdx : targetIdx2;
        if (impactIdx === jugIdx) {
          return landIdx === jugIdx ? state.board[jugIdx] : null;
        }
        if (impactIdx === landIdx) return state.board[jugIdx];
        if (impactIdx === survivorIdx) return state.board[impactIdx] ?? null;
        if (cleared.includes(impactIdx)) return null;
      }
      return state.board[impactIdx] ?? null;
    }
    const targetIdx = sqToIdx(parsed.to);
    if (targetIdx !== impactIdx) return state.board[impactIdx] ?? null;
    // The ability lands on the same square as the missile. What ends up on
    // that square depends on the ability.
    if (parsed.hero === 'necromancer') {
      const letter = (state.turn === 'w' ? 'P' : 'p') as PieceLetter;
      return { color: state.turn, letter };
    }
    if (parsed.hero === 'warlord') {
      // Warlord already destroyed the piece; the missile lands on an empty
      // square (no doomed piece to draw).
      return null;
    }
    // Frost / mutation / ICBM: no board change at the target square beyond
    // what was already there.
    return state.board[impactIdx] ?? null;
  }
  if (uci.length < 4) return state.board[impactIdx] ?? null;
  const fromIdx = sqToIdx(uci.slice(0, 2));
  const toIdx = sqToIdx(uci.slice(2, 4));
  // A Slime blob shift moves four tiles at once — map the impact square
  // through the whole-blob translation rather than the single from→to pair.
  const blobMover = state.board[fromIdx];
  if (blobMover && blobMover.letter.toUpperCase() === 'S') {
    const group = state.slimes.find((g) => g.tiles.includes(fromIdx));
    if (group) {
      const [ff, fr] = frOfIdx(fromIdx);
      const [tf, tr] = frOfIdx(toIdx);
      const df = tf - ff, dr = tr - fr;
      const newTiles = group.tiles.map((tIdx) => {
        const [f, r] = frOfIdx(tIdx);
        return idxFR(f + df, r + dr);
      });
      if (newTiles.includes(impactIdx)) return blobMover;
      if (group.tiles.includes(impactIdx)) return null;
      return state.board[impactIdx] ?? null;
    }
  }
  if (fromIdx === impactIdx) return null;
  if (toIdx === impactIdx) {
    const mover = state.board[fromIdx];
    if (!mover) return null;
    if (uci.length >= 5) {
      const promoChar = uci[4];
      const letter = (mover.color === 'w'
        ? promoChar.toUpperCase()
        : promoChar.toLowerCase()) as PieceLetter;
      return { color: mover.color, letter };
    }
    return mover;
  }
  return state.board[impactIdx] ?? null;
}

// ------------------------------------------------------------------
// Apply move (board or ability)
// ------------------------------------------------------------------
export function applyMove(state: GameState, uci: string): { state: GameState; result: MoveResult } | null {
  if (isAbilityUci(uci)) {
    const parsed = parseAbility(uci);
    if (!parsed) return null;
    const color = state.turn;
    if (state.heroes[color].hero !== parsed.hero) return null;
    if (!abilityReady(state, color)) return null;
    const targetIdx = sqToIdx(parsed.to);
    let next: GameState;
    let captured = false;
    if (parsed.hero === 'goofball') {
      if (!parsed.from) return null;
      const fromIdx = sqToIdx(parsed.from);
      if (!goofballLegalDestinations(state, fromIdx).includes(targetIdx)) return null;
      // Track whether the forced opp move was a capture so SFX still play.
      captured = !!state.board[targetIdx];
      next = applyAbility(state, 'goofball', targetIdx, fromIdx, parsed.promo);
    } else if (parsed.hero === 'twin-jutsu') {
      if (!parsed.from) return null;
      const fromIdx = sqToIdx(parsed.from);
      if (!twinJutsuLegalDestinations(state, fromIdx).includes(targetIdx)) return null;
      next = applyAbility(state, 'twin-jutsu', targetIdx, fromIdx, parsed.promo);
    } else if (parsed.hero === 'flight') {
      if (!parsed.from) return null;
      const fromIdx = sqToIdx(parsed.from);
      if (!flightLegalDestinations(state, fromIdx).includes(targetIdx)) return null;
      next = applyAbility(state, 'flight', targetIdx, fromIdx, parsed.promo);
    } else if (parsed.hero === 'slime') {
      if (!parsed.from) return null;
      const fromIdx = sqToIdx(parsed.from);
      if (!slimeLegalDestinations(state, fromIdx).includes(targetIdx)) return null;
      next = applyAbility(state, 'slime', targetIdx, fromIdx);
    } else {
      if (!abilityTargets(state).includes(targetIdx)) return null;
      next = applyAbility(state, parsed.hero, targetIdx);
      if (parsed.hero === 'warlord') {
        captured = true;
      } else if (parsed.hero === 'juggernaut') {
        // Quake leap can capture; rampage can flatten several pieces;
        // convert only flips allegiance. A simple piece-count diff covers
        // all three (plus any missile landing on the same ply).
        const count = (b: (Piece | null)[]) => b.reduce((n, p) => n + (p ? 1 : 0), 0);
        captured = count(next.board) < count(state.board);
      }
    }
    if (isInCheck(next, color)) return null;
    const kingDestroyed = detectKingDestroyed(state, next);
    const slimeSplits = detectSlimeSplits(state, next);
    const check = isInCheck(next, next.turn);
    const jugPhantom = !check && jugWouldBeInCheck(next);
    const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalAbility(next);
    // ICBM-king-strike counts as checkmate-style end: surface it as
    // checkmate=true so the existing finalize flow runs.
    const checkmate = (check && !oppHasMoves) || kingDestroyed != null;
    const stalemate = !check && !oppHasMoves && kingDestroyed == null;
    return {
      state: next,
      result: {
        uci,
        fenAfter: toFen(next),
        captured,
        castled: false,
        abilityUsed: parsed.hero,
        check,
        checkmate,
        stalemate,
        kingDestroyed,
        ...(slimeSplits.length > 0 ? { slimeSplits } : {}),
        ...(jugPhantom ? { jugPhantomCheck: true } : {}),
      },
    };
  }

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promoChar = uci.length >= 5 ? uci[4].toUpperCase() : undefined;
  const fromIdx = sqToIdx(from);
  const toIdx = sqToIdx(to);
  // Earthquake squares are impassable terrain — mirror the legalMovesFrom
  // filter at the apply layer so a typed / wire UCI can't bypass it.
  if (state.earthquakes.some((eq) => eq.idx === toIdx)) return null;
  const pseudos = pseudoMoves(state, fromIdx).filter((m) => m.to === toIdx);
  if (pseudos.length === 0) return null;
  const moverColor = state.board[fromIdx]?.color;
  if (!moverColor || moverColor !== state.turn) return null;

  let chosen: PseudoMove | null = null;
  for (const pm of pseudos) {
    if (pm.promotion) {
      if (promoChar && pm.promotion === promoChar) { chosen = pm; break; }
    } else if (!promoChar) {
      chosen = pm; break;
    }
  }
  if (!chosen) return null;

  const next = applyPseudo(state, chosen);
  if (isInCheck(next, moverColor)) return null;
  // Spending your last king square to capture a sub-tier-3 Juggernaut is
  // suicide — illegal, mirroring the filter in legalMovesFrom.
  if (hasAnyKingSquare(state, moverColor) && !hasAnyKingSquare(next, moverColor)) return null;

  const dest = state.board[toIdx];
  const kingDestroyed = detectKingDestroyed(state, next);
  const slimeSplits = detectSlimeSplits(state, next);
  // Missile demolition on the same ply counts as a capture for sfx/result —
  // but only when the missile actually destroys something. A piece moving
  // OFF the impact square leaves it empty before the explosion lands, so
  // that case is not a capture (we'd otherwise play the capture sound for
  // a piece that successfully escaped the strike).
  const missileCaptured = kingDestroyed != null || state.missiles.some((m) =>
    m.landsAtPly === next.ply &&
    m.idx !== chosen.from &&
    state.board[m.idx] != null,
  );
  const captured = !!dest || !!chosen.enPassantCapture || missileCaptured
    || (chosen.slimeCrushes != null && chosen.slimeCrushes.length > 0);
  const check = isInCheck(next, next.turn);
  const jugPhantom = !check && jugWouldBeInCheck(next);
  const oppHasMoves = allLegalBoardMoves(next).length > 0 || anyLegalAbility(next);
  const checkmate = (check && !oppHasMoves) || kingDestroyed != null;
  const stalemate = !check && !oppHasMoves && kingDestroyed == null;

  return {
    state: next,
    result: {
      uci,
      fenAfter: toFen(next),
      captured,
      castled: !!chosen.castle,
      abilityUsed: null,
      check,
      checkmate,
      stalemate,
      kingDestroyed,
      ...(slimeSplits.length > 0 ? { slimeSplits } : {}),
      ...(jugPhantom ? { jugPhantomCheck: true } : {}),
    },
  };
}

// Compare pre/post king presence to surface the loser of a missile strike
// (or a Slime crush that flattened the last enemy kings). King material
// counts both 'K' and Slime 'S' tiles.
function detectKingDestroyed(prev: GameState, next: GameState): C2Color | null {
  if (hasAnyKingSquare(prev, 'w') && !hasAnyKingSquare(next, 'w')) return 'w';
  if (hasAnyKingSquare(prev, 'b') && !hasAnyKingSquare(next, 'b')) return 'b';
  return null;
}

// Slime blobs that dissolved between prev and next — a group with no
// surviving entry sharing any tile split into minis (or was wiped out).
// Returns the destroyed tile squares + the squares where minis appeared.
function detectSlimeSplits(prev: GameState, next: GameState): { tiles: Square[]; minis: Square[] }[] {
  if (prev.slimes.length === 0) return [];
  const out: { tiles: Square[]; minis: Square[] }[] = [];
  for (const g of prev.slimes) {
    const ref = prev.board[g.tiles[0]];
    const color = ref?.color;
    // A shifted blob keeps an entry overlapping its old tiles; a split blob
    // has no successor at all. The successor must be the same side's blob —
    // an enemy blob crushing INTO this group's tiles also overlaps them.
    const survived = next.slimes.some((g2) =>
      g2.tiles.some((t) => g.tiles.includes(t)) &&
      next.board[g2.tiles[0]]?.color === color,
    );
    if (survived) continue;
    const minis: Square[] = [];
    const tiles: Square[] = [];
    for (const t of g.tiles) {
      const p = next.board[t];
      if (p && p.color === color && p.letter.toUpperCase() === 'K') minis.push(idxToSq(t));
      else tiles.push(idxToSq(t));
    }
    out.push({ tiles, minis });
  }
  return out;
}

// ------------------------------------------------------------------
// FEN serialization. Standard fields + a final whitespace token encoding
// hero/cooldown/frozen state. Frozen field is comma-separated `idx:exp`
// pairs so multiple simultaneous freezes survive the round-trip.
// ------------------------------------------------------------------
export function toFen(state: GameState): string {
  const parts: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[idxFR(f, r)];
      if (!p) { empty++; continue; }
      if (empty > 0) { row += empty; empty = 0; }
      row += p.letter;
    }
    if (empty > 0) row += empty;
    parts.push(row);
  }
  const board = parts.join('/');
  const ep = state.enPassant ?? '-';
  const wH = state.heroes.w;
  const bH = state.heroes.b;
  // A Juggernaut side carries its tier as a 4th hero-token field so the
  // position key distinguishes otherwise-identical boards at different tiers.
  const wT = wH.hero === 'juggernaut' ? `:${state.jugTier.w}` : '';
  const bT = bH.hero === 'juggernaut' ? `:${state.jugTier.b}` : '';
  const hero = `${wH.hero}:${wH.cooldownUntilPly}:${wH.flightUsed ? 1 : 0}${wT}|${bH.hero}:${bH.cooldownUntilPly}:${bH.flightUsed ? 1 : 0}${bT}`;
  const frozen = state.frozen.length === 0
    ? '-'
    : state.frozen.map((f) => `${f.idx}:${f.expiresAtPly}`).join(',');
  const missiles = state.missiles.length === 0
    ? '-'
    : state.missiles.map((m) => `${m.idx}:${m.landsAtPly}:${m.firedBy}`).join(',');
  let cas = '';
  if (state.castling.wK) cas += 'K';
  if (state.castling.wQ) cas += 'Q';
  if (state.castling.bK) cas += 'k';
  if (state.castling.bQ) cas += 'q';
  if (cas === '') cas = '-';
  // Twin-Jutsu mask bits, encoded as a 16-char hex string (4 bits/char ×16 =
  // 64 squares). Emitted as '-' when no piece is masked so the FEN stays
  // compact for non-Twin-Jutsu games.
  let masked = '-';
  if (state.masked && state.masked.some(Boolean)) {
    let hex = '';
    for (let nib = 0; nib < 16; nib++) {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        if (state.masked[nib * 4 + b]) v |= 1 << b;
      }
      hex += v.toString(16);
    }
    masked = hex;
  }
  // Slime blob groups: `t.t.t.t` per blob, comma-separated. '-' when no blob
  // is on the board so non-Slime FENs stay unchanged.
  const slimes = state.slimes.length === 0
    ? '-'
    : state.slimes.map((g) => g.tiles.join('.')).join(',');
  // Stunned pieces (Juggernaut slam) — same `idx:exp` format as frozen.
  const stunned = state.stunned.length === 0
    ? '-'
    : state.stunned.map((s) => `${s.idx}:${s.expiresAtPly}`).join(',');
  // Travelling earthquakes (Juggernaut tier 1) — `idx:df:dr:color:spawnPly`.
  const earthquakes = state.earthquakes.length === 0
    ? '-'
    : state.earthquakes.map((e) => `${e.idx}:${e.df}:${e.dr}:${e.color}:${e.spawnedAtPly}`).join(',');
  return `${board} ${state.turn} ${cas} ${ep} ${state.halfmove} ${state.fullmove} ${state.ply} ${hero} ${frozen} ${missiles} ${masked} ${slimes} ${stunned} ${earthquakes}`;
}

function positionKey(state: GameState): string {
  // Include hero / cooldown / freeze so threefold doesn't get tricked by
  // identical-looking boards that diverge in ability state.
  return toFen(state);
}

// ------------------------------------------------------------------
// End-state checks
// ------------------------------------------------------------------
export function isCheckmate(state: GameState): boolean {
  if (!isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalAbility(state);
}
export function isStalemate(state: GameState): boolean {
  if (isInCheck(state, state.turn)) return false;
  return allLegalBoardMoves(state).length === 0 && !anyLegalAbility(state);
}
export function isThreefoldRepetition(state: GameState): boolean {
  const key = positionKey(state);
  let count = 0;
  for (const k of state.positionHistory) if (k === key) count++;
  return count >= 3;
}
export function isFiftyMoveRule(state: GameState): boolean {
  return state.halfmove >= 100;
}
// K-vs-K is the only auto-draw — heroes can revive material via Necromancer
// so other "insufficient material" cases aren't really insufficient.
export function isInsufficientMaterial(state: GameState): boolean {
  let wK = 0, bK = 0;
  for (const p of state.board) {
    if (!p) continue;
    if (p.letter.toUpperCase() !== 'K') return false; // 'S' tiles are mating material too
    if (p.color === 'w') wK++; else bK++;
  }
  // A mini-king swarm can still mate (and can re-expand into a blob).
  if (wK > 1 || bK > 1) return false;
  // If either side could still spawn or freeze meaningfully, don't auto-draw.
  if (state.heroes.w.hero === 'necromancer' && state.ply >= state.heroes.w.cooldownUntilPly) return false;
  if (state.heroes.b.hero === 'necromancer' && state.ply >= state.heroes.b.cooldownUntilPly) return false;
  // A Slime side can grow its last king back into a blob, which can mate.
  if (state.heroes.w.hero === 'slime' && state.ply >= state.heroes.w.cooldownUntilPly) return false;
  if (state.heroes.b.hero === 'slime' && state.ply >= state.heroes.b.cooldownUntilPly) return false;
  return true;
}
