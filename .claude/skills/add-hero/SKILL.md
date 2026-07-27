---
name: add-hero
description: End-to-end checklist for adding a new Hero ability (or changing an existing one) in Hero mode — engine state, pseudo-UCI wiring, FEN, UI, SFX, sandbox, hero.md docs, smoke test, visual verify, version bump.
---

# Adding a hero

Source of truth is `HERO_INFO` in `src/lib/heroChess.ts`; `hero.md` is the
player-facing rulebook. Before starting, skim one recent hero end-to-end (Slime or
Juggernaut) with `git log -p --follow src/lib/heroChess.ts` or by grepping its kind
string — new heroes should follow the same seams.

## Engine (`src/lib/heroChess.ts`)

1. Add the id to `HeroKind` and `HERO_KINDS` (order = picker order). Add an alias in
   `normalizeHeroKind` if the name is easy to misspell.
2. Add the `HERO_INFO` entry: `{ kind, name, blurb, glowColor, cooldownTurns,
   initialCooldownTurns? }`. Cooldowns are in *your own turns* (converted ×2 to plies
   internally); `null` = passive/one-shot.
3. If the hero needs board state, extend `GameState` (per-mechanic array like
   `frozen`/`missiles`/`slimes`) and thread it through **both** `toFen` and `fromFen` —
   FEN is extended, and free play/review/rematch all round-trip through it. Existing
   tests assert field counts (Juggernaut expects 13 FEN fields), so update those too.
4. Active abilities are pseudo-UCI: pick an unused `!X` code, wire it into
   `abilityUci`/`parseAbility`/`isAbilityUci`, legality in `abilityTargets(state)`,
   application in the `applyMove` ability branch, and cooldown via
   `cooldownUntilPly`.
5. Check every end/draw detector and the position key for repetition still make sense
   with the new state.

## UI

6. `src/components/HeroAbilities.tsx` — add the `noTargetHint()` case and any special
   button flow (multi-step abilities like Goofball have prior art).
7. `src/components/MergeBoard.tsx` — overlays/animations for the new state (frozen
   tint, slime goo, missile markers are the patterns to copy).
8. `src/lib/replayView.ts` — surface new state in `DisplaySnapshot` so Review and the
   video editor render it.
9. Sandbox (`src/pages/Sandbox.tsx` / `src/lib/sandboxExport.ts`) — heroes are usable
   in the sandbox; make sure the new state survives its export/import.
10. SFX — every hero has one signature procedural sound in `src/lib/sfx.ts` (no audio
    files), fired from several **copy-pasted if/else chains**. Grep an existing hero's
    sound (e.g. `playSlimeExpand`) and mirror every hit:
    - ability application: `HeroGame.tsx` (local move, remote move, history replay —
      3 sites) and free-play `Home.tsx` (2 sites);
    - **hero picker preview** — selecting a hero in a dropdown plays its sound as a
      preview: `Home.tsx` free-play pickers (white + black) and `Sandbox.tsx` hero
      panel (`onPickW` + `onPickB`) — 4 sites;
    - the ability-animation whitelist adjacent to the apply chains
      (`ab === 'frost' || …`) if the hero has a board overlay;
    - the video editor's scene-sound map in `src/lib/videoExport.ts` if the hero gets
      a timeline effect token.
    These chains drift (some are missing newer heroes) — wire yours into all of them
    regardless, and if you find a new per-hero chain not listed here, add it to this
    skill.

## Docs, tests, version

11. `hero.md` — add to the cooldown table and a `### <Name> — \`#hexcolor\`` section
    (hex must match `glowColor`).
12. Engine smoke test `scripts/test-<hero>-engine.ts` (gitignored, keep it):
    run with `node --experimental-strip-types scripts/test-<hero>-engine.ts`.
13. Visual verify with a `scripts/verify-<hero>.mjs` Playwright driver — see the
    `verify-ui` skill. Cover: pick the hero in free play, use the ability, see the
    overlay, scrub back in history.
14. Bump `APP_VERSION` (minor) in `src/lib/version.ts`.

## Design constraints

- Online rosters are deterministic: `heroPoolForGame` samples 4 heroes from
  `HERO_KINDS` — a new hero is automatically in the online pool, so it must be fully
  playable over the wire (abilities are just signed moves; no extra wire messages).
- Both peers re-derive everything from the game id + move list — never introduce
  local-only randomness; seed from the gameId like `heroPoolForGame`/`minesForGame` do.
