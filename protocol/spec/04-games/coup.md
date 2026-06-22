# Coup — Protocol Behavior

Coup: 2-6 players, each starts with 2 hidden role cards and 2 coins.
Players take turns choosing one of several actions; some claim a
role, which can be challenged. Certain actions can be blocked by
claiming other roles; those blocks can also be challenged. Losing
any challenge, or being successfully couped, forces the loser to
reveal (lose) a card. Last player with a face-down card wins.
Source of truth:
[`games/coup/coup.go`](../../../games/coup/coup.go).

Schema cross-references:
- Rules: [`games/coup/rules.schema.json`](../../schema/games/coup/rules.schema.json)
- State: [`games/coup/state.schema.json`](../../schema/games/coup/state.schema.json)
- Action: [`games/coup/action.schema.json`](../../schema/games/coup/action.schema.json)
- Event: [`games/coup/event.schema.json`](../../schema/games/coup/event.schema.json)

## 1. Rules summary

Five roles: **Duke**, **Assassin**, **Captain**, **Ambassador**,
**Contessa**. Court deck = 3 copies of each = 15 cards. Each player
is dealt 2 face-down cards at start and receives 2 coins. Your
cards are hidden; revealing (losing) one moves it to your `revealed`
list permanently.

**Turn structure:** pick one action. If it claims a role, the
server enters `challenge_action` phase where any other alive player
may challenge. If no one challenges (everyone passes), the action
may be blockable (`foreign_aid`, `assassinate`, `steal`) — the
server enters `block` phase. If someone blocks (which itself claims
a role), the server enters `challenge_block` phase. Challenges are
resolved by revealing cards: truthful claimant wins (challenger
loses a card and truthful claimant reshuffles-and-redraws); lying
claimant loses a card and their action/block is cancelled.

**Mandatory coup at 10+ coins.** If your coin count ≥10, your ONLY
legal action on your turn is `coup`.

**Influence** = your count of face-down cards. At 0 face-down cards
you're eliminated. Last player with ≥1 face-down card wins.

## 2. Config

Coup ignores `game_start.data.config` — deck composition, starting
coins (2), starting hand (2 cards), and mandatory-coup threshold
(10) are all server-hardcoded. There is **no** `config.schema.json`
for this game.

## 3. State fields

Delivered as `action_request.data.state`. Coup has the most complex
state machine of the three games; most fields are conditionally
present based on `phase`.

### Always

| Field | Type | Meaning |
|-------|------|---------|
| `phase` | enum | `action` / `challenge_action` / `block` / `challenge_block` / `lose_influence` / `exchange_return` / `done` |
| `current_turn` | string | Player id whose turn it is (the actor). NOT necessarily the player being prompted — check `legal_actions` on the request envelope. |

### Phase-conditional (public)

| Field | Phases | Meaning |
|-------|--------|---------|
| `pending_action` | all except `action` / `done` | The action being resolved: `income`/`foreign_aid`/`coup`/`tax`/`assassinate`/`steal`/`exchange` |
| `pending_target` | when pending_action targets someone | Target player id |
| `claimed_role` | when action claims a role | `Duke` (tax), `Assassin` (assassinate), `Captain` (steal), `Ambassador` (exchange) |
| `blocker` | `challenge_block` | Player id who declared the block |
| `block_role` | `challenge_block` | Role they claim (`Duke` blocks foreign_aid; `Contessa` blocks assassinate; `Captain` or `Ambassador` blocks steal) |
| `influence_loser` | `lose_influence` | Player id who must reveal a card |
| `turn_log` | any | Narrative trace of this turn so far; cleared on `advanceTurn` |

### Private (recipient's own)

| Field | Meaning |
|-------|---------|
| `your_cards` | Roles of your face-down cards (1-2 entries) |
| `your_revealed` | Roles you've already revealed. Public — opponents see these too — but echoed here for convenience. |
| `coins` | Your coin count. Public (per-player `players[i].data.coins`); duplicated here for convenience. |
| `exchange_cards` | **Only in `exchange_return` phase AND you are the actor.** The 2 cards drawn from the deck for your pending Exchange. |
| `all_exchange_options` | **Only in `exchange_return` phase AND you are the actor.** Convenience = `your_cards ++ exchange_cards`; indices here are what you pass to `return_cards.data.return_indices`. |

### Per-player (in `PlayerView.players[i].data`)

| Field | Public? | Meaning |
|-------|---------|---------|
| `coins` | yes | Per-player coin count |
| `hidden_cards` | yes | Count of face-down cards (0/1/2 or higher after exchange+failed-challenge redraws) |
| `revealed` | yes | Ordered list of revealed role names |

### Done

| Field | Meaning |
|-------|---------|
| `winner` | Player id of match winner |

### `turn_log` structure

The `turn_log` object builds up as the turn progresses:

