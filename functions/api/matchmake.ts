// Cloudflare Pages Function: pairs peers waiting in the same time-control queue.
// Stateless across regions — uses a single Durable Object as the source of truth.
//
// Wrangler binding required (see wrangler.toml):
//   [[durable_objects.bindings]]
//   name = "MATCHMAKER"
//   class_name = "Matchmaker"
//
// Local dev fallback: when no DO binding is present (e.g. `vite dev`), this
// function is not even reached — Vite serves the SPA. To exercise matchmaking
// locally use `wrangler pages dev`.

interface Env {
  MATCHMAKER: DurableObjectNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  if (!ctx.env.MATCHMAKER) {
    return new Response(
      JSON.stringify({ error: 'MATCHMAKER DO binding missing — see wrangler.toml' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  const id = ctx.env.MATCHMAKER.idFromName('global');
  const stub = ctx.env.MATCHMAKER.get(id);
  return stub.fetch(ctx.request);
};

// ---------------------------------------------------------------------------
// Durable Object (exported from functions/_middleware.ts to be discoverable)
// ---------------------------------------------------------------------------

type WaitingEntry = {
  ticket: string;
  peerId: string;
  publicKeyHex: string;
  handle: string;
  rating: number;
  timeControlId: string;
  joinedAt: number;
};

type MatchedEntry = {
  ticket: string;
  partnerPeerId: string;
  partnerPubKey: string;
  partnerHandle: string;
  partnerRating: number;
  iAmWhite: boolean;
  gameId: string;
  // expires after a while so memory doesn't grow unbounded
  expiresAt: number;
};

export class Matchmaker {
  state: DurableObjectState;
  // ticket -> waiting entry
  waiting = new Map<string, WaitingEntry>();
  // queue per time control: list of tickets, oldest first
  queues = new Map<string, string[]>();
  // ticket -> matched info (ready to be polled)
  matched = new Map<string, MatchedEntry>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }

    const action = body.action;
    if (action === 'join') return this.handleJoin(body);
    if (action === 'poll') return this.handlePoll(body);
    if (action === 'cancel') return this.handleCancel(body);
    return json({ error: 'unknown action' }, 400);
  }

  private handleJoin(body: any): Response {
    const { timeControlId, peerId, publicKeyHex, handle, rating } = body;
    if (!timeControlId || !peerId || !publicKeyHex || typeof rating !== 'number') {
      return json({ error: 'missing fields' }, 400);
    }
    this.gc();

    const ticket = randomId();
    const queue = this.queues.get(timeControlId) ?? [];

    // Try to pair with the oldest waiting peer (skip stale ones)
    let pairTicket: string | undefined;
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      const candidateEntry = this.waiting.get(candidate);
      if (candidateEntry) {
        pairTicket = candidate;
        break;
      }
    }

    if (pairTicket) {
      const partner = this.waiting.get(pairTicket)!;
      this.waiting.delete(pairTicket);
      this.queues.set(timeControlId, queue);

      const gameId = randomId() + randomId();
      // Coin flip for color
      const newcomerIsWhite = Math.random() < 0.5;

      // Tell the *waiting* peer about the newcomer
      this.matched.set(pairTicket, {
        ticket: pairTicket,
        partnerPeerId: peerId,
        partnerPubKey: publicKeyHex,
        partnerHandle: handle,
        partnerRating: rating,
        iAmWhite: !newcomerIsWhite,
        gameId,
        expiresAt: Date.now() + 60_000,
      });

      // Respond synchronously to the *newcomer*
      return json({
        status: 'matched',
        ticket,
        partnerPeerId: partner.peerId,
        partnerPubKey: partner.publicKeyHex,
        partnerHandle: partner.handle,
        partnerRating: partner.rating,
        iAmWhite: newcomerIsWhite,
        gameId,
      });
    }

    // Otherwise queue
    const entry: WaitingEntry = {
      ticket,
      peerId,
      publicKeyHex,
      handle: handle ?? 'anon',
      rating,
      timeControlId,
      joinedAt: Date.now(),
    };
    this.waiting.set(ticket, entry);
    queue.push(ticket);
    this.queues.set(timeControlId, queue);

    return json({ status: 'waiting', ticket });
  }

  private handlePoll(body: any): Response {
    const { ticket } = body;
    if (!ticket) return json({ error: 'missing ticket' }, 400);
    this.gc();

    const matched = this.matched.get(ticket);
    if (matched) {
      this.matched.delete(ticket);
      return json({ status: 'matched', ...matched });
    }
    if (this.waiting.has(ticket)) {
      return json({ status: 'waiting' });
    }
    return json({ status: 'cancelled' });
  }

  private handleCancel(body: any): Response {
    const { ticket } = body;
    if (!ticket) return json({ error: 'missing ticket' }, 400);
    const entry = this.waiting.get(ticket);
    if (entry) {
      this.waiting.delete(ticket);
      const queue = this.queues.get(entry.timeControlId);
      if (queue) {
        const idx = queue.indexOf(ticket);
        if (idx >= 0) queue.splice(idx, 1);
      }
    }
    this.matched.delete(ticket);
    return json({ status: 'cancelled' });
  }

  // Drop entries older than 2 minutes
  private gc() {
    const now = Date.now();
    for (const [ticket, entry] of this.waiting) {
      if (now - entry.joinedAt > 120_000) {
        this.waiting.delete(ticket);
        const q = this.queues.get(entry.timeControlId);
        if (q) {
          const idx = q.indexOf(ticket);
          if (idx >= 0) q.splice(idx, 1);
        }
      }
    }
    for (const [ticket, m] of this.matched) {
      if (now > m.expiresAt) this.matched.delete(ticket);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
