import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  buildReplay,
  GameImportError,
  parseGameImport,
  type ExportedGame,
  type Replay,
} from '../lib/gameExport';
import { displayAt, totalPlyOf } from '../lib/replayView';
import {
  createProject,
  durationForMoveTimes,
  downloadVideoProject,
  parseVideoProject,
  VideoProjectError,
  newEffectId,
  DEFAULT_ARROW_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  MOVE_TYPES,
  MOVE_TYPE_LABEL,
  type EditProject,
  type EffectEvent,
  type MoveType,
  type MusicRef,
} from '../lib/videoProject';
import { QUICK_EMOJIS } from '../lib/inGameEmojis';
import { checkmateArrows, kingSquareOf as kingSqOnBoard } from '../lib/boardAttacks';
import { loadAllSprites, type SpriteCache } from '../lib/pieceSprites';
import { loadTokenSprites, type TokenSpriteCache } from '../lib/tokenSprites';
import { boardMargin, canvasSize, renderScene, squareAtPoint, type Frame, type SceneModel } from '../lib/videoRenderer';
import { canExportVideo, exportVideo, downloadBlob, fireSceneSounds } from '../lib/videoExport';
import {
  loadBundledMusic,
  loadUploadedMusic,
  type BundledTrack,
  type LoadedMusic,
} from '../lib/videoMusic';
import { TransportBar } from '../components/video/TransportBar';
import { Timeline } from '../components/video/Timeline';
import { ToolPalette, EffectEditor, type ActiveTool } from '../components/video/EffectInspector';
import { MusicPicker } from '../components/video/MusicPicker';
import { clamp } from '../components/video/util';

// ---- Reducer over the (nullable) EditProject -----------------------------

type Action =
  | { t: 'load'; project: EditProject }
  | { t: 'range'; startPly: number; endPly: number }
  | { t: 'moveTime'; index: number; ms: number }
  | { t: 'moveTimes'; updates: { index: number; ms: number }[] }
  | { t: 'moveType'; index: number; value: MoveType }
  | { t: 'moveTypes'; indices: number[]; value: MoveType }
  | { t: 'orientation' }
  | { t: 'boardPx'; px: number }
  | { t: 'fps'; fps: number }
  | { t: 'music'; music: MusicRef | null }
  | { t: 'musicOffset'; ms: number }
  | { t: 'addEffect'; e: EffectEvent }
  | { t: 'addEffects'; effects: EffectEvent[] }
  | { t: 'updateEffect'; id: string; patch: Partial<EffectEvent> }
  | { t: 'updateEffects'; patches: { id: string; patch: Partial<EffectEvent> }[] }
  | { t: 'removeEffect'; id: string }
  | { t: 'removeEffects'; ids: string[] }
  | { t: 'undo' }
  | { t: 'redo' };

function recomputeDuration(p: EditProject): number {
  const fromMoves = durationForMoveTimes(p.moveTimes, p.slideDurationMs);
  let maxEffect = 0;
  for (const e of p.effects) maxEffect = Math.max(maxEffect, e.startMs + e.durationMs);
  return Math.max(fromMoves, maxEffect + 300, 1000);
}
function withDuration(p: EditProject): EditProject {
  return { ...p, totalDurationMs: recomputeDuration(p) };
}

function reducer(state: EditProject | null, a: Action): EditProject | null {
  if (a.t === 'load') return a.project;
  if (!state) return state;
  switch (a.t) {
    case 'range': {
      const start = Math.max(1, Math.min(a.startPly, a.endPly));
      const end = Math.max(start, a.endPly);
      const count = end - start + 1;
      const moveTimes = createProject({ gameId: state.gameId, variant: state.variant, totalPly: end, startPly: start, endPly: end }).moveTimes;
      return withDuration({
        ...state,
        range: { startPly: start, endPly: end },
        moveTimes: moveTimes.slice(0, count),
        moveTypes: new Array(count).fill('normal') as MoveType[],
      });
    }
    case 'moveTime': {
      const moveTimes = state.moveTimes.slice();
      moveTimes[a.index] = Math.max(0, a.ms);
      return withDuration({ ...state, moveTimes });
    }
    case 'moveTimes': {
      const moveTimes = state.moveTimes.slice();
      for (const u of a.updates) moveTimes[u.index] = Math.max(0, u.ms);
      return withDuration({ ...state, moveTimes });
    }
    case 'moveType': {
      const moveTypes = state.moveTypes.slice();
      moveTypes[a.index] = a.value;
      return { ...state, moveTypes };
    }
    case 'moveTypes': {
      const moveTypes = state.moveTypes.slice();
      for (const i of a.indices) moveTypes[i] = a.value;
      return { ...state, moveTypes };
    }
    case 'orientation':
      return { ...state, orientation: state.orientation === 'white' ? 'black' : 'white' };
    case 'boardPx':
      return { ...state, boardPx: a.px };
    case 'fps':
      return { ...state, fps: a.fps };
    case 'music':
      return { ...state, music: a.music };
    case 'musicOffset':
      return state.music ? { ...state, music: { ...state.music, startOffsetMs: Math.max(0, a.ms) } } : state;
    case 'addEffect':
      return withDuration({ ...state, effects: [...state.effects, a.e] });
    case 'addEffects':
      return withDuration({ ...state, effects: [...state.effects, ...a.effects] });
    case 'updateEffect':
      return withDuration({
        ...state,
        effects: state.effects.map((e) => (e.id === a.id ? ({ ...e, ...a.patch } as EffectEvent) : e)),
      });
    case 'updateEffects': {
      const byId = new Map(a.patches.map((p) => [p.id, p.patch]));
      return withDuration({
        ...state,
        effects: state.effects.map((e) => (byId.has(e.id) ? ({ ...e, ...byId.get(e.id) } as EffectEvent) : e)),
      });
    }
    case 'removeEffect':
      return withDuration({ ...state, effects: state.effects.filter((e) => e.id !== a.id) });
    case 'removeEffects': {
      const ids = new Set(a.ids);
      return withDuration({ ...state, effects: state.effects.filter((e) => !ids.has(e.id)) });
    }
    case 'undo':
    case 'redo':
      return state; // handled by the undoable wrapper below
  }
}

