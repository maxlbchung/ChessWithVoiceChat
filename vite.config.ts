import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderAnnouncementsHtml } from './landing/announcements.ts';

// In-memory matchmaker for `npm run dev`. In production, the Cloudflare Pages
// Function in functions/api/matchmake.ts handles this with a Durable Object.
function devMatchmakerPlugin(): Plugin {
  type Waiting = {
    ticket: string;
    peerId: string;
    handle: string;
    rating: number;
    timeControlId: string;
    joinedAt: number;
    lastSeenAt: number;
  };
  type Matched = {
    ticket: string;
    partnerPeerId: string;
    partnerHandle: string;
    partnerRating: number;
    iAmWhite: boolean;
    gameId: string;
  };
  const waiting = new Map<string, Waiting>();
  const queues = new Map<string, string[]>();
  const matched = new Map<string, Matched>();
  // Append-only log of every queue join, keyed by time control. Trimmed to 30m.
  const joinLog: { timeControlId: string; joinedAt: number }[] = [];
  const rid = () => randomBytes(8).toString('hex');
  const LOG_TTL_MS = 30 * 60_000;
  const trimLog = () => {
    const cutoff = Date.now() - LOG_TTL_MS;
    while (joinLog.length && joinLog[0].joinedAt < cutoff) joinLog.shift();
  };

  // Shared between dev and preview servers. `vite preview` serves the
  // production build, which is the only way to exercise two-client P2P flows
  // headlessly: dev's React StrictMode double-mounts game pages and the
  // unmount cleanup tears the PeerJS session down at mount.
  const handler = async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        const reply = (obj: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(obj));
        };

        if (body.action === 'join') {
          const { timeControlId, peerId, handle, rating } = body;
          const ticket = rid();
          joinLog.push({ timeControlId, joinedAt: Date.now() });
          trimLog();
          const queue = queues.get(timeControlId) ?? [];
          // gc ghost waiters by heartbeat — anyone who hasn't polled in 5s is gone.
          for (const [t, w] of waiting) {
            if (Date.now() - w.lastSeenAt > 5_000) {
              waiting.delete(t);
              const q = queues.get(w.timeControlId);
              if (q) {
                const i = q.indexOf(t);
                if (i >= 0) q.splice(i, 1);
              }
            }
          }
          let pair: string | undefined;
          while (queue.length) {
            const c = queue.shift()!;
            if (waiting.has(c)) {
              pair = c;
              break;
            }
          }
          if (pair) {
            const partner = waiting.get(pair)!;
            waiting.delete(pair);
            queues.set(timeControlId, queue);
            const gameId = rid() + rid();
            const newcomerWhite = Math.random() < 0.5;
            matched.set(pair, {
              ticket: pair,
              partnerPeerId: peerId,
              partnerHandle: handle,
              partnerRating: rating,
              iAmWhite: !newcomerWhite,
              gameId,
            });
            reply({
              status: 'matched',
              ticket,
              partnerPeerId: partner.peerId,
              partnerHandle: partner.handle,
              partnerRating: partner.rating,
              iAmWhite: newcomerWhite,
              gameId,
            });
            return;
          }
          waiting.set(ticket, {
            ticket,
            peerId,
            handle: handle ?? 'anon',
            rating,
            timeControlId,
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
          });
          queue.push(ticket);
          queues.set(timeControlId, queue);
          reply({ status: 'waiting', ticket });
          return;
        }
        if (body.action === 'poll') {
          const t = body.ticket;
          // Heartbeat first so a slightly-late poll keeps the waiter alive.
          const w = waiting.get(t);
          if (w) w.lastSeenAt = Date.now();
          // Then prune ghosts (skip the just-bumped one).
          for (const [tk, wt] of waiting) {
            if (Date.now() - wt.lastSeenAt > 5_000) {
              waiting.delete(tk);
              const q = queues.get(wt.timeControlId);
              if (q) {
                const i = q.indexOf(tk);
                if (i >= 0) q.splice(i, 1);
              }
            }
          }
          const m = matched.get(t);
          if (m) {
            matched.delete(t);
            reply({ status: 'matched', ...m });
            return;
          }
          if (waiting.has(t)) {
            reply({ status: 'waiting' });
            return;
          }
          reply({ status: 'cancelled' });
          return;
        }
        if (body.action === 'stats') {
          trimLog();
          const windows = body.windows;
          if (!windows || typeof windows !== 'object') {
            reply({ error: 'missing windows' }, 400);
            return;
          }
          const counts: Record<string, number> = {};
          const now = Date.now();
          for (const [id, raw] of Object.entries(windows)) {
            const windowMs = Number(raw);
            if (!Number.isFinite(windowMs) || windowMs <= 0) continue;
            const since = now - Math.min(windowMs, 24 * 60 * 60_000);
            counts[id] = joinLog.reduce(
              (n, e) => (e.timeControlId === id && e.joinedAt >= since ? n + 1 : n),
              0,
            );
          }
          reply({ counts });
          return;
        }
        if (body.action === 'cancel') {
          const t = body.ticket;
          const w = waiting.get(t);
          if (w) {
            waiting.delete(t);
            const q = queues.get(w.timeControlId);
            if (q) {
              const i = q.indexOf(t);
              if (i >= 0) q.splice(i, 1);
            }
          }
          matched.delete(t);
          reply({ status: 'cancelled' });
          return;
        }
        reply({ error: 'unknown action' }, 400);
  };

  return {
    name: 'dev-matchmaker',
    configureServer(server) {
      server.middlewares.use('/api/matchmake', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/matchmake', handler);
    },
  };
}

// Generates the landing page's Announcements column from landing/announcements.ts
// and drops it into the marker in index.html. Runs for dev and build alike, so
// the page that ships is still static HTML — the changelog is data, but nothing
// renders it at runtime. app/index.html has no marker and passes through
// untouched. Vite watches config dependencies, so editing the list restarts dev.
function announcementsPlugin(): Plugin {
  const MARKER = '<!--announcements-->';
  return {
    name: 'landing-announcements',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.includes(MARKER) ? html.replace(MARKER, renderAnnouncementsHtml()) : html,
    },
  };
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), devMatchmakerPlugin(), announcementsPlugin()],
  server: { port: 5173 },
  optimizeDeps: {
    include: ['react-dom/server'],
  },
  base: process.env.GITHUB_PAGES === 'true' ? '/ChessWithVoiceChat/' : '/',
  build: {
    // Two HTML entries. Rollup keeps each one's path relative to the project
    // root, so this builds to dist/index.html (the static landing page — no
    // React, no router) and dist/app/index.html (the game itself, hash-routed
    // under /app/). Both are served by the same Pages deploy.
    rollupOptions: {
      input: {
        landing: here('index.html'),
        app: here('app/index.html'),
      },
    },
  },
});
