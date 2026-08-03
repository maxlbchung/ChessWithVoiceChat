# Architecture

Voice Chat Chess (VCC): six chess variants played P2P over WebRTC with optional voice
chat. Vite 5 + React 18 + TypeScript, zustand, react-router-dom v6 (hash router),
peerjs, chess.js, idb-keyval. Front end deploys to Cloudflare Pages; a small Cloudflare
Worker + D1 handles matchmaking and TURN credential minting.

There is no test framework and no linter config. Verification is `tsc -b`, hand-rolled
engine smoke tests, and Playwright drivers in the gitignored `scripts/` folder
(see `.claude/skills/verify-ui`).

## Game modes

`GameVariant` lives in `src/lib/timeControls.ts`:
`'normal' | 'merge' | 'two' | 'cash' | 'hero' | 'sweeper'`.

| Variant id | UI name | Page | Engine |
| --- | --- | --- | --- |
| `normal` | Normal | `src/pages/Game.tsx` | chess.js directly |
| `merge` | Merge | `src/pages/MergeGame.tsx` | `src/lib/mergeChess.ts` |
| `two` | Guerrilla | `src/pages/TwoGame.tsx` | `src/lib/chess2.ts` |
| `cash` | Cash Money | `src/pages/CashGame.tsx` | `src/lib/cashChess.ts` |
| `hero` | Hero | `src/pages/HeroGame.tsx` | `src/lib/heroChess.ts` |
| `sweeper` | Chesssweeper | `src/pages/SweeperGame.tsx` | `src/lib/sweeperChess.ts` |

Naming skew to remember: variant id `two`, engine file `chess2.ts`, UI name "Guerrilla".

### Chess Civilization (not a variant)

A standalone hex-grid strategy game at `/app/#/civilization`, reached from the
landing page — deliberately outside the base game: no `GameVariant` id, no lobby,
no recordings/replays/ratings, and it renders outside `Layout` (own topbar) via a
lazy top-level route in `router.tsx`. Engine: `src/lib/civEngine.ts` (axial hex
math, seeded procedural terrain, one-action-per-unit turns, zombie-horde and
rival-AI brains); page: `src/pages/Civilization.tsx` (menu + SVG board + HUD;
tiles carry `data-hex="q,r"` for Playwright). Three modes: zombie survival, AI
conquest, hotseat versus.

### Routing (`src/router.tsx`)

Hash router, single `Layout` parent: `/` → Home (lobby + free play for all variants),
`play/:gameId` → GameRoute, `join/:hostPeerId` → Join, `sandbox`, `review`, `profile`,
`settings`, and `video` → VideoEditor (**DEV-only**, lazy-gated behind
`import.meta.env.DEV` so `react-dom/server` never ships to prod).

There is no route per variant. `GameRoute` reads the lobby handoff's `timeControlId`
and dispatches on its prefix (`merge-*`, `two-*`, `cash-*`, `hero-*`, `sweeper-*`,
else normal). Time-control ids encode variant × control; 3 controls per variant,
18 total, in `TIME_CONTROLS` (`src/lib/timeControls.ts`).

The site has two HTML entries (`vite.config.ts` rollup inputs): root `index.html` is a
static marketing landing (styles in `landing/landing.css`), `app/index.html` is the real
app. Live URLs look like `…/app/#/sandbox`; in dev the app is at
`http://localhost:<port>/app/#/`.

## Engine layer

There is **no shared engine base class**. Each variant engine is an independent module
that converges on a duck-typed interface:

- `sqToIdx(sq)` / `idxToSq(idx)` — board is a flat 64 array, **index 0 = a8, 63 = h1**
- `initialState(...)` → `GameState` with `board: (Piece|null)[]`
- `legalMovesFrom(state, from)`, `allLegalMoves`/`allLegalBoardMoves`
- `applyMove(state, uci)` → `{ state, result } | null`
- `toFen(state)` / `fromFen(fen)`, plus draw/end detectors (`isCheckmate`, etc.)

