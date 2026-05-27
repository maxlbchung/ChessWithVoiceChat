# Heroes

Each side in Hero mode picks a "hero king" with a unique ability. Pieces and the king move normally; the hero ability is an *extra* action you can fire on your turn instead of making a board move (one ply, same time clock). Some are active with cooldowns, one is one-shot, one is passive.

Source of truth: `HERO_INFO` in `src/lib/heroChess.ts`.

## At a glance

| Hero          | Cooldown        | What it does                                              |
| ------------- | --------------- | --------------------------------------------------------- |
| **Frost**       | 2 turns         | Freeze a piece — can't move, can't be captured            |
| **Warlord**     | 1 turn          | Kill an adjacent enemy without moving your king. Starts with an extra rank of pawns and no queen |
| **Necromancer** | 5 turns         | Spawn a pawn next to your king                            |
| **Flight**      | 5 turns         | Teleport your king to any safe empty square               |
| **Harem**       | *passive*       | Your bishops + rooks start as queens                      |
| **Mutation**    | 5 turns         | Starts with bishops instead of knights; mutate B/R/Q to also move like a knight |
| **ICBM**        | 10-turn warmup, then none | Drop a bomb that lands in 5 plies and demolishes a square |
| **Goofball**    | 3 turns         | Force the opponent to make a legal move on their next ply |
| **Twin-Jitsu**  | 3 turns         | All your pieces look like kings to the opponent until they move. Active swaps two of your pieces and re-masks both. |

> A "turn" means one of *your own* moves. Under the hood the engine stores cooldowns in plies (`turns × 2`).

## Detail

### Frost — `#2b6fb0`
- **Active**, 2-turn cooldown.
- Freezes the target piece for 2 of the opponent's moves: they can't capture it and they can't move it. The freeze visualises as a snowflake overlay on the square.
- Cannot target kings or an already-frozen piece.
- The freeze expires when control returns to you after the opponent's second move.
- **Does not stop ICBM landings** — explosions clear frozen pieces just like everything else.

### Warlord — `#c41e1e`
- **Active**, 1-turn cooldown.
- **Starts the game with an extra rank of pawns and no queen** — the back rank is `R N B . K B N R` (the queen slot is empty), and there's a second row of pawns in front of the standard pawn line.
- Destroys one enemy piece adjacent to your king. Your king does not move.
- Can't target enemy kings.
- Useful for clearing checks and exposed back-rank pressure without committing the king.

### Necromancer — `#9b4dca`
- **Active**, 5-turn cooldown.
- Spawns one of your own pawns on an empty square adjacent to your king.
- Spawn square must be empty.
- The spawned pawn moves and promotes normally from wherever it lands. A pawn spawned on its home rank still has its initial double-step option; a pawn spawned on the 7th/8th rank can promote on its next move.

### Flight — `#87ceeb`
- **Active**, 5-turn cooldown.
- Moves your king to any unoccupied square that is **not currently attacked** by the opponent.
- The king's castling rights for both sides are forfeited when Flight fires.

### Harem — `#ff4fa3`
- **Passive** — no firable ability.
- All bishops and rooks start as queens. Castling rights are unchanged (the "rooks" still count for castling even though they render as queens).
- Picker UI labels this hero as `passive` rather than offering a cooldown.

### Mutation — `#3aa66b`
- **Active**, 5-turn cooldown.
- **Starts the game with bishops in place of both knights** — the back rank is `R B B Q K B B R`. The hero ability can then mutate any of those bishops (or rooks/queen) into knight-movement-fused pieces over the course of the game.
- Mutates your bishop / rook / queen to also move like a knight, producing the merge-chess fused glyphs:
  - **B → A** (bishop + knight, "archbishop")
  - **R → C** (rook + knight, "chancellor")
  - **Q → Z** (queen + knight, "amazon")
- Cannot target knights, pawns, kings, or already-fused pieces.
- A mutated rook **loses its castling right** because the castle code only recognises a plain `R` on the corner.
- While Mutation is active, your pawn promotions can also fuse with a knight: pawn promotion options expand to `Q / R / B / N / Z / C / A`.

### ICBM — `#ff6a00`
- **Active**. **10-turn warmup** to arm the weapons before the first launch, then no cooldown between launches — fire on every turn after that.
- Targets any square (yours, theirs, or empty). On fire, a missile is queued with `landsAtPly = state.ply + 5`.
- Lands exactly 5 plies later — demolishes whatever piece is on the target square at that moment (including kings; a destroyed king ends the game as a checkmate-style loss for the king's owner).
- **Bypasses Frost** — frozen pieces explode like any other.
- Both players see the in-flight crosshair + countdown number on the target square. The opponent can move a piece into or out of the target square; whatever's there when the timer hits 0 is what gets destroyed.
- UI:
  - **Real crosshair** for in-flight missiles: a circle ring with `+` ticks (white) or `X` ticks reaching the tile corners (black), plus the plies-remaining number in the centre.
  - **Ghost crosshair** previews the impact square while the ability is armed (no number).
  - Firing plays the launch SFX (two electronic beeps + ascending whistle). Landing plays the descending whistle + earthquake explosion, with the doomed piece visible through the half-second whistle window before it vanishes.

### Goofball — `#f7d000`
- **Active**, 3-turn cooldown.
- Two-click ability: first click picks an **enemy** piece, second click picks a legal destination *from that enemy's perspective*. The forced move is then applied as the opponent's move.
- Cannot pick an enemy piece with no legal moves.
- Cannot pick a destination that would leave you (the Goofball user) in check after the forced opponent move — the engine filters those out.
- Promotion: if the forced move is a pawn promotion, the engine accepts a promotion letter in the ability UCI; the UI prompts for it.

### Twin-Jitsu — `#bda0ff`
- **Passive + active**.
- **Passive — mask**: at game start, every one of your pieces (including pawns) renders as a king icon on the opponent's screen. The opponent has no way to tell the real king from the decoys until each piece reveals. A piece reveals the moment it moves (or is captured); the king reveals when it moves too. From your own screen, masked pieces render normally with a translucent king ghost overlaid so you remember which are still hidden.
- **Engine note**: the masking is purely visual on the opponent's side, *plus* check announcements are suppressed for the opponent — they're never told when they put your king in check. The engine still enforces legality normally; they just have to figure out which of the king icons is the actual king on their own.
- **Active — swap**, 3-turn cooldown. Two-click ability: first click picks one of your own pieces, second click picks the swap partner. At least one of the two endpoints must still be masked (or be the real king); a swap between two already-revealed non-king pieces is rejected.
- After the swap **both** endpoints are re-masked — even a previously-revealed piece becomes hidden again. Doesn't reveal identity.
- Cannot leave you in check after the swap (engine filters illegal pairs).
- The swap forfeits castling rights as if the involved pieces had moved (kings → both sides; rook on its home corner → that wing).
