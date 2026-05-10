import { useEffect, useRef, useState } from 'react';

// Returns a 0..1 volume estimate for the given MediaStream, sampled on rAF and
// throttled to ~30Hz so React re-renders stay reasonable. RMS is normalised by
// a perceived-loudness curve so typical speech sits around 0.4–0.7.
export function useVolume(stream: MediaStream | null): number {
  const [vol, setVol] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setVol(0);
      return;
    }
    let cancelled = false;
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctor();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);

    const buf = new Uint8Array(analyser.fftSize);
    let lastUpdate = 0;
    let lastSample = 0;
    let displayed = 0;
    // Asymmetric envelope: snap up instantly, fall ~0.5 units/sec (so a full
    // bar takes ~2s to drain). Mirrors classic VU-meter behaviour.
    const DECAY_PER_MS = 0.5 / 1000;

    const sample = (t: number) => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      // Stretch so the bar saturates at RMS 0.20 (loud speech). RMS ~0.05 ->
      // ~0.37, RMS ~0.10 -> ~0.62, RMS ~0.20 -> 1.0.
      const norm = Math.min(1, Math.pow(rms * 5, 0.7));

      const dt = lastSample === 0 ? 0 : t - lastSample;
      lastSample = t;
      if (norm >= displayed) {
        displayed = norm;
      } else {
        displayed = Math.max(norm, displayed - DECAY_PER_MS * dt);
      }

      if (t - lastUpdate > 33) {
        lastUpdate = t;
        setVol(displayed);
      }
      rafRef.current = requestAnimationFrame(sample);
    };
    rafRef.current = requestAnimationFrame(sample);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      try { src.disconnect(); } catch {}
      try { analyser.disconnect(); } catch {}
      try { ctx.close(); } catch {}
    };
  }, [stream]);

  return vol;
}
