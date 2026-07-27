---
name: verify-ui
description: Visually verify UI changes in VCC with Playwright — start a dev server on a safe port, bypass the identity gate, drive boards via data-sq, screenshot to .playwright-screens/ and actually look at the result. Use for ANY layout, CSS, board, animation, or visual change before declaring it done, and when asked to run or screenshot the app.
---

# Visual verification with Playwright

House rule: UI changes are not done until you've driven the real app and **looked at a
screenshot** (Read tool on the PNG). CSS reasoning alone is never sufficient.

## 1. Dev server

- **Never assume 5173.** Another Vite app ("Reodite") usually owns 5173/5174. Start
  your own server on an explicit fresh port and confirm from Vite's output:

  ```bash
  npm run dev -- --port 5199    # run in background; read "Local: http://localhost:PORT/"
  ```

- Reusing an already-running server is fine **only after** confirming it serves VCC
  (fetch `/` or check the page title — the app's title is "VCC").
- The app lives under **`/app/`**: `http://localhost:<port>/app/#/` (Home + free play),
  `/app/#/sandbox`, `/app/#/review`, `/app/#/video` (dev-only). Root `/` is the static
  landing page.
- For the built output use `npm run preview -- --port 5184` (same `/app/` layout).

## 2. Scripts live in `scripts/` (gitignored)

- Check for prior art first — 50+ existing drivers (`verify-*.mjs`,
  `*-screenshot.mjs`) cover heroes, sandbox, selects, cursors, online flows. Copy their
  patterns.
- Name new ones `verify-<feature>.mjs`; **keep them after use** (house convention).
- Playwright is in `node_modules` but not package.json; if it's missing after a fresh
  install: `npm i --no-save playwright`.
- Screenshots go to `.playwright-screens/` (gitignored).

## 3. Driver template

```js
// scripts/verify-<feature>.mjs — run: node scripts/verify-<feature>.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const PORT = process.env.PORT || '5199';
const BASE = `http://localhost:${PORT}/app/`;
const OUT = path.join(process.cwd(), '.playwright-screens');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE + '#/');

// Identity gate: Home/Join show a sign-up form until a handle exists. Race the two
// outcomes — the identity store loads async.
const gate = await Promise.race([
  page.waitForSelector('input[placeholder="your handle"]', { timeout: 3000 }).catch(() => null),
  page.waitForSelector('text=Voice Chat Chess', { timeout: 3000 }).then(() => null).catch(() => null),
]);
if (gate) {
  await gate.fill('verifier');
  await page.click('button[type=submit]');
}

// ... drive the feature (see selector vocabulary below) ...

await page.screenshot({ path: path.join(OUT, 'feature-1.png') });
await browser.close();
```

Then **Read the PNG** and check it actually shows what the change intended.

## 4. Selector vocabulary

| Target | Selector / pattern |
| --- | --- |
| Board square | `[data-sq="e2"]` (click to select/move) |
| Square occupied? | `document.querySelector('[data-sq="e4"] svg')` |
| Free-play mode select | `[aria-label="Free-play game mode"]` |
| Sandbox mode select | `[aria-label="Sandbox game mode"]` |
| CustomSelect options | portalled — click trigger, then `page.getByText(label, { exact: true }).last()` |
| Hero pickers (free play) | `.hero-side-pickers .hero-side-picker button` |
| Identity gate | `input[placeholder="your handle"]` + `button[type=submit]` |

## 5. Engine-level checks (no browser)

For rules/engine logic, prefer a smoke test over a browser run:

```bash
node --experimental-strip-types scripts/test-<x>-engine.ts
```

Pattern (see `scripts/test-juggernaut-engine.ts`): import the engine with an explicit
`.ts` extension, hand-rolled `check(name, cond)` printing PASS/FAIL, nonzero exit on
failure. Note `test-sweeper-engine.mjs` bundles via esbuild first — its outfile must be
a **relative** path because the project path contains a space.

## 6. Online / P2P flows

Use two browser contexts in one script (host + joiner) — see
`scripts/verify-sweeper-online.mjs`. The dev matchmaker is in-memory inside
`vite.config.ts`, so both tabs must hit the same dev server.
