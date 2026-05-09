// Matchmaker Worker — pairs peers waiting in the same time-control queue.
// Single Durable Object holds queue state across regions.
//
// Deploy from this directory: `npx wrangler deploy`
// Frontend points at the deployed URL via VITE_MATCHMAKE_URL.

interface Env {
  MATCHMAKER: DurableObjectNamespace;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return withCors(new Response('method not allowed', { status: 405 }));
    }

    if (!env.MATCHMAKER) {
      return withCors(json({ error: 'MATCHMAKER DO binding missing' }, 500));
    }
    const id = env.MATCHMAKER.idFromName('global');
    const stub = env.MATCHMAKER.get(id);
    const upstream = await stub.fetch(request);
    return withCors(upstream);
  },
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Durable Object
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
  expiresAt: number;
};

export class Matchmaker {
  state: DurableObjectState;
  waiting = new Map<string, WaitingEntry>();
  queues = new Map<string, string[]>();
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
      const newcomerIsWhite = Math.random() < 0.5;

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
