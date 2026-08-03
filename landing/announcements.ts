// The user-facing changelog. This list is the single source of truth: the
// `landing-announcements` plugin in vite.config.ts renders it into the root
// index.html at dev and build time, so shipping an announcement means adding
// one entry here — no HTML surgery, no demoting the previous lead card by hand.
// The page that ships is still plain static HTML; nothing is fetched or
// rendered at runtime.
//
// Writing an entry (see the `release` skill):
//   - roughly one per notable feature — anything worth a minor APP_VERSION
//     bump. Patch-level fixes don't get announcements.
//   - `version` is the APP_VERSION that shipped the feature — it renders as a
//     `vX.Y.Z` stamp in the card's meta row (the section is titled Changelog).
//   - `new` for features, `update` for changes and reworks.
//   - short punchy title + 1–2 sentence player-facing description. Write for a
//     player looking at the site, not in commit-message tone.
//
// Newest goes on top by convention, but the renderer sorts by date anyway, so
// an out-of-order entry still lands in the right place. Entries that fall off
// the end of the page stay in this file as history.

export type Announcement = {
  /** ISO `YYYY-MM-DD`. Rendered as "Jun 7, 2026"; also the `datetime` attr. */
  date: string;
  /** The APP_VERSION (src/lib/version.ts) that shipped it, no `v` prefix. */
  version: string;
  /** Drives the badge: `new` → green NEW, `update` → amber UPDATE. */
  kind: 'new' | 'update';
  title: string;
  body: string;
};

/**
 * How many entries follow the big lead card. Older ones drop off the page but
 * stay in the list below.
 */
export const GRID_COUNT = 5;

export const ANNOUNCEMENTS: Announcement[] = [
  {
    date: '2026-07-29',
    version: '2.26.0',
    kind: 'update',
    title: 'A new look, everywhere',
    body: 'The whole app has been redrawn as a chess bulletin: an editorial serif for headings, a proper monospace for everything you read as a number — clocks, ratings, board coordinates, move lists — and panels that sit on the page like printed plates instead of frosted glass. Same board, same rules, considerably better dressed.',
  },
  {
    date: '2026-07-27',
    version: '2.25.0',
    kind: 'new',
    title: 'Chesssweeper: there are mines on the board',
    body: "Four landmines sit buried across the middle of the board. A piece that travels over one is gone — the move stops dead on the crater, and only a knight's jump clears them. Landing safely tells you how many live mines that square touches, and you can flag the ones you don't trust, privately.",
  },
  {
    date: '2026-07-27',
    version: '2.24.3',
    kind: 'new',
    title: 'Kamakaze arms your own pieces',
    body: 'Mark one of your pieces as a bomb. It detonates when it captures or gets captured, clearing everything within a square — and any other armed piece caught in the blast goes off too.',
  },
  {
    date: '2026-07-27',
    version: '2.24.3',
    kind: 'new',
    title: 'Gojo spawns Hollow Purple',
    body: 'It appears next to your king and drifts one square every ply in a straight line to the edge of the board, annihilating everything it touches on the way. Your own pieces included.',
  },
  {
    date: '2026-07-27',
    version: '2.24.3',
    kind: 'update',
    title: 'Goofball forces two moves',
    body: 'One activation now puppets your opponent twice — any pieces, the same piece twice allowed — before they get a move of their own back.',
  },
  {
    date: '2026-06-07',
    version: '2.19.8',
    kind: 'new',
    title: 'Emoji reactions in online games',
    body: `Fire off a reaction mid-game and it pops up as a speech bubble on your opponent's board — the fastest way to say "really?" without unmuting.`,
  },
  {
    date: '2026-06-06',
    version: '2.19.0',
    kind: 'update',
    title: 'Captured-piece counters',
    body: "Both sides' captures are tracked next to the board, so material is readable at a glance instead of counted from memory.",
  },
  {
    date: '2026-06-06',
    version: '2.18.5',
    kind: 'new',
    title: 'Juggernaut joins the Hero roster',
    body: 'A king that eats the pieces sent to kill it. Every absorbed attacker tiers it up — earthquake, then edge charge, then the slam.',
  },
  {
    date: '2026-06-03',
    version: '2.16.0',
    kind: 'update',
    title: 'Flight rework',
    body: 'Flight now teleports any one of your pieces to any empty square, instead of only the squares next to your king.',
  },
  {
    date: '2026-05-28',
    version: '2.14.0',
    kind: 'new',
    title: 'Pinned games on your profile',
    body: 'Pin the games worth keeping. They stay at the top of your history and open straight into the review board.',
  },
];

// ── Rendering ───────────────────────────────────────────────────────────────
// Markup lives next to the copy rather than in vite.config.ts: the class names
// below are landing.css's, and both change together.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-06-07` → `Jun 7, 2026`. Parsed by hand — `new Date(iso)` reads as UTC
 *  and would render the previous day west of Greenwich. */
function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) {
    throw new Error(`[announcements] bad date ${JSON.stringify(iso)} — expected YYYY-MM-DD`);
  }
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function card(a: Announcement, indent: string, lead: boolean): string {
  return [
    `${indent}<article class="${lead ? 'news news-latest' : 'news'}">`,
    `${indent}  <div class="news-meta">`,
    `${indent}    <span class="tag tag-${a.kind}">${a.kind === 'new' ? 'New' : 'Update'}</span>`,
    `${indent}    <span class="news-version">v${esc(a.version)}</span>`,
    `${indent}    <time datetime="${a.date}">${displayDate(a.date)}</time>`,
    `${indent}  </div>`,
    `${indent}  <h3>${esc(a.title)}</h3>`,
    `${indent}  <p>${esc(a.body)}</p>`,
    `${indent}</article>`,
  ].join('\n');
}

/**
 * The Changelog cards as an HTML fragment: newest entry as the lead card,
 * the next `GRID_COUNT` in the column below it.
 *
 * `indent` is the source indentation of the marker it replaces — the first line
 * is left flush because it inherits the marker's own indentation.
 */
export function renderAnnouncementsHtml(indent = '        '): string {
  // Stable sort, so entries sharing a date keep the order they're listed in.
  const sorted = [...ANNOUNCEMENTS].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const [lead, ...rest] = sorted;
  if (!lead) return '';

  const blocks = [card(lead, indent, true)];
  const grid = rest.slice(0, GRID_COUNT);
  if (grid.length) {
    blocks.push(
      [
        `${indent}<div class="news-grid">`,
        ...grid.map((a) => card(a, `${indent}  `, false)),
        `${indent}</div>`,
      ].join('\n'),
    );
  }
  return blocks.join('\n\n').trimStart();
}