// ---- Undo/redo wrapper ---------------------------------------------------

type History = { past: EditProject[]; present: EditProject | null; future: EditProject[]; lastTag: string | null };
const INITIAL_HISTORY: History = { past: [], present: null, future: [], lastTag: null };
const HISTORY_LIMIT = 60;

// Continuous edits (a handle drag, an offset slider) share a tag so the whole
// gesture collapses into one undo step; discrete edits get null (always new).
function actionTag(a: Action): string | null {
  switch (a.t) {
    case 'moveTime': return `moveTime:${a.index}`;
    case 'moveTimes': return 'moveTimes:' + a.updates.map((u) => u.index).sort().join(',');
    case 'updateEffect': return `updateEffect:${a.id}`;
    case 'updateEffects': return 'updateEffects:' + a.patches.map((p) => p.id).sort().join(',');
    case 'musicOffset': return 'musicOffset';
    default: return null;
  }
}

function historyReducer(state: History, a: Action): History {
  if (a.t === 'undo') {
    if (state.past.length === 0) return state;
    const prev = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: prev,
      future: state.present ? [state.present, ...state.future] : state.future,
      lastTag: null,
    };
  }
  if (a.t === 'redo') {
    if (state.future.length === 0) return state;
    const next = state.future[0];
    return {
      past: state.present ? [...state.past, state.present] : state.past,
      present: next,
      future: state.future.slice(1),
      lastTag: null,
    };
  }
  const present = reducer(state.present, a);
  if (present === state.present) return state; // no-op
  if (a.t === 'load') return { past: [], present, future: [], lastTag: null };
  const tag = actionTag(a);
  // Coalesce a continuous gesture into the current entry.
  if (tag !== null && tag === state.lastTag && state.present !== null) {
    return { ...state, present, future: [], lastTag: tag };
  }
  return {
    past: state.present !== null ? [...state.past, state.present].slice(-HISTORY_LIMIT) : state.past,
    present,
    future: [],
    lastTag: tag,
  };
}

// ---- Helpers -------------------------------------------------------------

type Loaded = { exp: ExportedGame; replay: Replay; totalPly: number };

function buildFrames(replay: Replay, startPly: number, endPly: number): Frame[] {
  const frames: Frame[] = [];
  for (let ply = startPly - 1; ply <= endPly; ply++) {
    // displayAt returns the full per-ply snapshot (board + every variant
    // overlay), which is exactly our Frame.
    frames.push(displayAt(replay, Math.max(0, ply)));
  }
  return frames;
}

// SFX keys to play when each featured move starts, derived from the replay.
// One entry per move in the range (aligned with moveTimes).
function buildMoveSounds(replay: Replay, startPly: number, endPly: number): string[][] {
  const out: string[][] = [];
  for (let ply = startPly; ply <= endPly; ply++) {
    out.push(soundsForPly(replay, ply));
  }
  return out;
}

const HERO_ABILITY_SOUND: Record<string, string> = {
  frost: 'freeze',
  warlord: 'slice',
  necromancer: 'spawn',
  flight: 'fly',
  mutation: 'mutate',
  icbm: 'missile',
  goofball: 'goofball',
  kamakaze: 'kamakaze',
  'twin-jutsu': 'twin',
  slime: 'slime',
  juggernaut: 'jug',
  gojo: 'gojo',
  harem: 'harem',
};

