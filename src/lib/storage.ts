import { get, set, del } from 'idb-keyval';
import type { LocalGameSummary, GameRecord, Move, GameOutcome } from './types';
import { STARTING_ELO } from './elo';

const RATING_KEY = 'chess.rating.v1';
const RECORD_KEY_PREFIX = 'chess.record.v1.';

// v1 (legacy): a single flat array under this key. Read at most once per
// session — the migration helper fans it out into per-day buckets and
// deletes it. New code never writes here.
const LEGACY_SUMMARIES_KEY = 'chess.summaries.v1';

// v2: day-bucketed history.
//
//   chess.summaries.v2.index       — manifest: string[] of YYYY-MM-DD dates,
//                                     newest first. Only dates with at least
//                                     one summary appear.
//   chess.summaries.v2.day.<DATE>  — bucket: LocalGameSummary[] for that day,
//                                     newest within the day first.
//   chess.summaries.v2.aggregate   — counters: { wins, losses, draws, total }
//                                     so K-factor and the Profile card don't
//                                     need to walk every bucket.
//
// Per-day boundaries are in the user's local timezone — matches how a human
// thinks "games I played Tuesday." Bucketing is keyed off `endedAt`.
const INDEX_KEY = 'chess.summaries.v2.index';
const DAY_KEY_PREFIX = 'chess.summaries.v2.day.';
const AGGREGATE_KEY = 'chess.summaries.v2.aggregate';

// How many days of history we keep. When a new day pushes us past this, the
// oldest day's bucket, its summaries, and each of those summaries' backing
// record entries are dropped together. A year of casual play, easy to reason
// about in calendar terms.
export const HISTORY_DAYS_CAP = 365;

// Storage uses a compact Move shape: drop `fenAfter` (regenerable by
// replaying UCI through the variant engine — see lib/gameExport.buildReplay)
// and `ply` (always array index + 1). This cuts a typical record's bytes by
// roughly half. The wire-protocol Move keeps both fields because the live
// `applyRemoteMove` flow uses them for ordering + resync; only the persisted
// form drops them.
type StoredMove = {
  uci: string;
  whiteClockMs: number;
  blackClockMs: number;
};

type StoredGameRecord = Omit<GameRecord, 'moves'> & {
  moves: StoredMove[];
};

export type AggregateStats = {
  wins: number;
  losses: number;
  draws: number;
  total: number;
};

const EMPTY_AGGREGATE: AggregateStats = { wins: 0, losses: 0, draws: 0, total: 0 };

// ---------------------------------------------------------------------------
// Date helpers — local-timezone YYYY-MM-DD strings.
// ---------------------------------------------------------------------------

export function dateKeyFromTimestamp(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayBucketKey(date: string): string {
  return DAY_KEY_PREFIX + date;
}

// ---------------------------------------------------------------------------
// Migration — fan out the legacy flat list into per-day buckets. Idempotent:
// the legacy key's absence is our marker. Runs lazily on the first read /
// write that touches the v2 store.
// ---------------------------------------------------------------------------

let migrationPromise: Promise<void> | null = null;

async function ensureMigrated(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const legacy = await get<LocalGameSummary[]>(LEGACY_SUMMARIES_KEY);
    if (!legacy || legacy.length === 0) {
      // Either fresh install or already migrated. Either way we're done; just
      // make sure the legacy key isn't lingering as `[]`.
      if (legacy) await del(LEGACY_SUMMARIES_KEY);
      return;
    }
    // Group by date. Within each day's bucket, preserve the newest-first
    // ordering of the flat list — the legacy `appendSummary` did `unshift`,
    // so [0] is newest.
    const byDate = new Map<string, LocalGameSummary[]>();
    const aggregate: AggregateStats = { ...EMPTY_AGGREGATE };
    for (const s of legacy) {
      const date = dateKeyFromTimestamp(s.endedAt);
      const bucket = byDate.get(date) ?? [];
      bucket.push(s);
      byDate.set(date, bucket);
      bumpAggregate(aggregate, s.outcome, s.myColor);
    }
    // Manifest: dates sorted newest first.
    const dates = Array.from(byDate.keys()).sort().reverse();
    for (const date of dates) {
      await set(dayBucketKey(date), byDate.get(date)!);
    }
    await set(INDEX_KEY, dates);
    await set(AGGREGATE_KEY, aggregate);
    await del(LEGACY_SUMMARIES_KEY);
  })();
  return migrationPromise;
}

// Test-only escape hatch — lets the migration smoke test reset its memoized
// promise between runs. Production code never calls this.
export function _resetMigrationForTests(): void {
  migrationPromise = null;
}

// ---------------------------------------------------------------------------
// Index, day buckets, aggregate
// ---------------------------------------------------------------------------

export async function loadHistoryIndex(): Promise<string[]> {
  await ensureMigrated();
  return (await get<string[]>(INDEX_KEY)) ?? [];
}

export async function loadDaySummaries(date: string): Promise<LocalGameSummary[]> {
  await ensureMigrated();
  return (await get<LocalGameSummary[]>(dayBucketKey(date))) ?? [];
}

export async function loadAggregateStats(): Promise<AggregateStats> {
  await ensureMigrated();
  return (await get<AggregateStats>(AGGREGATE_KEY)) ?? { ...EMPTY_AGGREGATE };
}