Relationships:

- `mergeChess.ts` is the de-facto canonical `Piece`/board shape; `sweeperChess.ts`
  imports and re-exports its types; other engines redeclare compatible locals.
- `sweeperChess.ts` is the only engine delegating legality to chess.js — it keeps an
  authoritative FEN and removes mine-blast victims on top. Mines derive
  deterministically from the gameId (`minesForGame`), 4 mines in ranks 4–5.
- `heroChess.ts` is the largest engine (standard chess + all hero state; own castling,
  freeze/stun/missile/slime/earthquake/explosive substate). See "Hero system".
- `cashChess.ts` adds the economy (`SHOP_PRICES`, `CASH_IN_REWARD`, `buyUci`).
- Specials ride the normal move pipeline as pseudo-UCI strings: hero abilities are
  `!`-prefixed (`!F<sq>`, `!L<from><to>`…), cash purchases use `buyUci()` codes.
- `src/lib/boardAttacks.ts` is display-only (checkmate arrows for the video editor),
  not part of move generation.

The single board component for all variants and Review/Sandbox is
`src/components/MergeBoard.tsx` (custom drag/drop, highlights, overlays, ability
anims). Squares carry `data-sq="<square>"` — the selector every Playwright script uses.

## Hero system

Source of truth: `HERO_INFO` in `src/lib/heroChess.ts`; player-facing rules and
cooldowns in `hero.md` (root). 12 heroes in `HeroKind`/`HERO_KINDS`. Each
`HeroInfo` = `{ kind, name, blurb, glowColor, cooldownTurns, initialCooldownTurns? }`
(`null` cooldown = passive; cooldowns authored in own-turns, ×2 to plies internally).

Runtime: `GameState.heroes = { w, b }` (`AbilitySide`), plus per-mechanic arrays
(`frozen`, `missiles`, `masked`, `slimes`, `stunned`, `earthquakes`, `explosives`,
`jugTier`). Abilities are pseudo-UCI (`isAbilityUci`/`parseAbility`/`abilityUci`);
targeting via `abilityTargets(state)`. Online rosters are deterministic per game:
`heroPoolForGame(gameId)` picks `ONLINE_POOL_SIZE = 4` heroes both peers agree on.
Twin-Jutsu's shuffled back ranks come from `shuffledBackRank`/`backRanksForGame`.

UI: `HeroPicker.tsx` (cards from `HERO_INFO`, optional `pool` prop) and
`HeroAbilities.tsx` (ability buttons, cooldown display, per-hero `noTargetHint()`).

Adding a hero: see `.claude/skills/add-hero`.

## Networking

- **P2P**: `src/lib/peer.ts` — `class PeerSession` over PeerJS (public broker), one
  reliable DataConnection + one MediaConnection for voice. `setEvents()` lets Home hand
  the live session to the game page without teardown (via `src/store/lobbyHandoff.ts`,
  a plain module singleton — not zustand). Wire protocol: `WireMessage` union in
  `src/lib/types.ts`.
- **Matchmaking**: `src/lib/matchmaking.ts` posts `join | poll | cancel | stats` to one
  endpoint — in dev an in-memory matchmaker mounted at `/api/matchmake` by
  `devMatchmakerPlugin()` inside `vite.config.ts`; in prod the Worker
  (`worker/src/index.ts`, D1 tables `waiting`/`matched`/`queue_log` in
  `worker/schema.sql`).
- **TURN/ICE**: `src/lib/iceConfig.ts` — Google STUN always, plus Cloudflare Realtime
  TURN creds minted by the Worker (`action: 'turn'`), falling back to
  `VITE_TURN_URL/USER/PASS`, then STUN-only.
- **Voice**: `src/lib/voice.ts` (getUserMedia helpers) + `voiceMeter.ts`
  (`useVolume(stream)` hook).

## State & persistence

- zustand: `identityStore.ts` (handle/rating/avatar; `signUp`), `settingsStore.ts`
  (localStorage key `vcc.settings.v1`).
