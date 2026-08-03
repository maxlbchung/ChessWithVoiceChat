// Chess Civilization engine — a hex-grid, turn-based strategy mode that lives
// entirely outside the chess variants: no FEN, no UCI, no recordings/replays.
// The page (src/pages/Civilization.tsx) is the only consumer.
//
// Board: axial coordinates (q, r) on a hexagonal map of `radius` rings around
// the origin, pointy-top hexes. Tiles are keyed "q,r". Terrain is generated
// once per game from a seeded PRNG and never mutates afterwards, so clones of
// the state share the `tiles` record.
//
// Chess flavor:
//   - your home base is a rook (immobile, spawns units, prints gold)
//   - pawns and kings step one hex; kings can settle a new rook base
//   - knights jump over units, up to 3 hexes
//   - bishops fire a bullet at anything within a 3-hex radius
//   - the horde renders as black pawns/knights gone bad

// ── Types ────────────────────────────────────────────────────────────────

export type Axial = { q: number; r: number };
export type Terrain = 'plains' | 'forest' | 'mountain' | 'water' | 'gold';
export type CivMode = 'zombie' | 'ai' | 'vs';
export type Faction = 'p1' | 'p2' | 'zombie';
export type UnitKind = 'pawn' | 'knight' | 'bishop' | 'king' | 'base' | 'zombie' | 'brute';

export type Unit = {
  id: number;
  kind: UnitKind;
  faction: Faction;
  q: number;
  r: number;
  hp: number;
  maxHp: number;
  atk: number;
  /** Turn fully spent: attacked, settled, spawned — or moved without momentum. */
  acted: boolean;
  /** Used its movement this turn. Momentum units can still attack after. */
  moved: boolean;
};

// ── Unit properties ──────────────────────────────────────────────────────
// Named traits the UI can surface and the rules key off:
//   momentum — may move and then attack in the same turn (attacking ends it)
//   ranged   — attacks at a distance instead of walking into the target
//   anchor   — takes half damage on strong ground (forest, mountain, or a
//              "city": being a base or standing beside a friendly one), and
//              is the only kind of unit that can climb mountains

export type UnitProperty = 'momentum' | 'ranged' | 'anchor';

export const UNIT_PROPS: Record<UnitKind, UnitProperty[]> = {
  pawn: ['momentum'],
  knight: ['momentum'],
  bishop: ['ranged'],
  king: ['anchor'],
  base: ['anchor'],
  zombie: [],
  brute: ['momentum'],
};

export function hasProp(kind: UnitKind, p: UnitProperty): boolean {
  return UNIT_PROPS[kind].includes(p);
}

export type CivResult = { winner: Faction; reason: string };

export type CivState = {
  mode: CivMode;
  seed: number;
  radius: number;
  /** Terrain by "q,r" key. Immutable after generation — shared across clones. */
  tiles: Record<string, Terrain>;
  units: Unit[];
  nextId: number;
  /** Full rounds, 1-based. Increments when control returns to p1. */
  turn: number;
  current: Faction;
  gold: { p1: number; p2: number };
  wave: number;
  log: string[];
  result: CivResult | null;
  /** PRNG state for in-game randomness (wave spawns, AI tie-breaks). */
  rng: number;
  /** Fog of war: every tile a faction has ever seen. Visibility is computed
      fresh from unit positions (visibleTiles); this only ever grows. */
  explored: { p1: Set<string>; p2: Set<string> };
};

export type CivEvent = {
  type: 'move' | 'melee' | 'shot' | 'spawn' | 'settle' | 'wave' | 'death';
  from?: Axial;
  to?: Axial;
  /** The acting unit, for animation/sfx flavor (knight leap vs pawn step). */
  unitKind?: UnitKind;
  /** For melee/shot: what got hit, and whether it died. */
  targetKind?: UnitKind;
  targetFaction?: Faction;
  died?: boolean;
};

export type UnitActions = {
  /** Empty passable tiles this unit can move to. */
  moves: Axial[];
  /** Enemy-occupied tiles this unit can strike (bishop: shoot from afar). */
  attacks: Axial[];
  /** King only: may found a new base on its current tile. */
  canSettle: boolean;
};

// ── Constants ────────────────────────────────────────────────────────────

export const BUYABLE_KINDS = ['pawn', 'knight', 'bishop', 'king'] as const;
export type BuyableKind = (typeof BUYABLE_KINDS)[number];

export const UNIT_STATS: Record<
  BuyableKind,
  { cost: number; hp: number; atk: number; blurb: string }
