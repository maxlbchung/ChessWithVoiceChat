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

// Master bus for UI sounds (click, queue, etc.) — always live destination.
function bus(): AudioNode {
  const ac = getCtx();
  return ac.destination;
}

// Chess SFX share a separate bus that we can fade to silence on scrub events
// so rapid arrow-key scrubbing doesn't stack overlapping move/capture/check
// sounds on top of each other. ensureChessBus() always returns a valid bus.
let chessBus: GainNode | null = null;
function ensureChessBus(): GainNode {
  if (!chessBus) {
    const ac = getCtx();
    const g = ac.createGain();
    g.gain.value = 1;
    g.connect(ac.destination);
    chessBus = g;
  }
  return chessBus;
}

// Cut off any in-flight chess SFX. Fades the current bus to 0 over ~12ms
// (avoids a click) and detaches it; the next play creates a fresh bus.
// Sound graphs scheduled on the old bus keep their schedule but play into
// the muted node, so they self-stop without being heard.
export function cutoffChessSfx() {
  if (!chessBus) return;
  const ac = getCtx();
  const now = ac.currentTime;
  const old = chessBus;
  try {
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + 0.012);
  } catch {}
  setTimeout(() => { try { old.disconnect(); } catch {} }, 250);
  chessBus = null;
}

// A pitched blip: oscillator + AD envelope. Connects to opts.dest (defaults
// to the live UI bus). Works on AudioContext and OfflineAudioContext alike,
// which is what lets the reversed-render path use the same builder.
function blip(opts: {
  startAt: number;
  freq: number;
  freqEnd?: number;
  durMs: number;
  attackMs?: number;
  type?: OscillatorType;
  peak?: number;
  lpHz?: number;
  dest?: AudioNode;
}) {
  const dest = opts.dest ?? bus();
  const ac: BaseAudioContext = dest.context;
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
  tail.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// --- Reversed playback ---------------------------------------------------
// Each chess SFX has a builder that schedules its node graph on any context
// at a given start time, connected to a given destination. We can render
// that graph offline, reverse the resulting PCM, and play it back via a
// BufferSourceNode through the chess bus.
//
// Per-type tokens cancel earlier in-flight renders of the same type so
// rapid arrow scrubbing doesn't end up playing 5 staggered move sounds.
type Builder = (dest: AudioNode, t: number) => void;
const reverseTokens = { move: 0, capture: 0, check: 0 };

async function playReversed(
  kind: 'move' | 'capture' | 'check',
  builder: Builder,
  durSec: number,
) {
  reverseTokens[kind] += 1;
  const myToken = reverseTokens[kind];
  const ac = getCtx();
  const frames = Math.ceil(durSec * ac.sampleRate);
  const offline = new OfflineAudioContext(1, frames, ac.sampleRate);
  builder(offline.destination, 0);
  const rendered = await offline.startRendering();
  if (myToken !== reverseTokens[kind]) return; // a newer scrub superseded us
  // Reverse the rendered PCM in place.
  const data = rendered.getChannelData(0);
  for (let i = 0, j = data.length - 1; i < j; i++, j--) {
    const tmp = data[i];
    data[i] = data[j];
    data[j] = tmp;
  }
  const src = ac.createBufferSource();
  src.buffer = rendered;
  src.connect(ensureChessBus());
  src.start();
}

// Move — soft low wooden tap. Triangle at C3-ish, briefly lowpassed.
// ±2-semitone pitch jitter per call so consecutive moves don't sound identical.
const MOVE_DUR_SEC = 0.13;
function buildMove(dest: AudioNode, t: number) {
  const k = Math.pow(2, (Math.random() * 4 - 2) / 12);
  blip({ dest, startAt: t, freq: 260 * k, freqEnd: 180 * k, durMs: 90, type: 'triangle', peak: 0.32, lpHz: 1800 });
  blip({ dest, startAt: t, freq: 520 * k, freqEnd: 360 * k, durMs: 60, type: 'sine', peak: 0.08, lpHz: 3000 });
}
export function playMove() {
  buildMove(ensureChessBus(), getCtx().currentTime);
}
export function playMoveReversed() {
  return playReversed('move', buildMove, MOVE_DUR_SEC);
}

// Capture — heavy impact. Sub-bass thump that drops in pitch, a low body
// triangle, a short filtered-noise transient for the impact "smack", and a
// quick mid blip for snap. ±1.5-semitone jitter per call.
const CAPTURE_DUR_SEC = 0.42;
function buildCapture(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const k = Math.pow(2, (Math.random() * 3 - 1.5) / 12);

  blip({ dest, startAt: t, freq: 95 * k, freqEnd: 38 * k, durMs: 360, type: 'sine', peak: 0.55 });
  blip({ dest, startAt: t, freq: 140 * k, freqEnd: 70 * k, durMs: 260, type: 'triangle', peak: 0.4, lpHz: 1100 });
  blip({ dest, startAt: t, freq: 380 * k, freqEnd: 170 * k, durMs: 90, type: 'sine', peak: 0.16, lpHz: 2200 });

  // Impact noise transient — lowpassed white noise burst.
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
  src.connect(lp).connect(gain).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.02);
}
export function playCapture() {
  buildCapture(ensureChessBus(), getCtx().currentTime);
}
export function playCaptureReversed() {
  return playReversed('capture', buildCapture, CAPTURE_DUR_SEC);
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

// Check — a single short bouncy A3 note. Triangle voice with a tiny pitch
// blip up at the very start (the "boing" inflection) then settles to the
// note and decays. No layers, no triad — just one note with character.
const CHECK_DUR_SEC = 0.22;
function buildCheck(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const f = 220; // A3
  const dur = 0.18;

  const osc = ac.createOscillator();
  osc.type = 'triangle';
  // Pitch blip: jumps up a 5th for ~10ms then snaps back. Gives the bounce
  // without sounding like a swept note.
  osc.frequency.setValueAtTime(f * 1.5, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.025);

  const amp = ac.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.45, t + 0.004);
  amp.gain.setValueAtTime(0.45, t + 0.04);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(amp).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}