| Field | Populated when |
|-------|----------------|
| `action` / `actor` | Actor chose an action |
| `target` | Action has a target (coup / assassinate / steal) |
| `claimed_role` | Actor claims a role (tax / assassinate / steal / exchange) |
| `challenger` | Someone challenged the action |
| `challenge_result` | `"success"` = actor was lying (lost card, action cancelled); `"fail"` = actor truthful (challenger loses card) |
| `blocker` / `block_role` | Someone blocked |
| `block_challenger` | Someone challenged the block |
| `block_challenge_result` | `"success"` = blocker lying (loses card, action executes); `"fail"` = blocker truthful (challenger loses card, block stands) |

## 4. Action reference

Actions divide into **turn actions** (phase: `action`), **challenge
responses** (phase: `challenge_action` / `challenge_block`), **block
responses** (phase: `block`), **reveal** (phase: `lose_influence`),
and **exchange return** (phase: `exchange_return`).

### 4.1 `income` — Turn action

- **Data:** `{}`
- **Legal when:** `phase == "action"` and your coins < 10
- **Effect:** +1 coin. Unblockable, unchallengeable. Turn advances.

### 4.2 `foreign_aid` — Turn action

- **Data:** `{}`
- **Legal when:** `phase == "action"` and your coins < 10
- **Effect:** Transitions to `phase = "block"`. Any other alive
  player may block by claiming Duke. If all pass, you get +2 coins
  and turn advances.

### 4.3 `coup` — Turn action

- **Data:** `{ target: <pid> }`
- **Legal when:** `phase == "action"` and your coins ≥ 7. If coins ≥
  10, this is the ONLY legal turn action.
- **Effect:** You pay 7 coins immediately. Target is forced into
  `phase = "lose_influence"`. Unblockable, unchallengeable.

### 4.4 `tax` — Turn action (claims Duke)

- **Data:** `{}`
- **Legal when:** `phase == "action"` and your coins < 10
- **Effect:** Transitions to `phase = "challenge_action"`. If all
  pass, you get +3 coins. If challenged and Duke is in your hand, you
  keep +3 and the challenger loses influence. If challenged and you
  do NOT have Duke, you lose a card and the action cancels.

### 4.5 `assassinate` — Turn action (claims Assassin)

- **Data:** `{ target: <pid> }`
- **Legal when:** `phase == "action"`, your coins ≥ 3 (and < 10)
- **Effect:** You pay 3 coins immediately (not refunded on caught
  lie). Transitions to `phase = "challenge_action"`. If passed and
  not blocked, target loses influence. Target may `block` claiming
  Contessa.

### 4.6 `steal` — Turn action (claims Captain)

- **Data:** `{ target: <pid> }`
- **Legal when:** `phase == "action"` and your coins < 10
- **Effect:** Transitions to `phase = "challenge_action"`. If passed
  and not blocked, you take min(2, target.coins) coins from target.
  Target may `block` claiming Captain OR Ambassador.

### 4.7 `exchange` — Turn action (claims Ambassador)

- **Data:** `{}`
- **Legal when:** `phase == "action"` and your coins < 10
- **Effect:** Transitions to `phase = "challenge_action"`. If passed,
  server draws 2 cards from the deck and moves to
  `phase = "exchange_return"` (see §4.12).

### 4.8 `challenge` — Challenge response

