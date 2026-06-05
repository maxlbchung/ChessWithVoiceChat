# Heroes

Each side in Hero mode picks a "hero king" with a unique ability. Pieces and the king move normally; the hero ability is an *extra* action you can fire on your turn instead of making a board move (one ply, same time clock). Most are active with cooldowns, one is passive.

Source of truth: `HERO_INFO` in `src/lib/heroChess.ts`.

## At a glance

| Hero          | Cooldown        | What it does                                              |
| ------------- | --------------- | --------------------------------------------------------- |
| **Frost**       | 2 turns         | Freeze a piece — can't move, can't be captured            |
| **Warlord**     | 1 turn          | Kill an adjacent enemy without moving your king. Starts with an extra rank of pawns and no queen |
| **Necromancer** | 3 turns         | Spawn a pawn next to your king                            |
| **Flight**      | 5 turns         | Fly any of your pieces to any empty square                |
| **Harem**       | *passive*       | Your bishops + rooks start as queens                      |
| **Mutation**    | 5 turns         | Starts with bishops instead of knights; mutate B/R/Q to also move like a knight |
| **ICBM**        | 10-turn warmup, then none | Drop a bomb that lands in 5 plies and demolishes a square |
| **Goofball**    | *none*          | Force the opponent to make a legal move on their next ply |
| **Twin-Jutsu**  | 3 turns         | All your pieces look like kings to the opponent until they move. Back rank starts shuffled (opposite-color bishops; no castling). Active swaps two of your pieces and re-masks both. |
| **Slime**       | 10 turns        | Only pawns (3rd rank) + a 2×2 big king that slides one square and crushes what it lands on. Capturing a tile splits it into 3 mini kings; uncheckable until a single king remains. Active regrows a mini into a big king. |
| **Juggernaut**  | 3 turns         | A lone colorless king with three lives. Capturing it kills the attacker and tiers it up (king → knight → queen movement, new ability per tier); uncheckable until tier 3, where the next hit fells it. |

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
- **Active**, 3-turn cooldown.
- Spawns one of your own pawns on an empty square adjacent to your king.
- Spawn square must be empty.
- The spawned pawn moves and promotes normally from wherever it lands. A pawn spawned on its home rank still has its initial double-step option; a pawn spawned on the 7th/8th rank can promote on its next move.

