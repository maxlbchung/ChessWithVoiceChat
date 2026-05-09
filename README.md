# decentral.chess

A multiplayer chess web app with voice chat. Moves and audio go peer-to-peer over WebRTC; identity is a local Ed25519 keypair; ratings are computed from cryptographically-signed game records stored in your browser.

## What's "decentralized" here

| Piece | How |
| --- | --- |
| **Identity** | Ed25519 keypair generated in your browser, stored in IndexedDB. Exportable as a string. No accounts, no email, no password. |
| **Move transport** | Direct WebRTC data channel between the two players. No server sees the moves. |
| **Voice chat** | WebRTC audio track on the same peer connection. No server sees the audio. |
| **Game records** | Each move is signed by the mover. Final game records are signed by both players. Stored locally. |
| **Rating** | Computed locally from your signed game history (standard ELO, K=32 → 24). |
| **Matchmaking** | The one piece that needs *some* server: a tiny Cloudflare Pages Function with a Durable Object pairs two peers in the same time-control queue. It only sees peer IDs and public keys — it never sees moves, audio, or game results. The signaling itself can also be replaced with a self-hosted PeerJS server. |

> **Trust model in plain words:** if you trust your opponent's signed move records, you can verify everything they claim happened. The matchmaker can't lie about game results because it never sees them. The TURN server (when needed for voice) sees encrypted DTLS-SRTP packets, not plaintext audio.

## Features

- ♟️ Full chess rules via [chess.js](https://github.com/jhlywa/chess.js) and [react-chessboard](https://github.com/Clariity/react-chessboard)
- ⏱️ 10 time controls — Bullet, Blitz, Rapid, Classical
- 🎯 ELO ratings with proper K-factor (K=32 < 30 games, K=24 after)
- 🔍 Matchmaking queue (any opponent in the same time control)
- 🎙️ Voice chat (WebRTC audio, ride-along on the same peer connection)
- 💬 In-game text chat
- ✍️ Move signing + signature verification (Ed25519 over canonical move payload)
- 🪪 Self-sovereign identity, exportable across devices
- 📜 Local game history with signed game records

## Quick start

```bash
npm install
npm run dev          # local dev with in-memory matchmaker
```

Open in two browser tabs (or two devices on the same network), pick the same time control on both, hit **Play**. Allow mic permission when the voice button is clicked.

## Build & deploy (Cloudflare Pages)

```bash
npm run build        # static build → dist/
wrangler pages deploy dist
```

The matchmaking endpoint at `/api/matchmake` is automatically a Cloudflare Pages Function backed by the `Matchmaker` Durable Object declared in `wrangler.toml`. On first deploy you may need:

```bash
wrangler deploy --name decentralized-chess
# (binding for the DO is created via wrangler.toml's [[migrations]] block)
```

### Custom TURN

Free public TURN (Open Relay Project) is used by default. Most of the time it works; under strict NATs it can be flaky. To swap in your own:

```
VITE_TURN_URL="turn:your-turn.example.com:3478"
VITE_TURN_USER="user"
VITE_TURN_PASS="pass"
```

Set these as Cloudflare Pages environment variables (or in a `.env` for local dev) and rebuild.

### Self-host coturn

If you'd rather not rely on the Open Relay public credentials:

```yaml
# docker-compose.yml
services:
  turn:
    image: coturn/coturn
    network_mode: host
    command: >
      -n --log-file=stdout
      --realm=your-domain.example.com
      --user=youruser:yourpass
      --no-tls --no-dtls
```

Then point `VITE_TURN_URL` at your VPS.

## Project layout

```
src/
  lib/
    identity.ts          # keypair, sign, verify
    chess wrappers via chess.js
    timeControls.ts      # bullet/blitz/rapid/classical definitions
    elo.ts               # ELO math
    peer.ts              # PeerJS / WebRTC
    voice.ts             # getUserMedia helpers
    matchmaking.ts       # client for /api/matchmake
    gameRecord.ts        # canonical signing format
    storage.ts           # IndexedDB for rating + history
  components/            # Layout, Clock, VoiceControls, TimeModeSelector
  pages/                 # Home, Game, Profile
  store/                 # zustand identity store + lobby handoff
functions/api/
  matchmake.ts           # Cloudflare Pages Function + Durable Object
wrangler.toml            # CF Pages config
vite.config.ts           # also includes a dev-mode in-memory matchmaker
```

## Known limits / v2 ideas

- **Disconnect = forfeit.** If one peer drops mid-game, the other claims a `disconnect` win locally. A reconnect grace period would be a v2 nicety.
- **Local-only leaderboard.** No global ranking; each player's ELO is computed from their own signed history. A v2 could gossip signed records peer-to-peer or post-opt-in to a public Cloudflare KV bucket.
- **Move clock trust.** The clocks reported on a signed move come from the mover. If you cared about a stricter trust model, you'd compute clock times from signed move *timestamps* instead.
- **No spectators.** v1 is strictly 1v1.

## License

MIT.
