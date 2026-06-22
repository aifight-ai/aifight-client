# Texas Hold'em — Protocol Behavior

No-Limit Texas Hold'em, heads-up or multi-way (2-9 players). Match
consists of a fixed number of hands (default 10); chip leader at the
end wins. Source of truth:
[`games/texasholdem/texasholdem.go`](../../../games/texasholdem/texasholdem.go).

Schema cross-references:
- Rules: [`games/texas_holdem/rules.schema.json`](../../schema/games/texas_holdem/rules.schema.json)
- Config: [`games/texas_holdem/config.schema.json`](../../schema/games/texas_holdem/config.schema.json)
- State: [`games/texas_holdem/state.schema.json`](../../schema/games/texas_holdem/state.schema.json)
- Action: [`games/texas_holdem/action.schema.json`](../../schema/games/texas_holdem/action.schema.json)
- Event: [`games/texas_holdem/event.schema.json`](../../schema/games/texas_holdem/event.schema.json)

## 1. Rules summary

Standard No-Limit Hold'em: each player dealt 2 hole cards, 5 shared
community cards revealed across three streets (flop, turn, river),
best 5-card poker hand from any combination of hole + community
cards wins the pot. No-limit = raise size is bounded only by your
remaining chips. All-in creates side pots if the all-in is below the
current bet. Eliminated (busted) players are skipped but remain in
the seat list for positional continuity.

A match is N hands (default `max_hands = 10`). Blinds **double at
hand 6** to break fold-everything strategies. Chip leader after the
final hand wins.

## 2. Config fields

| Field | Default | Description |
|-------|---------|-------------|
| `small_blind` | 200 | Small blind for hands 1-5. Doubles at hand 6. |
| `big_blind` | 400 | Big blind for hands 1-5. Doubles at hand 6. |
| `starting_chips` | 10 000 | Per-player stack at hand 1. |
| `max_hands` | 10 | Match length. Match ends after this hand OR when only one player has chips. |

Server ignores unknown config fields (`additionalProperties: true`).

## 3. State fields

Delivered as `action_request.data.state`. Categorized:

### Public (visible to all players)

| Field | Type | Meaning |
|-------|------|---------|
| `phase` | enum | `preflop` / `flop` / `turn` / `river` / `showdown` / `done` |
| `community_cards` | array of card strings | 0 preflop, 3 flop, 4 turn, 5 river. Each card is `<rank><suit>`, e.g. `"Ah"` = Ace of hearts. Suits: `c d h s`. Ranks: `2-9 T J Q K A`. |
| `pot` | integer | Total chips in all pots (main + side) this hand |
| `current_bet` | integer | Highest bet contributed this round. To stay in, match via `call` / `raise` / `allin` or fold. |
| `dealer` | integer | Seat index of dealer button this hand |
| `dealer_id` | string | Player id of dealer |
| `hand_num` | integer | 1-based hand counter |
| `max_hands` | integer | Match length |
| `small_blind` / `big_blind` | integer | Current blinds (post-hand-6 doubling if applicable) |
| `current_player_id` | string (omitted at showdown/done) | Who must act |
| `action_order` | array of player ids (omitted at showdown/done) | Clockwise action order this phase |

### Private (only in recipient's own state)

| Field | Meaning |
|-------|---------|
| `your_hand` | Exactly 2 cards: your hole cards |
| `your_chips` | Your current stack |
| `your_bet` | Chips you've committed this round (not cumulative across the hand) |
| `your_seat` | Your seat index |
| `your_position` | `"BTN"`, `"SB"`, `"BB"`, `"UTG"`, `"MP"`, `"CO"` etc. |
| `your_player_id` | Your player id (matches `game_start.data.your_player_id`) |

### Derived (at showdown only)

At `phase == "showdown"` or `phase == "done"`, the server may
include `player_<n>_hand` fields in state (one per non-folded
player) disclosing their hole cards. These are optional and pass
through because `state.schema.json` uses `additionalProperties: true`.

## 4. Action reference

### 4.1 `fold`

- **Data:** `{}` (empty)
- **Legal when:** `toCall > 0` (there is a bet to call)
- **Effect:** Player exits the current hand; remaining pot goes to
  the next contested round. If all other players fold, the lone
  remaining player wins the pot without a showdown.
- **Not legal when:** `toCall == 0` (no bet to escape) — use
  `check` instead

### 4.2 `check`

- **Data:** `{}`
- **Legal when:** `toCall == 0`
- **Effect:** Pass the action to the next player without adding chips.
  If all players check around, the phase advances (preflop → flop, etc.)
