import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { MergeBoard } from '../components/MergeBoard';
import { PlayerCard } from '../components/PlayerCard';
import { ResultAvatar } from '../components/EndScreenAvatars';
import type { Piece as MergePiece } from '../lib/mergeChess';
import {
  buildGameExport,
  buildReplay,
  downloadGameExport,
  GameImportError,
  parseGameImport,
  type ExportedGame,
  type Replay,
} from '../lib/gameExport';
import { loadGameRecord, loadRecentSummaries } from '../lib/storage';
import { getTimeControl } from '../lib/timeControls';
import { HERO_INFO, idxToSq as heroIdxToSq } from '../lib/heroChess';
import type { GameEndReason, LocalGameSummary } from '../lib/types';
import * as sfx from '../lib/sfx';

type LoadedGame = {
  exp: ExportedGame;
  replay: Replay;
};

export function Review() {
  const navigate = useNavigate();
  const location = useLocation();

  const [loaded, setLoaded] = useState<LoadedGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [summaries, setSummaries] = useState<LocalGameSummary[]>([]);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [viewPly, setViewPly] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Loading by gameId via ?game=<id> query param — used by the Profile page's
  // "Review" links so users can jump straight into reviewing a past match.
  const queryGameId = useMemo(() => {
    const search = new URLSearchParams(location.search);
    return search.get('game');
  }, [location.search]);

  useEffect(() => {
    loadRecentSummaries(30).then(setSummaries);
  }, []);

  useEffect(() => {
    if (!queryGameId) return;
    if (loaded && loaded.exp.gameId === queryGameId) return;
    void loadFromLocalRecord(queryGameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryGameId]);

  const tryLoad = (text: string) => {
    try {
      const exp = parseGameImport(text);
      const replay = buildReplay(exp);
      setLoaded({ exp, replay });
      setViewPly(replay.variant === 'normal' ? replay.san.length : replay.results.length);
      setError(null);
    } catch (err) {
      if (err instanceof GameImportError) setError(err.message);
      else setError('Failed to import: ' + ((err as Error)?.message ?? String(err)));
      setLoaded(null);
    }
  };

  const loadFromLocalRecord = async (gameId: string) => {
    try {
      const rec = await loadGameRecord(gameId);
      if (!rec) {
        setError('That game isn’t in your local history.');
        return;
      }
      const tc = getTimeControl(rec.timeControlId);
      if (!tc) { setError('Unknown time control on that record.'); return; }
      // Hero replay needs the W/B picks to rebuild the starting position.
      // Records saved before hero-pick storage don't carry them.
      if (tc.variant === 'hero' && !rec.heroes) {
        setError('This hero match was saved before hero picks were stored — export the JSON from a newer live game to review it.');
        return;
      }
      const exp: ExportedGame = {
        formatVersion: 1,
        app: 'voice-chat-chess',
        appVersion: '',
        exportedAt: Date.now(),
        variant: tc.variant,
        gameId: rec.gameId,
        timeControlId: rec.timeControlId,
        white: rec.white,
        black: rec.black,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        outcome: rec.outcome,
        reason: rec.reason,
        moves: rec.moves,
        ...(rec.heroes ? { heroes: rec.heroes } : {}),
      };
      const replay = buildReplay(exp);
      setLoaded({ exp, replay });
      setViewPly(replay.variant === 'normal' ? replay.san.length : replay.results.length);
      setError(null);
    } catch (err) {
      if (err instanceof GameImportError) setError(err.message);
      else setError('Failed to load: ' + ((err as Error)?.message ?? String(err)));
    }
  };

  // Download a stored game as JSON straight from the history list — mirrors
  // the Profile page's per-row Export so users can review (or share) a match
  // without first loading it into the replay view.
  const exportFromLocalRecord = async (gameId: string) => {
    try {
      const rec = await loadGameRecord(gameId);
      if (!rec) { setError('That game isn’t in your local history.'); return; }
      const tc = getTimeControl(rec.timeControlId);
      if (!tc) { setError('Unknown time control on that record.'); return; }
      // A hero export without its picks can't be re-imported, so don't offer
      // a broken file for records that predate hero-pick storage.
      if (tc.variant === 'hero' && !rec.heroes) {
        setError('This hero match was saved before hero picks were stored, so it can’t be exported for replay.');
        return;
      }
      const exp = buildGameExport({
        variant: tc.variant,
        gameId: rec.gameId,
        timeControlId: rec.timeControlId,
        white: rec.white,
        black: rec.black,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        outcome: rec.outcome,
        reason: rec.reason,
        moves: rec.moves,
        heroes: rec.heroes,
      });
      downloadGameExport(exp);
    } catch (err) {
      setError('Failed to export: ' + ((err as Error)?.message ?? String(err)));
    }
  };

  const onFile = async (file: File) => {
    try {
      const text = await file.text();
      tryLoad(text);
    } catch (err) {
      setError('Failed to read file: ' + ((err as Error)?.message ?? String(err)));
    }
  };

  // Arrow-key history scrubbing. Left/Right step one ply; Up/Down jump to
  // the start/end — matching the moves list reading top-to-bottom.
  useEffect(() => {
    if (!loaded) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const total = totalPlyOf(loaded.replay);
      setViewPly((p) => {
        let next = p;
        if (e.key === 'ArrowRight') next = Math.min(total, p + 1);
        else if (e.key === 'ArrowLeft') next = Math.max(0, p - 1);
        else if (e.key === 'ArrowUp') next = 0;
        else if (e.key === 'ArrowDown') next = total;
        if (next !== p) {
          sfx.cutoffChessSfx();
          if (next > p) sfx.playMove();
          else sfx.playMoveReversed();
        }
        return next;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded]);

  if (!loaded) {
    return (
      <div className="page">
        <h1 className="page-title">Review a game</h1>
        <p className="muted">
          Load a game export to replay it move by move. Export files come from the
          <b> Export</b> button on any live or finished match.
        </p>

        {error && <div className="review-error neg">{error}</div>}

        <section className="review-import-card">
          <h2>From a file</h2>
          <div className="review-import-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <button
              className="primary-btn"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose JSON file…
            </button>
            <DropZone onFile={onFile} />
          </div>
        </section>

        <section className="review-import-card">
          <h2>Paste JSON</h2>
          <textarea
            className="text-input review-paste"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"variant":"normal","moves":[…],…}'
            rows={6}
          />
          <div className="review-import-row">
            <button
              className="primary-btn"
              type="button"
              disabled={!pasteText.trim()}
              onClick={() => tryLoad(pasteText)}
            >
              Load
            </button>
          </div>
        </section>

        {summaries.length > 0 && (
          <section className="review-import-card">
            <h2>From your local history</h2>
            <p className="muted small">
              Hero matches played before this update don’t store their hero picks — those can’t be replayed.
            </p>
            <table className="history-table">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Opponent</th>
                  <th>Result</th>
                  <th>Ended</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => {
                  const tc = getTimeControl(s.timeControlId);
                  const myResult =
                    s.outcome === 'draw' ? '½' : s.outcome === s.myColor ? '1' : '0';
                  const variant = tc?.variant ?? 'normal';
                  const variantLabel = VARIANT_LABEL[variant];
                  return (
                    <tr key={s.gameId}>
                      <td>{variantLabel}</td>
                      <td><span className="mono small">{s.opponentHandle}</span></td>
                      <td className={`result-${myResult === '1' ? 'win' : myResult === '0' ? 'loss' : 'draw'}`}>
                        {myResult}
                      </td>
                      <td className="muted small">{new Date(s.endedAt).toLocaleString()}</td>
                      <td>
                        <div className="history-row-actions">
                          <button
                            className="link-btn"
                            type="button"
                            onClick={() => void exportFromLocalRecord(s.gameId)}
                            title="Download this game as JSON"
                          >
                            Export
                          </button>
                          <button
                            className="link-btn"
                            type="button"
                            onClick={() => void loadFromLocalRecord(s.gameId)}
                            title="Review this game"
                          >
                            Review
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    );
  }

  const { exp, replay } = loaded;
  const total = totalPlyOf(replay);
  const display = displayAt(replay, viewPly);
  const canUndo = viewPly > 0;
  const canRedo = viewPly < total;
  const tc = getTimeControl(exp.timeControlId);
  const initialMs = tc?.initialMs ?? 0;
  // Each Move carries whiteClockMs/blackClockMs after that ply. At ply 0 both
  // clocks are at the time control's initial budget. After ply N, use moves[N-1]
  // — falls back to the initial budget if the export omitted clock values.
  const clockAt = (color: 'w' | 'b'): number => {
    if (viewPly <= 0) return initialMs;
    const m = exp.moves[viewPly - 1];
    if (!m) return initialMs;
    return color === 'w' ? m.whiteClockMs ?? initialMs : m.blackClockMs ?? initialMs;
  };

  return (
    <div className="game-layout">
      <div className="board-column">
        <div className="board-wrap viewing-history">
          <MergeBoard
            board={display.board}
            orientation={orientation}
            lastMove={display.lastMove}
            kingGlows={display.kingGlows}
            frozenSquares={display.frozenSquares ?? null}
            missiles={display.missiles}
            maskedAsKingSquares={display.maskedAsKingSquares ?? null}
            interactive={false}
            draggable={false}
          />
        </div>
      </div>

      <aside className="side-panel">
        <PlayerCard
          avatarDataUrl={null}
          handle={exp.black.handle}
          rating={exp.black.rating}
          voiceState="off"
          volume={0}
          ms={clockAt('b')}
          lowMs={0}
          active={false}
        />
        <PlayerCard
          avatarDataUrl={null}
          handle={exp.white.handle}
          rating={exp.white.rating}
          voiceState="off"
          volume={0}
          ms={clockAt('w')}
          lowMs={0}
          active={false}
        />

        <div className="game-meta">
          <div className="game-meta-title">
            {VARIANT_LABEL[exp.variant]} · {getTimeControl(exp.timeControlId)?.label ?? exp.timeControlId}
          </div>
          {exp.variant === 'hero' && exp.heroes && (
            <div className="muted small">
              White: {HERO_INFO[exp.heroes.w].name} · Black: {HERO_INFO[exp.heroes.b].name}
            </div>
          )}
          <div className="muted small">
            Ply {viewPly} / {total}
          </div>
        </div>

        <div className="history-nav-row">
          <button
            className="free-play-btn"
            type="button"
            disabled={!canUndo}
            onClick={() => setViewPly((p) => Math.max(0, p - 1))}
          >
            Undo
          </button>
          <button
            className="free-play-btn"
            type="button"
            disabled={!canRedo}
            onClick={() => setViewPly((p) => Math.min(total, p + 1))}
          >
            Redo
          </button>
          <button
            className="free-play-btn"
            type="button"
            onClick={() => setViewPly(0)}
            disabled={viewPly === 0}
          >
            ⏮ Start
          </button>
          <button
            className="free-play-btn"
            type="button"
            onClick={() => setViewPly(total)}
            disabled={viewPly === total}
          >
            End ⏭
          </button>
          <button
            className="free-play-btn"
            type="button"
            onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
          >
            Flip
          </button>
          <button
            className="free-play-btn"
            type="button"
            onClick={() => downloadGameExport(exp)}
            title="Download this game as JSON"
          >
            Export
          </button>
          <button
            className="secondary-btn"
            type="button"
            onClick={() => {
              setLoaded(null);
              setViewPly(0);
              // Strip ?game=… so a refresh doesn't re-load it immediately.
              if (queryGameId) navigate('/review', { replace: true });
            }}
          >
            Load another
          </button>
        </div>

        <MovesPanel replay={replay} viewPly={viewPly} onJump={setViewPly} />

        {exp.outcome && exp.reason && (
          <div className="game-result-strip">
            <div className="game-result-info">
              <div className="result-line">
                <span className="title-group">
                  <ResultAvatar
                    src={null}
                    handle={
                      exp.outcome === 'draw'
                        ? exp.white.handle
                        : exp.outcome === 'white' ? exp.white.handle : exp.black.handle
                    }
                  />
                  <span className="title">
                    {exp.outcome === 'draw'
                      ? 'Draw'
                      : `${exp.outcome === 'white' ? exp.white.handle : exp.black.handle} wins`}
                  </span>
                </span>
                <span className="reason">{labelFor(exp.reason)}</span>
              </div>
              <div className="rating-delta">
                {exp.outcome === 'draw'
                  ? '½ – ½'
                  : exp.outcome === 'white' ? '1 – 0' : '0 – 1'}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

const VARIANT_LABEL: Record<ExportedGame['variant'], string> = {
  normal: 'Normal',
  merge: 'Merge',
  two: 'Guerrilla',
  cash: 'Cash Money',
  hero: 'Hero',
};

function totalPlyOf(r: Replay): number {
  return r.variant === 'normal' ? r.san.length : r.results.length;
}

type DisplaySnapshot = {
  board: (MergePiece | null)[];
  lastMove: { from: string; to: string } | null;
  kingGlows?: { w?: string; b?: string };
  frozenSquares?: string[];
  missiles?: { sq: string; pliesLeft: number; firedBy: 'w' | 'b' }[];
  maskedAsKingSquares?: string[];
};

function displayAt(r: Replay, viewPly: number): DisplaySnapshot {
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
  // hero
  const state = r.states[viewPly] ?? r.states[0];
  const uci = viewPly > 0 ? r.results[viewPly - 1]?.uci : undefined;
  let lastMove: { from: string; to: string } | null = null;
  if (uci) {
    if (uci.startsWith('!')) {
      // Hero ability UCIs: !<letter><sq>[<dest>][<promo>] — pick the most
      // visually informative tint per kind. Twin-Jitsu/Goofball encode two
      // squares; the others encode one target.
      const hero = uci[1];
      if (hero === 'T' || hero === 'G') {
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
    w: HERO_INFO[state.heroes.w.hero].glowColor,
    b: HERO_INFO[state.heroes.b.hero].glowColor,
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
  return { board, lastMove, kingGlows, frozenSquares, missiles, maskedAsKingSquares };
}

function lastMoveFromUci(viewPly: number, ucis: string[]): { from: string; to: string } | null {
  if (viewPly <= 0) return null;
  const uci = ucis[viewPly - 1];
  if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function MovesPanel({
  replay,
  viewPly,
  onJump,
}: {
  replay: Replay;
  viewPly: number;
  onJump: (ply: number) => void;
}) {
  const moves = replay.variant === 'normal'
    ? replay.san
    : replay.results.map((r) => r.uci);

  if (moves.length === 0) return <div className="moves-panel"><div className="muted small">No moves.</div></div>;

  // Pair plies into move numbers like "1. e4 e5".
  const pairs: { num: number; w: { label: string; ply: number }; b?: { label: string; ply: number } }[] = [];
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      pairs.push({ num: i / 2 + 1, w: { label: moves[i], ply: i + 1 } });
    } else {
      pairs[pairs.length - 1].b = { label: moves[i], ply: i + 1 };
    }
  }

  return (
    <div className="moves-panel">
      {pairs.map((p) => (
        <div key={p.num} className="moves-line">
          <span className="muted">{p.num}.</span>{' '}
          <span
            className={'review-move' + (viewPly === p.w.ply ? ' active' : '')}
            onClick={() => onJump(p.w.ply)}
            role="button"
            tabIndex={0}
          >
            {p.w.label}
          </span>
          {p.b && (
            <>
              {' '}
              <span
                className={'review-move' + (viewPly === p.b.ply ? ' active' : '')}
                onClick={() => onJump(p.b!.ply)}
                role="button"
                tabIndex={0}
              >
                {p.b.label}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function DropZone({ onFile }: { onFile: (file: File) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={'review-dropzone' + (hover ? ' hover' : '')}
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      …or drop a .json file here
    </div>
  );
}

// Renderable label for a result reason — same set as the live game pages.
function labelFor(reason: GameEndReason): string {
  switch (reason) {
    case 'checkmate': return 'by checkmate';
    case 'stalemate': return 'by stalemate';
    case 'threefold': return 'by threefold repetition';
    case 'insufficient': return 'insufficient material';
    case 'fifty-move': return 'fifty-move rule';
    case 'resignation': return 'by resignation';
    case 'timeout': return 'on time';
    case 'draw-agreed': return 'by agreement';
    case 'disconnect': return 'opponent disconnected';
  }
}