> = {
  pawn: {
    cost: 1,
    hp: 6,
    atk: 2,
    blurb: 'Steps one hex, then can still strike. Momentum.',
  },
  knight: {
    cost: 3,
    hp: 10,
    atk: 3,
    blurb: 'Leaps up to 2 hexes over anything, then strikes. Momentum.',
  },
  bishop: {
    cost: 3,
    hp: 7,
    atk: 3,
    blurb: 'Steps one hex, or fires a bullet up to 3 hexes. Ranged.',
  },
  king: {
    cost: 50,
    hp: 12,
    atk: 2,
    blurb: 'Steps one hex; settles new bases. Anchor: half damage on strong ground.',
  },
};

export const BASE_HP = 30;
export const BASE_INCOME = 8;
export const GOLD_TILE_INCOME = 3; // per gold tile within base territory (radius 2)
export const GOLD_WORKED_INCOME = 2; // per gold tile a unit stands on, outside territory
export const STARTING_GOLD = 25;
export const WAVE_EVERY = 3; // a new horde every N rounds
export const SETTLE_MIN_DIST = 3; // min distance between bases
export const MAP_RADIUS = 14; // massive: 631 tiles, most of it under fog
const AI_UNIT_CAP = 12;
// The horde materializes this far from the nearest player base — close enough
// to arrive within a few turns of its wave, far enough to stay out of sight.
const WAVE_SPAWN_NEAR = 7;
const WAVE_SPAWN_FAR = 10;

const PASSABLE: Record<Terrain, boolean> = {
  plains: true,
  forest: true,
  gold: true,
  mountain: false,
  water: false,
};

// ── Hex math ─────────────────────────────────────────────────────────────

export const axialKey = (q: number, r: number) => `${q},${r}`;

const DIRS: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexNeighbors(h: Axial): Axial[] {
  return DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Pointy-top axial → pixel center. */
export function hexToPixel(h: Axial, size: number): { x: number; y: number } {
  return {
    x: size * Math.sqrt(3) * (h.q + h.r / 2),
    y: size * 1.5 * h.r,
  };
}

/** Corner offsets of a pointy-top hex, for an SVG polygon `points` string. */
export function hexCornerPoints(size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(size * Math.cos(a)).toFixed(2)},${(size * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** All hexes within `radius` rings of the origin. */
export function allHexes(radius: number): Axial[] {
  const out: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      out.push({ q, r });
    }
  }
  return out;
}

/** Hexes on the line between a and b (cube lerp + round), endpoints included. */
function hexLine(a: Axial, b: Axial): Axial[] {
  const n = hexDistance(a, b);
  if (n === 0) return [a];
  const out: Axial[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // cube coords: x=q, z=r, y=-q-r
    const x = a.q + (b.q - a.q) * t;
    const z = a.r + (b.r - a.r) * t;
    const y = -x - z;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);
    const dx = Math.abs(rx - x);
    const dy = Math.abs(ry - y);
    const dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    out.push({ q: rx, r: rz });
  }
  return out;
}

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Advance the state-embedded RNG. Call only on an owned (cloned) state. */
function roll(state: CivState): number {
  const f = mulberry32(state.rng);
  const v = f();
  state.rng = (state.rng + 0x9e3779b9) >>> 0;
  return v;
}

// ── Map generation ───────────────────────────────────────────────────────

