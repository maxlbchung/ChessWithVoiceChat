// Chess Civilization — a standalone hex-grid strategy mode. Lives outside the
// app's Layout chrome on its own route (/app/#/civilization) and outside the
// base game: no lobby, no recordings, no replays, no ratings. Reached from the
// landing page. Engine: src/lib/civEngine.ts.
//
// The board is a camera over a massive fogged map: drag to pan, wheel to zoom
// (viewBox is mutated directly during gestures so 60fps pans don't re-render
// 600 tiles), fog clears to each piece's own move/attack range. Enemy turns
// play back step-by-step, but steps nobody can see apply instantly.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  newGame,
  allHexes,
  axialKey,
  hexToPixel,
  hexCornerPoints,
  unitActions,
  moveOrAttack,
  spawnTargets,
  buyUnit,
  settleKing,
  boostKing,
  endPlayerTurn,
  enemyStep,
  isEnemyTurn,
  incomePreview,
  visibleTiles,
  unitAt,
  UNIT_STATS,
  UNIT_PROPS,
  BUYABLE_KINDS,
  WAVE_EVERY,
  type UnitProperty,
  type CivState,
  type CivMode,
  type CivEvent,
  type Unit,
  type Axial,
  type Terrain,
  type BuyableKind,
  type Faction,
} from '../lib/civEngine';
import { renderPiece, type PieceKey } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';

const HEX = 30; // hex size in viewBox units
const STEP_VISIBLE_MS = 210; // enemy step pacing when the player can see it
const CAM_START_W = 640;
const CAM_MIN_W = 300;

const MODE_INFO: Record<CivMode, { name: string; tag: string; blurb: string }> = {
  zombie: {
    name: 'Zombie',
    tag: 'Survival',
    blurb:
      'Hold your rook base against a horde that never stops coming — and gets meaner with every wave.',
  },
  ai: {
    name: 'AI Civilizations',
    tag: 'Conquest',
    blurb:
      'A rival civilization expands from somewhere across the map. Out-grow it, then raze its base.',
  },
  vs: {
    name: 'Versus',
    tag: 'Hotseat',
    blurb:
      'Two players, one device. Pass the machine between turns and settle it the old way.',
  },
};

const KIND_LETTER: Record<Unit['kind'], string> = {
  pawn: 'P',
  knight: 'N',
  bishop: 'B',
  king: 'K',
  base: 'R',
  zombie: 'P',
  brute: 'N',
};

const KIND_LABEL: Record<Unit['kind'], string> = {
  pawn: 'Pawn',
  knight: 'Knight',
  bishop: 'Bishop',
  king: 'King',
  base: 'Rook Base',
  zombie: 'Zombie',
  brute: 'Brute',
};

const KIND_BLURB: Record<Unit['kind'], string> = {
  pawn: 'Steps one hex, then can still strike the same turn.',
  knight: 'Leaps up to 2 hexes over anything, then strikes.',
  bishop: 'Steps one hex, or fires a bullet at anything within 3 hexes.',
  king: 'Your one king. Moves and strikes like a pawn, rallies its neighbors, settles cities. If it falls, so do you.',
  base: 'Prints gold, recruits one unit a turn, heals its neighbors.',
  zombie: 'Shambles one hex a turn. It only wants your base.',
  brute: 'A hulk that lopes two hexes and swings in the same breath.',
};

const PROP_INFO: Record<UnitProperty, { label: string; desc: string }> = {
  momentum: { label: 'Momentum', desc: 'Can move and then attack in the same turn.' },
  ranged: { label: 'Ranged', desc: 'Attacks at a distance instead of walking in.' },
  anchor: {
    label: 'Anchor',
    desc: 'Half damage in forest, mountains, or a city (a base, or beside a friendly one). Can climb mountains.',
  },
};

const TERRAIN_NOTE: Record<Terrain, string> = {
  plains: 'Plains — open ground.',
  forest: 'Forest — sheltered (−1 damage taken).',
  gold: 'Gold field — pays out when worked or held in territory.',
  mountain: 'Mountains — impassable, except to anchor units holding the high ground.',
  water: 'Water — impassable.',
};

function pieceKeyFor(u: Unit): PieceKey {
  const color = u.faction === 'p1' ? 'w' : 'b';
  return `${color}${KIND_LETTER[u.kind]}` as PieceKey;
}

// ── Terrain decorations (drawn at the tile center) ───────────────────────

