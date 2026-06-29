// Video export: drive renderScene over the clip's duration into an offscreen
// canvas, capture it with MediaRecorder, and mux audio in via a WebAudio
// MediaStreamDestination on the SHARED sfx context — so the chosen music slice
// AND the timed SFX (emoji bubbles, move-quality tokens) all land in one stream.
// Output is WebM; capture is realtime (timing rides the rAF clock).
import * as sfx from './sfx';
import type { SpriteCache } from './pieceSprites';
import type { TokenSpriteCache } from './tokenSprites';
import { canvasSize, renderScene, type SceneModel } from './videoRenderer';

export function canExportVideo(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

export function pickMime(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

// Maps a move-sound key (see buildMoveSounds in the page) to a sfx function.
const SOUND_FNS: Record<string, () => void> = {
  move: sfx.playMove,
  capture: sfx.playCapture,
  check: sfx.playCheck,
  castle: sfx.playCastle,
  push: sfx.playPush,
  merge: sfx.playMerge,
  buy: sfx.playBuy,
  cashin: sfx.playCashIn,
  freeze: sfx.playFreeze,
  slice: sfx.playSlice,
  spawn: sfx.playSpawn,
  fly: sfx.playFly,
  mutate: sfx.playMutate,
  missile: sfx.playMissileLaunch,
  goofball: sfx.playGoofball,
  twin: sfx.playTwinJutsu,
  slime: sfx.playSlimeExpand,
  jug: sfx.playJugQuake,
  harem: sfx.playHarem,
};

// Fire SFX (move sounds + emoji/token effects) whose start falls in
// (prevMs, curMs]. Used by both the live preview loop and the export loop so
// sounds stay in sync with the visuals.
export function fireSceneSounds(model: SceneModel, prevMs: number, curMs: number): void {
  if (curMs <= prevMs) return;
  const moveSounds = model.moveSounds;
  if (moveSounds) {
    for (let k = 0; k < model.moveTimes.length; k++) {
      const t = model.moveTimes[k];
      if (t > prevMs && t <= curMs) {
        for (const key of moveSounds[k] ?? []) SOUND_FNS[key]?.();
      }
    }
  }
  for (const e of model.effects) {
    if (e.startMs > prevMs && e.startMs <= curMs) {
      if (e.kind === 'emoji') sfx.playEmojiReaction(e.emoji);
      else if (e.kind === 'token') sfx.playMoveQuality(e.token);
    }
  }
}

export type ExportOptions = {
  model: SceneModel;
  sprites: SpriteCache;
  tokens?: TokenSpriteCache;
  fps: number;
  audio?: { buffer: AudioBuffer; startOffsetMs: number } | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export async function exportVideo(opts: ExportOptions): Promise<Blob> {
  const { model, sprites, tokens, fps, audio, onProgress, signal } = opts;
  if (!canExportVideo()) {
    throw new Error('This browser does not support in-page video capture (MediaRecorder/captureStream).');
  }

  const canvas = document.createElement('canvas');
  const size = canvasSize(model.boardPx);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context.');

  const stream = canvas.captureStream(fps);

  // One audio context for everything: tap the sfx master bus + (optionally) the
  // music source into a MediaStreamDestination and add its track to the stream.
  const ac = sfx.audioContext();
  if (ac.state === 'suspended') {
    try { await ac.resume(); } catch { /* best effort */ }
  }
  const dest = ac.createMediaStreamDestination();
  sfx.connectCapture(dest);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);

  let musicSrc: AudioBufferSourceNode | null = null;
  if (audio?.buffer) {
    musicSrc = ac.createBufferSource();
    musicSrc.buffer = audio.buffer;
    const g = ac.createGain();
    musicSrc.connect(g);
    g.connect(dest); // captured
    g.connect(ac.destination); // monitored live during the realtime export
  }

  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];

  return await new Promise<Blob>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      sfx.disconnectCapture(dest);
      try { musicSrc?.stop(); } catch { /* ignore */ }
    };
    const stop = () => {
      if (finished) return;
      finished = true;
      cleanup();
      if (rec.state !== 'inactive') rec.stop();
    };

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onerror = () => {
      cleanup();
      reject(new Error('Recording failed.'));
    };
    rec.onstop = () => resolve(new Blob(chunks, { type: mimeType }));

    renderScene(ctx, model, 0, sprites, tokens);
    rec.start();
    if (musicSrc && audio) {
      try {
        musicSrc.start(0, Math.max(0, audio.startOffsetMs / 1000), model.totalDurationMs / 1000);
      } catch { /* offset past end — ignore */ }
    }

    const t0 = performance.now();
    let prev = 0;
    const tick = (now: number) => {
      if (signal?.aborted) { stop(); return; }
      const t = now - t0;
      const clamped = Math.min(t, model.totalDurationMs);
      fireSceneSounds(model, prev, clamped);
      prev = clamped;
      renderScene(ctx, model, clamped, sprites, tokens);
      onProgress?.(model.totalDurationMs > 0 ? clamped / model.totalDurationMs : 1);
      if (t >= model.totalDurationMs) {
        requestAnimationFrame(() => stop());
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