function generateTiles(seed: number, radius: number, starts: Axial[]): Record<string, Terrain> {
  const rand = mulberry32(seed);
  const hexes = allHexes(radius);

  // Value noise: random per-tile values, smoothed twice with neighbors so
  // water/mountain/forest come out as clumps instead of static.
  let values = new Map<string, number>();
  for (const h of hexes) values.set(axialKey(h.q, h.r), rand());
  for (let pass = 0; pass < 2; pass++) {
    const next = new Map<string, number>();
    for (const h of hexes) {
      const k = axialKey(h.q, h.r);
      let sum = values.get(k)! * 2;
      let n = 2;
      for (const nb of hexNeighbors(h)) {
        const v = values.get(axialKey(nb.q, nb.r));
        if (v !== undefined) {
          sum += v;
          n++;
        }
      }
      next.set(k, sum / n);
    }
    values = next;
  }

  // Percentile thresholds keep terrain ratios stable across seeds.
  const sorted = [...values.values()].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const waterMax = at(0.13);
  const forestMin = at(0.72);
  const mountainMin = at(0.9);

  const tiles: Record<string, Terrain> = {};
  for (const h of hexes) {
    const k = axialKey(h.q, h.r);
    const v = values.get(k)!;
    let t: Terrain;
    if (v <= waterMax) t = 'water';
    else if (v >= mountainMin) t = 'mountain';
    else if (v >= forestMin) t = 'forest';
    else t = 'plains';
    if (t === 'plains' && rand() < 0.08) t = 'gold';
    tiles[k] = t;
  }

  // Clear ground around every start: radius 1 is always plains, radius 2
  // just can't be impassable.
  for (const s of starts) {
    for (const h of hexes) {
      const d = hexDistance(h, s);
      const k = axialKey(h.q, h.r);
      if (d <= 1) tiles[k] = 'plains';
      else if (d === 2 && !PASSABLE[tiles[k]]) tiles[k] = 'plains';
    }
  }

  // Connectivity: every start and all six map corners must be reachable from
  // the first start; carve a plains path along the hex line where they aren't.
  const corners: Axial[] = [
    { q: radius, r: 0 },
    { q: 0, r: radius },
    { q: -radius, r: radius },
    { q: -radius, r: 0 },
    { q: 0, r: -radius },
    { q: radius, r: -radius },
  ];
  const reachable = () => {
    const seen = new Set<string>([axialKey(starts[0].q, starts[0].r)]);
    const queue: Axial[] = [starts[0]];
    while (queue.length) {
      const h = queue.shift()!;
      for (const nb of hexNeighbors(h)) {
        const k = axialKey(nb.q, nb.r);
        if (tiles[k] !== undefined && PASSABLE[tiles[k]] && !seen.has(k)) {
          seen.add(k);
          queue.push(nb);
        }
      }
    }
    return seen;
  };
  for (const target of [...starts.slice(1), ...corners]) {
    if (!reachable().has(axialKey(target.q, target.r))) {
      for (const h of hexLine(starts[0], target)) {
        const k = axialKey(h.q, h.r);
        if (!PASSABLE[tiles[k]]) tiles[k] = 'plains';
      }
    }
  }

  return tiles;
}

// ── Game setup ───────────────────────────────────────────────────────────

function makeUnit(
  state: { nextId: number },
  kind: UnitKind,
  faction: Faction,
  at: Axial,
  stats: { hp: number; atk: number },
  acted = false,
): Unit {
  return {
    id: state.nextId++,
    kind,
    faction,
    q: at.q,
    r: at.r,
    hp: stats.hp,
    maxHp: stats.hp,
    atk: stats.atk,
    acted,
    moved: acted,
  };
}

export function newGame(mode: CivMode, seed: number, radius = MAP_RADIUS): CivState {
  const spread = Math.max(2, radius - 4);
  const starts: Axial[] =
    mode === 'zombie'
      ? [{ q: 0, r: 0 }]
      : [
          { q: -spread, r: 0 },
          { q: spread, r: 0 },
        ];
  const tiles = generateTiles(seed, radius, starts);

  const state: CivState = {
    mode,
    seed,
    radius,
    tiles,
    units: [],
    nextId: 1,
    turn: 1,
    current: 'p1',
    gold: { p1: STARTING_GOLD, p2: STARTING_GOLD },
    wave: 0,
    log: [],
    result: null,
    rng: (seed ^ 0xc0ffee) >>> 0 || 1,
    explored: { p1: new Set(), p2: new Set() },
  };

  const factions: Faction[] = mode === 'zombie' ? ['p1'] : ['p1', 'p2'];
  factions.forEach((f, i) => {
    const s = starts[i];
    state.units.push(makeUnit(state, 'base', f, s, { hp: BASE_HP, atk: 0 }));
    // Two starting pawns on the first free neighbors.
    let placed = 0;
    for (const nb of hexNeighbors(s)) {
      if (placed >= 2) break;
      const k = axialKey(nb.q, nb.r);
      if (tiles[k] !== undefined && PASSABLE[tiles[k]]) {
        state.units.push(makeUnit(state, 'pawn', f, nb, UNIT_STATS.pawn));
        placed++;
      }
    }
  });

  pushLog(
    state,
    mode === 'zombie'
      ? `The horde stirs. First wave at the end of turn ${WAVE_EVERY}.`
      : mode === 'ai'
        ? 'A rival civilization rises somewhere across the map.'
        : 'Two civilizations. One map. Good luck.',
  );
  updateExplored(state);
  return state;
}

// ── Fog of war ───────────────────────────────────────────────────────────

