# Voice Chat Chess

Five flavors of chess, played peer-to-peer with optional voice chat. Moves and audio travel directly between browsers over WebRTC. Identity is a local Ed25519 keypair, ratings are computed from cryptographically-signed game records stored in your browser, and the central infrastructure is kept minimal: a small Cloudflare Worker that pairs peers in a queue, a TURN relay for cross-NAT voice, and the public PeerJS broker for WebRTC signaling. None of those services see your moves.

## Game modes

VCC ships with five variants. Each one is playable solo in free-play (with full history scrubbing and branching) or online via the matchmaker. Every mode has the same three time controls: **5 min**, **10 min**, and **+1 min / move**.

| Mode | What's different |
| --- | --- |
| **Normal** | Standard chess. chess.js for rules. |
| **Merge** | Capture your own R/B/N/Q to fuse — combined pieces inherit both movement patterns (chancellor = R+N, archbishop = B+N, amazon = R+B+N). Kings and pawns can't merge. |
| **Guerilla** | A back-rank rethink: Queen moves 1 square like a king · Bishop slides 1–2 squares diagonally · Knight jumps over any adjacent piece checkers-style (captures both the hopped piece and the landed-on piece) · Rook moves 1 square orthogonally and can push a friendly chain. Pawn/King are standard. No castling. |
| **Cash Money** | Start with 8 pawns + a king — no other pieces. Gain 1 gold every turn; pushing a pawn to the opposing back rank cashes it in for **+10 gold**. Buy upgrades at the shop (Knight 3g, Bishop 3g, Rook 5g, Queen 9g) — each buy replaces one of your pawns and uses your turn. Multi-queen is legal. No castling. |
| **Hero** | Standard chess plus your king has an ability, picked at game start: **Frost** (freeze a piece) · **Warlord** (destroy an enemy piece adjacent to your king) · **Necromancer** (spawn a pawn next to your king) · **Flight** (fly any of your pieces to any empty square) · **Harem** (bishops + rooks start as queens) · **Mutation** (fuse B/R/Q with knight movement) · **ICBM** (delayed-strike missile) · **Goofball** (force an opponent move) · **Twin-Jutsu** (your pieces masquerade as kings). Full rules + cooldowns in [hero.md](hero.md). No castling. |

## What's decentralized here

| Piece | How |
| --- | --- |
| **Identity** | Ed25519 keypair generated in your browser, stored in IndexedDB. Exportable as a string. No accounts, no email, no password. |
| **Move transport** | Direct WebRTC data channel between the two players. No server sees the moves. |
| **Voice chat** | WebRTC audio between the two peers (separate from the move channel, same PeerJS session). No server sees the audio — TURN, when used, only relays encrypted DTLS-SRTP. |
| **Game records** | Every move is signed by the mover and verified by the opponent on receipt. At game end each side independently saves the record signed with *its own* key only — there's no mutual sign-off exchange yet. |
| **Rating** | Computed locally from your signed game history (standard ELO, K=32 → 24 after 30 games). |
| **Matchmaking** | A Cloudflare Worker backed by a D1 (SQLite) database holds the per-time-control wait queue and emits a pairing when two peers arrive. It sees peer IDs, handles, public keys, and ratings — never moves, audio, or game results. |
| **WebRTC signaling** | Uses the public PeerJS broker (`0.peerjs.com`) to bootstrap the connection between peers. The broker sees peer IDs and SDP offers, not move payloads — once the data channel is up, the broker is out of the loop. Swappable for a self-hosted PeerJS server. |

> **Trust model in plain words:** if you trust your opponent's signed move records, you can verify everything they claim happened. The matchmaker can't lie about game results because it never sees them. The TURN server (when needed for NAT traversal) sees encrypted DTLS-SRTP packets, not plaintext audio.

## Features

- ♟️ Five variants — Normal, Merge, Two, Cash Money, Hero
- 🎲 Free-play mode for every variant — scrub the move history, branch new lines, try anything against yourself
- ⏱️ Three time controls per variant — 5 min, 10 min, +1 min / move (with tenths-of-a-second display under 10s)
- 🎯 Local ELO ratings (K=32 < 30 games, K=24 after)
- 🔍 Matchmaking queue per (variant × time-control) combo
- 🎙️ Voice chat (WebRTC audio over the same PeerJS session as the move channel)
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

The front end is a static Vite build hosted on **Cloudflare Pages**; the matchmaker is a separate **Cloudflare Worker** with a **D1 (SQLite)** database. D1 was chosen over a Durable Object so the whole stack fits on the Workers free plan.

```bash
npm run deploy          # builds and pushes the front end to Pages (project: chess-vc)
npm run deploy:worker   # deploys the matchmaker Worker (worker/wrangler.toml)
```

### First-time matchmaker setup (D1)

The Worker needs a D1 database. Run these once before the first `deploy:worker`:

```bash
npm run d1:create        # creates the chess-matchmaker D1 db; copy the printed database_id
                         # into worker/wrangler.toml under [[d1_databases]]
npm run d1:schema        # applies worker/schema.sql (waiting / matched / queue_log tables)
npm run deploy:worker    # deploy
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
  src/index.ts           # matchmaker Worker (D1-backed) + TURN credential minter
  schema.sql             # D1 schema — waiting / matched / queue_log tables
  wrangler.toml          # Worker config (D1 binding)
vite.config.ts           # dev-mode in-memory matchmaker plugin
```

The board component (`MergeBoard`) is custom-built — `react-chessboard` was dropped so all five variants could share one render path that supports drag-drop, last-move highlights, frozen-piece overlays (Hero/Frost), and ability animations.

## Known limits / v2 ideas

- **Limited reconnect window.** If a peer drops mid-game, a 5-second forfeit countdown starts; any message from them cancels it. Up to two brief disconnects per game are forgiven — the third triggers an immediate forfeit. No long-lived reconnect across page reloads yet.
- **No leaderboard, no rating sync.** Your rating and game history live only in this browser's IndexedDB. There's no global ranking and no UI for browsing other players' results. Exporting your identity moves the keypair to another device, but the history stays put. A v2 could gossip signed records peer-to-peer or surface a public, opt-in ranking from signed game records.
- **Move clock trust.** Clocks reported on a signed move come from the mover. A stricter trust model would derive clock times from signed move *timestamps* on both ends.
- **No spectators.** v1 is strictly 1v1.

## License

TBD — see the discussion in [LICENSE](LICENSE) once it's added. The intent is **non-commercial**: source-available so anyone can fork, learn, and self-host, but the custom modes (Merge, Two, Cash Money, Hero) shouldn't be lifted and monetized. Game *rules* aren't copyrightable, but the implementation and assets are.
