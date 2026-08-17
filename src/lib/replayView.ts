import { Chess } from 'chess.js';
import type { Piece as MergePiece } from './mergeChess';
import type { Replay } from './gameExport';
import { HERO_INFO, goofballSlides, hollowPurpleOrigin, idxToSq as heroIdxToSq, kingSquareOf } from './heroChess';
import { idxToSq as sweeperIdxToSq, revealedCounts } from './sweeperChess';

// A board snapshot at a given ply, normalized across every variant into the
// shared MergePiece board shape plus the optional Hero/Slime/etc. overlays.
// Extracted from Review.tsx so the video editor can reuse the exact same
// replay→display projection (one source of truth for "what does ply N look
// like").
export type DisplaySnapshot = {
  board: (MergePiece | null)[];
  lastMove: { from: string; to: string } | null;
  kingGlows?: { w?: string; b?: string };
  frozenSquares?: string[];
  missiles?: { sq: string; pliesLeft: number; firedBy: 'w' | 'b' }[];
  maskedAsKingSquares?: string[];
  slimeBigKings?: { tiles: string[]; color: 'w' | 'b' }[];
  slimeKingSquares?: string[];
  juggernauts?: { sq: string; tier: number }[];
  stunnedSquares?: string[];
  explosiveSquares?: string[];
  earthquakes?: { sq: string; df: number; dr: number; color: 'w' | 'b' }[];
  hollowPurples?: { sq: string; df: number; dr: number; color: 'w' | 'b'; from?: string }[];
  // Chesssweeper: revealed adjacency numbers + craters left by blown mines.
  sweeperCounts?: { sq: string; count: number }[];
  sweeperCraters?: string[];
};

export function totalPlyOf(r: Replay): number {
  return r.variant === 'normal' ? r.san.length : r.results.length;
}

