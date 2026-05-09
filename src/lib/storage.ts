import { get, set, del } from 'idb-keyval';
import type { LocalGameSummary, GameRecord } from './types';
import { STARTING_ELO } from './elo';

const SUMMARIES_KEY = 'chess.summaries.v1';
const RATING_KEY = 'chess.rating.v1';
const RECORD_KEY_PREFIX = 'chess.record.v1.';

export async function loadSummaries(): Promise<LocalGameSummary[]> {
  return (await get<LocalGameSummary[]>(SUMMARIES_KEY)) ?? [];
}

export async function appendSummary(summary: LocalGameSummary): Promise<void> {
  const list = await loadSummaries();
  list.unshift(summary);
  await set(SUMMARIES_KEY, list.slice(0, 500));
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