- Everything else is IndexedDB via idb-keyval: `chess.identity.v1`,
  `chess.rating.v1`, `chess.record.v1.<gameId>`, `chess.summaries.v2.*`
  (day-bucketed history with index + aggregate, 365-day cap) — see
  `src/lib/storage.ts`.
- **Identity gate**: not a router guard — an early return in `Home.tsx` and `Join.tsx`
  rendering a sign-up form (`input[placeholder="your handle"]` + Continue). Sandbox,
  Review, Settings, and Video are not gated.
- ELO in `src/lib/elo.ts` (`STARTING_ELO = 100`, K 32→24 after 30 games).

Stale-docs warning: README still describes Ed25519 move signing and `gameRecord.ts` —
that system was removed; `identity.ts` now stores only a handle. Some old comments
(e.g. `vite.config.ts` mentioning `functions/api/matchmake.ts`) are stale too.

## Replay / video pipeline

record → export → replay → snapshot → scene → canvas → WebM:

1. `gameExport.ts` — `buildGameExport()`/`parseGameImport()` (versioned JSON), and
   `buildReplay(exp)` re-executes UCIs through the right engine into a discriminated
   `Replay`.
2. `replayView.ts` — `displayAt(replay, ply)` flattens any variant to a
   `DisplaySnapshot` (board + overlay lists: glows, frozen, missiles, sweeper counts…).
3. `Review.tsx` scrubs that in the DOM; `VideoEditor.tsx` (DEV-only) renders it to
   canvas via `videoProject.ts` (serializable `EditProject`: ply range, move timing,
   effects, music) → `videoRenderer.ts` (`SceneModel`, easing, sprites from
   `pieceSprites.ts`/`tokenSprites.ts`) → `videoExport.ts` (MediaRecorder muxing canvas
   + the SFX master bus).
4. `sandboxExport.ts` serves only the Sandbox page (5 variants, no sweeper; JSON + PNG
   export).

## Conventions

- **Versioning** is four separate systems — know which one you're touching:
  1. `APP_VERSION` in `src/lib/version.ts` (decoupled from package.json). Bump rules
     are commented in the file; shown in `Layout.tsx` corner tag and stamped on
     exports.
  2. Export format versions — `EXPORT_FORMAT_VERSION` (`gameExport.ts`),
     `SANDBOX_EXPORT_VERSION` (`sandboxExport.ts`), `VIDEO_PROJECT_FORMAT`
     (`videoProject.ts`), stamped as `formatVersion` on saved JSON. Bump when the
     schema changes shape, and keep `parse*Import` accepting older versions (parsers
     currently default missing `formatVersion` to 1).
  3. Storage key versions — IndexedDB/localStorage keys embed a version
     (`chess.summaries.v2.*`, `chess.identity.v1`, `vcc.settings.v1`). Never mutate a
     stored shape in place: bump the key version and write a migration; the pattern is
     `ensureMigrated()` in `storage.ts` (memoized one-shot v1→v2 fan-out).
  4. Landing-page Announcements — the news column at `/` is the user-facing
     changelog. Entries live in `landing/announcements.ts`; the
     `landing-announcements` plugin in `vite.config.ts` renders them into the
     `<!--announcements-->` marker in the root `index.html` at dev and build time,
     so the landing page ships as static HTML with no JS. Sorting, the lead-card
     split and date formatting are derived — adding an entry is the whole edit
     (see the `release` skill).
- **CSS**: one monolithic `src/styles.css`. No modules/Tailwind. `:root` design tokens,
  BEM-ish kebab-case classes, per-instance color via inline CSS vars
  (`['--hero-color' as any]`). Landing page has its own `landing/landing.css`, which
  **mirrors the app's tokens** — change one, change both.
