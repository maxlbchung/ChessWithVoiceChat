import { formatMs } from './util';

type Props = {
  previewMs: number;
  totalMs: number;
  onSeek: (ms: number) => void;
};

export function TransportBar({ previewMs, totalMs, onSeek }: Props) {
  return (
    <div className="vid-transport">
      <input
        className="vid-scrub"
        type="range"
        min={0}
        max={Math.max(1, Math.round(totalMs))}
        step={1}
        value={Math.round(Math.min(previewMs, totalMs))}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span className="vid-time mono">
        {formatMs(previewMs)} / {formatMs(totalMs)}
      </span>
    </div>
  );
}
