import { useEffect, useRef, useState } from 'react';

// Returns true while the given MediaStream is producing audio above the
// threshold. Uses a Web Audio AnalyserNode + RMS sampling on rAF.
export function useSpeaking(
  stream: MediaStream | null,
  opts?: { threshold?: number; holdMs?: number },
): boolean {
  const threshold = opts?.threshold ?? 0.04;
  const holdMs = opts?.holdMs ?? 250;
  const [speaking, setSpeaking] = useState(false);
  const rafRef = useRef<number>(0);
  const lastSpokeRef = useRef<number>(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
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
    const sample = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = performance.now();
      if (rms > threshold) {
        lastSpokeRef.current = now;
        setSpeaking(true);
      } else if (now - lastSpokeRef.current > holdMs) {
        setSpeaking(false);
      }
      rafRef.current = requestAnimationFrame(sample);
    };
    sample();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      try { src.disconnect(); } catch {}
      try { analyser.disconnect(); } catch {}
      try { ctx.close(); } catch {}
    };
  }, [stream, threshold, holdMs]);

  return speaking;
}
