// Matchmaker Worker — pairs peers waiting in the same time-control queue.
// State lives in D1 so it works on the Workers free plan (no Durable Objects).
//
// Setup:
//   npx wrangler d1 create chess-matchmaker        # paste database_id into wrangler.toml
//   npx wrangler d1 execute chess-matchmaker --remote --file=worker/schema.sql
//   npm run deploy:worker
//
// Frontend points at the deployed URL via VITE_MATCHMAKE_URL.

interface Env {
  DB: D1Database;
  // Cloudflare Realtime TURN credentials. Set with `wrangler secret put`:
  //   npx wrangler secret put TURN_KEY_ID
  //   npx wrangler secret put TURN_KEY_API_TOKEN
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
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

    let body: any;
    try {
      body = await request.json();
    } catch {
      return withCors(json({ error: 'invalid json' }, 400));
    }

    try {
      const action = body.action;
      // The turn action doesn't need DB — handle it before the DB-binding check
      // so a misconfigured DB doesn't block voice/WebRTC.
      if (action === 'turn') return withCors(await handleTurn(env, body));
      if (!env.DB) {
        return withCors(json({ error: 'DB binding missing — check wrangler.toml d1_databases binding' }, 500));
      }
      if (action === 'join') return withCors(await handleJoin(env.DB, body));
      if (action === 'poll') return withCors(await handlePoll(env.DB, body));
      if (action === 'cancel') return withCors(await handleCancel(env.DB, body));
      if (action === 'stats') return withCors(await handleStats(env.DB, body));
      return withCors(json({ error: 'unknown action' }, 400));
    } catch (err: any) {
      return withCors(json({ error: 'server error', detail: String(err?.message ?? err) }, 500));
    }
  },
};

// Per-isolate cache so we don't hit the Cloudflare TURN API on every page load.
// Isolates are recycled freely, so this is best-effort — worst case is more API
// calls, not staleness.
let turnCache: { iceServers: unknown; expiresAt: number } | null = null;
const TURN_TTL_SECONDS = 24 * 60 * 60; // 24h — clients refresh well before then
const TURN_CACHE_SAFETY_MARGIN_MS = 60 * 60_000; // re-mint with 1h to spare

async function handleTurn(env: Env, _body: any): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json({ error: 'TURN credentials not configured' }, 503);
  }
  const now = Date.now();
  if (turnCache && turnCache.expiresAt - TURN_CACHE_SAFETY_MARGIN_MS > now) {
    return json({ iceServers: turnCache.iceServers, expiresAt: turnCache.expiresAt });
  }
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'turn api failed', status: res.status, detail }, 502);
  }
  const data: any = await res.json();
  const iceServers = data?.iceServers;
  if (!iceServers) {
    return json({ error: 'turn api returned no iceServers', data }, 502);
  }
  const expiresAt = now + TURN_TTL_SECONDS * 1000;
  turnCache = { iceServers, expiresAt };
  return json({ iceServers, expiresAt });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

type WaitingRow = {
  ticket: string;
  time_control_id: string;
  peer_id: string;
  public_key_hex: string;
  handle: string;
  rating: number;
  joined_at: number;
};

type MatchedRow = {
  ticket: string;
  partner_peer_id: string;
  partner_pub_key: string;
  partner_handle: string;
  partner_rating: number;
  i_am_white: number;
  game_id: string;
  expires_at: number;
};

