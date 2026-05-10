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
    const sample = (t: number) => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      // Stretch RMS to 0..1 with a soft curve. RMS ~0.05 -> ~0.4, ~0.15 -> ~0.85.
      const norm = Math.min(1, Math.pow(rms * 4, 0.7));
      if (t - lastUpdate > 33) {
        lastUpdate = t;
        setVol(norm);
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