export function displayAt(r: Replay, viewPly: number): DisplaySnapshot {
  if (r.variant === 'normal') {
    const chess = new Chess();
    const all = r.initial.history(); // empty — we rewound it
    void all;
    // Rebuild by replaying SAN from san[] since we use it as the canonical
    // forward record for normal games.
    for (let i = 0; i < Math.min(viewPly, r.san.length); i++) {
      chess.move(r.san[i]);
    }
    const board: (MergePiece | null)[] = [];
    for (const row of chess.board()) {
      for (const cell of row) {
        if (cell == null) { board.push(null); continue; }
        const letter = cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
        board.push({ color: cell.color, letter: letter as MergePiece['letter'] });
      }
    }
    let lastMove: { from: string; to: string } | null = null;
    if (viewPly > 0) {
      const verbose = chess.history({ verbose: true }) as Array<{ from: string; to: string }>;
      const m = verbose[viewPly - 1];
      if (m) lastMove = { from: m.from, to: m.to };
    }
    return { board, lastMove };
  }
  if (r.variant === 'merge') {
    const state = r.states[viewPly] ?? r.states[0];
    const lastMove = lastMoveFromUci(viewPly, r.results.map((x) => x.uci));
    return { board: state.board as (MergePiece | null)[], lastMove };
  }
  if (r.variant === 'two') {
    const state = r.states[viewPly] ?? r.states[0];
    const lastMove = lastMoveFromUci(viewPly, r.results.map((x) => x.uci));
    return { board: state.board as unknown as (MergePiece | null)[], lastMove };
  }
  if (r.variant === 'cash') {
    const state = r.states[viewPly] ?? r.states[0];
    const uci = viewPly > 0 ? r.results[viewPly - 1]?.uci : undefined;
    let lastMove: { from: string; to: string } | null = null;
    if (uci) {
      // Cash buy: "+L<sq>" — tint the placement square only.
      if (uci.startsWith('+')) {
        const sq = uci.slice(2, 4);
        lastMove = { from: sq, to: sq };
      } else if (/^[a-h][1-8][a-h][1-8]/.test(uci)) {
        lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
      }
    }
    return { board: state.board as unknown as (MergePiece | null)[], lastMove };
  }
  if (r.variant === 'setup') {
    const state = r.states[viewPly] ?? r.states[0];
    const lastMove = lastMoveFromUci(viewPly, r.results.map((x) => x.uci));
    return { board: state.board as (MergePiece | null)[], lastMove };
  }
  if (r.variant === 'secret') {
    // Replays show both fakes honestly as the queens they are, from ply 0 —
    // review has no notion of "self vs opponent", and the game is over, so
    // there is nothing left to hide. (The engine board already carries Q/q
    // for the fakes; masking is a live-game UI concern.)
    const state = r.states[viewPly] ?? r.states[0];
    const lastMove = lastMoveFromUci(viewPly, r.results.map((x) => x.uci));
    return { board: state.board as (MergePiece | null)[], lastMove };
  }
  if (r.variant === 'sweeper') {
    const state = r.states[viewPly] ?? r.states[0];
    const lastMove = lastMoveFromUci(viewPly, r.results.map((x) => x.uci));
    return {
      board: state.board as (MergePiece | null)[],
      lastMove,
      sweeperCounts: revealedCounts(state).map(({ idx, count }) => ({ sq: sweeperIdxToSq(idx), count })),
      sweeperCraters: state.detonated.map(sweeperIdxToSq),
    };
  }
  // hero
  const state = r.states[viewPly] ?? r.states[0];
  const uci = viewPly > 0 ? r.results[viewPly - 1]?.uci : undefined;
  let lastMove: { from: string; to: string } | null = null;
  if (uci) {
    if (uci.startsWith('!')) {
      // Hero ability UCIs: !<letter><sq>[<dest>][<promo>] — pick the most
      // visually informative tint per kind. Twin-Jutsu/Goofball/Flight encode
      // two squares; the others encode one target.
      const hero = uci[1];
      if (hero === 'G' && goofballSlides(uci).length > 0) {
        // Goofball forces one or two opponent moves — tint where the
        // puppeting started and where it ended up.
        const legs = goofballSlides(uci);
        lastMove = { from: legs[0].from, to: legs[legs.length - 1].to };
      } else if (hero === 'T' || hero === 'G' || hero === 'L' || hero === 'S') {
        const a = uci.slice(2, 4);
        const b = uci.slice(4, 6);
        lastMove = { from: a, to: b };
      } else {
        const sq = uci.slice(2, 4);
        lastMove = { from: sq, to: sq };
      }
    } else if (/^[a-h][1-8][a-h][1-8]/.test(uci)) {
      lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    }
  }
  const board = state.board as unknown as (MergePiece | null)[];
  const kingGlows = {
    w: state.heroes.w.hero === 'slime' ? undefined : HERO_INFO[state.heroes.w.hero].glowColor,
    b: state.heroes.b.hero === 'slime' ? undefined : HERO_INFO[state.heroes.b.hero].glowColor,
  };
  const frozenSquares = state.frozen
    .filter((f) => state.ply < f.expiresAtPly)
    .map((f) => heroIdxToSq(f.idx));
  const missiles = state.missiles.map((m) => ({
    sq: heroIdxToSq(m.idx),
    pliesLeft: Math.max(0, m.landsAtPly - state.ply),
    firedBy: m.firedBy,
  }));
  // Render every masked-side piece as a king icon — review has no notion of
  // "self vs opponent", so we just show the opponent-perspective tells.
  const maskedAsKingSquares: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (state.masked[i] && state.board[i]) {
      maskedAsKingSquares.push(heroIdxToSq(i));
    }
  }
  // Slime: big-king blobs render via the stretched sprite; mini kings get
  // the goo overlay.
  const slimeBigKings = (state.slimes ?? [])
    .map((g: { tiles: number[] }) => {
      const ref = state.board[g.tiles[0]];
      return ref ? { tiles: g.tiles.map(heroIdxToSq), color: ref.color as 'w' | 'b' } : null;
    })
    .filter((g: unknown): g is { tiles: string[]; color: 'w' | 'b' } => g !== null);
  const slimeKingSquares: string[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.letter.toUpperCase() !== 'K') continue;
    if (state.heroes[p.color].hero === 'slime') slimeKingSquares.push(heroIdxToSq(i));
  }
  // Juggernaut: neutral king + tier pips, plus quake-leap stun overlays.
  const juggernauts: { sq: string; tier: number }[] = [];
  for (const c of ['w', 'b'] as const) {
    if (state.heroes[c].hero !== 'juggernaut') continue;
    const sq = kingSquareOf(state.board, c);
    if (sq) juggernauts.push({ sq, tier: state.jugTier[c] });
  }
  const stunnedSquares = state.stunned
    .filter((s) => state.ply < s.expiresAtPly)
    .map((s) => heroIdxToSq(s.idx));
  const explosiveSquares = (state.explosives ?? [])
    .filter((idx) => state.board[idx] != null)
    .map((idx) => heroIdxToSq(idx));
  const earthquakes = (state.earthquakes ?? []).map((eq) => ({
    sq: heroIdxToSq(eq.idx),
    df: eq.df,
    dr: eq.dr,
    color: eq.color,
  }));
  const hollowPurples = (state.hollowPurples ?? []).map((hp) => ({
    sq: heroIdxToSq(hp.idx),
    df: hp.df,
    dr: hp.dr,
    color: hp.color,
    from: hollowPurpleOrigin(state, hp) ?? undefined,
  }));
  return { board, lastMove, kingGlows, frozenSquares, missiles, maskedAsKingSquares, slimeBigKings, slimeKingSquares, juggernauts, stunnedSquares, explosiveSquares, earthquakes, hollowPurples };
}

export function lastMoveFromUci(viewPly: number, ucis: string[]): { from: string; to: string } | null {
  if (viewPly <= 0) return null;
  const uci = ucis[viewPly - 1];
  if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}
