// Procedural watercolor. Every call paints a fresh set of washes and publishes
// them as CSS custom properties on <html>; the stylesheets only ever
// reference the variables:
//
//   --wash-page                 the splotches behind the whole page
//   --wash-primary-{1,2,3}      indigo fill swatches for primary buttons
//   --wash-secondary-{1,2,3}    pale fill swatches for other buttons/dropdowns
//   --wash-ring-{1,2,3}         indigo ring swatches — the selected state
//   --wash-panel                tileable pigment mottle for plates
//   --paper, --board-tex        the static paper and board textures
//   --blot-{1,2,3}              watercolor blot shapes used as MASKS — any
//                               element masked by one becomes a paint splash
//                               of its own color (hero auras and effects)
//
// Three swatch variants per button kind so neighbouring buttons don't share a
// silhouette (styles.css picks one by :nth-child). The app repaints on every
// route change (Layout.tsx) — only the page splotches are regenerated per
// route; swatches and textures are baked once per document. The landing page
// paints once per load (landing/wash.ts).
//
// PERFORMANCE: the paintings are SVG filter graphs (turbulence, displacement,
// morphology, blurs, lighting) and must never reach CSS as SVG. Chrome
// re-runs an SVG background's filters whenever it rasterizes it — at full
// device resolution, per element size, and again after invalidations — which
// cost ~500ms of main thread per page-wash paint (measured: 10 long tasks of
// 500-750ms across four route changes). Instead each SVG is rasterized ONCE
// into a canvas (`bake`), encoded to a PNG blob, and CSS gets the blob URL —
// a plain bitmap. The page wash bakes at a third of CSS resolution (it's
// soft), the rest at 1x, and bakes are spread over idle callbacks so no single
// task runs long.

type Rng = () => number;

// mulberry32 — tiny seeded PRNG, so one seed reproduces a whole painting.
function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const seedInt = (r: Rng) => Math.floor(r() * 1000);
const f = (n: number) => n.toFixed(1);

// Pigments, matched to the palette tokens in styles.css.
const PAGE_PIGMENTS = ['#6f98c2', '#cf8a80', '#e0b062', '#8fb57c', '#a99ad0', '#7fb5b0'] as const;
const PALE_PIGMENTS = ['#e0b062', '#cf8a80', '#8fb57c', '#d9b49a', '#c4b3d6'] as const;
const INDIGO = ['#3d6c9a', '#45739f', '#36628f'] as const;

import paperSvg from '../textures/paper.svg?raw';
import boardSvg from '../textures/board.svg?raw';

// Give an SVG an explicit pixel size so it rasterizes at exactly the size it
// will be drawn (otherwise it rasterizes at its intrinsic size, then scales).
function sized(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag.replace(/\s(width|height)="[^"]*"/g, '').replace('<svg', `<svg width="${w}" height="${h}"`));
}