/** How far a unit sees — the same reach it moves or attacks with. */
export function viewRange(u: Unit): number {
  switch (u.kind) {
    case 'bishop':
      return 3; // fire range
    case 'knight':
    case 'brute':
      return 2; // leap range
    case 'base':
      return 2; // a base watches its territory
    default:
      return 1;
  }
}

/** Tiles faction `f` can see right now: union of every unit's view range. */
export function visibleTiles(state: CivState, f: Faction): Set<string> {
  const out = new Set<string>();
  for (const u of state.units) {
    if (u.faction !== f) continue;
    const range = viewRange(u);
    for (let dq = -range; dq <= range; dq++) {
      for (
        let dr = Math.max(-range, -dq - range);
        dr <= Math.min(range, -dq + range);
        dr++
      ) {
        const k = axialKey(u.q + dq, u.r + dr);
        if (state.tiles[k] !== undefined) out.add(k);
      }
    }
  }
  return out;
}

/** Fold current visibility into both players' explored maps. Mutates. */
function updateExplored(state: CivState) {
  for (const f of ['p1', 'p2'] as const) {
    if (f === 'p2' && state.mode === 'zombie') continue;
    for (const k of visibleTiles(state, f)) state.explored[f].add(k);
  }
}

// ── State helpers ────────────────────────────────────────────────────────

function clone(state: CivState): CivState {
  return {
    ...state,
    units: state.units.map((u) => ({ ...u })),
    gold: { ...state.gold },
    log: [...state.log],
    explored: { p1: new Set(state.explored.p1), p2: new Set(state.explored.p2) },
    // tiles is immutable after generation — safe to share.
  };
}

function pushLog(state: CivState, msg: string) {
  state.log = [...state.log.slice(-9), msg];
}

export function unitAt(state: CivState, q: number, r: number): Unit | undefined {
  return state.units.find((u) => u.q === q && u.r === r);
}

function terrainAt(state: CivState, h: Axial): Terrain | undefined {
  return state.tiles[axialKey(h.q, h.r)];
}

function isPassable(state: CivState, h: Axial): boolean {
  const t = terrainAt(state, h);
  return t !== undefined && PASSABLE[t];
}

function isFreePassable(state: CivState, h: Axial): boolean {
  return isPassable(state, h) && !unitAt(state, h.q, h.r);
}

/** Where can this unit stand? Anchors alone can climb mountains. */
function canStand(state: CivState, u: Unit, h: Axial): boolean {
  const t = terrainAt(state, h);
  if (t === undefined) return false;
  if (PASSABLE[t]) return true;
  return t === 'mountain' && hasProp(u.kind, 'anchor');
}

/** Knight reach: BFS up to `depth` over passable terrain, ignoring units. */
function jumpReach(state: CivState, from: Axial, depth: number): Axial[] {
  const seen = new Set<string>([axialKey(from.q, from.r)]);
  let frontier: Axial[] = [from];
  const out: Axial[] = [];
  for (let step = 0; step < depth; step++) {
    const next: Axial[] = [];
    for (const h of frontier) {
      for (const nb of hexNeighbors(h)) {
        const k = axialKey(nb.q, nb.r);
        if (!seen.has(k) && isPassable(state, nb)) {
          seen.add(k);
          next.push(nb);
          out.push(nb);
        }
      }
    }
    frontier = next;
  }
  return out;
}

const BISHOP_RANGE = 3;
const KNIGHT_REACH = 2;