- **Design system ("Bulletin")** — a dark chess-broadsheet look. Three faces, loaded via
  Google Fonts `<link>` in *both* HTML entries (`app/index.html`, `index.html`), each
  with a local fallback stack baked into the token:
  - `--font-display` (Newsreader) — page titles, section heads, outcome
    announcements, avatar initials, big stats. An editorial *reading* serif: weight
    600 at heading sizes, light negative tracking (~-0.01em). A didone (Bodoni Moda)
    was tried first and rejected — its hairlines went thin and hard to read.
  - `--font-body` (Archivo) — all UI and prose. The app default on `html, body`.
  - `--font-mono` (IBM Plex Mono) — **anything read as data**: clocks, ratings, board
    coordinates, move lists, dates, counts, peer ids, version tag. Also the
    tracked micro-caps idiom (`--track-label`, `.label-caps`) used for nav, panel
    captions, table headers and small control strips.

- **Scrollbars** (block at the top of `src/styles.css`, mirrored in `landing.css`).
  Three things that are easy to get wrong:
  1. *Document gutter* uses `html { overflow-y: scroll }`, **not**
     `scrollbar-gutter: stable`. The root element's `overflow` propagates to the
     viewport, so `html` computes `overflow: visible`, isn't a scroll container, and
     the gutter property is silently a no-op there (measured in Chrome 148).
  2. *Panel gutters* use `scrollbar-gutter: stable`, which does work — those are real
     `overflow-y: auto` containers. Set by name, never via `*`, or every
     `overflow: hidden` box gets a phantom gutter.
  3. *Styling*: `scrollbar-width`/`scrollbar-color` and `::-webkit-scrollbar` are
     **mutually exclusive in Chromium** — setting `scrollbar-width` switches it to the
     native renderer and the pseudo-element rules are ignored (OS stepper arrows come
     back). The standard properties are therefore gated behind
     `@supports not selector(::-webkit-scrollbar)` so only Firefox takes them.

  Scroll containers today: the document (app + landing), `.moves-panel`, `.chat-log`,
  `.custom-select-popover`, `.vid-timeline-scroll`, and `textarea`. A new one needs
  adding to the gutter list and, if vertical, the hairline-track-rule list.
- Surface tokens: `--rule` / `--rule-strong` are the hairline dividers that structure
  every panel (prefer them over `--border`); `--plate` is the letterpress shadow that
  makes a card read as a physical plate. Panels are 3px radius, the board 4px.
  `--brass` is the warm counter-accent (dates, secondary tags) against the green
  primary. `body::before` paints the app-wide grain; `.app-shell` sits above it.
  `.page`/`.page-narrow` children get a staggered route-reveal animation, so page
  content is expected to be a handful of direct-child blocks.
- **SFX**: `src/lib/sfx.ts` — fully procedural Web Audio, no audio files, one master
  gain. `Layout.tsx` plays a click for every `button, a` via a capture-phase listener;
  opt out with `data-no-sfx`.
- **Sprites**: pieces are inline SVG (`pieceSvgs.tsx`, Cburnett CC BY-SA); the video
  editor rasterizes them (`pieceSprites.ts`). Only video badges are real PNGs
  (`public/tokens/`).
- **Types**: `src/lib/types.ts` holds cross-cutting app types only; each engine owns
  its own `Piece`/`GameState` and consumers alias on import.
- **Comments** carry real decision history — read them before refactoring; a few are
  stale (flagged above).

## Build & deploy

- `npm run dev` — Vite dev server (config port 5173, but see the port gotcha in
  CLAUDE.md). `npm run build` = `tsc -b && vite build`.
- `npm run deploy` — build + `wrangler pages deploy dist --project-name=chess-vc`
  (Cloudflare Pages). `npm run deploy:worker` — the matchmaker Worker
  (`worker/wrangler.toml`, D1 binding).
- `.github/workflows/deploy.yml` additionally auto-deploys to **GitHub Pages** on push
  to main (build with `GITHUB_PAGES=true`, which flips Vite's `base`).
- Two wrangler configs: root `wrangler.toml` (Pages) vs `worker/wrangler.toml`
  (Worker). D1 setup steps are in README.