function soundsForPly(replay: Replay, ply: number): string[] {
  const i = ply - 1;
  if (replay.variant === 'normal') {
    const san = replay.san[i] ?? '';
    const keys: string[] = [];
    if (san.startsWith('O-O')) keys.push('castle');
    else keys.push(san.includes('x') ? 'capture' : 'move');
    if (san.includes('+')) keys.push('check'); // '#' (mate) intentionally silent
    return keys;
  }
  const r = replay.results[i] as Record<string, unknown> | undefined;
  if (!r) return ['move'];
  const has = (k: string) => Boolean(r[k]);
  const keys: string[] = [];
  if (replay.variant === 'hero' && r.abilityUsed) {
    const key = HERO_ABILITY_SOUND[String(r.abilityUsed)];
    keys.push(key ?? 'move');
  } else if (replay.variant === 'cash' && typeof r.uci === 'string' && r.uci.startsWith('+')) {
    keys.push('buy');
  } else if (has('castled')) {
    keys.push('castle');
  } else if (has('merged')) {
    keys.push('merge');
  } else if (has('pushed')) {
    keys.push('push');
  } else if (has('captured')) {
    keys.push('capture');
  } else {
    keys.push('move');
  }
  if (has('cashedIn')) keys.push('cashin');
  if (has('check') && !has('checkmate')) keys.push('check');
  return keys;
}

function moveLabelsOf(replay: Replay, startPly: number, endPly: number): string[] {
  const all = replay.variant === 'normal' ? replay.san : replay.results.map((r) => r.uci);
  const out: string[] = [];
  for (let ply = startPly; ply <= endPly; ply++) out.push(all[ply - 1] ?? `${ply}`);
  return out;
}

// Does the clip's last featured ply end the game (for the ending animation)?
function detectEnding(loaded: Loaded, endPly: number): 'checkmate' | 'draw' | null {
  const { replay, exp, totalPly } = loaded;
  if (replay.variant === 'normal') {
    if ((replay.san[endPly - 1] ?? '').includes('#')) return 'checkmate';
  } else {
    const r = replay.results[endPly - 1] as Record<string, unknown> | undefined;
    if (r?.checkmate) return 'checkmate';
    if (r?.stalemate) return 'draw';
  }
  if (endPly === totalPly && exp.outcome === 'draw') return 'draw';
  return null;
}

// Lowest lane row where [startMs, startMs+durationMs) doesn't overlap an
// existing effect, so newly placed effects pack tidily instead of stacking.
function autoRow(effects: EffectEvent[], startMs: number, durationMs: number): number {
  const end = startMs + durationMs;
  for (let r = 0; ; r++) {
    const clash = effects.some((e) => (e.row ?? 0) === r && startMs < e.startMs + e.durationMs && e.startMs < end);
    if (!clash) return r;
  }
}

// The time window of the move currently under the playhead, so a board-placed
// effect can "last one move" (from this move's start until the next move).
function moveWindowAt(p: EditProject, ms: number): { startMs: number; durationMs: number; anchorPly: number } {
  const times = p.moveTimes;
  if (times.length === 0) return { startMs: Math.max(0, ms), durationMs: 1000, anchorPly: p.range.startPly };
  let found = -1;
  for (let k = 0; k < times.length; k++) if (times[k] <= ms) found = k;
  if (found < 0) {
    return { startMs: Math.max(0, ms), durationMs: Math.max(300, times[0] - ms), anchorPly: p.range.startPly };
  }
  const start = times[found];
  const end = found + 1 < times.length ? times[found + 1] : p.totalDurationMs;
  return { startMs: start, durationMs: Math.max(200, end - start), anchorPly: p.range.startPly + found };
}

// ---- Component -----------------------------------------------------------

