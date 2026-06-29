import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { EditProject, EffectEvent } from '../../lib/videoProject';
import { formatMs } from './util';

type Props = {
  project: EditProject;
  previewMs: number;
  playing: boolean;
  selectedEffectIds: string[];
  selectedMoveIndices: number[];
  moveLabels: string[];
  onSeek: (ms: number) => void;
  onPlayPause: () => void;
  onStepMove: (dir: -1 | 1) => void;
  onMoveTimeChange: (index: number, ms: number) => void;
  onMoveTimesChange: (updates: { index: number; ms: number }[]) => void;
  onEffectChange: (id: string, patch: Partial<EffectEvent>) => void;
  onEffectsChange: (patches: { id: string; patch: Partial<EffectEvent> }[]) => void;
  onSelect: (effectIds: string[], moveIndices: number[]) => void;
};

type Drag =
  | { type: 'seek'; rectLeft: number }
  | { type: 'move'; index: number; startX: number; startMs: number }
  | { type: 'effect'; id: string; startX: number; startY: number; startMs: number; laneIdx: number; laneRows: number[] }
  | { type: 'effect-resize'; id: string; startX: number; startDur: number }
  | { type: 'effect-resize-l'; id: string; startX: number; startMs: number; startDur: number }
  | { type: 'group'; startX: number; primaryStart: number; primaryDur?: number; effIds: string[]; origEff: Map<string, number>; moveIdx: number[]; origMove: Map<number, number> }
  | { type: 'marquee'; rectLeft: number; rectTop: number; x0: number; y0: number };

const ZOOMS = [0.04, 0.07, 0.12, 0.2, 0.35, 0.6];
const LANE_H = 30;
const MOVES_H = 30;
const BAR_INSET = 4;

function effectLabel(e: EffectEvent): string {
  if (e.kind === 'arrow') return `arrow ${e.from}→${e.to}`;
  if (e.kind === 'highlight') return `highlight ${e.square}`;
  if (e.kind === 'token') return `${e.token} ${e.square}`;
  return `${e.emoji} ${e.square}`;
}