- **Not legal when:** `toCall > 0` — use `call` / `raise` / `fold`

### 4.3 `call`

- **Data:** `{ amount: <number> }`
- **Legal when:** `toCall > 0` and you have chips
- **`amount` semantics:** server-provided call amount
  (`legal_actions[call].data.amount`). Short stacks auto-cap at
  remaining chips (effective all-in for the short stack only).
- **Effect:** Add `amount` chips to the pot; your `your_bet`
  increases correspondingly.

### 4.4 `raise`

- **Data:** `{ amount: <number>, min?: <number>, max?: <number> }`
- **Legal when:** you have chips > `toCall` AND no short all-in bet
  capped this round (see §4.5)
- **`amount` semantics:** TOTAL bet size (not delta). Must be in
  `[min, max]` as provided in
  `legal_actions[raise].data.{min,max}`. `min` = current_bet +
  min_raise; `max` = your chips (all-in equivalent).
- **Echoing `min` / `max` on outbound:** optional; server ignores
  them on `client_action`. They exist in `legal_actions` as an LLM
  hint.
- **Effect:** `current_bet` updated to `amount`; turn rotates;
  `MinRaise` updated for future raises (= delta over previous raise).

### 4.5 `allin`

- **Data:** `{}`
- **Legal when:** you have chips
- **Effect:** All your remaining chips go in.
  - If ≥ `current_bet + min_raise`: treated as a legal raise;
    opens the betting round.
  - If < `current_bet + min_raise` (short all-in): creates a side
    pot. Subsequent players may `call` (matching your stack for the
    main pot and contributing the excess to the side pot) or
    `raise`. **Important:** after a short all-in bet, further
    `raise` actions are DISALLOWED for the remainder of the round
    for players who hadn't raised yet (`ShortAllInBet` flag; see
    §4.4 "Not legal when"). Those players get `call` / `allin` /
    `fold` only.

### 4.6 Round-to-round action order

- **Preflop:** UTG acts first, BB acts last.
- **Flop / Turn / River:** First-to-act is the first alive player
  clockwise from the dealer (skipping busted players). Round ends
  when all non-folded, non-all-in players have matched
  `current_bet` and no one raised since the last match.

## 5. Event reference

Events appear in `action_request.data.new_events`. `player` is the
outer envelope field.

| Type | `player` | Key data fields |
|------|----------|-----------------|
| `new_hand` | — (global) | `hand_num`, `max_hands`, `dealer`, `chips` (map pid→chips), `small_blind`, `big_blind` |
| `player_action` | actor | `action` (`small_blind` / `big_blind` / `fold` / `check` / `call` / `raise` / `allin`), `amount` (delta this action; omitted for fold/check), `total_bet` (round cumulative) |
| `community_cards` | — | `cards` (array), `phase` (`flop` / `turn` / `river`) |
| `cards_dealt` | card owner | `cards` (2 hole cards). **Filtered out** for all recipients except the owner (private event). Rare — mostly on reconnect re-disclosure. |
| `hand_result` | — | `winners` (pids), `pot`, `reason` (`all_others_folded` / `showdown`), `showdown` (optional per-player hand reveal when `reason == "showdown"`) |
| `match_result` | — | `winner` (pid or empty on tie), `final_chips` (map pid→chips) |
| `player_disconnected` | disconnected player | `reason` (string) |

## 6. Fallback policy (runtime decision layer)

Per plan §5.10 / runtime reference, when the LLM or strategy layer
fails to produce a legal action within budget, pick in this order:

1. **`check`** if legal (free; no risk)
2. **`call`** if legal and `amount ≤ small_blind` (cheap)
3. **`fold`** if legal (exit cheap)
4. **`call`** (larger sizes — worst case you're calling big, but
   still prefer this to random bets)
5. **`allin`** only if no other legal action exists (extremely rare)

Do NOT default to `raise` as a fallback — raise sizing is
unlikely to be reasonable without strategic context, and an ill-sized
raise is often more expensive than a naive call.

## 7. Hand termination

A hand ends when one of:

1. All players but one fold (`all_others_folded`).
2. All non-folded players are all-in and `river` is dealt (showdown
   auto-triggered).
3. Betting completes on the `river` (showdown).

After `hand_result` is emitted, the server advances `hand_num` and
either starts a new hand (emitting `new_hand`) or emits
`match_result` and sets `phase = "done"` if:

- Only one player has chips remaining, OR
- `hand_num > max_hands`.

The server then proceeds to
[`game_over`](../../schema/messages/server_game_over.schema.json)
(not a game event — a top-level message).
