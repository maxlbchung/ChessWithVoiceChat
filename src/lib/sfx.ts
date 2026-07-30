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

// The shared synthesis context. Exposed so the video editor can decode its
// music into the SAME context and tap the master bus — letting it mux SFX +
// music into a single captured stream during export.
export function audioContext(): AudioContext {
  return getCtx();
}

// Tap the master bus into an extra destination (e.g. a MediaStreamDestination
// for video export). Additive — the normal speaker output stays connected.
export function connectCapture(node: AudioNode): void {
  getMaster().connect(node);
}
export function disconnectCapture(node: AudioNode): void {
  try {
    getMaster().disconnect(node);
  } catch {
    /* wasn't connected */
  }
}

// Master gain — every SFX (UI + chess) eventually routes through this so the
// settings volume slider can attenuate the whole bus at once.
let master: GainNode | null = null;
let pendingMasterVolume = 1;
function getMaster(): GainNode {
  if (!master) {
    const ac = getCtx();
    const g = ac.createGain();
    g.gain.value = pendingMasterVolume;
    g.connect(ac.destination);
    master = g;
  }
  return master;
}
export function setMasterVolume(v: number) {
  const clamped = Math.max(0, Math.min(1, v));
  pendingMasterVolume = clamped;
  if (!master) return;
  const ac = getCtx();
  const now = ac.currentTime;
  try {
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(clamped, now + 0.04);
  } catch {
    master.gain.value = clamped;
  }
}

// Master bus for UI sounds (click, queue, etc.) — routed through the master
// gain so the volume slider attenuates UI clicks alongside chess SFX.
function bus(): AudioNode {
  return getMaster();
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
    g.connect(getMaster());
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

// Flip board — quick rising whoosh, evokes board rotation. Sine sweep up
// with a soft octave-up shimmer layered on for sparkle.
export function playFlip() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 400, freqEnd: 1150, durMs: 160, type: 'sine', peak: 0.28, attackMs: 4 });
  blip({ startAt: t + 0.02, freq: 800, freqEnd: 2300, durMs: 130, type: 'sine', peak: 0.08, attackMs: 1 });
}

// Reset board — analog-tape rewind: a high-band noise whir sweeping down,
// with a row of clock-tick "tocks" layered on top that fade in (quiet → loud)
// over the duration. Reads as time spooling backward.
export function playReset() {
  // Tight downward "swish" + soft thud — ~220 ms, no clock-tick layering.
  // The old reel-to-reel rewind was nearly a full second of chaotic ticks;
  // this one just punctuates the snap-back-to-start.
  const dest = ensureChessBus();
  const ac = getCtx();
  const t0 = ac.currentTime;

  // Filtered noise sweep — band-pass dropping from ~2 kHz to ~500 Hz.
  const swishDur = 0.18;
  const length = Math.max(1, Math.floor(swishDur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 4;
  bp.frequency.setValueAtTime(2000, t0);
  bp.frequency.exponentialRampToValueAtTime(520, t0 + swishDur);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0, t0);
  ng.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + swishDur);
  noise.connect(bp).connect(ng).connect(dest);
  noise.start(t0);
  noise.stop(t0 + swishDur + 0.02);

  // Soft thud at the bottom of the sweep — gives the gesture a landing.
  blip({
    dest, startAt: t0 + swishDur - 0.02,
    freq: 280, freqEnd: 180, durMs: 70,
    type: 'sine', peak: 0.18, attackMs: 1, lpHz: 900,
  });
}

// Castling — two quick taps in succession (king slide + rook hop), slightly
// pitched apart. Runs through the chess bus like playMove so scrub cutoff
// works on it too.
function buildCastle(dest: AudioNode, t: number) {
  const k = Math.pow(2, (Math.random() * 2 - 1) / 12);
  // King tap
  blip({ dest, startAt: t, freq: 280 * k, freqEnd: 200 * k, durMs: 80, type: 'triangle', peak: 0.32, lpHz: 1800 });
  blip({ dest, startAt: t, freq: 560 * k, freqEnd: 400 * k, durMs: 50, type: 'sine', peak: 0.08, lpHz: 3000 });
  // Rook tap, ~130ms later, a bit higher pitch
  const t2 = t + 0.13;
  blip({ dest, startAt: t2, freq: 340 * k, freqEnd: 240 * k, durMs: 90, type: 'triangle', peak: 0.32, lpHz: 1800 });
  blip({ dest, startAt: t2, freq: 680 * k, freqEnd: 480 * k, durMs: 55, type: 'sine', peak: 0.08, lpHz: 3000 });
}
export function playCastle() {
  buildCastle(ensureChessBus(), getCtx().currentTime);
}

// Push (chess 2.0) — sounds like shoving a piece across the board. A low
// triangle slide drops in pitch over the duration (momentum of the shove),
// a sub-octave sine layer adds weight, a lowpassed-noise burst over the
// first ~200ms gives the scraping texture, and a small low thud at the end
// is the pushed piece settling onto its new square.
function buildPush(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  blip({ dest, startAt: t, freq: 200, freqEnd: 120, durMs: 250, type: 'triangle', peak: 0.42, attackMs: 18, lpHz: 1300 });
  blip({ dest, startAt: t, freq: 100, freqEnd: 60,  durMs: 260, type: 'sine',     peak: 0.28, attackMs: 18 });

  // Scrape layer — LP-noise that softens as the slide progresses.
  const scrapeDur = 0.22;
  const len = Math.max(1, Math.floor(scrapeDur * ac.sampleRate));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1400, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + scrapeDur);
  const scrapeGain = ac.createGain();
  scrapeGain.gain.setValueAtTime(0, t);
  scrapeGain.gain.linearRampToValueAtTime(0.18, t + 0.015);
  scrapeGain.gain.exponentialRampToValueAtTime(0.0001, t + scrapeDur);
  src.connect(lp).connect(scrapeGain).connect(dest);
  src.start(t);
  src.stop(t + scrapeDur + 0.02);

  // Settle thud as the piece lands.
  const tThud = t + 0.18;
  blip({ dest, startAt: tThud, freq: 110, freqEnd: 70, durMs: 90, type: 'triangle', peak: 0.32, attackMs: 1, lpHz: 900 });
}
export function playPush() {
  buildPush(ensureChessBus(), getCtx().currentTime);
}

// Merge (merge gamemode) — two notes a 4th apart that converge to a single
// pitch, with bell partials sparkling on top. Evokes "fusion".
function buildMerge(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Rustling layer — 10–14 short HF-filtered noise grains scattered over
  // ~260ms. Each grain is a quick band-pass burst at a randomized pitch and
  // amplitude; stacked together they sound like pieces shuffling together.
  const n = 10 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const jitter = (Math.random() - 0.5) * 0.6;
    const at = t + (0.26 * (i + 0.5 + jitter)) / n;
    const gDur = 0.012 + Math.random() * 0.022;
    const len = Math.max(1, Math.floor((gDur + 0.005) * ac.sampleRate));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let j = 0; j < len; j++) data[j] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + Math.random() * 2800;
    bp.Q.value = 1.5;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const g = ac.createGain();
    const amp = 0.14 + Math.random() * 0.14;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(amp, at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + gDur);
    src.connect(bp).connect(hp).connect(g).connect(dest);
    src.start(at);
    src.stop(at + gDur + 0.01);
  }

}
export function playMerge() {
  buildMerge(ensureChessBus(), getCtx().currentTime);
}

// Buy (cash variant shop pick) — bright bell-like "ka-ching" chime. Two
// stacked high harmonics + a short delayed fundamental for a register-bell
// shape, plus a metallic noise snap at the very start.
export function playBuy() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 1760, durMs: 220, type: 'sine', peak: 0.24, attackMs: 1 });
  blip({ startAt: t, freq: 2637, durMs: 190, type: 'sine', peak: 0.14, attackMs: 1 });
  blip({ startAt: t + 0.06, freq: 1320, durMs: 240, type: 'sine', peak: 0.14, attackMs: 1 });
  const dur = 0.018;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4000;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.18, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(hp).connect(g).connect(getMaster());
  src.start(t);
  src.stop(t + dur + 0.01);
}

// Place (cash variant — dropping a bought piece on the board). A weightier
// wooden thud than a normal move with an ascending shimmer arpeggio on top
// to read as "summoned into being". Runs through the chess bus so scrub
// cutoff applies.
function buildPlace(dest: AudioNode, t: number) {
  const shim = [880, 1320, 1760];
  for (let i = 0; i < shim.length; i++) {
    blip({ dest, startAt: t + 0.02 + i * 0.035, freq: shim[i], durMs: 100, type: 'sine', peak: 0.13 - i * 0.025, attackMs: 1 });
  }
}
export function playPlace() {
  buildPlace(ensureChessBus(), getCtx().currentTime);
}

// Cash-in (cash variant — pawn reaches back rank and converts to gold).
// A coin cascade: 7 short bright blips scattered across ~350ms at randomized
// high pitches, with a warm sustaining bell underneath and a metallic noise
// snap at the start. Distinctly more celebratory than playBuy's single ding.
function buildCashIn(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const baseFreqs = [1320, 1760, 2093, 2637, 3136];
  for (let i = 0; i < baseFreqs.length; i++) {
    const f = baseFreqs[i] * (0.95 + Math.random() * 0.1);
    const at = t + i * 0.04 + Math.random() * 0.015;
    blip({ dest, startAt: at, freq: f, durMs: 110, type: 'sine', peak: 0.22, attackMs: 1 });
    blip({ dest, startAt: at, freq: f * 2, durMs: 60, type: 'sine', peak: 0.07, attackMs: 1 });
  }
  const dur = 0.04;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.14, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(hp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.01);
}
export function playCashIn() {
  buildCashIn(ensureChessBus(), getCtx().currentTime);
}

