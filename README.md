# VCC

Five flavors of chess, played peer-to-peer with optional voice chat. Moves and audio travel directly between browsers over WebRTC. Identity is a local Ed25519 keypair, ratings are computed from cryptographically-signed game records stored in your browser, and the only piece of central infrastructure is a tiny Cloudflare-hosted matchmaker that pairs two peers and then steps out of the way.

## Game modes

VCC ships with five variants. Each one is playable solo in free-play (with full history scrubbing and branching) or online via the matchmaker. Every mode has the same three time controls: **5 min**, **10 min**, and **+1 min / move**.

| Mode | What's different |
| --- | --- |
| **Normal** | Standard chess. chess.js for rules. |
| **Merge** | Capture your own R/B/N/Q to fuse — combined pieces inherit both movement patterns. Kings and pawns can't merge. |
| **Two** | A back-rank rethink: Queen moves 1 square like a king, Bishop slides 1–2 squares diagonally, Knight jumps over an adjacent piece, Rook can push a friendly chain orthogonally. Pawn/King are standard. No castling. |
| **Cash Money** | Start with 8 pawns + a king (no queen). Earn 1 gold per turn and buy upgrades — Knight 3g, Bishop 3g, Rook 5g, Queen 9g. Multi-queen is legal. No castling. |
| **Hero** | Standard chess plus your king has an ability. Pick one of four at game start: **Frost** (freeze any enemy piece, 5-turn cooldown) · **Knight** (destroy an adjacent enemy, 10-turn cooldown) · **Necromancer** (spawn a pawn adjacent, 10-turn cooldown) · **Flight** (one-shot teleport). |

## What's decentralized here

| Piece | How |
| --- | --- |
| **Identity** | Ed25519 keypair generated in your browser, stored in IndexedDB. Exportable as a string. No accounts, no email, no password. |
| **Move transport** | Direct WebRTC data channel between the two players. No server sees the moves. |
| **Voice chat** | WebRTC audio track on the same peer connection. No server sees the audio. |
| **Game records** | Each move is signed by the mover. Final game records are signed by both players. Stored locally. |
| **Rating** | Computed locally from your signed game history (standard ELO, K=32 → 24 after 30 games). |
| **Matchmaking** | The one piece that needs *some* server: a Cloudflare Worker (Durable Object) pairs two peers in the same time-control queue. It only sees peer IDs and public keys — never moves, audio, or game results. |

> **Trust model in plain words:** if you trust your opponent's signed move records, you can verify everything they claim happened. The matchmaker can't lie about game results because it never sees them. The TURN server (when needed for NAT traversal) sees encrypted DTLS-SRTP packets, not plaintext audio.

## Features

- ♟️ Five variants — Normal, Merge, Two, Cash Money, Hero
- 🎲 Free-play mode for every variant — scrub the move history, branch new lines, try anything against yourself
- ⏱️ Three time controls per variant — 5 min, 10 min, +1 min / move (with tenths-of-a-second display under 10s)
- 🎯 Local ELO ratings (K=32 < 30 games, K=24 after)
- 🔍 Matchmaking queue per (variant × time-control) combo
- 🎙️ Voice chat (WebRTC audio, ride-along on the same peer connection)
- 💬 In-game text chat
- ↻ Rematch handshake across all online modes
- 🟩 Last-move highlight, low-time clock warning, hero glow on king pieces
- ✍️ Ed25519 move signing + signature verification over canonical move payload
- 🪪 Self-sovereign identity, exportable across devices
- 📜 Local game history with signed game records

## Quick start

```bash
npm install
npm run dev          # local dev with in-memory matchmaker
```

Open in two browser tabs (or two devices on the same network), pick the same mode + time control on both, hit **Play**. Allow mic permission when the voice button is clicked. Or click **Free play** and play either color yourself.

## Build & deploy

The front end is a static Vite build hosted on **Cloudflare Pages**; the matchmaker is a separate **Cloudflare Worker** with a Durable Object.