export function unitActions(state: CivState, unitId: number): UnitActions {
  const empty: UnitActions = { moves: [], attacks: [], canSettle: false };
  const u = state.units.find((x) => x.id === unitId);
  if (!u || u.acted || u.faction !== state.current || state.result) return empty;
  const here = { q: u.q, r: u.r };

  if (u.kind === 'base') return empty;

  // A momentum unit that already moved keeps its attacks (from the new
  // position) but not its movement; everyone else spends the turn on the
  // first action, so `moved && !acted` never happens for them.
  const canMove = !u.moved;

  let moves: Axial[] = [];
  let attacks: Axial[];

  if (u.kind === 'knight' || u.kind === 'brute') {
    const reach = jumpReach(state, here, KNIGHT_REACH);
    attacks = [];
    for (const h of reach) {
      const occ = unitAt(state, h.q, h.r);
      if (!occ) {
        if (canMove) moves.push(h);
      } else if (occ.faction !== u.faction) attacks.push(h);
    }
  } else if (u.kind === 'bishop') {
    // Ranged: shoot anything within radius — no need to walk there.
    if (canMove) moves = hexNeighbors(here).filter((h) => isFreePassable(state, h));
    attacks = state.units
      .filter((e) => e.faction !== u.faction && hexDistance(here, e) <= BISHOP_RANGE)
      .map((e) => ({ q: e.q, r: e.r }));
  } else {
    // pawn / king / zombie: step one hex (anchors may step onto mountains).
    if (canMove) {
      moves = hexNeighbors(here).filter(
        (h) => canStand(state, u, h) && !unitAt(state, h.q, h.r),
      );
    }
    attacks = hexNeighbors(here)
      .map((h) => unitAt(state, h.q, h.r))
      .filter((e): e is Unit => !!e && e.faction !== u.faction)
      .map((e) => ({ q: e.q, r: e.r }));
  }

  let canSettle = false;
  if (u.kind === 'king' && !u.moved) {
    const t = terrainAt(state, here);
    const nearBase = state.units.some(
      (b) => b.kind === 'base' && hexDistance(b, here) < SETTLE_MIN_DIST,
    );
    canSettle = t !== undefined && PASSABLE[t] && !nearBase;
  }

  return { moves, attacks, canSettle };
}

// ── Combat ───────────────────────────────────────────────────────────────

/** Anchor ground: forest, mountain, or a "city" — being a base, or standing
    beside a friendly one. */
function onAnchorGround(state: CivState, u: Unit): boolean {
  const t = terrainAt(state, u);
  if (t === 'forest' || t === 'mountain') return true;
  if (u.kind === 'base') return true;
  return state.units.some(
    (b) => b.kind === 'base' && b.faction === u.faction && hexDistance(b, u) <= 1,
  );
}

/** Forest shelters defenders (−1, bases excluded); anchors then halve what's
    left while on strong ground. Never below 1. */
function damageAgainst(state: CivState, attacker: Unit, defender: Unit): number {
  let dmg = attacker.atk;
  if (defender.kind !== 'base' && terrainAt(state, defender) === 'forest') dmg -= 1;
  dmg = Math.max(1, dmg);
  if (hasProp(defender.kind, 'anchor') && onAnchorGround(state, defender)) {
    dmg = Math.max(1, Math.ceil(dmg / 2));
  }
  return dmg;
}

const KIND_NAMES: Record<UnitKind, string> = {
  pawn: 'Pawn',
  knight: 'Knight',
  bishop: 'Bishop',
  king: 'King',
  base: 'Base',
  zombie: 'Zombie',
  brute: 'Brute',
};

function factionName(state: CivState, f: Faction): string {
  if (f === 'zombie') return 'Horde';
  if (state.mode === 'vs') return f === 'p1' ? 'Blue' : 'Red';
  return f === 'p1' ? 'You' : 'Enemy';
}

/** "Your Pawn destroyed", "Enemy Knight destroyed" — for possessive log lines. */
function possessiveName(state: CivState, f: Faction): string {
  const n = factionName(state, f);
  return n === 'You' ? 'Your' : n;
}

/** Remove dead unit, check elimination. Returns true if defender died. */
function resolveHit(state: CivState, attacker: Unit, defender: Unit): boolean {
  defender.hp -= damageAgainst(state, attacker, defender);
  if (defender.hp > 0) return false;
  state.units = state.units.filter((x) => x.id !== defender.id);
  pushLog(
    state,
    `${possessiveName(state, defender.faction)} ${KIND_NAMES[defender.kind]} destroyed.`,
  );
  checkElimination(state);
  return true;
}

function checkElimination(state: CivState) {
  if (state.result) return;
  const hasBase = (f: Faction) =>
    state.units.some((u) => u.faction === f && u.kind === 'base');
  if (!hasBase('p1')) {
    state.result =
      state.mode === 'zombie'
        ? { winner: 'zombie', reason: `Your last base fell. Survived ${state.wave} waves.` }
        : { winner: 'p2', reason: `${factionName(state, 'p2')} razed the last base.` };
  } else if (state.mode !== 'zombie' && !hasBase('p2')) {
    state.result = { winner: 'p1', reason: `${factionName(state, 'p1')} razed the last enemy base.` };
  }
}

// ── Player actions ───────────────────────────────────────────────────────