export function VideoEditor() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [history, dispatch] = useReducer(historyReducer, INITIAL_HISTORY);
  const project = history.present;
  const [error, setError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');

  const [sprites, setSprites] = useState<SpriteCache | null>(null);
  const [tokens, setTokens] = useState<TokenSpriteCache | null>(null);
  const [audio, setAudio] = useState<LoadedMusic | null>(null);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);

  const [previewMs, setPreviewMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  const [selectedEffectIds, setSelectedEffectIds] = useState<string[]>([]);
  const [selectedMoveIndices, setSelectedMoveIndices] = useState<number[]>([]);
  const [rightTab, setRightTab] = useState<'project' | 'edit'>('edit');
  const [exportState, setExportState] = useState<{ active: boolean; progress: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projFileRef = useRef<HTMLInputElement>(null);

  // Refs the persistent rAF loop reads (kept fresh below).
  const spritesRef = useRef<SpriteCache | null>(null);
  const tokensRef = useRef<TokenSpriteCache | null>(null);
  const sceneRef = useRef<SceneModel | null>(null);
  const previewRef = useRef(0);
  const playingRef = useRef(false);
  const totalRef = useRef(0);
  // Cursor for one-shot SFX firing during playback (so a sound plays once as the
  // playhead crosses an effect's start, but not when scrubbing).
  const soundCursorRef = useRef(0);
  // When true, the rAF loop repaints once; set on every render (i.e. any state
  // change). While paused with nothing changing, the canvas stays idle.
  const dirtyRef = useRef(true);

  useEffect(() => {
    loadAllSprites().then(setSprites).catch(() => setError('Failed to rasterize piece sprites.'));
    loadTokenSprites().then(setTokens).catch(() => {});
  }, []);

  const frames = useMemo<Frame[]>(() => {
    if (!loaded || !project) return [];
    return buildFrames(loaded.replay, project.range.startPly, project.range.endPly);
  }, [loaded, project?.range.startPly, project?.range.endPly]);

  const moveLabels = useMemo<string[]>(() => {
    if (!loaded || !project) return [];
    return moveLabelsOf(loaded.replay, project.range.startPly, project.range.endPly);
  }, [loaded, project?.range.startPly, project?.range.endPly]);

  const moveSounds = useMemo<string[][]>(() => {
    if (!loaded || !project) return [];
    return buildMoveSounds(loaded.replay, project.range.startPly, project.range.endPly);
  }, [loaded, project?.range.startPly, project?.range.endPly]);

  const scene = useMemo<SceneModel | null>(() => {
    if (!project) return null;
    return {
      boardPx: project.boardPx,
      orientation: project.orientation,
      frames,
      moveTimes: project.moveTimes,
      moveTypes: project.moveTypes,
      slideDurationMs: project.slideDurationMs,
      effects: project.effects,
      totalDurationMs: project.totalDurationMs,
      moveSounds,
    };
  }, [project, frames, moveSounds]);

  // Keep loop refs fresh every render. Any render means something the canvas
  // depends on may have changed, so flag a repaint.
  spritesRef.current = sprites;
  tokensRef.current = tokens;
  sceneRef.current = scene;
  playingRef.current = playing;
  totalRef.current = scene?.totalDurationMs ?? 0;
  dirtyRef.current = true;

  // Single persistent rAF: advances the playhead while playing and always
  // redraws the current scene (so scrubbing + edits show immediately).
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (playingRef.current) {
        const prev = previewRef.current;
        let next = prev + dt;
        if (next >= totalRef.current) {
          next = totalRef.current;
          playingRef.current = false;
          setPlaying(false);
        }
        previewRef.current = next;
        setPreviewMs(next);
        // Fire move + emoji/token SFX as the playhead crosses their start times.
        if (sceneRef.current) fireSceneSounds(sceneRef.current, soundCursorRef.current, next);
        soundCursorRef.current = next;
      }
      // Repaint while playing, or once after any change; otherwise stay idle.
      if (playingRef.current || dirtyRef.current) {
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx && sceneRef.current && spritesRef.current) {
          renderScene(ctx, sceneRef.current, previewRef.current, spritesRef.current, tokensRef.current ?? undefined);
          dirtyRef.current = false;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Audio play/pause follows the transport.
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    if (playing && audio) {
      el.currentTime = Math.max(0, ((project?.music?.startOffsetMs ?? 0) + previewRef.current) / 1000);
      el.play().catch(() => {});
    } else {
      el.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const seek = (ms: number) => {
    const t = clamp(ms, 0, totalRef.current);
    previewRef.current = t;
    soundCursorRef.current = t; // don't retro-fire SFX after a jump
    setPreviewMs(t);
    const el = audioElRef.current;
    if (el && playingRef.current && audio) {
      el.currentTime = Math.max(0, ((project?.music?.startOffsetMs ?? 0) + t) / 1000);
    }
  };

  const onPlayPause = () => {
    if (!playing && previewRef.current >= totalRef.current - 1) seek(0);
    soundCursorRef.current = previewRef.current;
    setPlaying((p) => !p);
  };

  const stepMove = (dir: -1 | 1) => {
    if (!project) return;
    const times = project.moveTimes;
    const cur = previewRef.current;
    if (dir === 1) {
      const next = times.find((m) => m > cur + 1);
      seek(next ?? totalRef.current);
    } else {
      const prev = [...times].reverse().find((m) => m < cur - 1);
      seek(prev ?? 0);
    }
  };

  // Editor keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); dispatch({ t: e.shiftKey ? 'redo' : 'undo' }); return; }
        if (k === 'y') { e.preventDefault(); dispatch({ t: 'redo' }); return; }
        if (k === 'a') { e.preventDefault(); selectAll(); return; }
        return;
      }
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        onPlayPause();
        return;
      }
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); stepMove(1); break;
        case 'ArrowLeft': e.preventDefault(); stepMove(-1); break;
        case 'Home': e.preventDefault(); seek(0); break;
        case 'End': e.preventDefault(); seek(totalRef.current); break;
        case '1': setActiveTool({ kind: 'highlight', color: DEFAULT_HIGHLIGHT_COLOR }); break;
        case '2': setActiveTool({ kind: 'token', token: 'brilliant' }); break;
        case '3': setActiveTool({ kind: 'arrow', color: DEFAULT_ARROW_COLOR }); break;
        case '4': setActiveTool({ kind: 'emoji', emoji: QUICK_EMOJIS[0] }); break;
        case 'Escape': setActiveTool(null); break;
        case 'Delete': case 'Backspace':
          if (selectedEffectIds.length) { dispatch({ t: 'removeEffects', ids: selectedEffectIds }); setSelectedEffectIds([]); }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selectedEffectIds, playing]);

  // ---- Game import -------------------------------------------------------

  const loadGame = (exp: ExportedGame) => {
    const replay = buildReplay(exp);
    const totalPly = totalPlyOf(replay);
    setLoaded({ exp, replay, totalPly });
    dispatch({ t: 'load', project: createProject({ gameId: exp.gameId, variant: exp.variant, totalPly }) });
    seek(0);
    setSelectedEffectIds([]);
    setSelectedMoveIndices([]);
    setActiveTool(null);
    setError(null);
  };

  const tryLoadGame = (text: string) => {
    try {
      loadGame(parseGameImport(text));
    } catch (err) {
      setError(err instanceof GameImportError ? err.message : 'Failed to import game: ' + ((err as Error)?.message ?? String(err)));
    }
  };

  // ---- Project import/export --------------------------------------------

  const exportProject = () => {
    if (!project || !loaded) return;
    downloadVideoProject({ ...project, game: loaded.exp });
  };

  const tryLoadProject = (text: string) => {
    try {
      const p = parseVideoProject(text);
      if (!p.game) {
        setError('This project file has no embedded game. Re-export it from this editor, or import the game first.');
        return;
      }
      const replay = buildReplay(p.game);
      setLoaded({ exp: p.game, replay, totalPly: totalPlyOf(replay) });
      dispatch({ t: 'load', project: p });
      seek(0);
      setSelectedEffectIds([]);
      setSelectedMoveIndices([]);
      setError(null);
      if (p.music?.source === 'bundled') {
        setError('Re-select the bundled track to load its audio (offset is restored).');
      } else if (p.music?.source === 'upload') {
        setError(`Re-attach "${p.music.name}" via Upload audio (offset is restored).`);
      }
    } catch (err) {
      setError(err instanceof VideoProjectError ? err.message : 'Failed to load project: ' + ((err as Error)?.message ?? String(err)));
    }
  };

  // ---- Music -------------------------------------------------------------

  const attachMusic = async (loader: () => Promise<LoadedMusic>, ref: MusicRef) => {
    setMusicLoading(true);
    setMusicError(null);
    try {
      const m = await loader();
      setAudio((prev) => {
        if (prev?.isObjectUrl) URL.revokeObjectURL(prev.url);
        return m;
      });
      dispatch({ t: 'music', music: { ...ref, startOffsetMs: project?.music?.startOffsetMs ?? ref.startOffsetMs } });
    } catch (err) {
      setMusicError((err as Error)?.message ?? String(err));
    } finally {
      setMusicLoading(false);
    }
  };

  const onPickBundled = (t: BundledTrack) =>
    attachMusic(() => loadBundledMusic(t), { source: 'bundled', name: t.name, url: undefined, startOffsetMs: 0 });
  const onUploadMusic = (f: File) =>
    attachMusic(() => loadUploadedMusic(f), { source: 'upload', name: f.name, startOffsetMs: 0 });
  const clearMusic = () => {
    setAudio((prev) => {
      if (prev?.isObjectUrl) URL.revokeObjectURL(prev.url);
      return null;
    });
    dispatch({ t: 'music', music: null });
  };

  // ---- Effects board interaction ----------------------------------------

  // Place an armed effect by clicking the board. Single-square effects span the
  // move currently under the playhead ("lasts one move"); emoji always uses the
  // in-game ~1s bubble. Arrows take two clicks (from, then to).
  const placeEffectAt = (sq: string) => {
    if (!project || !activeTool) return;
    const win = moveWindowAt(project, previewRef.current);
    if (activeTool.kind === 'arrow') {
      if (!activeTool.from) {
        setActiveTool({ ...activeTool, from: sq });
        return;
      }
      const row = autoRow(project.effects, win.startMs, win.durationMs);
      const eff: EffectEvent = {
        id: newEffectId(), kind: 'arrow', from: activeTool.from, to: sq, color: activeTool.color,
        startMs: win.startMs, durationMs: win.durationMs, row, anchorPly: win.anchorPly,
      };
      dispatch({ t: 'addEffect', e: eff });
      selectEffect(eff.id);
      setActiveTool({ ...activeTool, from: undefined });
      return;
    }
    const durationMs = win.durationMs; // every effect (emoji included) lasts one move
    const row = autoRow(project.effects, win.startMs, durationMs);
    let eff: EffectEvent;
    if (activeTool.kind === 'highlight') {
      eff = { id: newEffectId(), kind: 'highlight', square: sq, color: activeTool.color, startMs: win.startMs, durationMs, row, anchorPly: win.anchorPly };
    } else if (activeTool.kind === 'token') {
      eff = { id: newEffectId(), kind: 'token', square: sq, token: activeTool.token, startMs: win.startMs, durationMs, row, anchorPly: win.anchorPly };
    } else {
      eff = { id: newEffectId(), kind: 'emoji', square: sq, emoji: activeTool.emoji, startMs: win.startMs, durationMs, row, anchorPly: win.anchorPly };
    }
    dispatch({ t: 'addEffect', e: eff });
    selectEffect(eff.id);
  };

  const onCanvasDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c || !project) return;
    const rect = c.getBoundingClientRect();
    const size = canvasSize(project.boardPx);
    const x = (e.clientX - rect.left) * (size / rect.width);
    const y = (e.clientY - rect.top) * (size / rect.height);
    const sq = squareAtPoint(x, y, project.boardPx, project.orientation, boardMargin(project.boardPx));
    if (sq && activeTool) placeEffectAt(sq);
  };

  // ---- Checkmate / draw ending ------------------------------------------

  const ending = useMemo(
    () => (loaded && project ? detectEnding(loaded, project.range.endPly) : null),
    [loaded, project?.range.endPly],
  );

  const addEnding = () => {
    if (!loaded || !project || !ending || frames.length === 0) return;
    const lastFrame = frames[frames.length - 1];
    const lastMoveTime = project.moveTimes[project.moveTimes.length - 1] ?? 0;
    const startMs = Math.round(lastMoveTime + 700); // after the last move lands
    const durationMs = 2400;
    const fx: EffectEvent[] = [];
    // These all start together, so pack each onto its own non-overlapping row.
    const rowFor = () => autoRow([...project.effects, ...fx], startMs, durationMs);
    if (ending === 'checkmate') {
      const moverColor = project.range.endPly % 2 === 1 ? 'w' : 'b';
      const matedColor = moverColor === 'w' ? 'b' : 'w';
      const kingSq = kingSqOnBoard(lastFrame.board, matedColor);
      if (kingSq) {
        fx.push({ id: newEffectId(), kind: 'token', token: 'checkmate', square: kingSq, startMs, durationMs, row: rowFor() });
        for (const ar of checkmateArrows(lastFrame.board, kingSq, matedColor)) {
          fx.push({ id: newEffectId(), kind: 'arrow', from: ar.from, to: ar.to, color: '#e0483a', startMs, durationMs, row: rowFor() });
        }
      }
    } else {
      for (const color of ['w', 'b'] as const) {
        const kingSq = kingSqOnBoard(lastFrame.board, color);
        if (kingSq) fx.push({ id: newEffectId(), kind: 'token', token: 'draw', square: kingSq, startMs, durationMs, row: rowFor() });
      }
    }
    if (fx.length) {
      dispatch({ t: 'addEffects', effects: fx });
      seek(startMs);
    }
  };

  // ---- Export video ------------------------------------------------------

  const doExportVideo = async () => {
    if (!scene || !sprites || !project) return;
    setPlaying(false);
    setExportState({ active: true, progress: 0 });
    try {
      const blob = await exportVideo({
        model: scene,
        sprites,
        tokens: tokens ?? undefined,
        fps: project.fps,
        audio: audio ? { buffer: audio.buffer, startOffsetMs: project.music?.startOffsetMs ?? 0 } : null,
        onProgress: (f) => setExportState({ active: true, progress: f }),
      });
      downloadBlob(blob, `vcc-clip-${project.gameId || 'clip'}.webm`);
    } catch (err) {
      setError('Export failed: ' + ((err as Error)?.message ?? String(err)));
    } finally {
      setExportState(null);
    }
  };

  const totalSelected = selectedEffectIds.length + selectedMoveIndices.length;
  const selectedEffectId = selectedEffectIds.length === 1 && selectedMoveIndices.length === 0 ? selectedEffectIds[0] : null;
  const selectedMoveIndex = selectedMoveIndices.length === 1 && selectedEffectIds.length === 0 ? selectedMoveIndices[0] : null;
  const selectedEffect = (selectedEffectId && project?.effects.find((e) => e.id === selectedEffectId)) || null;

  // Unified selection: effects and moves can be selected together (marquee /
  // Ctrl+A / double-click row). Any selection reveals the Edit tab.
  const setSelection = (effectIds: string[], moveIndices: number[]) => {
    setSelectedEffectIds(effectIds);
    setSelectedMoveIndices(moveIndices);
    if (effectIds.length || moveIndices.length) setRightTab('edit');
  };
  const selectEffect = (id: string | null) => setSelection(id ? [id] : [], []);
  const selectAll = () => {
    if (project) setSelection(project.effects.map((e) => e.id), project.moveTimes.map((_, i) => i));
  };

  // ---- Render: importer --------------------------------------------------

  if (!project || !loaded) {
    return (
      <div className="page">
        <h1 className="page-title">Video editor</h1>
        <p className="muted">
          Local tool. Import a game export (the <b>Export</b> button on Review or any finished match),
          then time the moves to music and add effects. Not shipped to production.
        </p>
        {error && <div className="review-error neg">{error}</div>}

        <section className="review-import-card">
          <h2>From a file</h2>
          <div className="review-import-row">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) tryLoadGame(await f.text());
                if (fileRef.current) fileRef.current.value = '';
              }}
            />
            <button className="primary-btn" type="button" onClick={() => fileRef.current?.click()}>
              Choose game JSON…
            </button>
            <input
              ref={projFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) tryLoadProject(await f.text());
                if (projFileRef.current) projFileRef.current.value = '';
              }}
            />
            <button className="secondary-btn" type="button" onClick={() => projFileRef.current?.click()}>
              Open project (.vccvid.json)…
            </button>
          </div>
        </section>

        <section className="review-import-card">
          <h2>Paste game JSON</h2>
          <textarea
            className="text-input review-paste"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"variant":"normal","moves":[…],…}'
            rows={6}
          />
          <div className="review-import-row">
            <button className="primary-btn" type="button" disabled={!pasteText.trim()} onClick={() => tryLoadGame(pasteText)}>
              Load
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---- Render: editor ----------------------------------------------------

  const exportable = canExportVideo();

  return (
    <div className="video-editor">
      {/* LEFT: chessboard + footer transport + timeline, all the same width. */}
      <div className="vid-stage">
        <div className="board-wrap">
          {sprites ? (
            <canvas
              ref={canvasRef}
              width={canvasSize(project.boardPx)}
              height={canvasSize(project.boardPx)}
              className="vid-canvas"
              onPointerDown={onCanvasDown}
            />
          ) : (
            <div className="muted">Loading pieces…</div>
          )}
        </div>
        <TransportBar previewMs={previewMs} totalMs={project.totalDurationMs} onSeek={seek} />
        {activeTool && (
          <div className="vid-tool-hint">
            Placing <b>{activeTool.kind}</b>
            {activeTool.kind === 'arrow' && activeTool.from ? ` (from ${activeTool.from})` : ''} — click the board. Press <b>Esc</b> to cancel.
          </div>
        )}
      </div>

      {/* RIGHT: tabs. */}
      <aside className="vid-tabs">
        <div className="vid-tab-bar">
          <button type="button" className={'vid-tab' + (rightTab === 'project' ? ' active' : '')} onClick={() => setRightTab('project')}>
            Project
          </button>
          <button type="button" className={'vid-tab' + (rightTab === 'edit' ? ' active' : '')} onClick={() => setRightTab('edit')}>
            Edit
          </button>
        </div>

        <div className="vid-tab-panel">
          {rightTab === 'project' ? (
            <>
              <section className="vid-panel">
                <h3>Project</h3>
                <div className="vid-project-actions">
                  <button className="secondary-btn" type="button" onClick={() => fileRef.current?.click()}>
                    Import game…
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) tryLoadGame(await f.text());
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  />
                  <button className="secondary-btn" type="button" onClick={() => projFileRef.current?.click()}>
                    Open project…
                  </button>
                  <input
                    ref={projFileRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) tryLoadProject(await f.text());
                      if (projFileRef.current) projFileRef.current.value = '';
                    }}
                  />
                  <button className="secondary-btn" type="button" onClick={() => dispatch({ t: 'orientation' })}>
                    Flip board ({project.orientation === 'white' ? 'White' : 'Black'} POV)
                  </button>
                  <button className="secondary-btn" type="button" onClick={exportProject}>
                    Save project
                  </button>
                  <button
                    className="primary-btn"
                    type="button"
                    disabled={!exportable || !!exportState?.active}
                    onClick={doExportVideo}
                    title={exportable ? 'Render to WebM' : 'This browser can’t capture canvas video'}
                  >
                    {exportState?.active ? `Exporting ${Math.round(exportState.progress * 100)}%` : 'Export video (WebM)'}
                  </button>
                </div>
                {!exportable && <div className="muted small">Video export needs MediaRecorder + canvas.captureStream (try Chrome/Firefox).</div>}
                <p className="muted small">Exports as WebM. Re-encode with ffmpeg/HandBrake for MP4.</p>
              </section>

              <section className="vid-panel">
                <h3>Clip</h3>
                <div className="vid-fields">
                  <label className="vid-field">
                    From ply
                    <input
                      type="number"
                      min={1}
                      max={loaded.totalPly}
                      value={project.range.startPly}
                      onChange={(e) => dispatch({ t: 'range', startPly: Number(e.target.value), endPly: project.range.endPly })}
                    />
                  </label>
                  <label className="vid-field">
                    To ply
                    <input
                      type="number"
                      min={1}
                      max={loaded.totalPly}
                      value={project.range.endPly}
                      onChange={(e) => dispatch({ t: 'range', startPly: project.range.startPly, endPly: Number(e.target.value) })}
                    />
                  </label>
                  <label className="vid-field">
                    Board px
                    <select value={project.boardPx} onChange={(e) => dispatch({ t: 'boardPx', px: Number(e.target.value) })}>
                      {[480, 600, 720, 1080].map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vid-field">
                    FPS
                    <select value={project.fps} onChange={(e) => dispatch({ t: 'fps', fps: Number(e.target.value) })}>
                      {[24, 30, 60].map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="muted small">of {loaded.totalPly} plies</div>
              </section>

              <MusicPicker
                music={project.music}
                loading={musicLoading}
                error={musicError}
                trackDurationMs={audio ? audio.buffer.duration * 1000 : null}
                onPickBundled={onPickBundled}
                onUploadFile={onUploadMusic}
                onOffsetChange={(ms) => dispatch({ t: 'musicOffset', ms })}
                onClear={clearMusic}
              />

              <section className="vid-panel">
                <h3>Ending</h3>
                {ending ? (
                  <>
                    <div className="muted small">
                      This clip ends in <b>{ending === 'checkmate' ? 'checkmate' : 'a draw'}</b>.
                    </div>
                    <button className="secondary-btn" type="button" onClick={addEnding}>
                      {ending === 'checkmate' ? 'Add checkmate (token + line-of-sight arrows + sfx)' : 'Add draw (token + sfx)'}
                    </button>
                  </>
                ) : (
                  <div className="muted small">No checkmate or draw at the end of this range.</div>
                )}
              </section>
            </>
          ) : (
            <>
              <ToolPalette activeTool={activeTool} onSetTool={setActiveTool} />

              {selectedMoveIndex != null && selectedMoveIndex < project.moveTypes.length ? (
                <section className="vid-panel">
                  <h3>Move</h3>
                  <div className="muted small">
                    Selected: <b>{moveLabels[selectedMoveIndex] ?? `move ${selectedMoveIndex + 1}`}</b>{' '}
                    @ {Math.round(project.moveTimes[selectedMoveIndex] ?? 0)}ms
                  </div>
                  <label className="vid-field">
                    Animation
                    <select
                      value={project.moveTypes[selectedMoveIndex]}
                      onChange={(e) => dispatch({ t: 'moveType', index: selectedMoveIndex, value: e.target.value as MoveType })}
                    >
                      {MOVE_TYPES.map((mt) => (
                        <option key={mt} value={mt}>{MOVE_TYPE_LABEL[mt]}</option>
                      ))}
                    </select>
                  </label>
                  <button className="secondary-btn" type="button" onClick={() => seek(project.moveTimes[selectedMoveIndex] ?? 0)}>
                    Jump to move
                  </button>
                </section>
              ) : selectedEffect ? (
                <EffectEditor
                  selected={selectedEffect}
                  onUpdateEffect={(id, patch) => dispatch({ t: 'updateEffect', id, patch })}
                  onRemoveEffect={(id) => {
                    dispatch({ t: 'removeEffect', id });
                    setSelectedEffectIds((cur) => cur.filter((x) => x !== id));
                  }}
                />
              ) : totalSelected > 1 ? (
                <section className="vid-panel">
                  <h3>{totalSelected} items selected</h3>
                  <div className="muted small">
                    {selectedEffectIds.length} effect{selectedEffectIds.length === 1 ? '' : 's'}, {selectedMoveIndices.length} move{selectedMoveIndices.length === 1 ? '' : 's'}. Drag any one to move them all together.
                  </div>
                  {selectedMoveIndices.length > 0 && (
                    <label className="vid-field">
                      Set animation (all selected moves)
                      <select value="" onChange={(e) => { if (e.target.value) dispatch({ t: 'moveTypes', indices: selectedMoveIndices, value: e.target.value as MoveType }); }}>
                        <option value="">—</option>
                        {MOVE_TYPES.map((mt) => (
                          <option key={mt} value={mt}>{MOVE_TYPE_LABEL[mt]}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selectedEffectIds.length > 0 && (
                    <button
                      className="secondary-btn neg"
                      type="button"
                      onClick={() => { dispatch({ t: 'removeEffects', ids: selectedEffectIds }); setSelectedEffectIds([]); }}
                    >
                      Delete {selectedEffectIds.length} effect{selectedEffectIds.length === 1 ? '' : 's'}
                    </button>
                  )}
                </section>
              ) : (
                <section className="vid-panel">
                  <h3>Inspector</h3>
                  <div className="muted small">
                    Select a move handle or a placed effect on the timeline to edit it — or pick a tool above and click the board to place one. Drag a box on empty timeline space to select several, double-click a row to select it, or Ctrl+A to select all.
                  </div>
                </section>
              )}

              <div className="muted small vid-shortcuts">
                Shortcuts: <b>Space</b> play · <b>←/→</b> move · <b>Home/End</b> ends ·
                <b> 1–4</b> tools · <b>Del</b> remove · <b>Esc</b> cancel · <b>Ctrl+Z</b> undo · <b>Ctrl+Shift+Z</b> redo · <b>Alt</b>-drag to ignore snapping
              </div>
            </>
          )}
        </div>
      </aside>

      <Timeline
        project={project}
        previewMs={previewMs}
        playing={playing}
        selectedEffectIds={selectedEffectIds}
        selectedMoveIndices={selectedMoveIndices}
        moveLabels={moveLabels}
        onSeek={seek}
        onPlayPause={onPlayPause}
        onStepMove={stepMove}
        onMoveTimeChange={(index, ms) => dispatch({ t: 'moveTime', index, ms })}
        onMoveTimesChange={(updates) => dispatch({ t: 'moveTimes', updates })}
        onEffectChange={(id, patch) => dispatch({ t: 'updateEffect', id, patch })}
        onEffectsChange={(patches) => dispatch({ t: 'updateEffects', patches })}
        onSelect={setSelection}
      />

      {error && <div className="review-error neg vid-floating-error">{error}</div>}
      <audio ref={audioElRef} src={audio?.url} style={{ display: 'none' }} />
    </div>
  );
}
