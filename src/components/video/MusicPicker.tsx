import { useRef } from 'react';
import { BUNDLED_TRACKS, type BundledTrack } from '../../lib/videoMusic';
import type { MusicRef } from '../../lib/videoProject';
import { formatMs } from './util';

type Props = {
  music: MusicRef | null;
  loading: boolean;
  error: string | null;
  trackDurationMs: number | null;
  onPickBundled: (t: BundledTrack) => void;
  onUploadFile: (f: File) => void;
  onOffsetChange: (ms: number) => void;
  onClear: () => void;
};

export function MusicPicker({
  music,
  loading,
  error,
  trackDurationMs,
  onPickBundled,
  onUploadFile,
  onOffsetChange,
  onClear,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <section className="vid-panel">
      <h3>Music</h3>
      <div className="vid-track-list">
        {BUNDLED_TRACKS.map((t) => (
          <label key={t.id} className="vid-radio">
            <input
              type="radio"
              name="vid-music"
              checked={music?.source === 'bundled' && music.name === t.name}
              onChange={() => onPickBundled(t)}
            />
            {t.name}
          </label>
        ))}
      </div>
      <div className="vid-upload-row">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadFile(f);
            if (fileRef.current) fileRef.current.value = '';
          }}
        />
        <button className="secondary-btn" type="button" onClick={() => fileRef.current?.click()}>
          Upload audio…
        </button>
        {music?.source === 'upload' && <span className="muted small">{music.name}</span>}
      </div>
      {loading && <div className="muted small">Loading track…</div>}
      {error && <div className="neg small">{error}</div>}
      {music && (
        <div className="vid-offset">
          <label className="small">Start in song: {formatMs(music.startOffsetMs)}</label>
          <input
            type="range"
            min={0}
            max={Math.max(0, Math.round(trackDurationMs ?? 0))}
            step={100}
            value={Math.round(music.startOffsetMs)}
            onChange={(e) => onOffsetChange(Number(e.target.value))}
          />
          <button className="link-btn" type="button" onClick={onClear}>
            Remove music
          </button>
        </div>
      )}
      <p className="muted small">
        Uploaded files aren’t saved into the project JSON — you’ll re-attach them on load.
      </p>
    </section>
  );
}