- **Data:** `{}`
- **Legal when:** `phase == "challenge_action"` (not the actor;
  hasn't passed yet) OR `phase == "challenge_block"` (not the
  blocker; hasn't passed yet)
- **Effect:** Server reveals claim resolution. See §4.4-§4.7 and
  §4.10 for consequences.

### 4.9 `pass` — Challenge / block response

- **Data:** `{}`
- **Legal when:** `phase == "challenge_action"` / `"challenge_block"`
  / `"block"` (for `foreign_aid`: any alive non-actor; for targeted
  block: only the target)
- **Effect:** Marks you as having decided not to challenge / block.
  When all eligible players have passed, the action progresses.

### 4.10 `block` — Block response

- **Data:** `{ role: <Duke|Contessa|Captain|Ambassador> }`
- **Legal when:** `phase == "block"` AND your role option matches
  the pending action:
  - `foreign_aid` → any non-actor player may block with `Duke`
  - `assassinate` → only target may block with `Contessa`
  - `steal` → only target may block with `Captain` or `Ambassador`
- **Effect:** Transitions to `phase = "challenge_block"`. If all
  pass (or eligible challengers timeout), block stands and action
  is cancelled. If challenged and blocker has the claimed role,
  challenger loses influence and blocker reshuffles-and-redraws;
  block still stands, action still cancelled. If challenged and
  blocker lying, blocker loses influence and the action executes.

### 4.11 `lose_card` — Reveal response

- **Data:** `{ card_index: <integer ≥0> }`
- **Legal when:** `phase == "lose_influence"` and you are
  `influence_loser`
- **Effect:** Reveals the card at index `card_index`. After
  reveal, the server dispatches back to the appropriate follow-up
  (continue action, cancel action, start new turn, etc.) based on
  `turn_log` context.
- **Note:** `card_index` is into your **full** `Cards` array
  (hidden + already-revealed), NOT just the hidden subset. It is
  usually 0 or 1 at game start but can be ≥2 after a mid-game
  failed challenge shuffle-and-redraw. Always pick the indices
  from `legal_actions[lose_card].data.card_index`.

### 4.12 `return_cards` — Exchange return

- **Data:** `{ return_indices: [<integer>, ...] }`
- **Legal when:** `phase == "exchange_return"` and you are the actor
- **Effect:** Server builds `allCards = your_cards ++ exchange_cards`.
  You specify `return_indices` = indices of cards to return (the
  complement is kept). You MUST return exactly
  `len(allCards) - len(your_cards_before_exchange)` cards (equal to
  `len(exchange_cards)` if you were not at partial influence;
  different otherwise — trust `legal_actions`). Legal options are
  enumerated by the server as all valid combinations.
- **`cards` / `all_cards` in data:** server-provided display hints
  (role names) so an LLM can reason beyond raw indices. Outbound
  `client_action` need not echo them.

## 5. Event reference

Events appear in `action_request.data.new_events`. Outer `player`
where indicated.

### Action flow

| Type | `player` | Key data |
|------|----------|----------|
| `action` | actor | `action` (enum), `target` (if any), `claimed_role` (if any) |
| `action_resolved` | actor | `action` (foreign_aid/tax/assassinate/steal), `coins_now` (foreign_aid/tax/steal), `target` + `stolen` (steal) |
| `exchange_draw` | actor | `action: "exchange"`, `drawn_count` (usually 2) |
| `exchange_complete` | actor | `player`, `returned_count` |

### Challenge flow

| Type | `player` | Key data |
|------|----------|----------|
| `challenge_pass` | passer | `player` |
| `challenge` | challenger | `challenger`, `actor`, `claimed_role` |
| `challenge_result` | actor | `result` (`fail` = actor truthful, `success` = actor lying), `actor`, `challenger`, `revealed_card` (only if result=fail) |

### Block flow

| Type | `player` | Key data |
|------|----------|----------|
| `block_pass` | passer | `player` |
| `block` | blocker | `blocker`, `claimed_role`, `action` |
| `block_challenge_pass` | passer | `player` |
| `block_accepted` | blocker | `blocker` — emitted when all eligible players passed challenging the block |
| `challenge_block` | challenger | `challenger`, `blocker`, `claimed_role` |
| `challenge_block_result` | blocker | `result` (fail/success), `blocker`, `challenger`, `revealed_card` (result=fail) |

### Influence / match end

| Type | `player` | Key data |
|------|----------|----------|
| `influence_lost` | card owner | `player`, `card` (role revealed — **public from here on**), `card_index` |
| `player_eliminated` | eliminated player | `player` |
| `game_over` | — | `winner` (pid or empty) |
| `player_disconnected` | disconnected | `player`. All their cards are force-revealed; usually followed by `player_eliminated` and a state-flow continuation. |

## 6. Fallback policy

Coup fallback is game-phase-specific:

- **Turn action (`phase: action`):**
  - If coins ≥ 10: `coup` (mandatory; target = any alive opponent)
  - Elif coins < 3: `income` (safe; no role claim)
  - Elif coins ∈ [3, 6]: `tax` (claim Duke; usually unchallenged)
  - Else: `coup` on highest-influence opponent
- **Challenge response (`challenge_action` / `challenge_block`):**
  `pass` — challenging without evidence is -EV; let the round resolve.
- **Block response (`block`):**
  - If `pending_action == "assassinate"` AND you are the target AND
    you're about to die (hidden_cards == 1): `block` claiming
    `Contessa` (pure survival bluff if you don't have one; but often
    your last play).
  - Otherwise: `pass`.
- **Reveal (`lose_influence`):** `lose_card` picking your **least**
  strategically valuable card (often the Contessa — it's reactive
  and harder to deploy proactively).
- **Exchange return (`exchange_return`):** return cards back such
  that you keep the combination with the highest claim-utility:
  priority order Duke ≥ Assassin ≥ Ambassador ≥ Captain ≥ Contessa.

Do NOT default to random bluffs (tax without Duke, assassinate
without Assassin). In a multi-agent pool, over time bluffs get
caught.

## 7. Match termination

The match ends when ≤1 alive player remains (emits `game_over`
event and sets `phase = "done"`). The server then proceeds to the
top-level
[`game_over` message](../../schema/messages/server_game_over.schema.json).