// Freeze (hero: frost) — crackling ice. A scatter of short HP-noise grains
// spread irregularly over ~420ms gives the brittle "tick-snap" texture of
// ice fracturing; roughly half of them get a tiny high-pitched sine ping
// for the resonant icy ring on top.
function buildFreeze(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const totalDur = 0.42;
  const n = 11;
  for (let i = 0; i < n; i++) {
    const at = t + (i / n) * totalDur + (Math.random() - 0.5) * 0.05;
    const gDur = 0.008 + Math.random() * 0.018;
    const length = Math.max(1, Math.floor((gDur + 0.005) * ac.sampleRate));
    const buf = ac.createBuffer(1, length, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let j = 0; j < length; j++) data[j] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500 + Math.random() * 2500;
    const g = ac.createGain();
    const amp = 0.2 + Math.random() * 0.22;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(amp, at + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + gDur);
    src.connect(hp).connect(g).connect(dest);
    src.start(at);
    src.stop(at + gDur + 0.01);
    if (Math.random() < 0.5) {
      const f = 2800 + Math.random() * 3500;
      blip({ dest, startAt: at, freq: f, durMs: 25 + Math.random() * 30, type: 'sine', peak: 0.06 + Math.random() * 0.05, attackMs: 0.5 });
    }
  }
}
export function playFreeze() {
  buildFreeze(ensureChessBus(), getCtx().currentTime);
}

// Frost shatter — the freeze expiring. A sharp glass-break: a brief
// bandpassed noise crack (the ice fracturing) followed by a scattered
// cascade of high tinkles (shards tumbling). Reads as a brittle break.
function buildFrostShatter(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  // Front crack — short, sharp bandpassed noise burst centred high.
  const crackDur = 0.09;
  const cLen = Math.max(1, Math.floor(crackDur * ac.sampleRate));
  const cBuf = ac.createBuffer(1, cLen, ac.sampleRate);
  const cData = cBuf.getChannelData(0);
  for (let i = 0; i < cLen; i++) cData[i] = Math.random() * 2 - 1;
  const cSrc = ac.createBufferSource();
  cSrc.buffer = cBuf;
  const cBp = ac.createBiquadFilter();
  cBp.type = 'bandpass';
  cBp.Q.value = 2.2;
  cBp.frequency.setValueAtTime(4200, t);
  cBp.frequency.exponentialRampToValueAtTime(2400, t + crackDur);
  const cG = ac.createGain();
  cG.gain.setValueAtTime(0, t);
  cG.gain.linearRampToValueAtTime(0.5, t + 0.002);
  cG.gain.exponentialRampToValueAtTime(0.0001, t + crackDur);
  cSrc.connect(cBp).connect(cG).connect(dest);
  cSrc.start(t);
  cSrc.stop(t + crackDur + 0.02);

  // Tinkle cascade — many short high sine blips scattered across ~0.5s, each
  // at a randomly-chosen high frequency. The chord-of-glass feel.
  const tinkleSpread = 0.55;
  const tinkleCount = 14;
  const baseFreqs = [3200, 3800, 4600, 5400, 6200, 7000, 7800, 8800];
  for (let i = 0; i < tinkleCount; i++) {
    const at = t + 0.015 + (i / tinkleCount) * tinkleSpread + Math.random() * 0.04;
    const f = baseFreqs[Math.floor(Math.random() * baseFreqs.length)] * (0.92 + Math.random() * 0.16);
    blip({
      dest,
      startAt: at,
      freq: f,
      durMs: 70 + Math.random() * 90,
      type: 'sine',
      peak: 0.05 + Math.random() * 0.07,
      attackMs: 0.8,
    });
  }

  // Lower body thud — the ice releasing pressure. Gives the break weight.
  blip({ dest, startAt: t, freq: 220, freqEnd: 110, durMs: 180, type: 'sine', peak: 0.16, attackMs: 1 });
}
export function playFrostShatter() {
  buildFrostShatter(ensureChessBus(), getCtx().currentTime);
}

// Slice (hero: warlord) — a drawn-out blade whoosh that crescendos into a
// metallic clang of sword striking armor. The wind-up is a mid-range air
// whoosh (no soaring whistle — that reads as a firework). The climax at
// ~150ms in is a steel-on-armor crack: bandpassed noise transient + an
// inharmonic clangtone stack + a low body thunk, decaying quickly as the
// armor damps the ring.
function buildSlice(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  // Internal timing is anchored so the impact falls at t + impactAt — call
  // sites fire playSlice() at swing-start so the whoosh leads INTO impact.
  const impactAt = 0.45;          // clang moment (aligned to 900ms swing midpoint)
  const whooshDur = impactAt + 0.05;

  // === WIND-UP: pure air whoosh ===
  // Just filtered noise — no tonal layers. Wide, low-Q lowpass on white
  // noise gives a diffuse "rushing wind" rather than a resonant whistle.
  // The cutoff sweeps up as the blade picks up speed.
  const length = Math.max(1, Math.floor(whooshDur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.5;
  lp.frequency.setValueAtTime(700, t);
  lp.frequency.exponentialRampToValueAtTime(2400, t + impactAt);
  // High-pass to roll off subsonic rumble so the noise reads as airy.
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.Q.value = 0.5;
  hp.frequency.value = 220;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + impactAt);
  g.gain.exponentialRampToValueAtTime(0.0001, t + whooshDur);
  src.connect(hp).connect(lp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + whooshDur + 0.02);

  // === IMPACT: sword striking armor ===
  // Sharp metallic crack — short bandpassed noise transient for the
  // steel-on-steel scrape that fronts the clang.
  const crackDur = 0.08;
  const cLen = Math.max(1, Math.floor(crackDur * ac.sampleRate));
  const cBuf = ac.createBuffer(1, cLen, ac.sampleRate);
  const cData = cBuf.getChannelData(0);
  for (let i = 0; i < cLen; i++) cData[i] = Math.random() * 2 - 1;
  const cSrc = ac.createBufferSource();
  cSrc.buffer = cBuf;
  const cBp = ac.createBiquadFilter();
  cBp.type = 'bandpass';
  cBp.Q.value = 2.4;
  cBp.frequency.setValueAtTime(2200, t + impactAt);
  cBp.frequency.exponentialRampToValueAtTime(1100, t + impactAt + crackDur);
  const cG = ac.createGain();
  cG.gain.setValueAtTime(0, t + impactAt);
  cG.gain.linearRampToValueAtTime(0.55, t + impactAt + 0.002);
  cG.gain.exponentialRampToValueAtTime(0.0001, t + impactAt + crackDur);
  cSrc.connect(cBp).connect(cG).connect(dest);
  cSrc.start(t + impactAt);
  cSrc.stop(t + impactAt + crackDur + 0.02);

  // Inharmonic clangtone stack — sine partials at non-harmonic ratios give
  // the characteristic clang of metal striking metal (bell-like inharmonicity
  // rather than a clean tone). Ratios chosen so no two voices are an octave
  // or fifth apart.
  const clangVoices: Array<{ f: number; peak: number; durMs: number }> = [
    { f: 340,  peak: 0.22, durMs: 360 },
    { f: 530,  peak: 0.18, durMs: 320 },
    { f: 870,  peak: 0.14, durMs: 280 },
    { f: 1430, peak: 0.1,  durMs: 240 },
    { f: 2350, peak: 0.07, durMs: 180 },
  ];
  for (const v of clangVoices) {
    blip({ dest, startAt: t + impactAt, freq: v.f, durMs: v.durMs, type: 'sine', peak: v.peak, attackMs: 1 });
  }

  // Low body thunk — the armor's deeper response gives the strike weight.
  blip({ dest, startAt: t + impactAt, freq: 150, freqEnd: 80, durMs: 220, type: 'sine', peak: 0.24, attackMs: 1 });
  blip({ dest, startAt: t + impactAt, freq: 90, durMs: 260, type: 'triangle', peak: 0.18, attackMs: 1 });
}
export function playSlice() {
  buildSlice(ensureChessBus(), getCtx().currentTime);
}

// Spawn (hero: necromancer) — deep, ominous summoning drone. A sub-bass
// foundation with detuned root sines, a slightly dissonant minor-third
// colour above, and sawtooth fifth/octave voices for the harmonic growl,
// all routed through a dark lowpass and crawling up out of silence.
function buildSpawn(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const swellDur = 0.55;
  const tailDur = 0.5;
  const totalDur = swellDur + tailDur;

  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  lp.Q.value = 0.9;
  lp.connect(dest);

  const voices: Array<{ f: number; type: OscillatorType; peak: number }> = [
    { f: 10.3,          type: 'sine',     peak: 0.5  }, // sub rumble (below hearing — felt)
    { f: 13.75,         type: 'sine',     peak: 0.42 }, // root sub
    { f: 13.75 * 1.006, type: 'sine',     peak: 0.32 }, // root detune — slow beat
    { f: 13.75,         type: 'sawtooth', peak: 0.22 }, // root saw — bass body via harmonics
    { f: 16.35,         type: 'triangle', peak: 0.26 }, // minor 3rd, warm body
    { f: 20.6,          type: 'sawtooth', peak: 0.26 }, // fifth — primary bass voice
    { f: 20.6 * 1.005,  type: 'sawtooth', peak: 0.2  }, // fifth detune
    { f: 27.5,          type: 'sawtooth', peak: 0.16 }, // octave — growl
  ];
  for (const v of voices) {
    const osc = ac.createOscillator();
    osc.type = v.type;
    osc.frequency.value = v.f;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v.peak, t + swellDur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + totalDur);
    osc.connect(g).connect(lp);
    osc.start(t);
    osc.stop(t + totalDur + 0.05);
  }
}
export function playSpawn() {
  buildSpawn(ensureChessBus(), getCtx().currentTime);
}

