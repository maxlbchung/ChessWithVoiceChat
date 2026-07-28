---
name: release
description: Version bump + deploy checklist for VCC — when to bump APP_VERSION, deploying the front end to Cloudflare Pages and the matchmaker Worker, and what the GitHub Pages workflow does. Use when asked to deploy, release, ship, or push live.
---

# Release / deploy

## 1. Version bump — `src/lib/version.ts`

`APP_VERSION` is hand-maintained and decoupled from package.json (never touch
package.json's version). Rules (also commented in the file):

- **major** — only when explicitly requested
- **minor** — new feature
- **patch** — bug fix, small change, visual tweak
- **no bump** — single-value tweaks (a pitch, a margin nudge, one constant)

The version shows in the app's corner tag (`Layout.tsx`) and is stamped on game/sandbox
exports.

Separate version systems that may also need a bump with your change (details in
docs/ARCHITECTURE.md → Versioning): export `formatVersion` constants
(`EXPORT_FORMAT_VERSION`, `SANDBOX_EXPORT_VERSION`, `VIDEO_PROJECT_FORMAT`) when a
JSON schema changes shape, and versioned storage keys (`chess.summaries.v2.*` etc.) —
never mutate a stored shape in place; bump the key and migrate like
`ensureMigrated()` in `storage.ts`.

## 1b. Landing-page announcement

The landing page's "Announcements" column is the user-facing changelog. It's generated:
the cards live in **`landing/announcements.ts`**, and the `landing-announcements` plugin
in `vite.config.ts` renders them into the `<!--announcements-->` marker in the root
`index.html` at dev and build time (the shipped page stays static HTML — no runtime JS).
Never hand-edit cards into `index.html`.

For a notable feature (roughly: anything worth a minor bump), add one entry at the top
of `ANNOUNCEMENTS`:

```ts
{ date: '2026-07-27', kind: 'new', title: 'Kamakaze arms your own pieces', body: '…' },
```

- `date` — ISO `YYYY-MM-DD` of today; renders as "Jul 27, 2026". The list is sorted
  newest-first at render, so an out-of-order entry still lands correctly; entries
  sharing a date keep their file order.
- `kind` — `'new'` for features, `'update'` for changes/reworks. Picks the badge.
- Layout is automatic: newest entry becomes the big lead card, the next `GRID_COUNT`
  (5) follow in the column, the rest stay in the file as history. No demoting by hand.
- Copy style: short punchy `title` + 1–2 sentence player-facing `body` — match the
  existing entries' voice, not commit-message tone.
- Patch-level fixes don't get announcements.
- Verify with `node scripts/verify-announcements.mjs` (dev on 5199 + preview on 5184).
  A bad date throws at build time rather than rendering "NaN".

## 2. Pre-deploy checks

```bash
npx tsc -b        # must be clean
npm run build     # must succeed; also catches vite/rollup issues
```

If the change was visual, it should already have passed `verify-ui`. Check
`git status` for a parallel session's in-flight work before deploying — you'd be
shipping their half-done changes too. If there are diffs you don't recognize, stop and
ask the user.

## 3. Deploy

Deploying is outward-facing — confirm with the user unless they already asked.

```bash
npm run deploy          # build + wrangler pages deploy dist --project-name=chess-vc
npm run deploy:worker   # ONLY when worker/ changed (matchmaker + TURN minting)
```

- Worker secrets (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN`) and D1 setup are one-time; steps
  in README.
- Pushing to `main` also triggers `.github/workflows/deploy.yml`, which deploys a
  GitHub Pages copy (build with `GITHUB_PAGES=true` flipping Vite's `base`). Cloudflare
  Pages (`npm run deploy`) is the primary target.

## 4. After deploy

Sanity-check the live site (landing at `/`, app at `/app/#/`) and confirm the corner
version tag shows the new `APP_VERSION`.
