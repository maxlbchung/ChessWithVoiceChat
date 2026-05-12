// UI sound effects — synthesised via Web Audio. These are intentionally
// abstract/musical rather than imitative: short pitched blips, a triad for
// the win cue, a bell for check, a quick swept blip for chat, and a soft
// modulated hiss for the volume-max alert. Designed to be clear signals
// rather than miniature recordings of real objects.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) {
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Master bus so every sound shares the same headroom & a gentle limiter feel.
function bus(): AudioNode {
  const ac = getCtx();
  return ac.destination;
}

// A pitched blip: oscillator + AD envelope. Returns when scheduled.
function blip(opts: {
  startAt: number;
  freq: number;
  freqEnd?: number;
  durMs: number;
  attackMs?: number;
  type?: OscillatorType;
  peak?: number;
  lpHz?: number;
}) {
  const ac = getCtx();
  const t = opts.startAt;
  const dur = opts.durMs / 1000;
  const attack = (opts.attackMs ?? 2) / 1000;
  const peak = opts.peak ?? 0.3;

  const osc = ac.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, t);
  if (opts.freqEnd != null) {
    osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + dur);
  }

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  let tail: AudioNode = gain;
  if (opts.lpHz != null) {
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lpHz;
    gain.connect(lp);
    tail = lp;
  }
  osc.connect(gain);
  tail.connect(bus());
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Move — soft low wooden tap. Triangle at C3-ish, briefly lowpassed.
export function playMove() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 260, freqEnd: 180, durMs: 90, type: 'triangle', peak: 0.32, lpHz: 1800 });
  // A second, quieter octave-up layer for a touch of brightness.
  blip({ startAt: t, freq: 520, freqEnd: 360, durMs: 60, type: 'sine', peak: 0.08, lpHz: 3000 });
}

// Capture — heavy impact. Sub-bass thump that drops in pitch, a low body
// triangle, a short filtered-noise transient for the impact "smack", and a
// quick mid blip for snap. Long enough to feel weighty without dragging.
export function playCapture() {
  const ac = getCtx();
  const t = ac.currentTime;

  // Deep sub thump — does most of the "weight" work.
  blip({ startAt: t, freq: 95, freqEnd: 38, durMs: 360, type: 'sine', peak: 0.55 });
  // Low body layer.
  blip({ startAt: t, freq: 140, freqEnd: 70, durMs: 260, type: 'triangle', peak: 0.4, lpHz: 1100 });
  // Mid snap.
  blip({ startAt: t, freq: 380, freqEnd: 170, durMs: 90, type: 'sine', peak: 0.16, lpHz: 2200 });

  // Impact noise transient — lowpassed white noise burst, fast attack, short
  // decay. Adds the "smack" that pure tones can't produce.
  const dur = 0.06;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.5, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(gain).connect(ac.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// Win — bright ascending major triad (C5 E5 G5), each note short with a slight
// overlap so it reads as one fanfare rather than three isolated beeps.
export function playWin() {
  const ac = getCtx();
  const t0 = ac.currentTime;
  const notes = [
    { f: 523.25, off: 0.0,  dur: 110 }, // C5
    { f: 659.25, off: 0.08, dur: 110 }, // E5
    { f: 783.99, off: 0.16, dur: 380 }, // G5 — held
  ];
  for (const n of notes) {
    const t = t0 + n.off;
    // Two slightly detuned voices per note for chorus.
    blip({ startAt: t, freq: n.f * 0.997, durMs: n.dur, type: 'triangle', peak: 0.22, attackMs: 4 });
    blip({ startAt: t, freq: n.f * 1.003, durMs: n.dur, type: 'sine',     peak: 0.18, attackMs: 4 });
  }
}

// Check — a clean bell ding. Fundamental + an inharmonic partial at ~2.76×
// (close to a real bell's strike tone ratio) so it has metallic colour
// without being aggressive.
export function playCheck() {
  const ac = getCtx();
  const t = ac.currentTime;
  const f = 880; // A5
  // Fundamental with a long-ish exponential decay.
  blip({ startAt: t, freq: f, durMs: 350, type: 'sine', peak: 0.32, attackMs: 1 });
  // Bell partial — quieter, decays a bit faster.
  blip({ startAt: t, freq: f * 2.76, durMs: 220, type: 'sine', peak: 0.14, attackMs: 1 });
  // Tiny higher shimmer.
  blip({ startAt: t, freq: f * 5.4, durMs: 120, type: 'sine', peak: 0.06, attackMs: 1 });
}

// Chat pop — quick sine sweep, short and bright.
export function playChat() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 1200, freqEnd: 620, durMs: 65, type: 'sine', peak: 0.32, attackMs: 1 });
  // A tiny higher tick at the start sharpens the "pop".
  blip({ startAt: t, freq: 2400, durMs: 18, type: 'sine', peak: 0.12, attackMs: 0.5 });
}

// Volume-max — soft pulsing band-limited hiss. Faint, non-musical, just a
// background "watch out" texture rather than a chaotic TV-static rip.
let staticState: {
  src: AudioBufferSourceNode;
  gain: GainNode;
  trem: OscillatorNode;
} | null = null;
const STATIC_PEAK = 0.045;

export function setStaticActive(active: boolean) {
  const ac = getCtx();
  const now = ac.currentTime;
  if (active && !staticState) {
    // 1s white-noise loop, lowpassed so it's airy not abrasive.
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(STATIC_PEAK * 0.7, now + 0.15);

    // Slow tremolo gives it that "we're in the red" pulse.
    const trem = ac.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = 3.5;
    const tremDepth = ac.createGain();
    tremDepth.gain.value = STATIC_PEAK * 0.4;
    trem.connect(tremDepth).connect(gain.gain);

    src.connect(hp).connect(lp).connect(gain).connect(bus());
    src.start();
    trem.start();
    staticState = { src, gain, trem };
  } else if (!active && staticState) {
    const { src, gain, trem } = staticState;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    const stopAt = now + 0.22;
    try { src.stop(stopAt); } catch {}
    try { trem.stop(stopAt); } catch {}
    staticState = null;
  }
}