// Fly (hero: flight) — soaring whoosh. A pair of sine sweeps low→high paired
// with a band-passed noise sweep climbing in pitch, evoking a king lifting
// off the board.
function buildFly(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  blip({ dest, startAt: t, freq: 300, freqEnd: 1500, durMs: 280, type: 'sine', peak: 0.26, attackMs: 8 });
  blip({ dest, startAt: t + 0.04, freq: 600, freqEnd: 3000, durMs: 240, type: 'sine', peak: 0.1, attackMs: 4 });
  const dur = 0.28;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2;
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(4000, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.2, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.02);
}
export function playFly() {
  buildFly(ensureChessBus(), getCtx().currentTime);
}

// Slime expand (hero: slime) — a wet, stretchy grow. A wobbling low sine
// bends upward (the blob inflating) under a band-passed noise swish, capped
// with a few bubble pops as the goo settles.
function buildSlimeExpand(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  // Inflating body — slow upward bend with an LFO wobble on the pitch.
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(330, t + 0.5);
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 9;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 22;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  osc.connect(lp).connect(g).connect(dest);
  osc.start(t); osc.stop(t + 0.65);
  lfo.start(t); lfo.stop(t + 0.65);

  // Wet swish — band-passed noise climbing with the stretch.
  const dur = 0.45;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(250, t);
  bp.frequency.exponentialRampToValueAtTime(900, t + dur);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0, t);
  ng.gain.linearRampToValueAtTime(0.12, t + 0.05);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(ng).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.02);

  // Bubble pops as the goo settles.
  blip({ dest, startAt: t + 0.30, freq: 620, freqEnd: 260, durMs: 70, type: 'sine', peak: 0.12, lpHz: 1600 });
  blip({ dest, startAt: t + 0.42, freq: 800, freqEnd: 320, durMs: 60, type: 'sine', peak: 0.09, lpHz: 1800 });
  blip({ dest, startAt: t + 0.52, freq: 500, freqEnd: 210, durMs: 80, type: 'sine', peak: 0.07, lpHz: 1400 });
}
export function playSlimeExpand() {
  buildSlimeExpand(ensureChessBus(), getCtx().currentTime);
}

// Slime split (hero: slime) — a squelchy pop. A wet noise splat through a
// fast-falling lowpass, a downward "deflate" bend, and stray droplet blips
// landing after the burst.
function buildSlimeSplit(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const dur = 0.22;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.6;
  lp.frequency.setValueAtTime(2600, t);
  lp.frequency.exponentialRampToValueAtTime(280, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.3, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.02);

  // Deflating body.
  blip({ dest, startAt: t, freq: 300, freqEnd: 90, durMs: 240, type: 'triangle', peak: 0.2, lpHz: 800 });
  // Droplets scattering.
  blip({ dest, startAt: t + 0.10, freq: 900, freqEnd: 380, durMs: 60, type: 'sine', peak: 0.1, lpHz: 2200 });
  blip({ dest, startAt: t + 0.17, freq: 700, freqEnd: 300, durMs: 70, type: 'sine', peak: 0.08, lpHz: 1800 });
  blip({ dest, startAt: t + 0.26, freq: 1100, freqEnd: 460, durMs: 55, type: 'sine', peak: 0.06, lpHz: 2400 });
}
export function playSlimeSplit() {
  buildSlimeSplit(ensureChessBus(), getCtx().currentTime);
}

// Juggernaut quake (hero: juggernaut) — a deep earthquake, the hero's
// signature per the design note. A compressed cousin of the ICBM explosion:
// LFO-modulated sub-bass voices over a low-passed rumble bed, with a single
// aftershock thump. Tighter (~1.2s) than the 2.3s missile blast since it
// plays on every ability use and tier-up.
function buildJugQuake(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Tremolo'd sub-bass voice — same recipe as the explosion's subQuake but
  // shorter. The LFO rocks a post-envelope gain (base 0.8 ± 0.2) so the
  // ground "shakes" rather than just thuds.
  const subQuake = (
    freq: number, freqEnd: number, durMs: number, peak: number,
    attackMs: number, lfoHz: number, startOffset = 0,
  ) => {
    const start = t + startOffset;
    const dur = durMs / 1000;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + dur);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attackMs / 1000);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    const trem = ac.createGain();
    trem.gain.value = 0.8;
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = lfoHz;
    const lfoAmt = ac.createGain();
    lfoAmt.gain.value = 0.2;
    lfo.connect(lfoAmt).connect(trem.gain);
    osc.connect(env).connect(trem).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.04);
    lfo.start(start);
    lfo.stop(start + dur + 0.04);
  };
  subQuake(52, 18, 1100, 0.7, 50, 6.2);
  subQuake(30, 13, 1250, 0.6, 70, 4.4);
  subQuake(72, 26, 800, 0.45, 40, 5.1, 0.03);

  // Rumble bed — low-passed noise with the corner sweeping down so the
  // spectral centroid stays buried in the bass. Two biquads in series for a
  // steeper rolloff (no mids leaking through).
  const dur = 1.2;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.9;
  lp.frequency.setValueAtTime(380, t);
  lp.frequency.exponentialRampToValueAtTime(60, t + dur);
  const lp2 = ac.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.setValueAtTime(380, t);
  lp2.frequency.exponentialRampToValueAtTime(60, t + dur);
  const env = ac.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.8, t + 0.04);
  env.gain.setValueAtTime(0.8, t + 0.14);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const trem = ac.createGain();
  trem.gain.value = 0.85;
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 4.2;
  const lfoAmt = ac.createGain();
  lfoAmt.gain.value = 0.15;
  lfo.connect(lfoAmt).connect(trem.gain);
  src.connect(lp).connect(lp2).connect(env).connect(trem).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.04);
  lfo.start(t);
  lfo.stop(t + dur + 0.04);

  // One aftershock thump rolling through the decay.
  blip({ dest, startAt: t + 0.45, freq: 46, freqEnd: 19, durMs: 550, type: 'sine', peak: 0.32, attackMs: 22 });
}
export function playJugQuake() {
  buildJugQuake(ensureChessBus(), getCtx().currentTime);
}

// Mutate (hero: mutation) — Geiger-counter style ticks accelerating over a
// low rising drone, capped by a soft "lock-in" chime. Reads as radiation
// building up and the piece reconfiguring.
function buildMutate(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const tickWindow = 0.5;

  // Sparse Geiger ticks — a handful of clicks spaced evenly across the
  // window, each jittered slightly so they don't sound mechanical.
  const numTicks = 6;
  for (let i = 0; i < numTicks; i++) {
    const progress = i / (numTicks - 1);
    const baseTime = progress * tickWindow;
    const jitter = (Math.random() - 0.5) * 0.03;
    const tickTime = t + baseTime + jitter;
    const tickDur = 0.018;
    const length = Math.ceil(tickDur * ac.sampleRate);
    const buf = ac.createBuffer(1, length, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let j = 0; j < length; j++) data[j] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800 + Math.random() * 1400;
    const g = ac.createGain();
    const peak = 0.05 + Math.random() * 0.12;
    g.gain.setValueAtTime(0, tickTime);
    g.gain.linearRampToValueAtTime(peak, tickTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, tickTime + tickDur);
    src.connect(hp).connect(g).connect(dest);
    src.start(tickTime);
    src.stop(tickTime + tickDur + 0.01);
  }

  // Low rising drone — DNA-warping growl that ramps up as the ticks build.
  blip({ dest, startAt: t, freq: 85, freqEnd: 175, durMs: 560, type: 'sawtooth', peak: 0.11, attackMs: 40, lpHz: 700 });
  blip({ dest, startAt: t + 0.04, freq: 128, freqEnd: 260, durMs: 520, type: 'triangle', peak: 0.08, attackMs: 30, lpHz: 1200 });
}
export function playMutate() {
  buildMutate(ensureChessBus(), getCtx().currentTime);
}