/** Move to an empty tile or strike an enemy on it. Null if illegal. */
export function moveOrAttack(
  state: CivState,
  unitId: number,
  to: Axial,
): { state: CivState; event: CivEvent } | null {
  const acts = unitActions(state, unitId);
  const isMove = acts.moves.some((h) => h.q === to.q && h.r === to.r);
  const isAttack = acts.attacks.some((h) => h.q === to.q && h.r === to.r);
  if (!isMove && !isAttack) return null;

  const next = clone(state);
  const u = next.units.find((x) => x.id === unitId)!;
  const from = { q: u.q, r: u.r };

  if (isMove) {
    u.q = to.q;
    u.r = to.r;
    u.moved = true;
    // Momentum: the turn stays open if there's something to hit from here.
    if (!hasProp(u.kind, 'momentum') || unitActions(next, unitId).attacks.length === 0) {
      u.acted = true;
    }
    updateExplored(next);
    return { state: next, event: { type: 'move', from, to, unitKind: u.kind } };
  }

  // Attacking always ends the turn.
  u.acted = true;
  const defender = unitAt(next, to.q, to.r)!;
  const hit = {
    unitKind: u.kind,
    targetKind: defender.kind,
    targetFaction: defender.faction,
  };
  const died = resolveHit(next, u, defender);
  if (u.kind === 'bishop') {
    return { state: next, event: { type: 'shot', from, to, ...hit, died } };
  }
  // Melee: if the tile is now clear, the attacker takes it.
  if (died) {
    u.q = to.q;
    u.r = to.r;
    updateExplored(next);
  }
  return { state: next, event: { type: 'melee', from, to, ...hit, died } };
}

export function spawnTargets(state: CivState, baseId: number): Axial[] {
  const b = state.units.find((x) => x.id === baseId);
  if (!b || b.kind !== 'base' || b.acted || b.faction !== state.current || state.result) return [];
  return hexNeighbors(b).filter((h) => isFreePassable(state, h));
}

export function buyUnit(
  state: CivState,
  baseId: number,
  kind: BuyableKind,
  to: Axial,
): { state: CivState; event: CivEvent } | null {
  if (state.current === 'zombie') return null;
  const stats = UNIT_STATS[kind];
  if (state.gold[state.current] < stats.cost) return null;
  if (!spawnTargets(state, baseId).some((h) => h.q === to.q && h.r === to.r)) return null;

  const next = clone(state);
  const b = next.units.find((x) => x.id === baseId)!;
  b.acted = true;
  next.gold[next.current as 'p1' | 'p2'] -= stats.cost;
  next.units.push(makeUnit(next, kind, next.current, to, stats, true));
  pushLog(next, `${KIND_NAMES[kind]} recruited for ${stats.cost}g.`);
  updateExplored(next);
  return { state: next, event: { type: 'spawn', to, unitKind: kind } };
}

/** A king founds a new rook base where it stands, consuming the king. */
export function settleKing(
  state: CivState,
  unitId: number,
): { state: CivState; event: CivEvent } | null {
  if (!unitActions(state, unitId).canSettle) return null;
  const next = clone(state);
  const u = next.units.find((x) => x.id === unitId)!;
  const at = { q: u.q, r: u.r };
  next.units = next.units.filter((x) => x.id !== unitId);
  const base = makeUnit(next, 'base', u.faction, at, { hp: BASE_HP, atk: 0 }, true);
  next.units.push(base);
  pushLog(next, `${factionName(next, u.faction)} founded a new base.`);
  updateExplored(next);
  return { state: next, event: { type: 'settle', to: at, unitKind: 'base' } };
}

// ── Turn flow ────────────────────────────────────────────────────────────

/** Gold tiles inside any own base's 2-hex territory, plus worked gold tiles. */
function incomeFor(state: CivState, f: 'p1' | 'p2'): number {
  const bases = state.units.filter((u) => u.faction === f && u.kind === 'base');
  let income = bases.length * BASE_INCOME;
  const counted = new Set<string>();
  for (const [k, t] of Object.entries(state.tiles)) {
    if (t !== 'gold' || counted.has(k)) continue;
    const [q, r] = k.split(',').map(Number);
    if (bases.some((b) => hexDistance(b, { q, r }) <= 2)) {
      counted.add(k);
      income += GOLD_TILE_INCOME;
    }
  }
  for (const u of state.units) {
    if (u.faction !== f || u.kind === 'base') continue;
    const k = axialKey(u.q, u.r);
    if (state.tiles[k] === 'gold' && !counted.has(k)) {
      counted.add(k);
      income += GOLD_WORKED_INCOME;
    }
  }
  return income;
}

