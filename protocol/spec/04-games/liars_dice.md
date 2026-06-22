# Liar's Dice — Protocol Behavior

Liar's Dice: 2-6 players, each starts with 5 hidden dice.
Players take turns making monotonically-increasing bids on the total
count of a face value across all alive players' dice. Challenging
(`"Liar!"`) reveals all dice; loser of the resolution drops a die.
Last player with dice remaining wins. Source of truth:
[`games/liarsdice/liarsdice.go`](../../../games/liarsdice/liarsdice.go).

Schema cross-references:
- Rules: [`games/liars_dice/rules.schema.json`](../../schema/games/liars_dice/rules.schema.json)
- State: [`games/liars_dice/state.schema.json`](../../schema/games/liars_dice/state.schema.json)
- Action: [`games/liars_dice/action.schema.json`](../../schema/games/liars_dice/action.schema.json)
- Event: [`games/liars_dice/event.schema.json`](../../schema/games/liars_dice/event.schema.json)

## 1. Rules summary

Each player's dice are hidden from opponents. On your turn, either:

- **Bid** a `(quantity, face)` claim that at least `quantity` dice
  across the combined alive players' dice show `face` (or are wild
  ones — see below). Each bid must strictly beat the previous.
- **Challenge** (`"Liar!"`) — all alive players reveal their dice.
  If the bid count is met or exceeded, the challenger drops a die;
  otherwise the last bidder drops a die. Dropping to zero dice
  eliminates the player. The losing player starts the next round's
  bidding.

**Wild rule:** face value `1` is wild by default — counts as any
face when resolving a challenge. **Exception:** if the bid itself is
on `face == 1`, then only actual `1`s count (no wilds). This
asymmetry is built into challenge resolution server-side; the
protocol does not expose separate "with-wild" vs "without-wild"
enums.

Last player with ≥1 die wins the match.

## 2. Config

Liar's Dice ignores `game_start.data.config` — dice count per player
(5) and face range (1-6) are server-hardcoded. The `config` field is
still present in `game_start` for shape uniformity; it is always an
empty object. There is **no** `config.schema.json` for this game.

## 3. State fields

Delivered as `action_request.data.state`.

### Public

| Field | Type | Meaning |
|-------|------|---------|
| `phase` | enum | `bidding` (active) or `done` (match over) |
| `round` | integer ≥1 | 1-based round counter; increments after each challenge that does not end the match |
| `current_bid` | object (omitted at start of round) | `{ quantity, face, bidder }` — the bid to beat |
| `current_turn` | string (omitted at done) | Player id to act |
| `total_dice` | integer ≥0 (omitted at done) | Sum of dice_count over alive players. Upper bound for any bid quantity. |

### Private

| Field | Meaning |
|-------|---------|
| `your_dice` | Array of your face values (1-6). Length = `your_dice_count`. Rolled fresh each round. |
| `your_dice_count` | 0-5. Decrements on challenge loss. |

### Per-player (in `PlayerView.players[i].data`)

| Field | Public? | Meaning |
|-------|---------|---------|
| `dice_count` | yes | Each player's remaining dice count — public so others can reason about bid quantity bounds |
| `dice` | **only in recipient's own entry** | The recipient's own face values (mirror of `your_dice`) |

### Done

| Field | Meaning |
|-------|---------|
| `winner` | Player id of match winner; omitted if no winner (simultaneous elimination) |

## 4. Action reference

### 4.1 `bid`

- **Data:** `{ quantity: <integer ≥1>, face: <integer 1-6> }`
- **Legal when:** always on your turn. The server enforces:
  - `face ∈ [1, 6]`
  - `quantity ≥ 1`
  - `quantity ≤ total_dice` (can't bid more than exist)
  - **Strictly higher** than `current_bid` (if set): either
    `(quantity > current_bid.quantity)` OR
    `(quantity == current_bid.quantity AND face > current_bid.face)`
- **Effect:** Becomes the new `current_bid`; turn advances to the
  next alive player; no die changes hands.

### 4.2 `challenge`

- **Data:** `{}`
- **Legal when:** `current_bid` is set (cannot challenge a fresh
  round's starter slot)
- **Effect:** Server reveals all alive players' dice, counts matching
  face values (with wild rule applied per §1), and:
  - If `actual_count ≥ current_bid.quantity`: bid held, challenger
    drops a die
  - Else: bid failed, bidder drops a die
  - The loser starts the next round's bidding (if not eliminated)
  - Dice are re-rolled for all alive players; new round begins unless
    `≤ 1` alive players remain (then `phase = done`)

## 5. Event reference

| Type | `player` | Key data fields |
|------|----------|-----------------|
| `bid` | bidder | `quantity`, `face` |
| `challenge` | challenger | `challenger`, `bidder`, `bid_quantity`, `bid_face`, `actual_count`, `bid_met` (bool), `all_dice` (map pid→[faces] for all alive players), `loser` |
| `player_eliminated` | eliminated player | `player` |
| `round_start` | — (global) | `round` (≥2), `dice_counts` (map pid→count for alive players). Emitted after challenge resolves AND match continues, OR after a drop-induced reset. |
| `game_over` | — | `winner` (pid or empty) |
| `player_disconnected` | disconnected player | `player` |

The `challenge` event **publicly reveals every alive player's
dice** via `all_dice`. This is intrinsic to the game mechanic and
cannot be filtered.

## 6. Fallback policy

If the LLM / strategy can't decide:

1. If `current_bid` exists and `bid_quantity > total_dice / 2`,
   **`challenge`** — aggressive bids are often bluffs once the total
   exceeds expected count (expected ≈ `total_dice × (1 + 1/6) / 6`
   with one-wild = `total_dice × 7/36 ≈ total_dice × 0.194`; a bid
   above half the pool is statistically unlikely).
2. Otherwise, **minimum legal `bid`**: same quantity as current and
   `face = current_face + 1` (if `face < 6`); else bump quantity by
   1 and reset `face = 1`. First bid of a round: `{ quantity: 1,
   face: your_most_common_face }`.

Do NOT default to challenging early bids — an early challenge almost
always fails (`actual_count ≥ quantity=1` is near-certain).

## 7. Match termination

The match ends when one of:

1. Only one player remains alive (`game_over.winner` = that player).
2. Simultaneous elimination leaves zero alive players —
   degenerate and rare (`game_over.winner` is empty string).

After `game_over` event the server sets `phase = "done"` and
proceeds to the top-level
[`game_over` message](../../schema/messages/server_game_over.schema.json).