```bash
npm run deploy          # builds and pushes the front end to Pages (project: chess-vc)
npm run deploy:worker   # deploys the matchmaker Worker (worker/wrangler.toml)
```

### TURN (cross-NAT relay)

Production uses **Cloudflare Realtime TURN**. The matchmaker Worker mints short-lived (24h) ICE credentials via the CF TURN API; the browser fetches them at session start. No long-lived TURN secret ships in the client bundle.

```bash
# 1. Create a TURN token in the Cloudflare dashboard:
#    Cloudflare Realtime → TURN → Create TURN Token
#    Copy the Token ID and the API token.

# 2. Bind them as Worker secrets:
npx wrangler secret put TURN_KEY_ID --config worker/wrangler.toml
npx wrangler secret put TURN_KEY_API_TOKEN --config worker/wrangler.toml

# 3. Redeploy the worker:
npm run deploy:worker
```

### Self-host coturn (optional fallback)

If you'd rather not use Cloudflare TURN, ship static credentials via env:

```
VITE_TURN_URL="turn:your-turn.example.com:3478"
VITE_TURN_USER="user"
VITE_TURN_PASS="pass"
```

Used only when the Worker's TURN endpoint isn't reachable.

```yaml
# docker-compose.yml example
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

## Project layout

```
src/
  lib/
    identity.ts          # keypair, sign, verify
    timeControls.ts      # variant × time-control matrix
    elo.ts               # ELO math
    peer.ts              # PeerJS / WebRTC session
    voice.ts             # getUserMedia helpers
    matchmaking.ts       # client for the Worker queue
    iceConfig.ts         # fetches ephemeral TURN credentials
    gameRecord.ts        # canonical signing format
    storage.ts           # IndexedDB for rating + history
    mergeChess.ts        # Merge variant engine
    chess2.ts            # Two variant engine
    cashChess.ts         # Cash Money variant engine + economy
    heroChess.ts         # Hero variant engine + abilities
  components/
    MergeBoard.tsx       # custom board — drag/drop, highlights, ability anims
    CashShop.tsx         # shop UI for Cash Money
    HeroAbilities.tsx    # ability buttons + cooldown display
    Clock.tsx, TimeModeSelector.tsx, VoiceControls.tsx, Layout.tsx, ...
  pages/
    Home.tsx             # lobby + free play (all variants)
    GameRoute.tsx        # dispatches to the right Game* page per variant
    Game.tsx, MergeGame.tsx, TwoGame.tsx, CashGame.tsx, HeroGame.tsx
    Join.tsx, Profile.tsx, Settings.tsx
  store/                 # zustand identity store + lobby handoff
worker/
  src/index.ts           # matchmaker Worker (Durable Object) + TURN minter
  wrangler.toml          # Worker config
vite.config.ts           # dev-mode in-memory matchmaker plugin
```

The board component (`MergeBoard`) is custom-built — `react-chessboard` was dropped so all five variants could share one render path that supports drag-drop, last-move highlights, frozen-piece overlays (Hero/Frost), and ability animations.

## Known limits / v2 ideas

- **Disconnect = forfeit.** If one peer drops mid-game, the other claims a `disconnect` win locally. A reconnect grace period would be a v2 nicety.
- **Local-only leaderboard.** No global ranking; each player's ELO is computed from their own signed history. A v2 could gossip signed records peer-to-peer or post opt-in to a public Cloudflare KV bucket.
- **Move clock trust.** Clocks reported on a signed move come from the mover. A stricter trust model would derive clock times from signed move *timestamps* on both ends.
- **No spectators.** v1 is strictly 1v1.

## License

TBD — see the discussion in [LICENSE](LICENSE) once it's added. The intent is **non-commercial**: source-available so anyone can fork, learn, and self-host, but the custom modes (Merge, Two, Cash Money, Hero) shouldn't be lifted and monetized. Game *rules* aren't copyrightable, but the implementation and assets are.