export function Timeline({
  project,
  previewMs,
  playing,
  selectedEffectIds,
  selectedMoveIndices,
  moveLabels,
  onSeek,
  onPlayPause,
  onStepMove,
  onMoveTimeChange,
  onMoveTimesChange,
  onEffectChange,
  onEffectsChange,
  onSelect,
}: Props) {
  const [zoomIdx, setZoomIdx] = useState(2);
  const pxPerMs = ZOOMS[zoomIdx];
  const contentRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const effects = project.effects;
  const selectedEff = new Set(selectedEffectIds);
  const selectedMov = new Set(selectedMoveIndices);
  const totalSel = selectedEffectIds.length + selectedMoveIndices.length;
  const rowOf = (e: EffectEvent) => e.row ?? 0;
  // Used rows (sorted) — empty rows collapse — plus one trailing empty row that
  // creates a new lane when something is dropped into it.
  const usedRows = [...new Set(effects.map(rowOf))].sort((a, b) => a - b);
  const newRowId = (usedRows.length ? usedRows[usedRows.length - 1] : -1) + 1;
  const laneRows = [...usedRows, newRowId];
  const laneIndexByRow = new Map(laneRows.map((r, i) => [r, i] as const));

  const totalMs = project.totalDurationMs;
  const contentMs = Math.max(totalMs, 4000);
  const width = contentMs * pxPerMs + 24;

  // ---- Snapping (grid, move times, effect edges, playhead, 0; Alt bypasses) -
  const gridStep = [250, 500, 1000, 2000, 5000, 10000].find((s) => s * pxPerMs >= 70) ?? 10000;
  const snapTh = () => 7 / pxPerMs;
  const nearest = (value: number, cands: number[], th: number): number => {
    let best = value;
    let bestD = th;
    for (const c of cands) {
      const dd = Math.abs(c - value);
      if (dd <= bestD) {
        bestD = dd;
        best = c;
      }
    }
    return best;
  };
  const targetsExcluding = (exEff: Set<string>, exMove: Set<number> = new Set()): number[] => {
    const t: number[] = [0, previewMs];
    project.moveTimes.forEach((m, i) => { if (!exMove.has(i)) t.push(m); });
    for (const e of effects) {
      if (exEff.has(e.id)) continue;
      t.push(e.startMs, e.startMs + e.durationMs);
    }
    return t;
  };
  const snapStart = (proposed: number, duration: number, targets: number[]): number => {
    const cands = [Math.round(proposed / gridStep) * gridStep];
    for (const t of targets) cands.push(t, t - duration); // align either edge
    return Math.max(0, nearest(proposed, cands, snapTh()));
  };
  const snapEnd = (proposedEnd: number, targets: number[]): number =>
    nearest(proposedEnd, [Math.round(proposedEnd / gridStep) * gridStep, ...targets], snapTh());
  const snapPoint = (proposed: number, targets: number[]): number =>
    Math.max(0, nearest(proposed, [Math.round(proposed / gridStep) * gridStep, ...targets], snapTh()));

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.type === 'seek') {
      onSeek(Math.max(0, (e.clientX - d.rectLeft) / pxPerMs));
      return;
    }
    if (d.type === 'marquee') {
      const x1 = e.clientX - d.rectLeft;
      const y1 = e.clientY - d.rectTop;
      marqueeRef.current = { x0: d.x0, y0: d.y0, x1, y1 };
      setMarquee({ x: Math.min(d.x0, x1), y: Math.min(d.y0, y1), w: Math.abs(x1 - d.x0), h: Math.abs(y1 - d.y0) });
      return;
    }
    const deltaMs = (e.clientX - d.startX) / pxPerMs;
    const snapOff = e.altKey;
    if (d.type === 'move') {
      let ms = Math.max(0, d.startMs + deltaMs);
      if (!snapOff) ms = snapPoint(ms, targetsExcluding(new Set(), new Set([d.index])));
      onMoveTimeChange(d.index, ms);
    } else if (d.type === 'effect-resize') {
      const eff = effects.find((x) => x.id === d.id);
      let dur = Math.max(50, d.startDur + deltaMs);
      if (eff && !snapOff) dur = Math.max(50, snapEnd(eff.startMs + dur, targetsExcluding(new Set([d.id]))) - eff.startMs);
      onEffectChange(d.id, { durationMs: dur });
    } else if (d.type === 'effect-resize-l') {
      const end = d.startMs + d.startDur;
      let start = Math.max(0, Math.min(end - 50, d.startMs + deltaMs));
      if (!snapOff) start = Math.max(0, Math.min(end - 50, snapPoint(start, targetsExcluding(new Set([d.id])))));
      onEffectChange(d.id, { startMs: start, durationMs: Math.max(50, end - start) });
    } else if (d.type === 'effect') {
      const eff = effects.find((x) => x.id === d.id);
      let start = Math.max(0, d.startMs + deltaMs);
      if (eff && !snapOff) start = snapStart(start, eff.durationMs, targetsExcluding(new Set([d.id])));
      const laneDelta = Math.round((e.clientY - d.startY) / LANE_H);
      const li = Math.max(0, Math.min(d.laneRows.length - 1, d.laneIdx + laneDelta));
      onEffectChange(d.id, { startMs: start, row: d.laneRows[li] });
    } else if (d.type === 'group') {
      let snapDelta = deltaMs;
      if (!snapOff) {
        const proposed = d.primaryStart + deltaMs;
        const targets = targetsExcluding(new Set(d.effIds), new Set(d.moveIdx));
        const snapped = d.primaryDur != null ? snapStart(proposed, d.primaryDur, targets) : snapPoint(proposed, targets);
        snapDelta = snapped - d.primaryStart;
      }
      if (d.effIds.length) onEffectsChange(d.effIds.map((id) => ({ id, patch: { startMs: Math.max(0, d.origEff.get(id)! + snapDelta) } })));
      if (d.moveIdx.length) onMoveTimesChange(d.moveIdx.map((i) => ({ index: i, ms: Math.max(0, d.origMove.get(i)! + snapDelta) })));
    }
  };
  const onUp = () => {
    const d = dragRef.current;
    if (d?.type === 'marquee') {
      const m = marqueeRef.current;
      if (m) {
        const box = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) };
        if (box.w < 4 && box.h < 4) {
          onSelect([], []); // a click on empty space clears the selection
        } else {
          const effIds = effects
            .filter((eff) => {
              const li = laneIndexByRow.get(rowOf(eff)) ?? 0;
              const bx = eff.startMs * pxPerMs;
              const bw = Math.max(8, eff.durationMs * pxPerMs);
              const by = MOVES_H + li * LANE_H;
              return bx < box.x + box.w && bx + bw > box.x && by < box.y + box.h && by + LANE_H > box.y;
            })
            .map((e) => e.id);
          const moveIdx: number[] = [];
          if (box.y < MOVES_H && box.y + box.h > 0) {
            project.moveTimes.forEach((mt, i) => {
              const hx = mt * pxPerMs;
              if (hx >= box.x && hx <= box.x + box.w) moveIdx.push(i);
            });
          }
          onSelect(effIds, moveIdx);
        }
      }
      setMarquee(null);
      marqueeRef.current = null;
    }
    dragRef.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  const startDrag = (d: Drag, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = d;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const seekFromRuler = (e: ReactPointerEvent) => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return;
    onSeek(Math.max(0, (e.clientX - rect.left) / pxPerMs));
    startDrag({ type: 'seek', rectLeft: rect.left }, e);
  };

  // Drag a whole selection (effects + moves) by the same time delta.
  const startGroup = (primaryStart: number, primaryDur: number | undefined, e: ReactPointerEvent) => {
    const effIds = selectedEffectIds.slice();
    const moveIdx = selectedMoveIndices.slice();
    const origEff = new Map(effIds.map((id) => [id, effects.find((x) => x.id === id)?.startMs ?? 0] as const));
    const origMove = new Map(moveIdx.map((i) => [i, project.moveTimes[i] ?? 0] as const));
    startDrag({ type: 'group', startX: e.clientX, primaryStart, primaryDur, effIds, origEff, moveIdx, origMove }, e);
  };

  const onBarDown = (e: ReactPointerEvent, eff: EffectEvent) => {
    if (selectedEff.has(eff.id) && totalSel > 1) {
      startGroup(eff.startMs, eff.durationMs, e);
      return;
    }
    onSelect([eff.id], []);
    startDrag({ type: 'effect', id: eff.id, startX: e.clientX, startY: e.clientY, startMs: eff.startMs, laneIdx: laneIndexByRow.get(rowOf(eff)) ?? 0, laneRows }, e);
  };

  const onMoveDown = (e: ReactPointerEvent, index: number, ms: number) => {
    if (selectedMov.has(index) && totalSel > 1) {
      startGroup(ms, undefined, e);
      return;
    }
    onSelect([], [index]);
    startDrag({ type: 'move', index, startX: e.clientX, startMs: ms }, e);
  };

  const onTracksBackgroundDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('.vid-effect-bar, .vid-move-handle, .vid-effect-resize')) return;
    const rect = tracksRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    marqueeRef.current = { x0, y0, x1: x0, y1: y0 };
    setMarquee({ x: x0, y: y0, w: 0, h: 0 });
    startDrag({ type: 'marquee', rectLeft: rect.left, rectTop: rect.top, x0, y0 }, e);
  };

  // Double-click empty space in a row selects everything in it.
  const onTracksDblClick = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('.vid-effect-bar, .vid-move-handle')) return;
    const rect = tracksRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = e.clientY - rect.top;
    if (y < MOVES_H) {
      onSelect([], project.moveTimes.map((_, i) => i));
      return;
    }
    const rowVal = laneRows[Math.floor((y - MOVES_H) / LANE_H)];
    if (rowVal === undefined) {
      onSelect([], []);
      return;
    }
    onSelect(effects.filter((ef) => rowOf(ef) === rowVal).map((ef) => ef.id), []);
  };

  const ticks: number[] = [];
  for (let t = 0; t <= contentMs; t += gridStep) ticks.push(t);

  return (
    <div className="vid-timeline">
      <div className="vid-tl-controls">
        <button className="vid-tl-btn" type="button" onClick={onPlayPause} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          {playing ? '⏸' : '▶'}
        </button>
        <button className="vid-tl-btn" type="button" onClick={() => onStepMove(-1)} title="Previous move (←)">⏮</button>
        <button className="vid-tl-btn" type="button" onClick={() => onStepMove(1)} title="Next move (→)">⏭</button>
        <button className="vid-tl-btn" type="button" disabled={zoomIdx <= 0} onClick={() => setZoomIdx((z) => Math.max(0, z - 1))} title="Zoom out">−</button>
        <button className="vid-tl-btn" type="button" disabled={zoomIdx >= ZOOMS.length - 1} onClick={() => setZoomIdx((z) => Math.min(ZOOMS.length - 1, z + 1))} title="Zoom in">+</button>
      </div>

      <div className="vid-timeline-scroll">
        <div className="vid-timeline-content" ref={contentRef} style={{ width }}>
          {/* Ruler */}
          <div className="vid-ruler" onPointerDown={seekFromRuler}>
            {ticks.map((t) => (
              <div key={t} className="vid-tick" style={{ left: t * pxPerMs }}>
                <span className="vid-tick-label">{formatMs(t)}</span>
              </div>
            ))}
          </div>

          {/* Tracks: moves lane + effect lanes (one container for marquee). */}
          <div className="vid-tracks" ref={tracksRef} onPointerDown={onTracksBackgroundDown} onDoubleClick={onTracksDblClick}>
            <div className="vid-lane vid-lane-moves" style={{ height: MOVES_H }}>
              <span className="vid-lane-label">Moves</span>
              {project.moveTimes.map((ms, i) => {
                const type = project.moveTypes[i] ?? 'normal';
                return (
                  <div
                    key={i}
                    className={'vid-move-handle' + (selectedMov.has(i) ? ' selected' : '')}
                    style={{ left: ms * pxPerMs }}
                    title={`${moveLabels[i] ?? `move ${i + 1}`} · ${type} @ ${formatMs(ms)}`}
                    onPointerDown={(e) => onMoveDown(e, i, ms)}
                  >
                    <span className="vid-move-dot" />
                    <span className="vid-move-num">{moveLabels[i] ?? i + 1}</span>
                    {type !== 'normal' && <span className="vid-move-type">{type === '3d' ? '3D' : 'A'}</span>}
                  </div>
                );
              })}
            </div>

            <div className="vid-effects" style={{ height: laneRows.length * LANE_H }}>
              {laneRows.map((rowVal, i) => (
                <div
                  key={rowVal}
                  className={'vid-elane' + (i === laneRows.length - 1 ? ' empty' : '')}
                  style={{ top: i * LANE_H, height: LANE_H }}
                />
              ))}
              {effects.map((e) => {
                const li = laneIndexByRow.get(rowOf(e)) ?? 0;
                return (
                  <div
                    key={e.id}
                    className={`vid-effect-bar kind-${e.kind}` + (selectedEff.has(e.id) ? ' selected' : '')}
                    style={{ left: e.startMs * pxPerMs, width: Math.max(10, e.durationMs * pxPerMs), top: li * LANE_H + BAR_INSET, height: LANE_H - BAR_INSET * 2 }}
                    onPointerDown={(ev) => onBarDown(ev, e)}
                  >
                    <span
                      className="vid-effect-resize left"
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        onSelect([e.id], []);
                        startDrag({ type: 'effect-resize-l', id: e.id, startX: ev.clientX, startMs: e.startMs, startDur: e.durationMs }, ev);
                      }}
                    />
                    <span className="vid-effect-bar-label">{effectLabel(e)}</span>
                    <span
                      className="vid-effect-resize right"
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        onSelect([e.id], []);
                        startDrag({ type: 'effect-resize', id: e.id, startX: ev.clientX, startDur: e.durationMs }, ev);
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {marquee && <div className="vid-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          </div>

          {/* Playhead */}
          <div className="vid-playhead" style={{ left: previewMs * pxPerMs }} />
        </div>
      </div>
    </div>
  );
}