export function playCheck() {
  buildCheck(ensureChessBus(), getCtx().currentTime);
}
export function playCheckReversed() {
  return playReversed('check', buildCheck, CHECK_DUR_SEC);
}

// Generic UI click — subtle, neutral tap played on every button by default
// (see the document-level click handler in Layout). Quiet enough to layer
// under other SFX without doubling up annoyingly.
export function playClick() {
  const ac = getCtx();
  const t = ac.currentTime;
  const k = Math.pow(2, (Math.random() * 2 - 1) / 12); // ±1 semitone jitter
  blip({ startAt: t, freq: 680 * k, durMs: 40, type: 'sine', peak: 0.14, attackMs: 1 });
  // Tiny HF noise tick on top for tactile snap.
  const dur = 0.01;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.1, t + 0.0008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(hp).connect(g).connect(ac.destination);
  src.start(t);
  src.stop(t + dur + 0.01);
}

// Button tap — short bright blip for picking an option.
export function playSelect() {
  const ac = getCtx();
  const t = ac.currentTime;
  const k = Math.pow(2, (Math.random() * 2 - 1) / 12); // ±1 semitone jitter
  blip({ startAt: t, freq: 880 * k, durMs: 55, type: 'sine', peak: 0.22, attackMs: 1 });
  blip({ startAt: t, freq: 1760 * k, durMs: 30, type: 'sine', peak: 0.08, attackMs: 0.5 });
}

// Dropdown opening — short rising chirp.
export function playOpen() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 380, freqEnd: 760, durMs: 90, type: 'sine', peak: 0.22, attackMs: 2 });
  blip({ startAt: t, freq: 760, freqEnd: 1520, durMs: 60, type: 'sine', peak: 0.07, attackMs: 1, lpHz: 4000 });
}

// Dropdown closing — short falling chirp (mirror of open).
export function playClose() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 760, freqEnd: 380, durMs: 90, type: 'sine', peak: 0.22, attackMs: 2 });
  blip({ startAt: t, freq: 1520, freqEnd: 760, durMs: 60, type: 'sine', peak: 0.07, attackMs: 1, lpHz: 4000 });
}

// Queuing a game — a short two-note rising synth confirmation. Detuned saws
// through the same lowpass-pluck envelope used by the check sound, so it
// reads as "you committed" rather than just "you clicked".
export function playQueue() {
  const ac = getCtx();
  const t = ac.currentTime;
  const notes = [
    { f: 392, off: 0.0,  dur: 0.18 }, // G4
    { f: 587, off: 0.09, dur: 0.32 }, // D5 (perfect 5th up)
  ];

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 4;
  filter.frequency.setValueAtTime(700, t);
  filter.frequency.linearRampToValueAtTime(3200, t + 0.05);
  filter.frequency.exponentialRampToValueAtTime(700, t + 0.45);

  const amp = ac.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.28, t + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  filter.connect(amp).connect(ac.destination);

  for (const n of notes) {
    const start = t + n.off;
    for (const cents of [-6, +6]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = n.f * Math.pow(2, cents / 1200);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.35, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(start + n.dur + 0.05);
    }
  }
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
