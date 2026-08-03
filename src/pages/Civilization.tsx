// Chess Civilization — a standalone hex-grid strategy mode. Lives outside the
// app's Layout chrome on its own route (/app/#/civilization) and outside the
// base game: no lobby, no recordings, no replays, no ratings. Reached from the
// landing page. Engine: src/lib/civEngine.ts.
import { useEffect, useMemo, useState } from 'react';
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
  endPlayerTurn,
  enemyStep,
  isEnemyTurn,
  incomePreview,
  unitAt,
  UNIT_STATS,
  BUYABLE_KINDS,
  WAVE_EVERY,
  type CivState,
  type CivMode,
  type CivEvent,
  type Unit,
  type Axial,
  type BuyableKind,
} from '../lib/civEngine';
import { renderPiece, type PieceKey } from '../lib/pieceSvgs';
import * as sfx from '../lib/sfx';

const HEX = 30; // hex size in viewBox units
const ENEMY_STEP_MS = 170;

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
      'A rival civilization expands from the far side of the map. Out-grow it, then raze its base.',
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

// ── Board ────────────────────────────────────────────────────────────────

type Fx = { id: number; kind: 'shot' | 'hit'; x1: number; y1: number; x2: number; y2: number };

function Board({
  state,
  selected,
  moves,
  attacks,
  spawns,
  fx,
  onTile,
}: {
  state: CivState;
  selected: number | null;
  moves: Axial[];
  attacks: Axial[];
  spawns: Axial[];
  fx: Fx[];
  onTile: (h: Axial) => void;
}) {
  const hexes = useMemo(() => allHexes(state.radius), [state.radius]);
  const corners = useMemo(() => hexCornerPoints(HEX), []);
  const cornersInner = useMemo(() => hexCornerPoints(HEX - 2.2), []);

  const w = Math.sqrt(3) * HEX * state.radius + HEX + 4;
  const h = 1.5 * HEX * state.radius + HEX + 4;

  const key = (a: Axial) => axialKey(a.q, a.r);
  const moveSet = useMemo(() => new Set(moves.map(key)), [moves]);
  const attackSet = useMemo(() => new Set(attacks.map(key)), [attacks]);
  const spawnSet = useMemo(() => new Set(spawns.map(key)), [spawns]);
  const selectedUnit = state.units.find((u) => u.id === selected);

  return (
    <svg
      className="civ-board"
      viewBox={`${-w} ${-h} ${w * 2} ${h * 2}`}
      role="img"
      aria-label="Chess Civilization map"
    >
      {hexes.map((hx) => {
        const k = key(hx);
        const t = state.tiles[k];
        const { x, y } = hexToPixel(hx, HEX);
        const interactive = moveSet.has(k) || attackSet.has(k) || spawnSet.has(k);
        return (
          <g
            key={k}
            transform={`translate(${x} ${y})`}
            data-hex={k}
            className={
              `civ-tile civ-tile-${t}` +
              (interactive ? ' civ-tile-hot' : '')
            }
            onClick={() => onTile(hx)}
          >
            <polygon className="civ-hex" points={corners} />
            <TerrainDecor terrain={t} />
            {moveSet.has(k) && <polygon className="civ-hint civ-hint-move" points={cornersInner} />}
            {spawnSet.has(k) && (
              <polygon className="civ-hint civ-hint-spawn" points={cornersInner} />
            )}
            {attackSet.has(k) && (
              <polygon className="civ-hint civ-hint-attack" points={cornersInner} />
            )}
          </g>
        );
      })}

      {/* Units above tiles so they never get clipped by neighbor hexes. */}
      {state.units.map((u) => {
        const { x, y } = hexToPixel(u, HEX);
        const size = u.kind === 'base' ? 44 : 36;
        const spent = u.faction === state.current && u.acted && state.result === null;
        return (
          <g
            key={u.id}
            transform={`translate(${x - size / 2} ${y - size / 2 - 3})`}
            className={
              `civ-unit civ-unit-${u.faction}` +
              (u.id === selected ? ' civ-unit-selected' : '') +
              (spent ? ' civ-unit-spent' : '')
            }
            pointerEvents="none"
          >
            {renderPiece(pieceKeyFor(u), size)}
            {u.hp < u.maxHp && (
              <g transform={`translate(${size / 2 - 14} ${size + 1})`}>
                <rect className="civ-hp-bg" width="28" height="4" rx="2" />
                <rect
                  className={
                    'civ-hp-fill ' +
                    (u.hp / u.maxHp > 0.55 ? 'ok' : u.hp / u.maxHp > 0.28 ? 'low' : 'crit')
                  }
                  width={Math.max(2, (28 * u.hp) / u.maxHp)}
                  height="4"
                  rx="2"
                />
              </g>
            )}
          </g>
        );
      })}

      {/* Selection ring on top of the unit sprite. */}
      {selectedUnit &&
        (() => {
          const { x, y } = hexToPixel(selectedUnit, HEX);
          return (
            <g transform={`translate(${x} ${y})`} pointerEvents="none">
              <polygon className="civ-selection" points={corners} />
            </g>
          );
        })()}

      {fx.map((f) =>
        f.kind === 'shot' ? (
          <g key={f.id} className="civ-fx-shot" pointerEvents="none">
            <line x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} />
            <circle cx={f.x2} cy={f.y2} r="7" />
          </g>
        ) : (
          <circle key={f.id} className="civ-fx-hit" cx={f.x2} cy={f.y2} r="10" pointerEvents="none" />
        ),
      )}
    </svg>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export function Civilization() {
  const [state, setState] = useState<CivState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [spawnKind, setSpawnKind] = useState<BuyableKind | null>(null);
  const [seedText, setSeedText] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [fx, setFx] = useState<Fx[]>([]);

  const acts = useMemo(
    () =>
      state && selected !== null
        ? unitActions(state, selected)
        : { moves: [], attacks: [], canSettle: false },
    [state, selected],
  );
  const spawns = useMemo(
    () => (state && selected !== null && spawnKind ? spawnTargets(state, selected) : []),
    [state, selected, spawnKind],
  );
  const selectedUnit = state?.units.find((u) => u.id === selected) ?? null;

  const addFx = (kind: Fx['kind'], from: Axial | undefined, to: Axial) => {
    const a = from ? hexToPixel(from, HEX) : hexToPixel(to, HEX);
    const b = hexToPixel(to, HEX);
    const id = Date.now() + Math.random();
    setFx((cur) => [...cur, { id, kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y }]);
    window.setTimeout(() => setFx((cur) => cur.filter((f) => f.id !== id)), 500);
  };

  const playEvent = (ev: CivEvent | undefined) => {
    if (!ev) return;
    if (ev.type === 'move') sfx.playMove();
    else if (ev.type === 'melee') {
      sfx.playCapture();
      if (ev.to) addFx('hit', ev.from, ev.to);
    } else if (ev.type === 'shot') {
      sfx.playSlice();
      if (ev.from && ev.to) addFx('shot', ev.from, ev.to);
    } else if (ev.type === 'spawn') sfx.playSpawn();
    else if (ev.type === 'settle') sfx.playPlace();
  };

  // Enemy turn playback: one engine step per tick until control returns.
  useEffect(() => {
    if (!state || !isEnemyTurn(state)) return;
    const t = window.setTimeout(() => {
      const res = enemyStep(state);
      playEvent(res.event);
      setState(res.state);
    }, ENEMY_STEP_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Win/lose jingle, once.
  const [resultPlayed, setResultPlayed] = useState(false);
  useEffect(() => {
    if (!state?.result || resultPlayed) return;
    setResultPlayed(true);
    if (state.result.winner === 'p1' || state.mode === 'vs') sfx.playWin();
    else sfx.playCheck();
  }, [state, resultPlayed]);

  const start = (mode: CivMode) => {
    const seed = seedText.trim()
      ? Math.abs(
          [...seedText.trim()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
        ) || 7
      : Math.floor(Math.random() * 1e9);
    setState(newGame(mode, seed));
    setSelected(null);
    setSpawnKind(null);
    setHandoff(false);
    setResultPlayed(false);
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

    // Spawn placement takes priority while a recruit card is armed.
    if (selected !== null && spawnKind) {
      if (spawns.some((s) => s.q === h.q && s.r === h.r)) {
        const res = buyUnit(state, selected, spawnKind, h);
        if (res) {
          sfx.playBuy();
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
          playEvent(res.event);
          setState(res.state);
          deselect();
          return;
        }
      }
    }

    const u = unitAt(state, h.q, h.r);
    if (u && u.faction === state.current) {
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
    if (next.mode === 'vs' && !next.result) setHandoff(true);
  };

  const onSettle = () => {
    if (!state || selected === null) return;
    const res = settleKing(state, selected);
    if (res) {
      playEvent(res.event);
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
            A turn-based civilization game on a procedurally generated hex map. Your home base
            is a rook. Pawns and kings step, knights leap over anything, bishops fire across
            three hexes — and kings can settle new bases.
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
                <strong>Rook base</strong> — prints {8}g a turn, recruits one unit a turn onto
                a neighboring hex, heals adjacent units. Lose every base and you lose.
              </li>
              <li>
                <strong>Pawn · 10g</strong> — steps one hex. <strong>Knight · 24g</strong> —
                leaps up to three hexes, over anything. <strong>Bishop · 28g</strong> — fires a
                bullet at any enemy within three hexes. <strong>King · 50g</strong> — steps one
                hex and can found a new base, three hexes clear of any other.
              </li>
              <li>
                <strong>Terrain</strong> — mountains and water are impassable. Forests shelter
                defenders (−1 damage). Gold tiles pay out when worked by a unit, more inside a
                base's territory.
              </li>
              <li>
                <strong>Turns</strong> — every unit gets one action: move, strike, shoot, or
                settle. Walking into an enemy strikes it; clear the hex and you take it.
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
  const me = state.mode === 'vs' ? (state.current === 'zombie' ? 'p1' : state.current) : 'p1';
  const enemyBusy = isEnemyTurn(state);
  const untilWave =
    state.mode === 'zombie' ? (WAVE_EVERY - (state.turn % WAVE_EVERY)) % WAVE_EVERY : 0;
  const playerLabel =
    state.mode === 'vs' ? (state.current === 'p1' ? 'Blue (White)' : 'Red (Black)') : null;

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
          <Board
            state={state}
            selected={selected}
            moves={selected !== null && !spawnKind ? acts.moves : []}
            attacks={selected !== null && !spawnKind ? acts.attacks : []}
            spawns={spawns}
            fx={fx}
            onTile={onTile}
          />

          {handoff && (
            <div className="civ-overlay">
              <div className="civ-overlay-card">
                <p className="label-caps">Pass the device</p>
                <h2>{playerLabel} to move</h2>
                <button className="primary-btn" onClick={() => setHandoff(false)}>
                  Ready
                </button>
              </div>
            </div>
          )}

          {state.result && (
            <div className="civ-overlay">
              <div className="civ-overlay-card">
                <p className="label-caps">
                  {state.mode === 'zombie'
                    ? `Wave ${state.wave}`
                    : `Turn ${state.turn}`}
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
              <span className="label-caps">{state.mode === 'vs' ? `${playerLabel} gold` : 'Gold'}</span>
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
                    {untilWave === 0 ? ' next: this turn' : ` next in ${untilWave} turn${untilWave > 1 ? 's' : ''}`}
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
            {selectedUnit ? (
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
                </div>

                {selectedUnit.kind === 'base' ? (
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
                            className={
                              'civ-recruit-btn' + (spawnKind === k ? ' armed' : '')
                            }
                            disabled={disabled}
                            data-recruit={k}
                            onClick={() => setSpawnKind(spawnKind === k ? null : k)}
                          >
                            <span className="civ-recruit-icon">
                              {renderPiece(`${me === 'p2' ? 'b' : 'w'}${KIND_LETTER[k]}` as PieceKey, 26)}
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
                    {spawnKind && <p className="civ-hint-text">Click a highlighted hex to place.</p>}
                  </div>
                ) : (
                  <p className="civ-hint-text">
                    {UNIT_STATS[selectedUnit.kind as BuyableKind]?.blurb ?? ''}
                    {selectedUnit.acted ? ' Already acted this turn.' : ''}
                  </p>
                )}

                {selectedUnit.kind === 'king' && (
                  <button
                    className="secondary-btn"
                    disabled={!acts.canSettle}
                    onClick={onSettle}
                    title={
                      acts.canSettle
                        ? 'Found a new base here'
                        : 'Needs passable ground, 3 hexes from any base'
                    }
                  >
                    Settle new base
                  </button>
                )}
              </>
            ) : (
              <p className="civ-hint-text">
                Select one of your pieces. Your rook base recruits; everything else moves once
                a turn.
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