// Rasterize an SVG into a PNG blob URL, wrapped for CSS.
async function bake(svg: string, w: number, h: number): Promise<string> {
  const img = new Image();
  img.src = `data:image/svg+xml,${encodeURIComponent(sized(svg, w, h))}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res));
  if (!blob) throw new Error('watercolor: bake failed');
  return `url("${URL.createObjectURL(blob)}")`;
}

// One bake per idle slot, so the work interleaves with input and rendering.
function idle(): Promise<void> {
  return new Promise((res) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => res(), { timeout: 400 });
    else setTimeout(res, 16);
  });
}
const frame = () => new Promise<number>((res) => requestAnimationFrame(res));

// The wash filter shared by every swatch: warp the shape's outline with
// low-frequency noise, darken a rim where pigment pools as it dries, mottle
// the body unevenly, then break it up with paper tooth (tooth = alpha slope
// and offset of the grain mask; buttons use a lighter tooth so text stays
// legible on them).
function washFilter(r: Rng, id: string, warpFreq: number, warpScale: number, rim: number, tooth = [1.4, 1.45], octaves = 4): string {
  return `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${warpFreq}" numOctaves="${octaves}" seed="${seedInt(r)}" result="warp"/>
<feDisplacementMap in="SourceGraphic" in2="warp" scale="${warpScale}" xChannelSelector="R" yChannelSelector="G" result="shape"/>
<feGaussianBlur in="shape" stdDeviation="${f(warpScale * 0.015 + 0.6)}" result="crisp"/>
<feMorphology in="shape" operator="erode" radius="${f(rim)}" result="inner"/>
<feGaussianBlur in="inner" stdDeviation="${f(rim * 1.5)}" result="innerSoft"/>
<feComposite in="crisp" in2="innerSoft" operator="arithmetic" k2="1" k3="-0.5" result="pooled"/>
<feTurbulence type="fractalNoise" baseFrequency="${(warpFreq * 3).toFixed(4)}" numOctaves="${Math.min(octaves, 3)}" seed="${seedInt(r)}" result="bloom"/>
<feColorMatrix in="bloom" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1.8 -0.25" result="bloomMask"/>
<feComposite in="crisp" in2="bloomMask" operator="in" result="mottle"/>
<feComposite in="pooled" in2="mottle" operator="arithmetic" k2="1" k3="0.45" result="body"/>
<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seedInt(r)}" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -${tooth[0]} ${tooth[1]}" result="grainMask"/>
<feComposite in="body" in2="grainMask" operator="in"/>
</filter>`;
}

// Page splotches. Big washes are anchored around the edges (the content
// column stays mostly clear), each with a few satellite drops and splatter.
function pageWash(r: Rng): string {
  const W = 1600, H = 1000;
  const anchors: [number, number][] = [
    [0.1, 0.12], [0.5, -0.02], [0.9, 0.12], [1.02, 0.5],
    [0.9, 0.9], [0.5, 1.02], [0.1, 0.9], [-0.02, 0.5],
  ];
  // Shuffle the anchors and keep 4–6 of them.
  for (let i = anchors.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
  }
  const count = 4 + Math.floor(r() * 3);
  let shapes = '';
  for (let i = 0; i < count; i++) {
    const [ax, ay] = anchors[i];
    const cx = ax * W + between(r, -90, 90);
    const cy = ay * H + between(r, -70, 70);
    const rx = between(r, 170, 340);
    const ry = rx * between(r, 0.45, 0.8);
    const rot = between(r, -35, 35);
    const fill = pick(r, PAGE_PIGMENTS);
    const op = between(r, 0.32, 0.55);
    shapes += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" transform="rotate(${f(rot)} ${f(cx)} ${f(cy)})" fill="${fill}" opacity="${op.toFixed(2)}"/>`;
    // Satellite drops — smaller blooms bleeding off the main wash.
    const drops = Math.floor(between(r, 1, 4));
    for (let d = 0; d < drops; d++) {
      const ang = r() * Math.PI * 2;
      const dist = rx * between(r, 0.8, 1.25);
      const dr = between(r, 25, 70);
      shapes += `<circle cx="${f(cx + Math.cos(ang) * dist)}" cy="${f(cy + Math.sin(ang) * dist * 0.7)}" r="${f(dr)}" fill="${fill}" opacity="${(op * between(r, 0.6, 1)).toFixed(2)}"/>`;
    }
    // Splatter — flicked specks; too small for the warp to erase.
    const specks = Math.floor(between(r, 0, 7));
    for (let s = 0; s < specks; s++) {
      const ang = r() * Math.PI * 2;
      const dist = rx * between(r, 1.1, 1.7);
      shapes += `<circle cx="${f(cx + Math.cos(ang) * dist)}" cy="${f(cy + Math.sin(ang) * dist * 0.7)}" r="${f(between(r, 6, 16))}" fill="${fill}" opacity="${(op * 0.9).toFixed(2)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${washFilter(r, 'p', 0.006, 200, 14, [1.4, 1.45], 3)}</defs><g filter="url(#p)">${shapes}</g></svg>`;
}