/** What `f` will collect at its next turn start — for the HUD. */
export function incomePreview(state: CivState, f: 'p1' | 'p2'): number {
  return incomeFor(state, f);
}

/** Start-of-turn upkeep for a player faction: income, healing, fresh actions. */
function beginPlayerTurn(state: CivState, f: 'p1' | 'p2') {
  state.current = f;
  const income = incomeFor(state, f);
  state.gold[f] += income;
  const bases = state.units.filter((u) => u.faction === f && u.kind === 'base');
  for (const u of state.units) {
    if (u.faction !== f) continue;
    u.acted = false;
    u.moved = false;
    // Field hospital: units next to a friendly base patch up.
    if (u.kind !== 'base' && u.hp < u.maxHp && bases.some((b) => hexDistance(b, u) <= 1)) {
      u.hp = Math.min(u.maxHp, u.hp + 1);
    }
  }
  updateExplored(state);
}

function spawnWave(state: CivState) {
  state.wave++;
  const count = 2 + state.wave;
  const hp = 3 + state.wave;
  const atk = 1 + Math.floor(state.wave / 3);
  // Materialize a few hexes out from the nearest player base — outside
  // anyone's sight if possible, so the fog is what warns you. Falls back to
  // wider rings if the neighborhood is cramped.
  const bases = state.units.filter((u) => u.faction === 'p1' && u.kind === 'base');
  const seen = visibleTiles(state, 'p1');
  const distToBase = (h: Axial) =>
    bases.length ? Math.min(...bases.map((b) => hexDistance(b, h))) : hexDistance(h, { q: 0, r: 0 });
  const candidates = (near: number, far: number, dodgeSight: boolean) =>
    allHexes(state.radius).filter((h) => {
      const d = distToBase(h);
      if (d < near || d > far) return false;
      if (dodgeSight && seen.has(axialKey(h.q, h.r))) return false;
      return isFreePassable(state, h);
    });
  let pool = candidates(WAVE_SPAWN_NEAR, WAVE_SPAWN_FAR, true);
  if (pool.length < count) pool = candidates(WAVE_SPAWN_NEAR - 2, WAVE_SPAWN_FAR + 4, true);
  if (pool.length < count) pool = candidates(2, state.radius * 2, false);
  let spawned = 0;
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(roll(state) * pool.length);
    const [spot] = pool.splice(idx, 1);
    const brute = state.wave % 3 === 0 && i === 0;
    state.units.push(
      makeUnit(
        state,
        brute ? 'brute' : 'zombie',
        'zombie',
        spot,
        brute ? { hp: hp * 2 + 2, atk: atk + 1 } : { hp, atk },
      ),
    );
    spawned++;
  }
  pushLog(state, `Wave ${state.wave} — ${spawned} of the horde shamble in.`);
}

/**
 * End the current player's turn. Hands control to the next faction:
 * zombie mode p1→zombie, ai mode p1→p2(AI), vs mode p1↔p2.
 * Enemy factions (zombie, ai-p2) are then driven by repeated enemyStep calls.
 */
export function endPlayerTurn(state: CivState): CivState {
  if (state.result || state.current === 'zombie') return state;
  const next = clone(state);

  if (next.mode === 'vs') {
    if (next.current === 'p1') {
      beginPlayerTurn(next, 'p2');
    } else {
      next.turn++;
      beginPlayerTurn(next, 'p1');
    }
    return next;
  }

  if (next.mode === 'ai') {
    if (next.current === 'p1') {
      // AI turn: income now; units act via enemyStep.
      beginPlayerTurn(next, 'p2');
      return next;
    }
    next.turn++;
    beginPlayerTurn(next, 'p1');
    return next;
  }

  // zombie mode: hand to the horde.
  next.current = 'zombie';
  for (const u of next.units) {
    if (u.faction === 'zombie') {
      u.acted = false;
      u.moved = false;
    }
  }
  if (next.turn % WAVE_EVERY === 0) spawnWave(next);
  return next;
}

export function isEnemyTurn(state: CivState): boolean {
  if (state.result) return false;
  return state.current === 'zombie' || (state.mode === 'ai' && state.current === 'p2');
}

// ── Enemy brains ─────────────────────────────────────────────────────────