function TerrainDecor({ terrain }: { terrain: string }) {
  switch (terrain) {
    case 'forest':
      return (
        <g className="civ-decor-forest" aria-hidden>
          <path d="M -9 8 l 5 -11 l 5 11 z" />
          <path d="M 0 6 l 5.5 -13 l 5.5 13 z" />
          <path d="M -3 11 l 4.5 -9 l 4.5 9 z" />
        </g>
      );
    case 'mountain':
      return (
        <g className="civ-decor-mountain" aria-hidden>
          <path className="rock" d="M -13 10 L -3 -9 L 3 1 L 8 -6 L 15 10 z" />
          <path className="snow" d="M -3 -9 L 0 -3.5 L -5.5 -4.5 z" />
        </g>
      );
    case 'water':
      return (
        <g className="civ-decor-water" aria-hidden>
          <path d="M -11 -2 q 3 -4 6 0 t 6 0 t 6 0" />
          <path d="M -8 6 q 3 -4 6 0 t 6 0" />
        </g>
      );
    case 'gold':
      return (
        <g className="civ-decor-gold" aria-hidden>
          <circle r="6.2" />
          <path d="M 0 -3.4 L 1 -1 L 3.4 0 L 1 1 L 0 3.4 L -1 1 L -3.4 0 L -1 -1 z" />
        </g>
      );
    default:
      return null;
  }
}

// ── HP bar: one pip per hit point, so "3 hp" reads as three rectangles.
// Bases (30 hp) fall back to a continuous bar — 30 pips is static noise.

const HP_BAR_W = 28;
const HP_PIP_MAX = 12;

function HpBar({ hp, maxHp, size }: { hp: number; maxHp: number; size: number }) {
  const ratio = hp / maxHp;
  const tone = ratio > 0.55 ? 'ok' : ratio > 0.28 ? 'low' : 'crit';
  return (
    <g transform={`translate(${size / 2 - HP_BAR_W / 2} ${size + 1})`}>
      {maxHp <= HP_PIP_MAX ? (
        (() => {
          const gap = 1;
          const pipW = (HP_BAR_W - gap * (maxHp - 1)) / maxHp;
          return Array.from({ length: maxHp }, (_, i) => (
            <rect
              key={i}
              className={i < hp ? `civ-hp-pip ${tone}` : 'civ-hp-pip empty'}
              x={i * (pipW + gap)}
              width={pipW}
              height="4"
              rx="1"
            />
          ));
        })()
      ) : (
        <>
          <rect className="civ-hp-bg" width={HP_BAR_W} height="4" rx="2" />
          <rect
            className={`civ-hp-fill ${tone}`}
            width={Math.max(2, HP_BAR_W * ratio)}
            height="4"
            rx="2"
          />
        </>
      )}
    </g>
  );
}

// ── Transient board effects ──────────────────────────────────────────────

type FxInput =
  | { kind: 'bullet'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'impact'; x2: number; y2: number }
  | { kind: 'hit'; x2: number; y2: number }
  | { kind: 'boost'; x2: number; y2: number };
type Fx = FxInput & { id: number };

type Ghost = {
  id: number;
  x: number;
  y: number;
  piece: PieceKey;
  faction: Faction;
  size: number;
};

// ── Page ─────────────────────────────────────────────────────────────────