// Control swatches, stretched over the control with
// preserveAspectRatio="none" (tuned for a ~3:1 box). Two shapes:
//   fill — paint covering the whole face, edges ragged just inside the
//          outline (the normal state);
//   ring — the inverse: paint only in a ragged band around the edge, bare
//          paper in the middle (the selected state).
// The ring is one even-odd path (outer rect minus inner rect), so the warp
// roughens both its edges and the pooled rim darkens both.
function swatch(r: Rng, fill: string, opacity: number, shape: 'fill' | 'ring'): string {
  const W = 240, H = 80;
  const o = 3;
  const outer = `M${o} ${o + 4}Q${o} ${o} ${o + 6} ${o}H${W - o - 6}Q${W - o} ${o} ${W - o} ${o + 6}V${H - o - 6}Q${W - o} ${H - o} ${W - o - 6} ${H - o}H${o + 6}Q${o} ${H - o} ${o} ${H - o - 6}Z`;
  const ix = between(r, 13, 17), iy = between(r, 12, 15);
  const inner = `M${f(ix)} ${f(iy)}H${f(W - ix)}V${f(H - iy)}H${f(ix)}Z`;
  const d = shape === 'ring' ? outer + inner : outer;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>${washFilter(r, 's', 0.04, 7, shape === 'ring' ? 2.5 : 4, [0.6, 1.2], 3)}</defs><g filter="url(#s)"><path d="${d}" fill-rule="evenodd" fill="${fill}" opacity="${opacity}"/></g></svg>`;
}

// Blot: one dropped splash of paint — ragged lobed edge, darker pooled rim,
// mottled body, paper tooth. Only its alpha matters: it's used as a CSS mask,
// so whatever is masked (a hero's aura color, an explosion's gradient) takes
// on the blot's shape and texture.
function blot(r: Rng): string {
  const cx = 100 + between(r, -4, 4), cy = 100 + between(r, -4, 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>${washFilter(r, 'b', 0.02, 46, 9, [0.8, 1.1], 3)}</defs><g filter="url(#b)"><ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(between(r, 66, 76))}" ry="${f(between(r, 62, 72))}" fill="#000" opacity="0.92"/></g></svg>`;
}

// Panel ground: a seamless tile of faint pigment mottle (no outline), so a
// plate reads as a sheet that was given a light wash.
function panelTile(r: Rng): string {
  const [tr, tg, tb] = pick(r, [[0.25, 0.35, 0.5], [0.55, 0.38, 0.2], [0.35, 0.45, 0.3]]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360"><filter id="m" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="2" seed="${seedInt(r)}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 ${tr} 0 0 0 0 ${tg} 0 0 0 0 ${tb} 0 0 0 0.55 -0.2"/></filter><rect width="360" height="360" filter="url(#m)"/></svg>`;
}

// Bakes that happen once per document: the static paper/board textures and
// the control/panel swatches. Rasterized at 1x — each stays under ~50ms of
// main thread — and slotted into idle time after the first page wash.
let onceBaked: Promise<void> | null = null;
function bakeOnce(root: HTMLElement): Promise<void> {
  onceBaked ??= (async () => {
    const r = rng((Math.random() * 2 ** 32) >>> 0);
    const set = async (name: string, svg: string, w: number, h: number) => {
      await idle();
      root.style.setProperty(name, await bake(svg, w, h));
    };
    for (let i = 1; i <= 3; i++) {
      await set(`--wash-primary-${i}`, swatch(r, pick(r, INDIGO), 1, 'fill'), 240, 80);
      await set(`--wash-secondary-${i}`, swatch(r, pick(r, PALE_PIGMENTS), 0.5, 'fill'), 240, 80);
      await set(`--wash-ring-${i}`, swatch(r, pick(r, INDIGO), 0.85, 'ring'), 240, 80);
    }
    await set('--wash-panel', panelTile(r), 360, 360);
    for (let i = 1; i <= 3; i++) await set(`--blot-${i}`, blot(r), 160, 160);
    await set('--paper', paperSvg, 480, 480);
    await set('--board-tex', boardSvg, 400, 400);
  })();
  return onceBaked;
}

let generation = 0;
let liveWash: string | null = null;

// Paint the page splotches — fresh on every call (every load and route
// change). The first call also kicks off the once-per-document bakes.
export async function paintWashes(root: HTMLElement = document.documentElement): Promise<void> {
  const gen = ++generation;
  const r = rng((Math.random() * 2 ** 32) >>> 0);
  await idle();
  if (gen !== generation) return;
  // Third resolution: the wash is soft, and filter cost scales with pixels.
  const scale = 0.35;
  const wash = await bake(pageWash(r), Math.max(240, Math.round(innerWidth * scale)), Math.max(240, Math.round(innerHeight * scale)));
  if (gen !== generation) {
    URL.revokeObjectURL(wash.slice(5, -2));
    return;
  }
  // Restart the fade on the page layer (.wash-fresh in styles.css): drop the
  // class, then re-add it a frame later alongside the new image — no forced
  // reflow.
  root.classList.remove('wash-fresh');
  await frame();
  root.style.setProperty('--wash-page', wash);
  root.classList.add('wash-fresh');
  const old = liveWash;
  liveWash = wash.slice(5, -2);
  // The old bitmap is only safe to drop once nothing references it.
  if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  void bakeOnce(root);
}
