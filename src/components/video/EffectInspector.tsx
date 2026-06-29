import { QUICK_EMOJIS } from '../../lib/inGameEmojis';
import {
  DEFAULT_ARROW_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  TOKEN_KINDS,
  TOKEN_SPECS,
  type EffectEvent,
  type TokenKind,
} from '../../lib/videoProject';
import { isSquare } from './util';

// What clicking the board will place. `null` = no tool armed (board clicks do
// nothing). Arrows remember the first-clicked square in `from`.
export type ActiveTool =
  | null
  | { kind: 'highlight'; color: string }
  | { kind: 'token'; token: TokenKind }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'arrow'; color: string; from?: string };

// The "items you can place" header: pick a tool, then click the board.
export function ToolPalette({
  activeTool,
  onSetTool,
}: {
  activeTool: ActiveTool;
  onSetTool: (t: ActiveTool) => void;
}) {
  const active = (k: string) => activeTool?.kind === k;
  const toolBtn = (k: string, label: string, armed: ActiveTool) => (
    <button
      type="button"
      className={'secondary-btn' + (active(k) ? ' active' : '')}
      onClick={() => onSetTool(active(k) ? null : armed)}
    >
      {label}
    </button>
  );

  return (
    <section className="vid-panel">
      <h3>Place</h3>
      <div className="vid-tool-grid">
        {toolBtn('highlight', 'Highlight', { kind: 'highlight', color: DEFAULT_HIGHLIGHT_COLOR })}
        {toolBtn('token', 'Token', { kind: 'token', token: 'brilliant' })}
        {toolBtn('arrow', 'Arrow', { kind: 'arrow', color: DEFAULT_ARROW_COLOR })}
        {toolBtn('emoji', 'Emoji', { kind: 'emoji', emoji: QUICK_EMOJIS[0] })}
      </div>

      {activeTool?.kind === 'highlight' && (
        <label className="vid-field">
          Color
          <input type="color" value={activeTool.color} onChange={(e) => onSetTool({ kind: 'highlight', color: e.target.value })} />
        </label>
      )}
      {activeTool?.kind === 'token' && (
        <label className="vid-field">
          Token
          <select value={activeTool.token} onChange={(e) => onSetTool({ kind: 'token', token: e.target.value as TokenKind })}>
            {TOKEN_KINDS.map((k) => (
              <option key={k} value={k}>{TOKEN_SPECS[k].label}</option>
            ))}
          </select>
        </label>
      )}
      {activeTool?.kind === 'emoji' && (
        <label className="vid-field">
          Emoji
          <select value={activeTool.emoji} onChange={(e) => onSetTool({ kind: 'emoji', emoji: e.target.value })}>
            {QUICK_EMOJIS.map((em) => (
              <option key={em} value={em}>{em}</option>
            ))}
          </select>
        </label>
      )}

      <div className="muted small">
        {activeTool?.kind === 'arrow'
          ? activeTool.from
            ? `From ${activeTool.from} — click the target square.`
            : 'Click the arrow’s start square.'
          : activeTool
            ? 'Click the board to place. Lasts one move (emoji ≈ 1s). Esc clears.'
            : 'Pick a tool, then click the board to place it.'}
      </div>
    </section>
  );
}

// Settings for an already-placed effect.
export function EffectEditor({
  selected,
  onUpdateEffect,
  onRemoveEffect,
}: {
  selected: EffectEvent;
  onUpdateEffect: (id: string, patch: Partial<EffectEvent>) => void;
  onRemoveEffect: (id: string) => void;
}) {
  const patch = (p: Partial<EffectEvent>) => onUpdateEffect(selected.id, p);
  return (
    <section className="vid-panel">
      <div className="vid-effect-edit-head">
        <h3 className="vid-effect-kind">{selected.kind}</h3>
        <button className="link-btn neg" type="button" onClick={() => onRemoveEffect(selected.id)}>
          Delete
        </button>
      </div>

      <div className="vid-fields">
      <label className="vid-field">
        Start (ms)
        <input type="number" value={Math.round(selected.startMs)} min={0} step={50} onChange={(e) => patch({ startMs: Number(e.target.value) })} />
      </label>
      <label className="vid-field">
        Duration (ms)
        <input type="number" value={Math.round(selected.durationMs)} min={50} step={50} onChange={(e) => patch({ durationMs: Math.max(50, Number(e.target.value)) })} />
      </label>

      {selected.kind === 'highlight' && (
        <>
          <SquareField label="Square" value={selected.square} onChange={(v) => patch({ square: v } as Partial<EffectEvent>)} />
          <label className="vid-field">
            Color
            <input type="color" value={selected.color} onChange={(e) => patch({ color: e.target.value } as Partial<EffectEvent>)} />
          </label>
        </>
      )}

      {selected.kind === 'token' && (
        <>
          <SquareField label="Square" value={selected.square} onChange={(v) => patch({ square: v } as Partial<EffectEvent>)} />
          <label className="vid-field">
            Token
            <select value={selected.token} onChange={(e) => patch({ token: e.target.value as TokenKind } as Partial<EffectEvent>)}>
              {TOKEN_KINDS.map((k) => (
                <option key={k} value={k}>{TOKEN_SPECS[k].label}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {selected.kind === 'emoji' && (
        <>
          <SquareField label="Square" value={selected.square} onChange={(v) => patch({ square: v } as Partial<EffectEvent>)} />
          <label className="vid-field">
            Emoji
            <select value={selected.emoji} onChange={(e) => patch({ emoji: e.target.value } as Partial<EffectEvent>)}>
              {QUICK_EMOJIS.map((em) => (
                <option key={em} value={em}>{em}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {selected.kind === 'arrow' && (
        <>
          <SquareField label="From" value={selected.from} onChange={(v) => patch({ from: v } as Partial<EffectEvent>)} />
          <SquareField label="To" value={selected.to} onChange={(v) => patch({ to: v } as Partial<EffectEvent>)} />
          <label className="vid-field">
            Color
            <input type="color" value={selected.color} onChange={(e) => patch({ color: e.target.value } as Partial<EffectEvent>)} />
          </label>
        </>
      )}
      </div>
    </section>
  );
}

function SquareField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="vid-field">
      {label}
      <input
        type="text"
        value={value}
        maxLength={2}
        className={isSquare(value) ? '' : 'invalid'}
        onChange={(e) => onChange(e.target.value.toLowerCase().trim())}
        placeholder="e4"
      />
    </label>
  );
}
