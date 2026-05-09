import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';

// In-memory matchmaker for `npm run dev`. In production, the Cloudflare Pages
// Function in functions/api/matchmake.ts handles this with a Durable Object.
function devMatchmakerPlugin(): Plugin {
  type Waiting = {
    ticket: string;
    peerId: string;
    publicKeyHex: string;
    handle: string;
    rating: number;
    timeControlId: string;
    joinedAt: number;
  };
  type Matched = {
    ticket: string;
    partnerPeerId: string;
    partnerPubKey: string;
    partnerHandle: string;
    partnerRating: number;
    iAmWhite: boolean;
    gameId: string;
  };
  const waiting = new Map<string, Waiting>();
  const queues = new Map<string, string[]>();
  const matched = new Map<string, Matched>();
  const rid = () => randomBytes(8).toString('hex');

  return {
    name: 'dev-matchmaker',
    configureServer(server) {
      server.middlewares.use('/api/matchmake', async (req, res) => {
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
          const { timeControlId, peerId, publicKeyHex, handle, rating } = body;
          const ticket = rid();
          const queue = queues.get(timeControlId) ?? [];
          // gc stale waiters
          for (const [t, w] of waiting) {
            if (Date.now() - w.joinedAt > 120_000) {
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
              partnerPubKey: publicKeyHex,
              partnerHandle: handle,
              partnerRating: rating,
              iAmWhite: !newcomerWhite,
              gameId,
            });
            reply({
              status: 'matched',
              ticket,
              partnerPeerId: partner.peerId,
              partnerPubKey: partner.publicKeyHex,
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
            publicKeyHex,
            handle: handle ?? 'anon',
            rating,
            timeControlId,
            joinedAt: Date.now(),
          });
          queue.push(ticket);
          queues.set(timeControlId, queue);
          reply({ status: 'waiting', ticket });
          return;
        }
        if (body.action === 'poll') {
          const t = body.ticket;
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
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devMatchmakerPlugin()],
  server: { port: 5173 },
});