// Walk the manifest newest-first and collect summaries until `limit` is
// reached. Cheap when `limit` is small (a few day reads) regardless of how
// many total games are stored. Used by the Review page picker.
export async function loadRecentSummaries(limit: number): Promise<LocalGameSummary[]> {
  await ensureMigrated();
  const dates = await loadHistoryIndex();
  const out: LocalGameSummary[] = [];
  for (const date of dates) {
    if (out.length >= limit) break;
    const bucket = await loadDaySummaries(date);
    for (const s of bucket) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Append flow — updates today's bucket + manifest + aggregate + enforces cap.
// ---------------------------------------------------------------------------

export async function appendSummary(summary: LocalGameSummary): Promise<void> {
  await ensureMigrated();
  const date = dateKeyFromTimestamp(summary.endedAt);
  // 1. Push into today's bucket (newest first within the day).
  const bucket = await loadDaySummaries(date);
  bucket.unshift(summary);
  await set(dayBucketKey(date), bucket);
  // 2. Update the manifest — promote `date` to the front if it's already
  //    there, or insert it at the right place if it's new.
  const index = await loadHistoryIndex();
  const existingIdx = index.indexOf(date);
  if (existingIdx >= 0) {
    // Same day — manifest position doesn't change; days are sorted by date,
    // not last-write. No update needed.
  } else {
    index.push(date);
    index.sort().reverse();
    await set(INDEX_KEY, index);
  }
  // 3. Increment aggregate.
  const aggregate = await loadAggregateStats();
  bumpAggregate(aggregate, summary.outcome, summary.myColor);
  await set(AGGREGATE_KEY, aggregate);
  // 4. Enforce day cap by dropping oldest days entirely.
  await enforceDayCap();
}

function bumpAggregate(
  aggregate: AggregateStats,
  outcome: GameOutcome,
  myColor: 'white' | 'black',
): void {
  aggregate.total += 1;
  if (outcome === 'draw') aggregate.draws += 1;
  else if (outcome === myColor) aggregate.wins += 1;
  else aggregate.losses += 1;
}

async function enforceDayCap(): Promise<void> {
  const index = await loadHistoryIndex();
  if (index.length <= HISTORY_DAYS_CAP) return;
  // Drop everything past the cap. Index is newest-first, so the tail is
  // oldest. For each dropped day: load its bucket, delete each record blob,
  // delete the bucket, decrement the aggregate.
  const kept = index.slice(0, HISTORY_DAYS_CAP);
  const dropped = index.slice(HISTORY_DAYS_CAP);
  const aggregate = await loadAggregateStats();
  for (const date of dropped) {
    const bucket = await loadDaySummaries(date);
    for (const s of bucket) {
      try { await deleteGameRecord(s.gameId); } catch {}
      // Mirror bumpAggregate but decrementing.
      aggregate.total = Math.max(0, aggregate.total - 1);
      if (s.outcome === 'draw') aggregate.draws = Math.max(0, aggregate.draws - 1);
      else if (s.outcome === s.myColor) aggregate.wins = Math.max(0, aggregate.wins - 1);
      else aggregate.losses = Math.max(0, aggregate.losses - 1);
    }
    try { await del(dayBucketKey(date)); } catch {}
  }
  await set(INDEX_KEY, kept);
  await set(AGGREGATE_KEY, aggregate);
}

// ---------------------------------------------------------------------------
// Records — unchanged from v1 on disk (compaction lives at the Move shape).
// ---------------------------------------------------------------------------

export async function loadRating(): Promise<number> {
  return (await get<number>(RATING_KEY)) ?? STARTING_ELO;
}

export async function saveRating(rating: number): Promise<void> {
  await set(RATING_KEY, rating);
}

export async function saveGameRecord(record: GameRecord): Promise<void> {
  const compact: StoredGameRecord = {
    ...record,
    moves: record.moves.map((m) => ({
      uci: m.uci,
      whiteClockMs: m.whiteClockMs,
      blackClockMs: m.blackClockMs,
    })),
  };
  await set(RECORD_KEY_PREFIX + record.gameId, compact);
}

export async function loadGameRecord(gameId: string): Promise<GameRecord | undefined> {
  const stored = await get<StoredGameRecord | GameRecord>(RECORD_KEY_PREFIX + gameId);
  if (!stored) return undefined;
  // Rehydrate to the full Move shape. ply is reconstructed from position;
  // fenAfter is left empty — the Review page replays via the variant engine
  // and doesn't need a per-move FEN. Records persisted before the storage
  // compaction (which still carry fenAfter/ply on disk) flow through here
  // untouched.
  const moves: Move[] = stored.moves.map((m, i) => {
    const anyM = m as Partial<Move> & StoredMove;
    return {
      uci: anyM.uci,
      whiteClockMs: anyM.whiteClockMs,
      blackClockMs: anyM.blackClockMs,
      ply: anyM.ply ?? i + 1,
      fenAfter: anyM.fenAfter ?? '',
    };
  });
  return { ...stored, moves };
}

export async function deleteGameRecord(gameId: string): Promise<void> {
  await del(RECORD_KEY_PREFIX + gameId);
}

// ---------------------------------------------------------------------------
// Back-compat shim. Several callers still pull the full flat list — namely
// the Review page picker (capped to ~30 entries anyway). New code should
// prefer loadRecentSummaries / loadAggregateStats / loadDaySummaries.
// ---------------------------------------------------------------------------

export async function loadSummaries(): Promise<LocalGameSummary[]> {
  await ensureMigrated();
  const dates = await loadHistoryIndex();
  const out: LocalGameSummary[] = [];
  for (const date of dates) {
    const bucket = await loadDaySummaries(date);
    for (const s of bucket) out.push(s);
  }
  return out;
}
