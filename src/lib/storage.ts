import { get, set, del } from 'idb-keyval';
import type { LocalGameSummary, GameRecord } from './types';
import { STARTING_ELO } from './elo';

const SUMMARIES_KEY = 'chess.summaries.v1';
const RATING_KEY = 'chess.rating.v1';
const RECORD_KEY_PREFIX = 'chess.record.v1.';

// Hard cap on how many game summaries we keep. When a new summary pushes us
// past this, the oldest are dropped AND their backing record entries are
// garbage-collected in the same pass — otherwise the `chess.record.v1.*`
// blobs would orphan in IDB forever.
export const SUMMARY_CAP = 500;

export async function loadSummaries(): Promise<LocalGameSummary[]> {
  return (await get<LocalGameSummary[]>(SUMMARIES_KEY)) ?? [];
}

export async function appendSummary(summary: LocalGameSummary): Promise<void> {
  const list = await loadSummaries();
  list.unshift(summary);
  const kept = list.slice(0, SUMMARY_CAP);
  const dropped = list.slice(SUMMARY_CAP);
  await set(SUMMARIES_KEY, kept);
  // Garbage-collect the record entries that just fell off the end of the
  // summary list. Best-effort: a single failure shouldn't abort the rest.
  for (const s of dropped) {
    try { await deleteGameRecord(s.gameId); } catch {}
  }
}

export async function loadRating(): Promise<number> {
  return (await get<number>(RATING_KEY)) ?? STARTING_ELO;
}

export async function saveRating(rating: number): Promise<void> {
  await set(RATING_KEY, rating);
}

export async function saveGameRecord(record: GameRecord): Promise<void> {
  await set(RECORD_KEY_PREFIX + record.gameId, record);
}

export async function loadGameRecord(gameId: string): Promise<GameRecord | undefined> {
  return await get<GameRecord>(RECORD_KEY_PREFIX + gameId);
}

export async function deleteGameRecord(gameId: string): Promise<void> {
  await del(RECORD_KEY_PREFIX + gameId);
}