async function handleJoin(db: D1Database, body: any): Promise<Response> {
  const { timeControlId, peerId, publicKeyHex, handle, rating } = body;
  if (!timeControlId || !peerId || !publicKeyHex || typeof rating !== 'number') {
    return json({ error: 'missing fields' }, 400);
  }
  await gc(db);

  const ticket = randomId();
  await db.prepare(
    `INSERT INTO queue_log (time_control_id, joined_at) VALUES (?, ?)`,
  ).bind(timeControlId, Date.now()).run();

  // Atomically pop the oldest waiter in this queue. SQLite serializes the
  // statement, so concurrent joins won't pick the same partner.
  const partner = await db.prepare(
    `DELETE FROM waiting
       WHERE ticket = (
         SELECT ticket FROM waiting
           WHERE time_control_id = ?
           ORDER BY joined_at ASC
           LIMIT 1
       )
       RETURNING *`,
  ).bind(timeControlId).first<WaitingRow>();

  if (partner) {
    const gameId = randomId() + randomId();
    const newcomerIsWhite = Math.random() < 0.5;
    const expiresAt = Date.now() + 60_000;

    // Stash the match keyed by the partner's ticket so they pick it up on poll.
    await db.prepare(
      `INSERT INTO matched (ticket, partner_peer_id, partner_pub_key, partner_handle, partner_rating, i_am_white, game_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      partner.ticket,
      peerId,
      publicKeyHex,
      handle ?? 'anon',
      rating,
      newcomerIsWhite ? 0 : 1,
      gameId,
      expiresAt,
    ).run();

    return json({
      status: 'matched',
      ticket,
      partnerPeerId: partner.peer_id,
      partnerPubKey: partner.public_key_hex,
      partnerHandle: partner.handle,
      partnerRating: partner.rating,
      iAmWhite: newcomerIsWhite,
      gameId,
    });
  }

  const now = Date.now();
  await db.prepare(
    `INSERT INTO waiting (ticket, time_control_id, peer_id, public_key_hex, handle, rating, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(ticket, timeControlId, peerId, publicKeyHex, handle ?? 'anon', rating, now, now).run();

  return json({ status: 'waiting', ticket });
}

async function handlePoll(db: D1Database, body: any): Promise<Response> {
  const { ticket } = body;
  if (!ticket) return json({ error: 'missing ticket' }, 400);

  // Bump heartbeat BEFORE gc so a slightly-late poll doesn't get its own
  // waiter pruned in the same request.
  await db.prepare(
    `UPDATE waiting SET last_seen_at = ? WHERE ticket = ?`,
  ).bind(Date.now(), ticket).run();

  await gc(db);

  const matched = await db.prepare(
    `DELETE FROM matched WHERE ticket = ? RETURNING *`,
  ).bind(ticket).first<MatchedRow>();

  if (matched) {
    return json({
      status: 'matched',
      partnerPeerId: matched.partner_peer_id,
      partnerPubKey: matched.partner_pub_key,
      partnerHandle: matched.partner_handle,
      partnerRating: matched.partner_rating,
      iAmWhite: matched.i_am_white === 1,
      gameId: matched.game_id,
    });
  }

  const stillWaiting = await db.prepare(
    `SELECT 1 FROM waiting WHERE ticket = ?`,
  ).bind(ticket).first();

  if (stillWaiting) return json({ status: 'waiting' });
  return json({ status: 'cancelled' });
}

async function handleStats(db: D1Database, body: any): Promise<Response> {
  await gc(db);
  const windows = body?.windows;
  if (!windows || typeof windows !== 'object') {
    return json({ error: 'missing windows' }, 400);
  }
  const counts: Record<string, number> = {};
  const now = Date.now();
  for (const [id, raw] of Object.entries(windows)) {
    const windowMs = Number(raw);
    if (!Number.isFinite(windowMs) || windowMs <= 0) continue;
    const since = now - Math.min(windowMs, 24 * 60 * 60_000);
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM queue_log WHERE time_control_id = ? AND joined_at >= ?`,
    ).bind(id, since).first<{ n: number }>();
    counts[id] = Number(row?.n ?? 0);
  }
  return json({ counts });
}

async function handleCancel(db: D1Database, body: any): Promise<Response> {
  const { ticket } = body;
  if (!ticket) return json({ error: 'missing ticket' }, 400);
  await db.batch([
    db.prepare(`DELETE FROM waiting WHERE ticket = ?`).bind(ticket),
    db.prepare(`DELETE FROM matched WHERE ticket = ?`).bind(ticket),
  ]);
  return json({ status: 'cancelled' });
}

async function gc(db: D1Database) {
  const now = Date.now();
  await db.batch([
    // Heartbeat-based liveness: clients poll every 1.5s, so a 5s window allows
    // for one missed beat. Anyone older than that has closed their tab and is
    // a ghost — must not be paired with a real newcomer.
    db.prepare(`DELETE FROM waiting WHERE last_seen_at < ?`).bind(now - 5_000),
    db.prepare(`DELETE FROM matched WHERE expires_at < ?`).bind(now),
    // Keep queue_log only as long as the longest activity window we report (30 min).
    db.prepare(`DELETE FROM queue_log WHERE joined_at < ?`).bind(now - 30 * 60_000),
  ]);
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
