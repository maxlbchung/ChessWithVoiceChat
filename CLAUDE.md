# CLAUDE.md

Voice Chat Chess (VCC) — six chess variants (Normal, Merge, Guerrilla, Cash Money,
Hero, Chesssweeper) played P2P over WebRTC with voice chat. Vite + React 18 + TS,
custom variant engines, Cloudflare Pages + Worker/D1 backend.

Deep module map: **docs/ARCHITECTURE.md**. Hero rules & cooldowns: **hero.md**.
README has good product context but its crypto section is stale (Ed25519 move signing
was removed; `identity.ts` stores only a handle).

## Commands

```bash
npm run dev -- --port 5199   # dev server — ALWAYS pick an explicit fresh port (see gotchas)
npx tsc -b                   # typecheck (also runs as a Stop hook)
npm run build                # tsc -b && vite build
npm run deploy               # build + Cloudflare Pages (project chess-vc) — confirm with user first
npm run deploy:worker        # matchmaker Worker — only when worker/ changed
node --experimental-strip-types scripts/test-<x>-engine.ts   # engine smoke tests
node scripts/verify-<x>.mjs  # Playwright UI drivers (see .claude/skills/verify-ui)
```

There is no test framework, no linter. Verification = typecheck + engine smoke tests +
Playwright screenshots you actually look at.

## Hard rules

- **Verify UI changes visually.** For any layout/CSS/board/visual change, drive the
  real app with Playwright and read the screenshot before calling it done. Use the
  `verify-ui` skill. CSS reasoning alone is not verification.
- **Bump `APP_VERSION`** in `src/lib/version.ts` (NOT package.json) for user-visible
  changes: minor = new feature, patch = fix/tweak, major only when asked. Skip the bump
  for single-value tweaks (a pitch, a margin nudge). Related version systems: export
  `formatVersion` constants, versioned storage keys (never mutate a stored shape —
  bump key + migrate), and the landing-page Announcements column (the user-facing
  changelog — add an entry to `landing/announcements.ts`; it renders itself into
  `index.html`) — see "Versioning" in docs/ARCHITECTURE.md.
- **Generalize edits across variants.** Six modes share `MergeBoard.tsx` and one
  `styles.css`; if a change makes sense on other boards/modes, apply it everywhere it
  fits.
- **Parallel sessions are real.** The user often runs a second Claude session on this
  repo. If git status shows work you didn't do, or an Edit fails with "file modified
  since read", another session is active — don't revert/absorb its diffs, and confirm
  before touching the same files (`heroChess.ts`, `MergeBoard.tsx`, `HeroGame.tsx`,
  `Home.tsx`, `Sandbox.tsx`, `styles.css` are the usual collision points).
- `ideas.md` is gitignored; never delete entries — mark implemented ones with
  "✅ (implemented in vX.Y.Z)".

## Gotchas

- **Port 5173 is usually NOT this app** — another Vite project ("Reodite") tends to own
  5173/5174. Start dev servers with an explicit port (`npm run dev -- --port 5199`) and
  read the actual port from Vite's output. Before driving a browser at an
  already-running server, verify it serves VCC (check the page title).
- The app is served from **`/app/`** (root `index.html` is a static landing page):
  dev URLs are `http://localhost:<port>/app/#/`, `/app/#/sandbox`, etc.
- The identity gate: Home/Join render a sign-up form until a handle exists. Scripts get
  past it by filling `input[placeholder="your handle"]` and clicking Continue.
- `scripts/` is **gitignored** ad-hoc tooling (Playwright drivers + engine tests).
  Convention: keep scripts after use; check for prior art there before writing new ones.
- Playwright is in `node_modules` but **not in package.json** — after a fresh
  `npm ci`, restore it with `npm i --no-save playwright`.
- `/video` (VideoEditor) is DEV-only — lazy-gated behind `import.meta.env.DEV`.
- Board indexing in every engine: flat 64 array, index 0 = a8, 63 = h1. Hero abilities
  and cash purchases travel as pseudo-UCI strings (`!F<sq>`, buy codes).
- One monolithic `src/styles.css`; kebab-case BEM-ish classes; per-instance color via
  inline CSS vars. Buttons get a global click SFX — opt out with `data-no-sfx`.
- Per-hero behavior is wired through copy-pasted `if/else` chains in multiple files
  (picker preview SFX, ability SFX, animation whitelists). When you touch one chain,
  grep for its siblings — they drift. Full map in the `add-hero` skill.

## Agent infrastructure

- Hooks (`.claude/settings.json` + `.claude/hooks/`): SessionStart injects repo state
  (parallel-session diffs, listening ports); Stop runs `tsc -b` when TS files are dirty
  and blocks on errors.
- Skills (`.claude/skills/`): `verify-ui` (Playwright verification workflow),
  `add-hero` (end-to-end hero checklist), `release` (version bump + deploy).