// Missile launch (hero: ICBM firing) — two electronic arming beeps, then
// an ascending whistle. The whistle mirrors the landing whistle's spectrum
// exactly (same stacked sines + sub rumble + airy high), just inverted in
// direction (ascending) and envelope (peaks at ignition then fades as the
// missile pulls away — opposite the landing's crescendo into impact).
function buildMissileLaunch(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Electronic arming beeps — square-wave fundamental for that classic
  // "system alert" / 8-bit harmonic character, run through a steep lowpass
  // to tame the harshness while keeping the harmonics that make it sound
  // electronic. Sharp linear-release shape (vs the natural exp decay) gives
  // the crisp "blip" edge of a digital tone.
  const beep = (start: number, freq: number, durMs: number, peak: number) => {
    const dur = durMs / 1000;
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = freq * 4;
    lp.Q.value = 1.4;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.002);
    g.gain.setValueAtTime(peak, start + dur - 0.004);
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  beep(t,        880, 95, 0.05);
  beep(t + 0.16, 880, 95, 0.05);

  // Launch whistle begins just after the second beep finishes. Mirrors
  // the landing whistle's voice stack, reversed.
  const wStart = t + 0.32;
  const wDur = 1.05;

  // Ascending tone whose amplitude peaks just after ignition then decays —
  // mirror of the landing's silent → loud crescendo.
  const climb = (
    freqStart: number,
    freqEnd: number,
    peakAmp: number,
    oscType: OscillatorType,
    startOffset = 0,
  ) => {
    const start = wStart + startOffset;
    const len = wDur - startOffset;
    const osc = ac.createOscillator();
    osc.type = oscType;
    osc.frequency.setValueAtTime(freqStart, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + len);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peakAmp, start + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, start + len);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + len + 0.04);
  };

  // Mid-band body — ascending sines (mirror of the landing's 680→200 etc).
  climb(200, 680, 0.42, 'sine');
  climb(95,  340, 0.4,  'sine');
  // Lower body — felt weight as the missile lifts off.
  climb(60,  150, 0.5,  'sine');
  // Sub-bass rumble — the launch thrust, fades as missile gets distant.
  climb(32,  42,  0.78, 'sine');
  // High airy whistle voice — quiet, retains the "whistle" character.
  climb(480, 2000, 0.16, 'sine');

  // Bandpassed turbulence — air being shoved aside by the climbing rocket.
  // Sweeps up alongside the swoop voices, peaks just after ignition.
  const length = Math.max(1, Math.floor(wDur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(380, wStart);
  bp.frequency.exponentialRampToValueAtTime(1800, wStart + wDur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, wStart);
  g.gain.linearRampToValueAtTime(0.45, wStart + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, wStart + wDur);
  src.connect(bp).connect(g).connect(dest);
  src.start(wStart);
  src.stop(wStart + wDur + 0.04);
}
export function playMissileLaunch() {
  buildMissileLaunch(ensureChessBus(), getCtx().currentTime);
}

// Missile whistle (hero: ICBM in flight) — every voice fades IN from near
// silence and crescendoes into the explosion, so it reads as "something
// huge falling closer and closer." Spectrum is intentionally wide: a deep
// sub-bass rumble for mass, mid-band swoop tones for the body, and a
// quieter high airborne whistle riding on top. Bandpassed turbulence noise
// crescendos alongside. Total duration matches the half-second pause so
// the climax meets the explosion exactly.
function buildMissileWhistle(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const dur = 0.5;
  // A descending tone whose amplitude crescendos from silence to peak.
  // Doesn't use blip() because blip uses an attack-decay envelope (peaks
  // early then fades) — here we want a slow rise that's loudest at the end.
  const swoop = (
    freqStart: number,
    freqEnd: number,
    peakAmp: number,
    oscType: OscillatorType,
    startOffset = 0,
  ) => {
    const start = t + startOffset;
    const len = dur - startOffset;
    const osc = ac.createOscillator();
    osc.type = oscType;
    osc.frequency.setValueAtTime(freqStart, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + len);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peakAmp, start + len);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + len + 0.04);
  };

  // Mid-band body — descending sines suggesting the missile cutting air.
  swoop(680, 200, 0.42, 'sine');
  swoop(340, 95,  0.4,  'sine');
  // Lower body — felt weight.
  swoop(150, 60,  0.5,  'sine');
  // Sub-bass rumble — the "ground rumble" that builds as it approaches.
  // Stays in the felt-only sub range; rises slightly so it has motion.
  swoop(42, 32, 0.78, 'sine');
  // High airy whistle voice — quiet, keeps a faint "whistle" character.
  swoop(2000, 480, 0.16, 'sine');

  // Bandpassed turbulence — air being torn open. Crescendos with the swoop.
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(1800, t);
  bp.frequency.exponentialRampToValueAtTime(380, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.45, t + dur);
  src.connect(bp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.04);
}
export function playMissileWhistle() {
  buildMissileWhistle(ensureChessBus(), getCtx().currentTime);
}

// Explosion (hero: ICBM landing) — an explosive earthquake, not a slap.
// The previous design's HF crack and 8ms attack read as percussive; here
// we drop the high-frequency transient entirely, slow every attack to
// 40–90ms (so it BUILDS instead of snapping), and run all sub-bass voices
// through LFO-modulated gain stages for a ground-shaking tremolo. A long
// low-passed noise bed carries the rumble; aftershock thumps roll through
// the decay so the ground keeps shifting after the initial impact.
function buildExplosion(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Sub-bass voice with LFO-modulated amplitude — the LFO offsets a
  // downstream gain node (base 0.8, depth ±0.2) so the post-envelope level
  // rocks at lfoHz Hz. No full dropouts; just shaking.
  const subQuake = (
    freq: number,
    freqEnd: number,
    durMs: number,
    peak: number,
    attackMs: number,
    lfoHz: number,
    startOffset = 0,
  ) => {
    const start = t + startOffset;
    const dur = durMs / 1000;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + dur);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attackMs / 1000);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    const trem = ac.createGain();
    trem.gain.value = 0.8;
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = lfoHz;
    const lfoAmt = ac.createGain();
    lfoAmt.gain.value = 0.2;
    lfo.connect(lfoAmt).connect(trem.gain);
    osc.connect(env).connect(trem).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.04);
    lfo.start(start);
    lfo.stop(start + dur + 0.04);
  };

  // Stacked earthquake voices — pure sines so no harmonic adds drum-like
  // tonality. Different LFO rates so the shake isn't a uniform pulse.
  subQuake(48, 16, 2100, 0.85, 70, 5.5);
  subQuake(28, 12, 2300, 0.75, 90, 7.2);
  subQuake(75, 28, 1500, 0.55, 60, 4.1, 0.04);
  subQuake(20, 14, 2500, 0.5, 100, 3.3);

  // Soft low-band noise burst on the front — gives the impact a moment of
  // definition without any mid/high content. Lowpassed at 220Hz (down from
  // 700) so the spectral centroid stays buried in the bass — perceived
  // pitch tracks the centroid, not just the fundamentals, so pulling the
  // top off makes the same sub-bass feel deeper.
  const fDur = 0.22;
  const fLen = Math.max(1, Math.floor(fDur * ac.sampleRate));
  const fBuf = ac.createBuffer(1, fLen, ac.sampleRate);
  const fData = fBuf.getChannelData(0);
  for (let i = 0; i < fLen; i++) fData[i] = Math.random() * 2 - 1;
  const fSrc = ac.createBufferSource();
  fSrc.buffer = fBuf;
  const fLp = ac.createBiquadFilter();
  fLp.type = 'lowpass';
  fLp.frequency.value = 220;
  const fG = ac.createGain();
  fG.gain.setValueAtTime(0, t);
  fG.gain.linearRampToValueAtTime(0.42, t + 0.04);
  fG.gain.exponentialRampToValueAtTime(0.0001, t + fDur);
  fSrc.connect(fLp).connect(fG).connect(dest);
  fSrc.start(t);
  fSrc.stop(t + fDur + 0.02);

  // Main earthquake noise bed — long lowpassed rumble. Starting LP drops
  // from 1400Hz → 450Hz so the spectral centroid stays low even at peak.
  // The same noise energy, but with the top sheared off, reads as much
  // deeper. 50ms attack + brief hold means it builds rather than slaps.
  // Steeper Q on the lowpass keeps the corner sharp so no mids leak.
  const dur = 2.3;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.9;
  lp.frequency.setValueAtTime(450, t);
  lp.frequency.exponentialRampToValueAtTime(55, t + dur);
  // Second lowpass in series for an effective steeper rolloff — kills any
  // residual mid-band content the single biquad lets through.
  const lp2 = ac.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.setValueAtTime(450, t);
  lp2.frequency.exponentialRampToValueAtTime(55, t + dur);
  const env = ac.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.95, t + 0.05);
  env.gain.setValueAtTime(0.95, t + 0.22);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const trem = ac.createGain();
  trem.gain.value = 0.85;
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 3.8;
  const lfoAmt = ac.createGain();
  lfoAmt.gain.value = 0.15;
  lfo.connect(lfoAmt).connect(trem.gain);
  src.connect(lp).connect(lp2).connect(env).connect(trem).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.04);
  lfo.start(t);
  lfo.stop(t + dur + 0.04);

  // Aftershock thumps — secondary impacts rolling through the decay. Slow
  // attacks (25–30ms) keep them rumble-shaped, not slap-shaped.
  blip({ dest, startAt: t + 0.55, freq: 50, freqEnd: 20, durMs: 750, type: 'sine', peak: 0.42, attackMs: 25 });
  blip({ dest, startAt: t + 1.00, freq: 38, freqEnd: 18, durMs: 850, type: 'sine', peak: 0.32, attackMs: 30 });
  blip({ dest, startAt: t + 1.45, freq: 30, freqEnd: 16, durMs: 650, type: 'sine', peak: 0.22, attackMs: 25 });
}
export function playExplosion() {
  buildExplosion(ensureChessBus(), getCtx().currentTime);
}