export function Civilization() {
  const [state, setState] = useState<CivState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [spawnKind, setSpawnKind] = useState<BuyableKind | null>(null);
  const [seedText, setSeedText] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [fx, setFx] = useState<Fx[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [hitStamp, setHitStamp] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [resultPlayed, setResultPlayed] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const camRef = useRef({ x: -CAM_START_W / 2, y: -CAM_START_W / 2, w: CAM_START_W, h: CAM_START_W * 0.85 });
  const dragRef = useRef({ active: false, px: 0, py: 0, moved: false });
  const waveRef = useRef(0);
  const fxId = useRef(1);

  // Whose fog do we render? p1 owns the screen except in hotseat.
  const viewer: 'p1' | 'p2' =
    state && state.mode === 'vs' && state.current !== 'zombie' ? state.current : 'p1';

  const acts = useMemo(
    () =>
      state && selected !== null
        ? unitActions(state, selected)
        : { moves: [], attacks: [], canSettle: false, canBoost: false },
    [state, selected],
  );
  const spawns = useMemo(
    () => (state && selected !== null && spawnKind ? spawnTargets(state, selected) : []),
    [state, selected, spawnKind],
  );
  const selectedUnit = state?.units.find((u) => u.id === selected) ?? null;
  const visible = useMemo(
    () => (state ? visibleTiles(state, viewer) : new Set<string>()),
    [state, viewer],
  );

  // ── Camera ─────────────────────────────────────────────────────────────

  const mapExtent = state ? Math.sqrt(3) * HEX * state.radius + HEX * 2 : 800;

  const applyCam = () => {
    const c = camRef.current;
    const pad = 60;
    const maxW = mapExtent * 2 + pad;
    c.w = Math.min(Math.max(c.w, CAM_MIN_W), maxW);
    c.h = c.w * 0.85;
    c.x = Math.min(Math.max(c.x, -mapExtent - pad), mapExtent + pad - c.w);
    c.y = Math.min(Math.max(c.y, -mapExtent - pad), mapExtent + pad - c.h);
    svgRef.current?.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`);
  };

  const centerOn = (h: Axial, w?: number) => {
    const c = camRef.current;
    if (w !== undefined) c.w = w;
    c.h = c.w * 0.85;
    const p = hexToPixel(h, HEX);
    c.x = p.x - c.w / 2;
    c.y = p.y - c.h / 2;
    applyCam();
  };

  const zoomBy = (factor: number) => {
    const c = camRef.current;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    c.w *= factor;
    c.h = c.w * 0.85;
    c.x = cx - c.w / 2;
    c.y = cy - c.h / 2;
    applyCam();
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = { active: true, px: e.clientX, py: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d.active || !svgRef.current) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const scale = camRef.current.w / svgRef.current.clientWidth;
    camRef.current.x -= dx * scale;
    camRef.current.y -= dy * scale;
    d.px = e.clientX;
    d.py = e.clientY;
    applyCam();
  };
  const onPointerUp = () => {
    dragRef.current.active = false;
  };

  // Wheel zoom must be a manual non-passive listener — React's synthetic
  // onWheel can't preventDefault the page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !state) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camRef.current;
      const rect = el.getBoundingClientRect();
      const mx = c.x + ((e.clientX - rect.left) / rect.width) * c.w;
      const my = c.y + ((e.clientY - rect.top) / rect.height) * c.h;
      const factor = e.deltaY > 0 ? 1.13 : 1 / 1.13;
      const oldW = c.w;
      c.w *= factor;
      c.h = c.w * 0.85;
      // Keep the point under the cursor fixed.
      const applied = c.w / oldW;
      c.x = mx - (mx - c.x) * applied;
      c.y = my - (my - c.y) * applied;
      applyCam();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state === null]);

  const homeBaseOf = (s: CivState, f: 'p1' | 'p2'): Axial => {
    const b = s.units.find((u) => u.faction === f && u.kind === 'base');
    return b ? { q: b.q, r: b.r } : { q: 0, r: 0 };
  };

  // ── Effects & sounds ───────────────────────────────────────────────────

  const pushFx = (f: FxInput, ttl = 550) => {
    const id = fxId.current++;
    setFx((cur) => [...cur, { ...f, id }]);
    window.setTimeout(() => setFx((cur) => cur.filter((x) => x.id !== id)), ttl);
  };

  const markHit = (to: Axial) => {
    const k = axialKey(to.q, to.r);
    setHitStamp((cur) => ({ ...cur, [k]: Date.now() }));
    window.setTimeout(
      () =>
        setHitStamp((cur) => {
          const next = { ...cur };
          delete next[k];
          return next;
        }),
      450,
    );
  };

  const spawnGhost = (prev: CivState, ev: CivEvent) => {
    if (!ev.died || !ev.to || !ev.targetKind || !ev.targetFaction) return;
    const { x, y } = hexToPixel(ev.to, HEX);
    const size = ev.targetKind === 'base' ? 44 : 36;
    const id = fxId.current++;
    void prev;
    setGhosts((cur) => [
      ...cur,
      {
        id,
        x,
        y,
        size,
        faction: ev.targetFaction!,
        piece: `${ev.targetFaction === 'p1' ? 'w' : 'b'}${KIND_LETTER[ev.targetKind!]}` as PieceKey,
      },
    ]);
    window.setTimeout(() => setGhosts((cur) => cur.filter((g) => g.id !== id)), 700);
  };

  const stepSfxFor = (terrain: Terrain | undefined, kind: CivEvent['unitKind']) => {
    if (kind === 'knight' || kind === 'brute') return sfx.playLeap();
    if (kind === 'zombie') {
      // Groan sometimes, shuffle otherwise — a whole horde groaning every
      // step would be a wall of noise.
      return Math.random() < 0.35 ? sfx.playZombieGroan() : sfx.playStepPlains();
    }
    if (terrain === 'forest') return sfx.playStepForest();
    if (terrain === 'gold') return sfx.playStepGold();
    return sfx.playStepPlains();
  };

  /** Play sound + spawn board fx for an engine event. prev = state before it. */
  const playEvent = (prev: CivState, ev: CivEvent | undefined) => {
    if (!ev) return;
    const terrainAtTo = ev.to ? prev.tiles[axialKey(ev.to.q, ev.to.r)] : undefined;
    switch (ev.type) {
      case 'move':
        stepSfxFor(terrainAtTo, ev.unitKind);
        break;
      case 'melee': {
        if (ev.targetKind === 'base') sfx.playBaseHit();
        else sfx.playCapture();
        if (ev.to) {
          markHit(ev.to);
          const p = hexToPixel(ev.to, HEX);
          pushFx({ kind: 'hit', x2: p.x, y2: p.y });
        }
        spawnGhost(prev, ev);
        break;
      }
      case 'shot': {
        sfx.playSlice();
        if (ev.from && ev.to) {
          const a = hexToPixel(ev.from, HEX);
          const b = hexToPixel(ev.to, HEX);
          pushFx({ kind: 'bullet', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, 260);
          const to = ev.to;
          window.setTimeout(() => {
            sfx.playBulletImpact();
            if (ev.targetKind === 'base') sfx.playBaseHit();
            markHit(to);
            const p = hexToPixel(to, HEX);
            pushFx({ kind: 'impact', x2: p.x, y2: p.y });
          }, 190);
        }
        spawnGhost(prev, ev);
        break;
      }
      case 'spawn':
        sfx.playSpawn();
        break;
      case 'settle':
        sfx.playPlace();
        break;
      case 'boost': {
        sfx.playMerge();
        if (ev.to) {
          const p = hexToPixel(ev.to, HEX);
          pushFx({ kind: 'boost', x2: p.x, y2: p.y }, 700);
        }
        break;
      }
    }
  };

  const eventIsVisible = (s: CivState, ev: CivEvent | undefined): boolean => {
    if (!ev) return false;
    const seen = visibleTiles(s, viewer);
    const at = (h?: Axial) => !!h && seen.has(axialKey(h.q, h.r));
    return at(ev.from) || at(ev.to);
  };

  // ── Enemy turn playback ────────────────────────────────────────────────
  // One visible step per tick; invisible steps (deep in the fog) apply
  // instantly in a synchronous batch so massive-map turns stay snappy.
  useEffect(() => {
    if (!state || !isEnemyTurn(state)) return;
    const t = window.setTimeout(() => {
      let cur = state;
      for (let guard = 0; guard < 400; guard++) {
        const res = enemyStep(cur);
        if (res.event && eventIsVisible(res.state, res.event)) {
          playEvent(cur, res.event);
          setState(res.state);
          return; // effect re-fires for the next step
        }
        cur = res.state;
        if (res.done) break;
      }
      setState(cur);
    }, STEP_VISIBLE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Wave arrival: toast + horde choir, once per wave.
  useEffect(() => {
    if (!state) return;
    if (state.wave > waveRef.current) {
      waveRef.current = state.wave;
      if (state.wave > 0) {
        sfx.playHordeArrive();
        const id = fxId.current++;
        setToast({ id, text: `Wave ${state.wave} — the horde shambles in` });
        window.setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), 2600);
      }
    }
  }, [state]);

  // Win/lose jingle, once.
  useEffect(() => {
    if (!state?.result || resultPlayed) return;
    setResultPlayed(true);
    if (state.result.winner === 'p1' || state.mode === 'vs') sfx.playWin();
    else sfx.playCheck();
  }, [state, resultPlayed]);

  // ── Flow ───────────────────────────────────────────────────────────────

  const start = (mode: CivMode) => {
    const seed = seedText.trim()
      ? Math.abs(
          [...seedText.trim()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
        ) || 7
      : Math.floor(Math.random() * 1e9);
    const s = newGame(mode, seed);
    setState(s);
    setSelected(null);
    setSpawnKind(null);
    setHandoff(false);
    setResultPlayed(false);
    setGhosts([]);
    setFx([]);
    waveRef.current = 0;
    // Land the camera on your base; the rest of the map is out there, dark.
    window.setTimeout(() => centerOn(homeBaseOf(s, 'p1'), CAM_START_W), 0);
  };

  const backToMenu = () => {
    setState(null);
    setSelected(null);
    setSpawnKind(null);
    setHandoff(false);
  };

  const deselect = () => {
    setSelected(null);
    setSpawnKind(null);
  };

  const onTile = (h: Axial) => {
    if (!state || state.result || isEnemyTurn(state) || handoff) return;
    if (dragRef.current.moved) return; // that was a pan, not a click

    // Spawn placement takes priority while a recruit card is armed.
    if (selected !== null && spawnKind) {
      if (spawns.some((s) => s.q === h.q && s.r === h.r)) {
        const res = buyUnit(state, selected, spawnKind, h);
        if (res) {
          sfx.playBuy();
          playEvent(state, res.event);
          setState(res.state);
          setSpawnKind(null);
          return;
        }
      }
      setSpawnKind(null);
    }

    if (selected !== null) {
      const inMoves = acts.moves.some((m) => m.q === h.q && m.r === h.r);
      const inAttacks = acts.attacks.some((m) => m.q === h.q && m.r === h.r);
      if (inMoves || inAttacks) {
        const res = moveOrAttack(state, selected, h);
        if (res) {
          playEvent(state, res.event);
          setState(res.state);
          // Momentum: a move that leaves targets in reach keeps the piece
          // selected so the follow-up strike is one click away.
          const still = res.state.units.find((x) => x.id === selected);
          if (!(res.event.type === 'move' && still && !still.acted)) deselect();
          return;
        }
      }
    }

    // Select anything you can see — your own pieces to command, enemy pieces
    // and towers to inspect.
    const u = unitAt(state, h.q, h.r);
    if (u && (u.faction === viewer || visible.has(axialKey(h.q, h.r)))) {
      sfx.playSelect();
      setSelected(u.id);
      setSpawnKind(null);
    } else {
      deselect();
    }
  };

  const onEndTurn = () => {
    if (!state || state.result || isEnemyTurn(state)) return;
    deselect();
    const next = endPlayerTurn(state);
    setState(next);
    if (next.mode === 'vs' && !next.result) {
      sfx.playFlip();
      setHandoff(true);
    }
  };

  const onHandoffReady = () => {
    setHandoff(false);
    if (state) centerOn(homeBaseOf(state, viewer), camRef.current.w);
  };

  const onSettle = () => {
    if (!state || selected === null) return;
    const res = settleKing(state, selected);
    if (res) {
      playEvent(state, res.event);
      setState(res.state);
      deselect();
    }
  };

  const onBoost = () => {
    if (!state || selected === null) return;
    const res = boostKing(state, selected);
    if (res) {
      playEvent(state, res.event);
      setState(res.state);
      deselect();
    }
  };

  // ── Menu screen ────────────────────────────────────────────────────────
  if (!state) {
    return (
      <div className="civ-shell">
        <header className="civ-topbar">
          <a href="../" className="brand" data-no-sfx>
            <span className="brand-mark">♜</span>
            <span className="brand-text">Chess Civilization</span>
          </a>
          <a className="civ-back-link" href="#/">
            ← Voice Chat Chess
          </a>
        </header>
        <main className="civ-menu">
          <p className="label-caps civ-eyebrow">A separate expedition · not the base game</p>
          <h1 className="civ-title">Chess Civilization</h1>
          <p className="civ-tagline">
            A turn-based civilization game on a massive, procedurally generated hex map. Your
            home base is a rook. Pawns and kings step, knights leap over anything, bishops
            fire across three hexes — and the world past your sight line is fog.
          </p>

          <div className="civ-mode-grid">
            {(Object.keys(MODE_INFO) as CivMode[]).map((m) => (
              <button key={m} className="civ-mode-card" data-mode={m} onClick={() => start(m)}>
                <span className="label-caps civ-mode-tag">{MODE_INFO[m].tag}</span>
                <span className="civ-mode-name">{MODE_INFO[m].name}</span>
                <span className="civ-mode-blurb">{MODE_INFO[m].blurb}</span>
                <span className="civ-mode-cta">Play →</span>
              </button>
            ))}
          </div>

          <div className="civ-seed-row">
            <label className="label-caps" htmlFor="civ-seed">
              Map seed
            </label>
            <input
              id="civ-seed"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              placeholder="random"
              spellCheck={false}
            />
          </div>

          <div className="civ-rules">
            <h2 className="label-caps">How it plays</h2>
            <ul>
              <li>
                <strong>Your king</strong> — you start with exactly one. It moves and strikes
                like a pawn, can <em>boost</em> its neighbors (+1 hp and a fresh turn, using
                its own), and founds new cities. If it dies — or you lose every city — the
                game is over.
              </li>
              <li>
                <strong>Rook city</strong> — prints {8}g a turn, recruits one unit a turn onto
                a neighboring hex, heals adjacent units.
              </li>
              <li>
                <strong>Pawn · 1g · 2hp</strong> — steps one hex. <strong>Knight · 3g · 5hp</strong>{' '}
                — leaps up to two hexes, over anything. <strong>Bishop · 3g · 3hp</strong> —
                steps one hex, or fires a bullet at any enemy within three hexes.
              </li>
              <li>
                <strong>Properties</strong> — pawns and knights have <em>momentum</em>: move,
                then still attack the same turn. Bishops are <em>ranged</em>. Kings and cities
                are <em>anchors</em>: half damage in forest, mountains, or a city — and kings
                alone can climb mountains.
              </li>
              <li>
                <strong>Fog</strong> — the map starts dark. Each piece clears fog exactly as
                far as it moves or attacks; ground you've seen stays mapped but goes dim when
                nobody's watching it. Drag to pan, scroll to zoom.
              </li>
              <li>
                <strong>Terrain</strong> — mountains and water are impassable. Forests shelter
                defenders (−1 damage). Gold tiles pay out when worked by a unit, more inside a
                base's territory.
              </li>
              <li>
                <strong>Turns</strong> — every unit gets one action: move, strike, shoot, or
                settle. Walking into an enemy strikes it; clear the hex and you take it. Click
                any enemy you can see for its details.
              </li>
            </ul>
          </div>
        </main>
        <footer className="civ-footer">
          <span>No recordings, no replays, no ratings — this one's just for the map.</span>
        </footer>
      </div>
    );
  }

  // ── Game screen ────────────────────────────────────────────────────────
  const mode = MODE_INFO[state.mode];
  const me = viewer;
  const enemyBusy = isEnemyTurn(state);
  const untilWave =
    state.mode === 'zombie' ? (WAVE_EVERY - (state.turn % WAVE_EVERY)) % WAVE_EVERY : 0;
  const playerLabel =
    state.mode === 'vs' ? (state.current === 'p1' ? 'Blue (White)' : 'Red (Black)') : null;

  const hexes = allHexes(state.radius);
  const corners = hexCornerPoints(HEX);
  const cornersInner = hexCornerPoints(HEX - 2.2);
  const key = (a: Axial) => axialKey(a.q, a.r);
  const moveSet = new Set((selected !== null && !spawnKind ? acts.moves : []).map(key));
  const attackSet = new Set((selected !== null && !spawnKind ? acts.attacks : []).map(key));
  const spawnSet = new Set(spawns.map(key));
  const explored = state.explored[me];
  const cam = camRef.current;

  const selectedIsMine = selectedUnit?.faction === state.current && !enemyBusy;
  const selectedVisible =
    selectedUnit &&
    (selectedUnit.faction === me || visible.has(axialKey(selectedUnit.q, selectedUnit.r)));

  return (
    <div className="civ-shell">
      <header className="civ-topbar">
        <a href="../" className="brand" data-no-sfx>
          <span className="brand-mark">♜</span>
          <span className="brand-text">Chess Civilization</span>
        </a>
        <span className="label-caps civ-mode-indicator">
          {mode.name} · turn {state.turn}
        </span>
        <button className="link-btn" onClick={backToMenu}>
          menu
        </button>
      </header>

      <main className="civ-game">
        <div className="civ-board-wrap">
          <svg
            ref={svgRef}
            className="civ-board"
            viewBox={`${cam.x} ${cam.y} ${cam.w} ${cam.h}`}
            preserveAspectRatio="xMidYMid slice"
            role="img"
            aria-label="Chess Civilization map"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {hexes.map((hx) => {
              const k = key(hx);
              const t = state.tiles[k];
              const { x, y } = hexToPixel(hx, HEX);
              const isExplored = explored.has(k);
              const isVisible = visible.has(k);
              if (!isExplored) {
                return (
                  <g key={k} transform={`translate(${x} ${y})`} data-hex={k} className="civ-tile civ-tile-unseen">
                    <polygon className="civ-hex" points={corners} onClick={() => onTile(hx)} />
                  </g>
                );
              }
              const interactive = moveSet.has(k) || attackSet.has(k) || spawnSet.has(k);
              return (
                <g
                  key={k}
                  transform={`translate(${x} ${y})`}
                  data-hex={k}
                  className={
                    `civ-tile civ-tile-${t}` +
                    (interactive ? ' civ-tile-hot' : '') +
                    (isVisible ? '' : ' civ-tile-dim')
                  }
                  onClick={() => onTile(hx)}
                >
                  <polygon className="civ-hex" points={corners} />
                  <TerrainDecor terrain={t} />
                  {!isVisible && <polygon className="civ-fog-veil" points={corners} />}
                  {moveSet.has(k) && (
                    <polygon className="civ-hint civ-hint-move" points={cornersInner} />
                  )}
                  {spawnSet.has(k) && (
                    <polygon className="civ-hint civ-hint-spawn" points={cornersInner} />
                  )}
                  {attackSet.has(k) && (
                    <polygon className="civ-hint civ-hint-attack" points={cornersInner} />
                  )}
                </g>
              );
            })}

            {/* Units — outer <g> carries the (transitioned) position, inner
                <g> carries enter/hit animations so the transforms compose. */}
            {state.units.map((u) => {
              const k = axialKey(u.q, u.r);
              if (u.faction !== me && !visible.has(k)) return null;
              const { x, y } = hexToPixel(u, HEX);
              const size = u.kind === 'base' ? 44 : 36;
              const spent = u.faction === state.current && u.acted && state.result === null;
              const hit = hitStamp[k] !== undefined;
              return (
                <g
                  key={u.id}
                  className={
                    `civ-unit civ-unit-${u.faction}` +
                    (u.id === selected ? ' civ-unit-selected' : '') +
                    (spent ? ' civ-unit-spent' : '')
                  }
                  style={{ transform: `translate(${x - size / 2}px, ${y - size / 2 - 3}px)` }}
                  pointerEvents="none"
                >
                  <g className={'civ-unit-body' + (hit ? ' civ-unit-hit' : '')}>
                    {renderPiece(pieceKeyFor(u), size)}
                    {u.hp < u.maxHp && <HpBar hp={u.hp} maxHp={u.maxHp} size={size} />}
                  </g>
                </g>
              );
            })}

            {/* Fallen units linger for a beat, fading out. */}
            {ghosts.map((g) => (
              <g
                key={`ghost-${g.id}`}
                className={`civ-unit civ-unit-${g.faction} civ-ghost`}
                style={{
                  transform: `translate(${g.x - g.size / 2}px, ${g.y - g.size / 2 - 3}px)`,
                }}
                pointerEvents="none"
              >
                <g className="civ-ghost-body">{renderPiece(g.piece, g.size)}</g>
              </g>
            ))}

            {/* Selection ring on top of the unit sprite. */}
            {selectedUnit &&
              selectedVisible &&
              (() => {
                const { x, y } = hexToPixel(selectedUnit, HEX);
                return (
                  <g transform={`translate(${x} ${y})`} pointerEvents="none">
                    <polygon
                      className={
                        'civ-selection' + (selectedIsMine ? '' : ' civ-selection-enemy')
                      }
                      points={corners}
                    />
                  </g>
                );
              })()}

            {fx.map((f) => {
              if (f.kind === 'bullet') {
                return (
                  <circle
                    key={f.id}
                    className="civ-fx-bullet"
                    cx={f.x1}
                    cy={f.y1}
                    r="4"
                    style={
                      {
                        '--tx': `${f.x2 - f.x1}px`,
                        '--ty': `${f.y2 - f.y1}px`,
                      } as React.CSSProperties
                    }
                    pointerEvents="none"
                  />
                );
              }
              return (
                <circle
                  key={f.id}
                  className={
                    f.kind === 'impact'
                      ? 'civ-fx-impact'
                      : f.kind === 'boost'
                        ? 'civ-fx-boost'
                        : 'civ-fx-hit'
                  }
                  cx={f.x2}
                  cy={f.y2}
                  r={f.kind === 'boost' ? 26 : 10}
                  pointerEvents="none"
                />
              );
            })}
          </svg>

          <div className="civ-cam-controls" aria-hidden>
            <button className="civ-cam-btn" data-no-sfx onClick={() => zoomBy(1 / 1.35)} title="Zoom in">
              +
            </button>
            <button className="civ-cam-btn" data-no-sfx onClick={() => zoomBy(1.35)} title="Zoom out">
              −
            </button>
            <button
              className="civ-cam-btn"
              data-no-sfx
              onClick={() => centerOn(homeBaseOf(state, me), CAM_START_W)}
              title="Back to base"
            >
              ⌂
            </button>
          </div>

          {toast && (
            <div key={toast.id} className="civ-toast">
              {toast.text}
            </div>
          )}

          {handoff && (
            <div className="civ-overlay">
              <div className="civ-overlay-card">
                <p className="label-caps">Pass the device</p>
                <h2>{playerLabel} to move</h2>
                <button className="primary-btn" onClick={onHandoffReady}>
                  Ready
                </button>
              </div>
            </div>
          )}

          {state.result && (
            <div className="civ-overlay">
              <div className="civ-overlay-card">
                <p className="label-caps">
                  {state.mode === 'zombie' ? `Wave ${state.wave}` : `Turn ${state.turn}`}
                </p>
                <h2>
                  {state.mode === 'vs'
                    ? `${state.result.winner === 'p1' ? 'Blue' : 'Red'} wins`
                    : state.result.winner === 'p1'
                      ? 'Victory'
                      : 'Defeat'}
                </h2>
                <p className="civ-result-reason">{state.result.reason}</p>
                <div className="civ-overlay-actions">
                  <button className="primary-btn" onClick={() => start(state.mode)}>
                    Play again
                  </button>
                  <button className="secondary-btn" onClick={backToMenu}>
                    Menu
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="civ-side">
          <section className="civ-panel civ-status">
            <div className="civ-stat">
              <span className="label-caps">
                {state.mode === 'vs' ? `${playerLabel} gold` : 'Gold'}
              </span>
              <span className="civ-stat-value">
                {state.gold[me]}g
                <em> +{incomePreview(state, me)}/turn</em>
              </span>
            </div>
            {state.mode === 'zombie' && (
              <div className="civ-stat">
                <span className="label-caps">Horde</span>
                <span className="civ-stat-value">
                  wave {state.wave}
                  <em>
                    {untilWave === 0
                      ? ' next: this turn'
                      : ` next in ${untilWave} turn${untilWave > 1 ? 's' : ''}`}
                  </em>
                </span>
              </div>
            )}
            {enemyBusy && (
              <p className="civ-enemy-banner">
                {state.current === 'zombie' ? 'The horde moves…' : 'Enemy civilization moves…'}
              </p>
            )}
          </section>

          <section className="civ-panel civ-selected">
            {selectedUnit && selectedVisible ? (
              <>
                <div className="civ-selected-head">
                  <span className="civ-selected-icon">
                    {renderPiece(pieceKeyFor(selectedUnit), 34)}
                  </span>
                  <div>
                    <strong>{KIND_LABEL[selectedUnit.kind]}</strong>
                    <span className="civ-selected-stats">
                      {selectedUnit.hp}/{selectedUnit.maxHp} hp
                      {selectedUnit.atk > 0 ? ` · ${selectedUnit.atk} atk` : ''}
                    </span>
                  </div>
                  <span
                    className={
                      'civ-faction-tag ' +
                      (selectedUnit.faction === me
                        ? 'mine'
                        : selectedUnit.faction === 'zombie'
                          ? 'horde'
                          : 'enemy')
                    }
                  >
                    {selectedUnit.faction === me
                      ? 'Yours'
                      : selectedUnit.faction === 'zombie'
                        ? 'Horde'
                        : state.mode === 'vs'
                          ? selectedUnit.faction === 'p1'
                            ? 'Blue'
                            : 'Red'
                          : 'Enemy'}
                  </span>
                </div>

                <p className="civ-hint-text">{KIND_BLURB[selectedUnit.kind]}</p>
                {UNIT_PROPS[selectedUnit.kind].length > 0 && (
                  <div className="civ-props">
                    {UNIT_PROPS[selectedUnit.kind].map((p) => (
                      <span key={p} className={`civ-prop civ-prop-${p}`} title={PROP_INFO[p].desc}>
                        {PROP_INFO[p].label}
                      </span>
                    ))}
                  </div>
                )}
                <p className="civ-hint-text civ-terrain-note">
                  {TERRAIN_NOTE[state.tiles[axialKey(selectedUnit.q, selectedUnit.r)]]}
                </p>
                {selectedIsMine && selectedUnit.moved && !selectedUnit.acted && (
                  <p className="civ-hint-text civ-momentum-note">
                    Momentum — it moved, and can still strike this turn.
                  </p>
                )}

                {selectedUnit.kind === 'base' && selectedUnit.faction === me && selectedIsMine ? (
                  <div className="civ-recruit">
                    <span className="label-caps">Recruit — pick, then place</span>
                    <div className="civ-recruit-grid">
                      {BUYABLE_KINDS.map((k) => {
                        const stats = UNIT_STATS[k];
                        const disabled =
                          selectedUnit.acted ||
                          state.gold[me] < stats.cost ||
                          spawnTargets(state, selectedUnit.id).length === 0;
                        return (
                          <button
                            key={k}
                            className={'civ-recruit-btn' + (spawnKind === k ? ' armed' : '')}
                            disabled={disabled}
                            data-recruit={k}
                            onClick={() => setSpawnKind(spawnKind === k ? null : k)}
                          >
                            <span className="civ-recruit-icon">
                              {renderPiece(
                                `${me === 'p2' ? 'b' : 'w'}${KIND_LETTER[k]}` as PieceKey,
                                26,
                              )}
                            </span>
                            <span className="civ-recruit-name">{KIND_LABEL[k]}</span>
                            <span className="civ-recruit-cost">{stats.cost}g</span>
                          </button>
                        );
                      })}
                    </div>
                    {selectedUnit.acted && (
                      <p className="civ-hint-text">This base already recruited this turn.</p>
                    )}
                    {spawnKind && (
                      <p className="civ-hint-text">Click a highlighted hex to place.</p>
                    )}
                  </div>
                ) : selectedIsMine && selectedUnit.acted ? (
                  <p className="civ-hint-text">Already acted this turn.</p>
                ) : null}

                {selectedUnit.kind === 'king' && selectedIsMine && (
                  <div className="civ-king-actions">
                    <button
                      className="secondary-btn"
                      disabled={!acts.canBoost || selectedUnit.acted}
                      onClick={onBoost}
                      title={
                        acts.canBoost
                          ? 'Rally adjacent allies: +1 hp and a fresh turn. Uses the king’s turn.'
                          : 'Needs an ally on a neighboring hex'
                      }
                    >
                      Boost allies
                    </button>
                    <button
                      className="secondary-btn"
                      disabled={!acts.canSettle}
                      onClick={onSettle}
                      title={
                        acts.canSettle
                          ? 'Found a city here — the king steps aside'
                          : 'Needs passable ground, 3 hexes clear of any city, and room to step aside'
                      }
                    >
                      Settle city
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="civ-hint-text">
                Select one of your pieces — or any enemy you can see — for details. Drag the
                map to pan; scroll to zoom. The fog clears as far as each piece can move or
                shoot.
              </p>
            )}
          </section>

          <button
            className="primary-btn big civ-end-turn"
            onClick={onEndTurn}
            disabled={!!state.result || enemyBusy || handoff}
          >
            End turn
          </button>

          <section className="civ-panel civ-log">
            <span className="label-caps">Dispatches</span>
            <ul>
              {[...state.log].reverse().map((line, i) => (
                <li key={`${state.log.length - i}-${line}`}>{line}</li>
              ))}
            </ul>
          </section>
        </aside>
      </main>
    </div>
  );
}