### Flight — `#87ceeb`
- **Active**, 5-turn cooldown.
- Two-click ability: first click picks **any of your pieces**, second click flies it to **any unoccupied square**.
- Cannot leave you in check after the teleport (engine filters those destinations — which also means the king can't fly onto an attacked square).
- A **pawn flown to its back rank promotes** — the UI prompts for the piece (free play auto-queens).
- Castling rights are forfeited as if the flyer had moved normally: flying the king loses both wings; flying a rook off its home corner loses that wing.

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
- **Active**, no cooldown.
- Two-click ability: first click picks an **enemy** piece, second click picks a legal destination *from that enemy's perspective*. The forced move is then applied as the opponent's move.
- Cannot pick an enemy piece with no legal moves.
- Cannot pick a destination that would leave you (the Goofball user) in check after the forced opponent move — the engine filters those out.
- Promotion: if the forced move is a pawn promotion, the engine accepts a promotion letter in the ability UCI; the UI prompts for it.

### Slime — `#7ed957`
- **Active**, 10-turn cooldown, plus heavy passives.
- **Starting army**: only 8 pawns — on the **3rd rank** (6th for black, no double-step from there) — and a **2×2 big king** of blob tiles (`S`) on d1/e1/d2/e2 (d8/e8/d7/e7 for black). No other pieces, no castling.
- **Big king movement**: the whole 2×2 blob slides **one square in any direction**, crushing every enemy piece on the squares it enters (up to 2 orthogonally / 3 diagonally). Own pieces and frozen pieces block the slide. Because it crushes, the blob *gives check* to adjacent enemy kings — but only in directions it could actually slide.
- **Split**: when any blob tile is captured (by a move, a crush, or an ICBM blast), the blob bursts — the three surviving tiles become **normal mini kings**. The minis move and capture like kings.
- **Multi-king check immunity**: while a Slime side has more than one king square (blob tiles + minis combined), it **cannot be checked** — its kings are simply capturable pieces. Normal check/checkmate rules resume once it's down to a single king. Losing the last king square (e.g. to a missile or a double-crush) loses the game.
- **Active — expand**, 10-turn cooldown. Two-click: pick a mini king, then the diagonal corner of an empty 2×2 quadrant — the mini grows back into a big king there. The three new squares must be empty and on the board. Expanding while in check is legal (the blob is uncheckable). Splitting then re-expanding is how the slime multiplies.
- Blob tiles can't be frozen (Frost), carved (Warlord), or flown; they serialize as `S`/`s` in FEN with a trailing blob-groups token.

### Juggernaut — `#b08d57`
- **Active**, 3-turn cooldown, plus heavy passives. Plays a deep-earthquake SFX on every ability use and tier-up.
- **Starting army**: nothing but a **lone, colorless king** (the Juggernaut) on e1/e8 — no pawns, no pieces, no castling. It renders as a stone-grey king with three tier pips under it.
- **Three lives — capture attempts feed it**: capturing the Juggernaut at tier 1 or 2 **kills the attacker instead** — the Juggernaut keeps its square and **rises a tier**. An ICBM blast counts as a capture attempt too (tier +1, square not cleared). At **tier 3 a capture finally lands**: the Juggernaut dies and its side loses. A Slime blob can't crush a sub-tier-3 Juggernaut (the slide is blocked).
- **The enemy king can never suicide into it**: a king capturing a sub-tier-3 Juggernaut would die with it, so the move is illegal — same as moving into check. (A multi-king Slime side may legally spend a spare king.) An undefended **tier-3** Juggernaut can be captured by the king normally.
- **Check immunity until tier 3**: at tiers 1-2 the Juggernaut cannot be checked — it walks through attacked squares freely (the check *sound* still plays as a flavor cue). At tier 3, normal check/checkmate rules switch on: the opponent can now mate it, or land the killing capture.
- **Tier kits** (movement passive + active ability, `!J<sq>`):
  - **Tier 1 — moves like a king. Convert**: turn an enemy piece (not a king / blob tile) adjacent to the Juggernaut to your side. This is how the lone king builds an army.
  - **Tier 2 — moves like a knight. Quake Leap**: jump like a knight (capturing what you land on); every piece — both sides' — within a 2-tile radius of the landing is **stunned** for one turn each. Stunned pieces can't move and don't attack, but unlike frozen pieces they CAN be captured.
  - **Tier 3 — moves like a queen. Rampage**: charge left or right along the rank to the board edge, **destroying every piece in the path** (both sides', frozen included — like ICBM it ignores Frost). A flattened king ends the game on the spot.
- The Juggernaut *gives* check with its current movement pattern (adjacent at tier 1, knight squares at tier 2, queen lines at tier 3) — a tier-1 Juggernaut standing next to the enemy king is real check, and since the king can't capture it, the only outs are escaping or sacrificing a piece into it (which powers it up and breaks the adjacency check).
- Serialization: the tier rides the hero FEN token (`juggernaut:<cd>:<flight>:<tier>`); stunned squares get a trailing `idx:expiry` token.

### Twin-Jutsu — `#bda0ff`
- **Passive + active**.
- **Passive — mask**: at game start, every one of your pieces (including pawns) renders as a king icon on the opponent's screen. The opponent has no way to tell the real king from the decoys until each piece reveals. A piece reveals the moment it moves (or is captured); the king reveals when it moves too. From your own screen, masked pieces render normally with a translucent king ghost overlaid so you remember which are still hidden.
- **Passive — shuffled start**: your back rank starts in a random arrangement (bishops constrained to opposite square colors, Chess960-style) so the standard setup can't give your masked pieces away by their starting squares. A shuffled side cannot castle. Online games derive the shuffle deterministically from the shared gameId, so both peers build the identical board; replays store the arrangement on the record.
- **Engine note**: the masking is purely visual on the opponent's side, *plus* check announcements are suppressed for the opponent — they're never told when they put your king in check. The engine still enforces legality normally; they just have to figure out which of the king icons is the actual king on their own.
- **Active — swap**, 3-turn cooldown. Two-click ability: first click picks one of your own pieces, second click picks the swap partner. At least one of the two endpoints must still be masked (or be the real king); a swap between two already-revealed non-king pieces is rejected.
- After the swap **both** endpoints are re-masked — even a previously-revealed piece becomes hidden again. Doesn't reveal identity.
- Cannot leave you in check after the swap (engine filters illegal pairs).
- The swap forfeits castling rights as if the involved pieces had moved (kings → both sides; rook on its home corner → that wing).