// Harem — the classic two-note wolf whistle. A short rising "fweet" that
// starts at the mid-pitch of the second whistle, an abrupt pause, then a
// longer falling "fhwooo" from the peak down. Sine carriers tuned to
// whistle frequencies with a touch of bandpassed breath noise underneath.
function buildHarem(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Fixed pitches chosen by hand for the cleanest catcall:
  //   W1: 1400 → 1800 Hz
  //   W2: 1200 → 1400 → 600 Hz (small upward bend before the long fall)
  //   200 ms abrupt pause between.
  const w1StartFreq = 1400;
  const w1EndFreq = 2000;
  const w2StartFreq = 1200;
  const w2PeakFreq = 1400;
  const w2EndFreq = 600;
  // Fraction of W2's duration spent climbing 1200 → 1400 before the descent.
  const w2PeakFrac = 0.12;

  // ---- Whistle 1: short rising slide ("fweet!") ----
  const w1Start = t;
  const w1Dur = 0.15;
  const w1Osc = ac.createOscillator();
  w1Osc.type = 'sine';
  w1Osc.frequency.setValueAtTime(w1StartFreq, w1Start);
  w1Osc.frequency.exponentialRampToValueAtTime(w1EndFreq, w1Start + w1Dur);
  const w1G = ac.createGain();
  // Sharp linear release at the very end gives the "abrupt" cutoff
  // before the pause; no exponential tail bleeding into the gap.
  w1G.gain.setValueAtTime(0, w1Start);
  w1G.gain.linearRampToValueAtTime(0.3, w1Start + 0.025);
  w1G.gain.setValueAtTime(0.3, w1Start + w1Dur - 0.015);
  w1G.gain.linearRampToValueAtTime(0, w1Start + w1Dur);
  w1Osc.connect(w1G).connect(dest);
  w1Osc.start(w1Start);
  w1Osc.stop(w1Start + w1Dur + 0.01);

  // Breath noise tracking the rising slide.
  const breath1Len = Math.ceil(w1Dur * ac.sampleRate);
  const breath1Buf = ac.createBuffer(1, breath1Len, ac.sampleRate);
  const b1d = breath1Buf.getChannelData(0);
  for (let i = 0; i < breath1Len; i++) b1d[i] = Math.random() * 2 - 1;
  const breath1Src = ac.createBufferSource();
  breath1Src.buffer = breath1Buf;
  const breath1Bp = ac.createBiquadFilter();
  breath1Bp.type = 'bandpass';
  breath1Bp.Q.value = 4;
  breath1Bp.frequency.setValueAtTime(w1StartFreq, w1Start);
  breath1Bp.frequency.exponentialRampToValueAtTime(w1EndFreq, w1Start + w1Dur);
  const breath1G = ac.createGain();
  breath1G.gain.setValueAtTime(0, w1Start);
  breath1G.gain.linearRampToValueAtTime(0.04, w1Start + 0.03);
  breath1G.gain.linearRampToValueAtTime(0, w1Start + w1Dur);
  breath1Src.connect(breath1Bp).connect(breath1G).connect(dest);
  breath1Src.start(w1Start);
  breath1Src.stop(w1Start + w1Dur + 0.01);

  // ---- Abrupt 200 ms pause ----
  const gap = 0.2;

  // ---- Whistle 2: short upward bend then long descending slide
  // ("fhwooo") 1400 → 1600 → 400 ----
  const w2Start = w1Start + w1Dur + gap;
  const w2Dur = 0.7;
  const w2PeakAt = w2Start + w2Dur * w2PeakFrac;
  const w2Osc = ac.createOscillator();
  w2Osc.type = 'sine';
  w2Osc.frequency.setValueAtTime(w2StartFreq, w2Start);
  w2Osc.frequency.exponentialRampToValueAtTime(w2PeakFreq, w2PeakAt);
  w2Osc.frequency.exponentialRampToValueAtTime(w2EndFreq, w2Start + w2Dur);
  const w2G = ac.createGain();
  w2G.gain.setValueAtTime(0, w2Start);
  w2G.gain.linearRampToValueAtTime(0.32, w2Start + 0.03);
  w2G.gain.setValueAtTime(0.32, w2Start + w2Dur * 0.55);
  w2G.gain.exponentialRampToValueAtTime(0.0001, w2Start + w2Dur);
  w2Osc.connect(w2G).connect(dest);
  w2Osc.start(w2Start);
  w2Osc.stop(w2Start + w2Dur + 0.04);

  // Breath noise tracking the descending slide.
  const breath2Len = Math.ceil(w2Dur * ac.sampleRate);
  const breath2Buf = ac.createBuffer(1, breath2Len, ac.sampleRate);
  const b2d = breath2Buf.getChannelData(0);
  for (let i = 0; i < breath2Len; i++) b2d[i] = Math.random() * 2 - 1;
  const breath2Src = ac.createBufferSource();
  breath2Src.buffer = breath2Buf;
  const breath2Bp = ac.createBiquadFilter();
  breath2Bp.type = 'bandpass';
  breath2Bp.Q.value = 4;
  breath2Bp.frequency.setValueAtTime(w2StartFreq, w2Start);
  breath2Bp.frequency.exponentialRampToValueAtTime(w2PeakFreq, w2PeakAt);
  breath2Bp.frequency.exponentialRampToValueAtTime(w2EndFreq, w2Start + w2Dur);
  const breath2G = ac.createGain();
  breath2G.gain.setValueAtTime(0, w2Start);
  breath2G.gain.linearRampToValueAtTime(0.05, w2Start + 0.04);
  breath2G.gain.exponentialRampToValueAtTime(0.0001, w2Start + w2Dur);
  breath2Src.connect(breath2Bp).connect(breath2G).connect(dest);
  breath2Src.start(w2Start);
  breath2Src.stop(w2Start + w2Dur + 0.02);
}
export function playHarem() {
  buildHarem(ensureChessBus(), getCtx().currentTime);
}