/** Multi-source BFS distance field over passable terrain toward `targets`. */
function distanceField(state: CivState, targets: Axial[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Axial[] = [];
  for (const t of targets) {
    dist.set(axialKey(t.q, t.r), 0);
    queue.push(t);
  }
  while (queue.length) {
    const h = queue.shift()!;
    const d = dist.get(axialKey(h.q, h.r))!;
    for (const nb of hexNeighbors(h)) {
      const k = axialKey(nb.q, nb.r);
      if (!dist.has(k) && isPassable(state, nb)) {
        dist.set(k, d + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

function enemiesOf(state: CivState, f: Faction): Unit[] {
  return state.units.filter((u) => u.faction !== f);
}

/** Pick the strike target: bases first, then lowest hp. */
function pickTarget(state: CivState, attacks: Axial[]): Axial {
  const units = attacks.map((h) => unitAt(state, h.q, h.r)!);
  units.sort((a, b) => {
    if ((a.kind === 'base') !== (b.kind === 'base')) return a.kind === 'base' ? -1 : 1;
    return a.hp - b.hp;
  });
  return { q: units[0].q, r: units[0].r };
}

/** One enemy unit (or AI base) takes its action. */
export function enemyStep(state: CivState): { state: CivState; event?: CivEvent; done: boolean } {
  if (!isEnemyTurn(state)) return { state, done: true };
  const f = state.current;

  // AI base spawning, one purchase per base per turn.
  if (f === 'p2') {
    const base = state.units.find((u) => u.faction === 'p2' && u.kind === 'base' && !u.acted);
    if (base) {
      const next = clone(state);
      const b = next.units.find((x) => x.id === base.id)!;
      b.acted = true;
      const army = next.units.filter((u) => u.faction === 'p2' && u.kind !== 'base');
      const spots = hexNeighbors(b).filter((h) => isFreePassable(next, h));
      if (army.length < AI_UNIT_CAP && spots.length) {
        const affordable = BUYABLE_KINDS.filter(
          (k) => k !== 'king' && UNIT_STATS[k].cost <= next.gold.p2,
        );
        if (affordable.length) {
          // Early pawns, then whatever's fanciest with a bit of wobble.
          const pawns = army.filter((u) => u.kind === 'pawn').length;
          const kind =
            pawns < 2 && affordable.includes('pawn')
              ? 'pawn'
              : affordable[
                  roll(next) < 0.35 ? 0 : Math.floor(roll(next) * affordable.length)
                ];
          const spot = spots[Math.floor(roll(next) * spots.length)];
          next.gold.p2 -= UNIT_STATS[kind].cost;
          next.units.push(makeUnit(next, kind, 'p2', spot, UNIT_STATS[kind], true));
          updateExplored(next);
          return { state: next, event: { type: 'spawn', to: spot, unitKind: kind }, done: false };
        }
      }
      return { state: next, done: false };
    }
  }

  const mover = state.units.find((u) => u.faction === f && u.kind !== 'base' && !u.acted);
  if (!mover) {
    // Horde/AI exhausted — hand back to p1.
    const next = clone(state);
    next.turn++;
    beginPlayerTurn(next, 'p1');
    return { state: next, done: true };
  }

  const acts = unitActions(state, mover.id);
  if (acts.attacks.length) {
    const res = moveOrAttack(state, mover.id, pickTarget(state, acts.attacks))!;
    return { state: res.state, event: res.event, done: false };
  }

  // No strike available: walk toward the nearest enemy thing.
  const targets = enemiesOf(state, f).map((u) => ({ q: u.q, r: u.r }));
  const next = clone(state);
  const u = next.units.find((x) => x.id === mover.id)!;
  u.acted = true;
  if (targets.length && acts.moves.length) {
    const field = distanceField(next, targets);
    let best = acts.moves[0];
    let bestD = field.get(axialKey(best.q, best.r)) ?? Infinity;
    for (const h of acts.moves) {
      const d = field.get(axialKey(h.q, h.r)) ?? Infinity;
      if (d < bestD || (d === bestD && roll(next) < 0.35)) {
        best = h;
        bestD = d;
      }
    }
    const here = field.get(axialKey(u.q, u.r)) ?? Infinity;
    if (bestD < here) {
      const from = { q: u.q, r: u.r };
      u.q = best.q;
      u.r = best.r;
      u.moved = true;
      // Momentum enemies keep the turn open if the step brought a target
      // into reach — the next enemyStep will pick them again and strike.
      if (hasProp(u.kind, 'momentum')) {
        u.acted = false;
        if (unitActions(next, u.id).attacks.length === 0) u.acted = true;
      }
      updateExplored(next);
      return {
        state: next,
        event: { type: 'move', from, to: best, unitKind: u.kind },
        done: false,
      };
    }
  }
  return { state: next, done: false };
}
