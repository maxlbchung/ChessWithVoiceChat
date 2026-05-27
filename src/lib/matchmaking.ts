import type { Identity } from './identity';

export type MatchResult =
  | { status: 'matched'; partnerPeerId: string; partnerHandle: string; partnerRating: number; iAmWhite: boolean; gameId: string }
  | { status: 'waiting' }
  | { status: 'cancelled' };

// In dev, route to the in-process plugin in vite.config.ts. In prod, default
// to the public Worker. Override via VITE_MATCHMAKE_URL when self-hosting.
const MATCHMAKE_URL =
  import.meta.env.VITE_MATCHMAKE_URL ||
  (import.meta.env.DEV ? '/api/matchmake' : 'https://chess-matchmaker.maxlbchung.workers.dev');
const POLL_MS = 1500;

export class Matchmaker {
  private cancelled = false;
  private ticket: string | null = null;

  async start(opts: {
    identity: Identity;
    peerId: string;
    rating: number;
    timeControlId: string;
  }): Promise<MatchResult> {
    this.cancelled = false;

    const join = await fetch(MATCHMAKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        timeControlId: opts.timeControlId,
        peerId: opts.peerId,
        handle: opts.identity.handle,
        rating: opts.rating,
      }),
    });
    if (!join.ok) throw new Error('matchmake join failed: ' + join.status);
    const joinResult = await join.json();
    this.ticket = joinResult.ticket;
    if (joinResult.status === 'matched') {
      return joinResult;
    }

    // poll
    while (!this.cancelled) {
      await sleep(POLL_MS);
      if (this.cancelled) break;
      const poll = await fetch(MATCHMAKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'poll', ticket: this.ticket }),
      });
      if (!poll.ok) continue;
      const result = await poll.json();
      if (result.status === 'matched') return result;
    }
    return { status: 'cancelled' };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.ticket) {
      try {
        await fetch(MATCHMAKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', ticket: this.ticket }),
        });
      } catch {}
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function fetchQueueStats(
  windows: Record<string, number>,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const res = await fetch(MATCHMAKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stats', windows }),
    signal,
  });
  if (!res.ok) throw new Error('stats fetch failed: ' + res.status);
  const data = await res.json();
  return (data?.counts ?? {}) as Record<string, number>;
}