// Goofball — comedy clown horn. Two short "honk!"s, each built from a
// nasal sawtooth + an octave-above saw, run through a bandpass at ~700 Hz
// so it gets the buzzy, comedy-bulb-horn timbre. Quick attack, fast
// decay, two honks separated by a brief gap.
function buildHorn(dest: AudioNode, t: number, baseFreq: number, dur: number) {
  const ac: BaseAudioContext = dest.context;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1300;
  bp.Q.value = 4;
  bp.connect(dest);

  // Two saw voices — fundamental + octave — for that buzzy, nasal sound.
  const voices: Array<{ freq: number; peak: number }> = [
    { freq: baseFreq,     peak: 0.42 },
    { freq: baseFreq * 2, peak: 0.18 },
  ];
  for (const v of voices) {
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = v.freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v.peak, t + 0.008);
    g.gain.setValueAtTime(v.peak, t + dur - 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bp);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
function buildGoofball(dest: AudioNode, t: number) {
  // Two honks with a tiny gap. Second honk is slightly higher pitched —
  // the classic "honk-HONK!" comedy beat.
  const honk1Dur = 0.075;
  const honk2Dur = 0.15;
  const gap = 0.05;
  buildHorn(dest, t, 600, honk1Dur);
  buildHorn(dest, t + honk1Dur + gap, 760, honk2Dur);
}
export function playGoofball() {
  buildGoofball(ensureChessBus(), getCtx().currentTime);
}

// Smoke bomb (hero: twin-jutsu) — quick "pft" ignition pop followed by a
// longer hissing release of "gas" that sweeps downward in frequency as the
// cloud dissipates. A subtle low thunk underneath gives the pop bottom.
function buildTwinJutsuPoof(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // === POP: short ignition burst ===
  const popDur = 0.07;
  const pLen = Math.max(1, Math.floor(popDur * ac.sampleRate));
  const pBuf = ac.createBuffer(1, pLen, ac.sampleRate);
  const pData = pBuf.getChannelData(0);
  for (let i = 0; i < pLen; i++) pData[i] = Math.random() * 2 - 1;
  const pSrc = ac.createBufferSource();
  pSrc.buffer = pBuf;
  const pBp = ac.createBiquadFilter();
  pBp.type = 'bandpass';
  pBp.Q.value = 1.4;
  pBp.frequency.setValueAtTime(420, t);
  pBp.frequency.exponentialRampToValueAtTime(220, t + popDur);
  const pG = ac.createGain();
  pG.gain.setValueAtTime(0, t);
  pG.gain.linearRampToValueAtTime(0.4, t + 0.003);
  pG.gain.exponentialRampToValueAtTime(0.0001, t + popDur);
  pSrc.connect(pBp).connect(pG).connect(dest);
  pSrc.start(t);
  pSrc.stop(t + popDur + 0.02);

  // === HISS: smoke / gas release ===
  // Filtered white noise with a downward-sweeping bandpass — pressure
  // venting through the smoke bomb's holes, then the cloud spreading and
  // settling as the highs roll off.
  const hissDur = 0.55;
  const hLen = Math.max(1, Math.floor(hissDur * ac.sampleRate));
  const hBuf = ac.createBuffer(1, hLen, ac.sampleRate);
  const hData = hBuf.getChannelData(0);
  for (let i = 0; i < hLen; i++) hData[i] = Math.random() * 2 - 1;
  const hSrc = ac.createBufferSource();
  hSrc.buffer = hBuf;
  const hBp = ac.createBiquadFilter();
  hBp.type = 'bandpass';
  hBp.Q.value = 0.6;
  hBp.frequency.setValueAtTime(1900, t + 0.04);
  hBp.frequency.exponentialRampToValueAtTime(700, t + hissDur);
  // Roll subsonic off so the hiss doesn't muddy the pop's body.
  const hHp = ac.createBiquadFilter();
  hHp.type = 'highpass';
  hHp.Q.value = 0.5;
  hHp.frequency.value = 380;
  const hG = ac.createGain();
  hG.gain.setValueAtTime(0.0001, t);
  hG.gain.exponentialRampToValueAtTime(0.34, t + 0.09);
  hG.gain.exponentialRampToValueAtTime(0.0001, t + hissDur);
  hSrc.connect(hHp).connect(hBp).connect(hG).connect(dest);
  hSrc.start(t);
  hSrc.stop(t + hissDur + 0.02);

  // === BODY: subtle low thunk for weight ===
  blip({ dest, startAt: t, freq: 90, freqEnd: 60, durMs: 110, type: 'sine', peak: 0.22, attackMs: 4 });
}
export function playTwinJutsu() {
  buildTwinJutsuPoof(ensureChessBus(), getCtx().currentTime);
}

// Kamakaze arming (hero: kamakaze) — a charge strapped to one of your own
// pieces, winding itself up to a hair trigger. Six layers, all pointed at the
// same idea (energy accumulating past the point where it's stable):
//   1. an ignition crack that closes the contact,
//   2. a capacitor whine that rises in two stages so the climb accelerates,
//   3. one LFO driving both an amplitude tremolo and a filter growl, its rate
//      and depth ramping up — the fuller the charge, the more it shudders,
//   4. sparks whose crackle gets denser toward the end,
//   5. a sub pressure swell that peaks right at the brink,
//   6. a detonation timer whose beeps accelerate into a final contact snap.
// Lands on a snap plus a dissonant, beating overtone rather than a settled
// confirm — the piece is live and unhappy about it. The payoff sound
// (playExplosion) comes later.
const KAMAKAZE_CHARGE_SEC = 0.82;
function buildKamakazeCharge(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const CHARGE = KAMAKAZE_CHARGE_SEC;
  const brink = t + CHARGE;

  // === IGNITION: contact spark that kicks the charge off. Has to be
  // immediately audible — this is the click-feedback for the arm action, and
  // the whine behind it is still nearly silent at this point.
  const igDur = 0.07;
  const igLen = Math.max(1, Math.floor(igDur * ac.sampleRate));
  const igBuf = ac.createBuffer(1, igLen, ac.sampleRate);
  const igData = igBuf.getChannelData(0);
  // Steep-ish decay so it reads as a crack rather than a hiss.
  for (let i = 0; i < igLen; i++) {
    const d = 1 - i / igLen;
    igData[i] = (Math.random() * 2 - 1) * d * Math.sqrt(d);
  }
  const igSrc = ac.createBufferSource();
  igSrc.buffer = igBuf;
  const igBp = ac.createBiquadFilter();
  igBp.type = 'bandpass';
  igBp.Q.value = 0.8;
  igBp.frequency.setValueAtTime(4200, t);
  igBp.frequency.exponentialRampToValueAtTime(1500, t + igDur);
  const igG = ac.createGain();
  igG.gain.setValueAtTime(0, t);
  igG.gain.linearRampToValueAtTime(0.42, t + 0.003);
  igG.gain.exponentialRampToValueAtTime(0.0001, t + igDur);
  igSrc.connect(igBp).connect(igG).connect(dest);
  igSrc.start(t);
  igSrc.stop(t + igDur + 0.02);
  // Switch thrown — a little weight under the spark.
  blip({ dest, startAt: t, freq: 190, freqEnd: 88, durMs: 80, type: 'triangle', peak: 0.22, attackMs: 2, lpHz: 900 });

  // === VOLATILITY: one shared LFO, accelerating 5 -> 22 Hz. It fans out to
  // an amplitude tremolo and to the core filter cutoff, both with depths that
  // grow over the wind-up, so a smooth early whine turns into a shudder.
  // The 22Hz ceiling is deliberate: past ~25Hz amplitude modulation stops
  // reading as a shudder you can count and turns into plain roughness, and the
  // rate would collide with the sub swell's own 30-66Hz range.
  const lfo = ac.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.setValueAtTime(5, t);
  lfo.frequency.exponentialRampToValueAtTime(22, brink);
  lfo.start(t);
  lfo.stop(brink + 0.14);

  const tremDepth = ac.createGain();  // into a gain param: 0..1
  tremDepth.gain.setValueAtTime(0.05, t);
  tremDepth.gain.linearRampToValueAtTime(0.4, brink);
  lfo.connect(tremDepth);

  const growlDepth = ac.createGain(); // into a filter frequency param: Hz
  growlDepth.gain.setValueAtTime(50, t);
  growlDepth.gain.linearRampToValueAtTime(1000, brink);
  lfo.connect(growlDepth);

  // === CORE: the capacitor whine. Resonant lowpass opening up under the
  // growl, pitch climbing in two stages (slow, then steep).
  const coreLp = ac.createBiquadFilter();
  coreLp.type = 'lowpass';
  coreLp.Q.value = 5;
  coreLp.frequency.setValueAtTime(420, t);
  coreLp.frequency.exponentialRampToValueAtTime(1500, t + CHARGE * 0.6);
  coreLp.frequency.exponentialRampToValueAtTime(6000, brink);
  coreLp.connect(dest);
  growlDepth.connect(coreLp.frequency);

  // Envelope for the whole whine — swells through the wind-up, spikes at the
  // brink, then gets cut short (the charge is spent into the trigger).
  const coreG = ac.createGain();
  coreG.gain.setValueAtTime(0.0001, t);
  coreG.gain.exponentialRampToValueAtTime(0.4, t + CHARGE * 0.15);
  coreG.gain.linearRampToValueAtTime(0.78, t + CHARGE * 0.92);
  coreG.gain.linearRampToValueAtTime(0.9, brink);
  coreG.gain.linearRampToValueAtTime(0.18, brink + 0.05);
  coreG.gain.exponentialRampToValueAtTime(0.0001, brink + 0.17);
  coreG.connect(coreLp);

  // Tremolo sits between the oscillators and the envelope. Its base tracks
  // 1 - depth so the modulated peak stays at unity as the depth grows.
  const trem = ac.createGain();
  trem.gain.setValueAtTime(0.95, t);
  trem.gain.linearRampToValueAtTime(0.6, brink);
  tremDepth.connect(trem.gain);
  trem.connect(coreG);

  // Detuned saws beat against each other for grit; the octave triangle keeps
  // some brightness once the filter opens.
  const wind = (mult: number, peak: number, type: OscillatorType) => {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(128 * mult, t);
    osc.frequency.exponentialRampToValueAtTime(300 * mult, t + CHARGE * 0.6);
    osc.frequency.exponentialRampToValueAtTime(920 * mult, brink);
    const g = ac.createGain();
    g.gain.value = peak;
    osc.connect(g).connect(trem);
    osc.start(t);
    osc.stop(brink + 0.2);
  };
  wind(1,     0.082, 'sawtooth');  // body
  wind(1.007, 0.048, 'sawtooth');  // beating twin — instability
  wind(0.991, 0.034, 'sawtooth');  // second beat, slower
  wind(2,     0.026, 'triangle');  // octave shimmer

  // === SPARKS: crackle that thickens as the charge fills ===
  const spDur = CHARGE + 0.06;
  const spLen = Math.max(1, Math.floor(spDur * ac.sampleRate));
  const spBuf = ac.createBuffer(1, spLen, ac.sampleRate);
  const spData = spBuf.getChannelData(0);
  let spark = 0;
  for (let i = 0; i < spLen; i++) {
    const p = i / spLen;
    // Spike probability climbing steeply — a few pops early, a shower by the
    // end. Each spike decays over a couple of ms.
    if (Math.random() < 0.0012 + 0.022 * p * p * Math.sqrt(p)) spark = 1;
    spark *= 0.9988;
    spData[i] = (Math.random() * 2 - 1) * (0.18 + 0.82 * spark);
  }
  const spSrc = ac.createBufferSource();
  spSrc.buffer = spBuf;
  const spHp = ac.createBiquadFilter();
  spHp.type = 'highpass';
  spHp.Q.value = 0.7;
  spHp.frequency.value = 1400;
  const spG = ac.createGain();
  spG.gain.setValueAtTime(0.05, t);
  spG.gain.linearRampToValueAtTime(0.2, brink);
  spG.gain.exponentialRampToValueAtTime(0.0001, brink + 0.06);
  spSrc.connect(spHp).connect(spG).connect(dest);
  spSrc.start(t);
  spSrc.stop(t + spDur + 0.02);

  // === PRESSURE: sub swell peaking at the brink. blip's attack does the
  // whole rise here, so the low end arrives with the charge rather than
  // thumping at the front.
  blip({ dest, startAt: t, freq: 30, freqEnd: 66, durMs: (CHARGE + 0.14) * 1000, type: 'sine', peak: 0.26, attackMs: CHARGE * 880 });
  blip({ dest, startAt: t, freq: 58, freqEnd: 124, durMs: (CHARGE + 0.1) * 1000, type: 'triangle', peak: 0.11, attackMs: CHARGE * 900, lpHz: 400 });

  // === TIMER: warning beeps accelerating toward the brink ===
  const beep = (start: number, freq: number, durMs: number, peak: number) => {
    const dur = durMs / 1000;
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = freq * 4;
    lp.Q.value = 1.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.002);
    g.gain.setValueAtTime(peak, start + dur - 0.004);
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  // Gap shrinks geometrically but is floored, so the ticks bottom out into a
  // machine-gun stutter instead of converging on a fixed point. Count is
  // capped as a belt-and-braces guard on the loop.
  let tick = t + 0.09;
  let gap = 0.19;
  let tickFreq = 620;
  for (let n = 0; n < 16 && tick < brink - 0.03; n++) {
    beep(tick, tickFreq, 32, 0.05);
    tick += gap;
    gap = Math.max(0.034, gap * 0.7);
    tickFreq *= 1.075;
  }

  // === BRINK: contact snaps shut, weight lands, and the charge sits there
  // ringing on a beating pair a few Hz apart — armed, not settled.
  const snapDur = 0.03;
  const snLen = Math.max(1, Math.floor(snapDur * ac.sampleRate));
  const snBuf = ac.createBuffer(1, snLen, ac.sampleRate);
  const snData = snBuf.getChannelData(0);
  for (let i = 0; i < snLen; i++) snData[i] = (Math.random() * 2 - 1) * (1 - i / snLen);
  const snSrc = ac.createBufferSource();
  snSrc.buffer = snBuf;
  const snBp = ac.createBiquadFilter();
  snBp.type = 'bandpass';
  snBp.Q.value = 1.1;
  snBp.frequency.value = 2600;
  const snG = ac.createGain();
  snG.gain.setValueAtTime(0, brink);
  snG.gain.linearRampToValueAtTime(0.26, brink + 0.002);
  snG.gain.exponentialRampToValueAtTime(0.0001, brink + snapDur);
  snSrc.connect(snBp).connect(snG).connect(dest);
  snSrc.start(brink);
  snSrc.stop(brink + snapDur + 0.02);

  blip({ dest, startAt: brink, freq: 132, freqEnd: 60, durMs: 210, type: 'sine', peak: 0.3, attackMs: 3 });
  blip({ dest, startAt: brink + 0.01, freq: 1460, freqEnd: 1440, durMs: 280, type: 'sine', peak: 0.045, attackMs: 6 });
  blip({ dest, startAt: brink + 0.01, freq: 1472, freqEnd: 1452, durMs: 280, type: 'sine', peak: 0.045, attackMs: 6 });
  blip({ dest, startAt: brink + 0.01, freq: 733, freqEnd: 726, durMs: 240, type: 'triangle', peak: 0.04, attackMs: 8 });
}
export function playKamakazeArm() {
  buildKamakazeCharge(ensureChessBus(), getCtx().currentTime);
}

// Hollow Purple (hero: gojo) — two opposed cursed-energy tones (a bright
// "blue" sine sweeping up, a gritty "red" saw sweeping down) converge, get
// swallowed by a half-second suction whoosh, and annihilate into a deep
// detonation with a shimmering violet ring ringing out over the tail.
function buildHollowPurple(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  const CONVERGE = 0.62;

  // The two halves rushing at each other. They meet in pitch at the impact.
  blip({ dest, startAt: t, freq: 240, freqEnd: 620, durMs: CONVERGE * 1000, type: 'sine', peak: 0.14, attackMs: 60 });
  blip({ dest, startAt: t, freq: 1180, freqEnd: 620, durMs: CONVERGE * 1000, type: 'sawtooth', peak: 0.09, attackMs: 70, lpHz: 2200 });
  // Beating partial a few cents off so the convergence shimmers instead of
  // reading as one clean tone.
  blip({ dest, startAt: t + 0.05, freq: 246, freqEnd: 632, durMs: (CONVERGE - 0.05) * 1000, type: 'triangle', peak: 0.07, attackMs: 60 });

  // Suction whoosh — noise pulled through a bandpass that sweeps upward and
  // narrows, so the energy sounds like it's collapsing into a point.
  const whooshDur = CONVERGE + 0.06;
  const length = Math.max(1, Math.floor(whooshDur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + whooshDur);
  bp.Q.setValueAtTime(1.2, t);
  bp.Q.linearRampToValueAtTime(7, t + whooshDur);
  const wg = ac.createGain();
  wg.gain.setValueAtTime(0, t);
  wg.gain.linearRampToValueAtTime(0.22, t + whooshDur * 0.75);
  wg.gain.exponentialRampToValueAtTime(0.0001, t + whooshDur);
  src.connect(bp).connect(wg).connect(dest);
  src.start(t);
  src.stop(t + whooshDur + 0.04);

  // Annihilation — a deep sub drop with a bright transient on top.
  const hit = t + CONVERGE;
  blip({ dest, startAt: hit, freq: 150, freqEnd: 32, durMs: 900, type: 'sine', peak: 0.42, attackMs: 4 });
  blip({ dest, startAt: hit, freq: 90, freqEnd: 24, durMs: 1100, type: 'triangle', peak: 0.3, attackMs: 8 });
  blip({ dest, startAt: hit, freq: 1500, freqEnd: 300, durMs: 220, type: 'sawtooth', peak: 0.16, attackMs: 1, lpHz: 3200 });

  // Violet ring-out — a stack of detuned partials humming over the decay so
  // the orb feels like it's still sitting there, live.
  for (const [f, p, d] of [[392, 0.075, 1500], [588, 0.055, 1300], [784, 0.04, 1100]] as const) {
    blip({ dest, startAt: hit + 0.03, freq: f, freqEnd: f * 0.97, durMs: d, type: 'sine', peak: p, attackMs: 40 });
  }
}
export function playHollowPurple() {
  buildHollowPurple(ensureChessBus(), getCtx().currentTime);
}

// Hollow Purple impact — the orb ran a piece down mid-drift. Shorter and
// nastier than the cast: an inrushing suck, a crunching sub thud, and a
// detuned violet shimmer that decays fast (no lingering hum — the orb is
// still travelling).
function buildHollowPurpleHit(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;

  // Brief inrush right before the crunch — noise through a bandpass that
  // snaps upward, so the hit feels like the piece is pulled in first.
  const suckDur = 0.1;
  const length = Math.max(1, Math.floor(suckDur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(3200, t + suckDur);
  bp.Q.value = 4;
  const sg = ac.createGain();
  sg.gain.setValueAtTime(0, t);
  sg.gain.linearRampToValueAtTime(0.2, t + suckDur * 0.8);
  sg.gain.exponentialRampToValueAtTime(0.0001, t + suckDur);
  src.connect(bp).connect(sg).connect(dest);
  src.start(t);
  src.stop(t + suckDur + 0.03);

  // The crunch.
  const hit = t + suckDur;
  blip({ dest, startAt: hit, freq: 180, freqEnd: 38, durMs: 420, type: 'sine', peak: 0.36, attackMs: 3 });
  blip({ dest, startAt: hit, freq: 1300, freqEnd: 260, durMs: 150, type: 'sawtooth', peak: 0.14, attackMs: 1, lpHz: 3000 });
  // Detuned pair for the violet shimmer — a tight tritone so it reads as
  // "wrong" rather than musical.
  blip({ dest, startAt: hit + 0.02, freq: 520, freqEnd: 500, durMs: 420, type: 'sine', peak: 0.06, attackMs: 18 });
  blip({ dest, startAt: hit + 0.02, freq: 736, freqEnd: 706, durMs: 380, type: 'sine', peak: 0.05, attackMs: 18 });
}
export function playHollowPurpleHit() {
  buildHollowPurpleHit(ensureChessBus(), getCtx().currentTime);
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
  src.connect(hp).connect(g).connect(getMaster());
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
  filter.connect(amp).connect(getMaster());

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

// Clock tick (low time) — short dry "tock" that fires once per second when a
// player is running low. Pitched lower than playClick so it reads as a wall
// clock rather than a UI tap, with a tiny HF noise transient for the wood-on-wood
// snap. Routed through the chess bus so the volume slider attenuates it and the
// scrub cutoff silences it on history navigation.
function buildTick(dest: AudioNode, t: number) {
  const ac: BaseAudioContext = dest.context;
  blip({ dest, startAt: t, freq: 1400, freqEnd: 900, durMs: 28, type: 'square', peak: 0.18, attackMs: 0.4, lpHz: 3200 });
  const dur = 0.012;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2200;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.0006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(hp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.01);
}
export function playTick() {
  buildTick(ensureChessBus(), getCtx().currentTime);
}

// Low-time warning — fired exactly once when the active player's clock first
// crosses the low threshold. Three ticks at ~150ms intervals read as a brief
// "you're in trouble" alert rather than a continuous countdown.
export function playLowTimeWarning() {
  const dest = ensureChessBus();
  const t0 = getCtx().currentTime;
  buildTick(dest, t0);
  buildTick(dest, t0 + 0.15);
  buildTick(dest, t0 + 0.30);
}

// Chat pop — quick sine sweep, short and bright.
export function playChat() {
  const ac = getCtx();
  const t = ac.currentTime;
  blip({ startAt: t, freq: 1200, freqEnd: 620, durMs: 65, type: 'sine', peak: 0.32, attackMs: 1 });
  // A tiny higher tick at the start sharpens the "pop".
  blip({ startAt: t, freq: 2400, durMs: 18, type: 'sine', peak: 0.12, attackMs: 0.5 });
}

function emojiNoise(opts: {
  startAt: number;
  durMs: number;
  peak: number;
  hpHz?: number;
  lpHz?: number;
  bpHz?: number;
  q?: number;
}) {
  const dest = bus();
  const ac: BaseAudioContext = dest.context;
  const dur = opts.durMs / 1000;
  const length = Math.max(1, Math.floor(dur * ac.sampleRate));
  const buf = ac.createBuffer(1, length, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;

  let tail: AudioNode = src;
  if (opts.hpHz != null) {
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts.hpHz;
    tail.connect(hp);
    tail = hp;
  }
  if (opts.lpHz != null) {
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lpHz;
    tail.connect(lp);
    tail = lp;
  }
  if (opts.bpHz != null) {
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = opts.bpHz;
    bp.Q.value = opts.q ?? 1.4;
    tail.connect(bp);
    tail = bp;
  }

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, opts.startAt);
  gain.gain.linearRampToValueAtTime(opts.peak, opts.startAt + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.startAt + dur);
  tail.connect(gain).connect(dest);
  src.start(opts.startAt);
  src.stop(opts.startAt + dur + 0.02);
}

export function playEmojiReaction(emoji: string) {
  const ac = getCtx();
  const t = ac.currentTime;
  switch (emoji) {
    case '😂':
      blip({ startAt: t, freq: 880, freqEnd: 1180, durMs: 70, type: 'triangle', peak: 0.18, attackMs: 1 });
      blip({ startAt: t + 0.07, freq: 980, freqEnd: 700, durMs: 90, type: 'triangle', peak: 0.18, attackMs: 1 });
      blip({ startAt: t + 0.16, freq: 760, freqEnd: 1060, durMs: 75, type: 'triangle', peak: 0.14, attackMs: 1 });
      break;
    case '😅':
      blip({ startAt: t, freq: 1200, freqEnd: 760, durMs: 85, type: 'sine', peak: 0.18, attackMs: 1 });
      blip({ startAt: t + 0.11, freq: 560, freqEnd: 430, durMs: 120, type: 'triangle', peak: 0.14, attackMs: 4 });
      break;
    case '😭':
      blip({ startAt: t, freq: 840, freqEnd: 420, durMs: 190, type: 'sine', peak: 0.2, attackMs: 8 });
      blip({ startAt: t + 0.16, freq: 700, freqEnd: 320, durMs: 220, type: 'sine', peak: 0.18, attackMs: 8 });
      blip({ startAt: t + 0.34, freq: 560, freqEnd: 260, durMs: 210, type: 'sine', peak: 0.14, attackMs: 10 });
      break;
    case '😢':
      blip({ startAt: t, freq: 660, freqEnd: 360, durMs: 190, type: 'sine', peak: 0.17, attackMs: 8 });
      blip({ startAt: t + 0.18, freq: 440, freqEnd: 300, durMs: 140, type: 'triangle', peak: 0.1, attackMs: 6 });
      break;
    case '😴':
      blip({ startAt: t, freq: 520, freqEnd: 420, durMs: 150, type: 'sine', peak: 0.12, attackMs: 8 });
      blip({ startAt: t + 0.15, freq: 650, freqEnd: 520, durMs: 150, type: 'sine', peak: 0.1, attackMs: 8 });
      blip({ startAt: t + 0.31, freq: 780, freqEnd: 620, durMs: 220, type: 'sine', peak: 0.08, attackMs: 10 });
      break;
    case '🔥':
      emojiNoise({ startAt: t, durMs: 150, peak: 0.12, hpHz: 900, lpHz: 5200 });
      blip({ startAt: t, freq: 420, freqEnd: 960, durMs: 130, type: 'sawtooth', peak: 0.12, attackMs: 10, lpHz: 1800 });
      blip({ startAt: t + 0.08, freq: 900, freqEnd: 1500, durMs: 90, type: 'sine', peak: 0.08, attackMs: 2 });
      break;
    case '👏':
      emojiNoise({ startAt: t, durMs: 34, peak: 0.22, hpHz: 900, lpHz: 4200 });
      emojiNoise({ startAt: t + 0.09, durMs: 42, peak: 0.2, hpHz: 800, lpHz: 3800 });
      break;
    case '🤝':
      blip({ startAt: t, freq: 330, freqEnd: 250, durMs: 80, type: 'triangle', peak: 0.2, attackMs: 1, lpHz: 1300 });
      blip({ startAt: t + 0.08, freq: 390, freqEnd: 290, durMs: 80, type: 'triangle', peak: 0.18, attackMs: 1, lpHz: 1300 });
      blip({ startAt: t + 0.16, freq: 660, durMs: 120, type: 'sine', peak: 0.08, attackMs: 4 });
      break;
    case '😮':
      blip({ startAt: t, freq: 360, freqEnd: 930, durMs: 170, type: 'sine', peak: 0.2, attackMs: 16 });
      emojiNoise({ startAt: t + 0.03, durMs: 120, peak: 0.05, bpHz: 1400, q: 2.8 });
      break;
    case '🤔':
      blip({ startAt: t, freq: 300, durMs: 120, type: 'triangle', peak: 0.16, attackMs: 5, lpHz: 1100 });
      blip({ startAt: t + 0.14, freq: 360, durMs: 160, type: 'triangle', peak: 0.12, attackMs: 5, lpHz: 1000 });
      break;
    case '😎':
      blip({ startAt: t, freq: 180, freqEnd: 150, durMs: 180, type: 'sawtooth', peak: 0.16, attackMs: 8, lpHz: 900 });
      blip({ startAt: t + 0.07, freq: 540, freqEnd: 720, durMs: 110, type: 'sine', peak: 0.08, attackMs: 2 });
      break;
    case '💀':
      emojiNoise({ startAt: t, durMs: 22, peak: 0.14, hpHz: 1800, lpHz: 6000 });
      blip({ startAt: t + 0.02, freq: 980, freqEnd: 730, durMs: 45, type: 'square', peak: 0.1, attackMs: 0.5, lpHz: 2500 });
      blip({ startAt: t + 0.09, freq: 820, freqEnd: 580, durMs: 55, type: 'square', peak: 0.08, attackMs: 0.5, lpHz: 2200 });
      break;
    case '💩':
      blip({ startAt: t, freq: 150, freqEnd: 72, durMs: 170, type: 'triangle', peak: 0.22, attackMs: 4, lpHz: 700 });
      emojiNoise({ startAt: t + 0.06, durMs: 80, peak: 0.07, bpHz: 420, q: 1.2 });
      break;
    case '❤️':
      blip({ startAt: t, freq: 392, durMs: 90, type: 'sine', peak: 0.16, attackMs: 5 });
      blip({ startAt: t + 0.11, freq: 523, durMs: 140, type: 'sine', peak: 0.14, attackMs: 5 });
      blip({ startAt: t + 0.11, freq: 659, durMs: 140, type: 'sine', peak: 0.08, attackMs: 5 });
      break;
    case '♟️':
      blip({ startAt: t, freq: 260, freqEnd: 180, durMs: 90, type: 'triangle', peak: 0.22, attackMs: 1, lpHz: 1600 });
      blip({ startAt: t + 0.08, freq: 410, freqEnd: 300, durMs: 70, type: 'triangle', peak: 0.1, attackMs: 1, lpHz: 1800 });
      break;
    default:
      break;
  }
}

// Move-quality token cues for the video editor. Good moves rise to a bright
// chime; mistakes/blunders sag into a low buzz — echoing the visual badges.
export function playMoveQuality(kind: string) {
  const ac = getCtx();
  const t = ac.currentTime;
  switch (kind) {
    case 'brilliant':
      blip({ startAt: t, freq: 660, durMs: 90, type: 'sine', peak: 0.18, attackMs: 2 });
      blip({ startAt: t + 0.08, freq: 990, durMs: 90, type: 'sine', peak: 0.16, attackMs: 2 });
      blip({ startAt: t + 0.16, freq: 1320, durMs: 180, type: 'sine', peak: 0.14, attackMs: 2 });
      break;
    case 'great':
      blip({ startAt: t, freq: 620, durMs: 90, type: 'triangle', peak: 0.18, attackMs: 2 });
      blip({ startAt: t + 0.09, freq: 940, durMs: 160, type: 'triangle', peak: 0.14, attackMs: 2 });
      break;
    case 'best':
    case 'excellent':
      blip({ startAt: t, freq: 720, durMs: 110, type: 'sine', peak: 0.16, attackMs: 3 });
      blip({ startAt: t + 0.1, freq: 1080, durMs: 150, type: 'sine', peak: 0.12, attackMs: 3 });
      break;
    case 'good':
      blip({ startAt: t, freq: 680, durMs: 120, type: 'sine', peak: 0.15, attackMs: 3 });
      break;
    case 'book':
      blip({ startAt: t, freq: 440, durMs: 130, type: 'triangle', peak: 0.12, attackMs: 6, lpHz: 1400 });
      break;
    case 'inaccuracy':
      blip({ startAt: t, freq: 500, freqEnd: 420, durMs: 150, type: 'triangle', peak: 0.14, attackMs: 4, lpHz: 1700 });
      break;
    case 'mistake':
      blip({ startAt: t, freq: 380, freqEnd: 300, durMs: 170, type: 'triangle', peak: 0.16, attackMs: 4, lpHz: 1500 });
      break;
    case 'miss':
      blip({ startAt: t, freq: 300, freqEnd: 200, durMs: 200, type: 'sawtooth', peak: 0.16, attackMs: 4, lpHz: 1100 });
      break;
    case 'blunder':
      blip({ startAt: t, freq: 200, freqEnd: 120, durMs: 260, type: 'sawtooth', peak: 0.18, attackMs: 6, lpHz: 800 });
      blip({ startAt: t + 0.05, freq: 150, freqEnd: 90, durMs: 260, type: 'sawtooth', peak: 0.12, attackMs: 6, lpHz: 700 });
      break;
    case 'checkmate':
      playWin();
      break;
    case 'draw':
      // Two equal tones — a "tie".
      blip({ startAt: t, freq: 392, durMs: 220, type: 'sine', peak: 0.16, attackMs: 6 });
      blip({ startAt: t + 0.16, freq: 392, durMs: 260, type: 'sine', peak: 0.13, attackMs: 6 });
      break;
  }
}

