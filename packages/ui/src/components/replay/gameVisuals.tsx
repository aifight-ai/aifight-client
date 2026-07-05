/*
 * Game visualization components extracted from the legacy ReplayPage.tsx.
 * These render game-specific boards (Texas Hold'em, Liar's Dice, Coup, etc.)
 * plus the shared EventBadge / EventDetail helpers used by the event log.
 *
 * All public surface used by the new ReplayPage shell is exported at the
 * bottom of this file.
 */
import type { MatchDetail, MatchEvent, MatchPlayer } from '@aifight/api-types'
import SeatCard, { type SeatPosition, type SeatStatus } from '../live/SeatCard'
import BoardV2, { type BoardPhase } from '../live/BoardV2'
import { identiconDataUri } from '../../lib/identicon'
import { AvatarPresetTile, getAvatarPreset } from '../../lib/avatarPresets'

// Shared rounded-square seat avatar for the non-poker visuals (Coup, Liar's
// Dice). Same identity system as AgentAvatar/SeatCard (precedence): uploaded
// image > chosen preset > deterministic id-seeded geometric identicon (no
// initials). Mystery players ignore the chosen avatar so identity can never
// leak — they always get the identicon. CSS sizes the box.
function SeatAvatar({ player }: { player: MatchPlayer }) {
  const seed = `agent:${player.agent_id}`
  const presetDef =
    !player.is_mystery && !player.avatar_url ? getAvatarPreset(player.avatar_preset) : null
  return (
    <div className="seat-avatar">
      {!player.is_mystery && player.avatar_url ? (
        <img src={player.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' }} />
      ) : presetDef ? (
        <AvatarPresetTile preset={presetDef} size="fill" />
      ) : (
        <img src={identiconDataUri(seed, 64)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' }} />
      )}
    </div>
  )
}

// --- Visual Game State Renderers ---

function GameStateVisual({ match, events, allEvents, isLive }: { match: MatchDetail; events: MatchEvent[]; allEvents?: MatchEvent[]; isLive?: boolean }) {
  switch (match.game) {
    case 'texas_holdem':
      return <PokerVisual match={match} events={events} allEvents={allEvents} isLive={isLive} />
    case 'liars_dice':
      return <LiarsDiceVisual match={match} events={events} />
    case 'coup':
      return <CoupVisual match={match} events={events} />
    case 'skull':
    case 'auction_war':
      return <GenericGameVisual match={match} events={events} />
    default:
      return null
  }
}

// --- Coup visual ---

function CoupRoleCard({ role }: { role: string }) {
  const colors: Record<string, string> = {
    Duke:       'text-blue-400 border-blue-500/30 bg-blue-500/10',
    Assassin:   'text-red-400 border-red-500/30 bg-red-500/10',
    Captain:    'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
    Ambassador: 'text-green-400 border-green-500/30 bg-green-500/10',
    Contessa:   'text-pink-400 border-pink-500/30 bg-pink-500/10',
  }
  const c = colors[role] || 'text-on-surface-variant border-on-surface/10 bg-surface-container-highest'
  return (
    <div className={`w-9 h-13 rounded-md border flex items-center justify-center text-[10px] font-bold leading-tight text-center ${c}`}>
      {role.slice(0, 3)}
    </div>
  )
}

function CoupVisual({ match, events }: { match: MatchDetail; events: MatchEvent[] }) {
  const getName = (id: string) => {
    if (!id) return '?'
    const p = match.players.find(p => p.player_id === id || p.agent_id === id)
    return p?.agent_name || id.slice(0, 8)
  }
  const findIdx = (id: string) =>
    match.players.findIndex(p => p.player_id === id || p.agent_id === id)

  // Player state: coins, influence cards, alive
  const states = match.players.map(() => ({
    coins: 2, hidden: 2, revealed: [] as string[], alive: true,
  }))

  // Build a Claude Design v2 style "chain" from the latest chain of events.
  // Walk events in reverse to find the most recent action + its follow-ups.
  type Phase = 'action' | 'challenge' | 'block' | 'reveal'
  type ChainStep = {
    n: number
    kind: 'declared' | 'challenge' | 'resolved' | 'block' | 'result'
    body: React.ReactNode
    cur: boolean
  }
  type Chain = {
    actor: string
    target: string
    verb: string
    claim: string
    phase: Phase
    steps: ChainStep[]
  }
  let currentChain: Chain | null = null
  let turn = 0
  let gameOver = false
  let winnerId = ''

  const roleKey: Record<string, 'duke' | 'asn' | 'cap' | 'amb' | 'con'> = {
    Duke: 'duke', Assassin: 'asn', Captain: 'cap', Ambassador: 'amb', Contessa: 'con',
    duke: 'duke', assassin: 'asn', captain: 'cap', ambassador: 'amb', contessa: 'con',
  }

  const humanVerb = (a: string): string => {
    const m: Record<string, string> = {
      income: 'income', foreign_aid: 'foreign aid', tax: 'tax',
      coup: 'coup', assassinate: 'assassinate', steal: 'steal',
      exchange: 'exchange', targeted: 'targeted',
    }
    return m[a] || a
  }

  const RoleChip = ({ role }: { role: string }) => {
    const rk = roleKey[role] || 'asn'
    return (
      <span className="role-chip">
        <span className="sw" style={{ background: `var(--role-${rk})` }} />
        {role}
      </span>
    )
  }

  for (const evt of events) {
    const d = evt.data || {}
    switch (evt.type) {
      case 'action': {
        turn++
        const actor = evt.player_id || ''
        const action = d.action as string
        const target = (d.target as string) || ''
        const role = (d.claimed_role as string) || ''
        const ai = findIdx(actor)
        if (ai >= 0) {
          if (action === 'income') states[ai].coins++
          if (action === 'coup') states[ai].coins -= 7
          if (action === 'assassinate') states[ai].coins -= 3
        }
        currentChain = {
          actor, target, verb: action, claim: role, phase: 'action',
          steps: [{
            n: 1, kind: 'declared', cur: true,
            body: (
              <>
                <span className="who">{getName(actor)}</span>{' '}
                <span className="verb">{humanVerb(action)}</span>
                {target ? (
                  <>
                    {' '}<span className="who">{getName(target)}</span>
                  </>
                ) : null}
                {role ? (
                  <>
                    {' '}· claims <RoleChip role={role} />
                  </>
                ) : null}
              </>
            ),
          }],
        }
        break
      }
      case 'challenge': {
        const challenger = (d.challenger as string) || evt.player_id || ''
        if (currentChain) {
          currentChain.phase = 'challenge'
          currentChain.steps.forEach((s) => (s.cur = false))
          currentChain.steps.push({
            n: currentChain.steps.length + 1,
            kind: 'challenge', cur: true,
            body: (
              <>
                <span className="who">{getName(challenger)}</span> challenges — demands proof
              </>
            ),
          })
        }
        break
      }
      case 'challenge_result': {
        const actor = (d.actor as string) || ''
        const challenger = (d.challenger as string) || ''
        const revealed = d.revealed_card as string
        if (currentChain) {
          currentChain.phase = 'reveal'
          currentChain.steps.forEach((s) => (s.cur = false))
          if (d.result === 'fail') {
            currentChain.steps.push({
              n: currentChain.steps.length + 1,
              kind: 'resolved', cur: true,
              body: (
                <>
                  <span className="who">{getName(actor)}</span> reveals {revealed} — truthful ·{' '}
                  <span className="who">{getName(challenger)}</span> loses 1 influence
                </>
              ),
            })
          } else {
            currentChain.steps.push({
              n: currentChain.steps.length + 1,
              kind: 'challenge', cur: true,
              body: (
                <>
                  <span className="who">{getName(actor)}</span> was bluffing — loses 1 influence
                </>
              ),
            })
          }
        }
        break
      }
      case 'block': {
        const blocker = (d.blocker as string) || evt.player_id || ''
        const cr = (d.claimed_role as string) || ''
        if (currentChain) {
          currentChain.phase = 'block'
          currentChain.steps.forEach((s) => (s.cur = false))
          currentChain.steps.push({
            n: currentChain.steps.length + 1,
            kind: 'block', cur: true,
            body: (
              <>
                <span className="who">{getName(blocker)}</span> blocks · claims <RoleChip role={cr} />
              </>
            ),
          })
        }
        break
      }
      case 'challenge_block_result': {
        const blocker = (d.blocker as string) || ''
        if (currentChain) {
          currentChain.steps.forEach((s) => (s.cur = false))
          if (d.result === 'fail') {
            currentChain.steps.push({
              n: currentChain.steps.length + 1,
              kind: 'resolved', cur: true,
              body: (
                <>
                  <span className="who">{getName(blocker)}</span> reveals {d.revealed_card as string} — block stands
                </>
              ),
            })
          } else {
            currentChain.steps.push({
              n: currentChain.steps.length + 1,
              kind: 'challenge', cur: true,
              body: (
                <>
                  <span className="who">{getName(blocker)}</span> was bluffing — block fails
                </>
              ),
            })
          }
        }
        break
      }
      case 'influence_lost': {
        const player = (d.player as string) || evt.player_id || ''
        const card = d.card as string
        const i = findIdx(player)
        if (i >= 0) {
          states[i].hidden = Math.max(0, states[i].hidden - 1)
          states[i].revealed.push(card)
        }
        break
      }
      case 'player_eliminated': {
        const player = (d.player as string) || evt.player_id || ''
        const i = findIdx(player)
        if (i >= 0) states[i].alive = false
        break
      }
      case 'action_resolved': {
        const i = findIdx(evt.player_id || '')
        if (i >= 0 && d.coins_now !== undefined) states[i].coins = d.coins_now as number
        if (d.action === 'steal' && d.target) {
          const ti = findIdx(d.target as string)
          if (ti >= 0 && d.stolen !== undefined) states[ti].coins -= d.stolen as number
        }
        break
      }
      case 'game_over': {
        gameOver = true
        winnerId = (d.winner as string) || ''
        break
      }
    }
  }

  // ── Narration ledger ────────────────────────────────────────────────
  // A plain-language transcript, one line per visible frame, built in a second
  // light pass over the same events. The LAST entry is the current frame. This
  // is what makes income-heavy Coup games legible: every step adds a visible
  // line, and the rare big moments (coup / lost influence / KO / win) are
  // colour-coded so they pop instead of slipping past unnoticed.
  const ROLE_LONG: Record<string, string> = {
    duke: 'Duke', asn: 'Assassin', cap: 'Captain', amb: 'Ambassador', con: 'Contessa',
  }
  const prettyRole = (role: string) => ROLE_LONG[roleKey[role] || ''] || role
  type Tone = 'gain' | 'loss' | 'win' | 'info'
  type Line = { tone: Tone; big: boolean; node: React.ReactNode; coinIdx: number; coinDelta: number }
  const who = (id: string) => <b className="who">{getName(id)}</b>
  const ledger: Line[] = []
  for (const evt of events) {
    const d = evt.data || {}
    switch (evt.type) {
      case 'action': {
        const actor = evt.player_id || ''
        const action = d.action as string
        const target = (d.target as string) || ''
        const role = (d.claimed_role as string) || ''
        const ai = findIdx(actor)
        const delta = action === 'income' ? 1 : action === 'coup' ? -7 : action === 'assassinate' ? -3 : 0
        const verbMap: Record<string, string> = {
          income: 'takes income', foreign_aid: 'takes foreign aid', tax: 'collects tax',
          coup: 'launches a COUP on', assassinate: 'assassinates', steal: 'steals from',
          exchange: 'exchanges influence',
        }
        const big = action === 'coup' || action === 'assassinate'
        ledger.push({
          tone: big ? 'loss' : 'gain', big,
          coinIdx: delta !== 0 ? ai : -1, coinDelta: delta,
          node: (
            <>
              {who(actor)} <span className="lg-verb">{verbMap[action] || humanVerb(action)}</span>
              {target ? <> {who(target)}</> : null}
              {role ? <> · claims <RoleChip role={role} /></> : null}
            </>
          ),
        })
        break
      }
      case 'challenge': {
        const challenger = (d.challenger as string) || evt.player_id || ''
        ledger.push({ tone: 'info', big: true, coinIdx: -1, coinDelta: 0,
          node: <>{who(challenger)} <span className="lg-verb">challenges</span> — demands proof</> })
        break
      }
      case 'challenge_result': {
        const actor = (d.actor as string) || ''
        const challenger = (d.challenger as string) || ''
        const revealed = (d.revealed_card as string) || ''
        ledger.push(d.result === 'fail'
          ? { tone: 'info', big: true, coinIdx: -1, coinDelta: 0,
              node: <>{who(actor)} reveals <RoleChip role={revealed} /> — truthful · {who(challenger)} loses an influence</> }
          : { tone: 'loss', big: true, coinIdx: -1, coinDelta: 0,
              node: <>{who(actor)} was <span className="lg-verb">bluffing</span> — loses an influence</> })
        break
      }
      case 'block': {
        const blocker = (d.blocker as string) || evt.player_id || ''
        const cr = (d.claimed_role as string) || ''
        ledger.push({ tone: 'info', big: true, coinIdx: -1, coinDelta: 0,
          node: <>{who(blocker)} <span className="lg-verb">blocks</span> · claims <RoleChip role={cr} /></> })
        break
      }
      case 'challenge_block_result': {
        const blocker = (d.blocker as string) || ''
        const revealed = (d.revealed_card as string) || ''
        ledger.push(d.result === 'fail'
          ? { tone: 'info', big: true, coinIdx: -1, coinDelta: 0,
              node: <>{who(blocker)} reveals <RoleChip role={revealed} /> — block stands</> }
          : { tone: 'loss', big: true, coinIdx: -1, coinDelta: 0,
              node: <>{who(blocker)} was <span className="lg-verb">bluffing</span> — block fails</> })
        break
      }
      case 'influence_lost': {
        const player = (d.player as string) || evt.player_id || ''
        const card = (d.card as string) || ''
        ledger.push({ tone: 'loss', big: true, coinIdx: -1, coinDelta: 0,
          node: <>{who(player)} <span className="lg-verb">loses</span> {card ? <RoleChip role={card} /> : 'an influence'}</> })
        break
      }
      case 'player_eliminated': {
        const player = (d.player as string) || evt.player_id || ''
        ledger.push({ tone: 'loss', big: true, coinIdx: -1, coinDelta: 0,
          node: <>{who(player)} is <span className="lg-verb">eliminated</span> — out of the game</> })
        break
      }
      case 'game_over': {
        const w = (d.winner as string) || winnerId
        ledger.push({ tone: 'win', big: true, coinIdx: -1, coinDelta: 0,
          node: <>{who(w)} <span className="lg-verb">wins the match</span></> })
        break
      }
    }
  }
  const current = ledger.length ? ledger[ledger.length - 1] : null
  const WINDOW = 7
  const shownStart = Math.max(0, ledger.length - WINDOW)
  const shown = ledger.slice(shownStart)

  return (
    <div className="coup-visual">
      <div className="coup-board">
        <div className="chain-head-row">
          <span className="round-chip">
            Turn {turn}
            {currentChain ? ` · ${getName(currentChain.actor)}'s turn` : ''}
          </span>
          <span className="coup-legend">income +1 · foreign aid +2 · tax +3 · coup −7 (removes an influence)</span>
        </div>

        {/* What just happened, in plain language — the focal point of each frame. */}
        <div className={`coup-now coup-now--${current ? current.tone : 'info'}${current?.big ? ' is-big' : ''}`}>
          <div className="coup-now-main">
            {current ? current.node : <span className="coup-now-await">awaiting first move…</span>}
          </div>
          {current && current.coinDelta !== 0 && current.coinIdx >= 0 && (
            <div className="coup-now-delta">
              <span className="coin" />
              {current.coinDelta > 0 ? '+' : '−'}{Math.abs(current.coinDelta)}
              <span className="coup-now-arrow">→ {states[current.coinIdx].coins}</span>
            </div>
          )}
        </div>
      </div>

      <div className="seats-zone">
        <div className="seats" data-n={match.players.length}>
          {match.players.map((p, i) => {
            const s = states[i]
            const isActor = !!(currentChain && findIdx(currentChain.actor) === i)
            const isTarget = !!(currentChain && currentChain.target && findIdx(currentChain.target) === i)
            const justCoin = !!(current && current.coinIdx === i && current.coinDelta !== 0)
            const cls = ['seat']
            if (isActor && s.alive) cls.push('acting')
            if (isTarget && s.alive) cls.push('target')
            if (!s.alive) cls.push('eliminated')
            const toCoup = Math.max(0, 7 - s.coins)
            return (
              <div key={i} className={cls.join(' ')}>
                <div className="seat-row-1">
                  <div className="seat-ident">
                    <SeatAvatar player={p} />
                    <div className="seat-name-wrap">
                      <div className="seat-name">{p.agent_name || p.player_id}</div>
                      <div className="seat-num">
                        {s.alive ? `${s.hidden} influence${s.hidden === 1 ? '' : 's'} left` : 'eliminated'}
                      </div>
                    </div>
                  </div>
                  <span className="seat-flag">
                    {!s.alive ? 'out' : isActor ? 'acting' : isTarget ? 'target' : 'in play'}
                  </span>
                </div>
                <div className="cards-row">
                  {Array.from({ length: s.hidden }).map((_, j) => (
                    <div key={`h${j}`} className="inf-card back">?</div>
                  ))}
                  {s.revealed.map((role, j) => {
                    const rk = roleKey[role] || 'asn'
                    return (
                      <div key={`r${j}`} className="inf-card face dead" data-role={rk}>
                        <div className="band" />
                        <div className="letter">{role.charAt(0).toUpperCase()}</div>
                        <div className="role-name">{prettyRole(role)}</div>
                        <div className="inf-lost">lost</div>
                      </div>
                    )
                  })}
                </div>
                <div className="seat-footer">
                  <span className={`coins${s.coins >= 7 ? ' high' : ''}`}>
                    <span className="coin" />
                    {s.coins}
                    {justCoin && current && (
                      <span className={`coin-delta ${current.coinDelta > 0 ? 'up' : 'down'}`}>
                        {current.coinDelta > 0 ? '+' : '−'}{Math.abs(current.coinDelta)}
                      </span>
                    )}
                  </span>
                  <span className={`coin-hint${s.alive && s.coins >= 7 ? ' ready' : ''}`}>
                    {!s.alive ? '' : s.coins >= 10 ? 'must coup' : s.coins >= 7 ? 'can coup' : `${toCoup} to coup`}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Accumulating move log — the current line is highlighted at the bottom. */}
      <div className="coup-ledger">
        <div className="coup-ledger-head">
          <span>move log</span>
          {shownStart > 0 && <span className="coup-ledger-earlier">+{shownStart} earlier</span>}
        </div>
        <div className="coup-ledger-rows">
          {ledger.length === 0 && <div className="coup-ledger-row coup-ledger-row--info">no moves yet</div>}
          {shown.map((l, k) => {
            const idx = shownStart + k
            const isCur = idx === ledger.length - 1
            return (
              <div
                key={idx}
                className={`coup-ledger-row coup-ledger-row--${l.tone}${l.big ? ' is-big' : ''}${isCur ? ' is-cur' : ''}`}
              >
                <span className="lg-n">{idx + 1}</span>
                <span className="lg-body">{l.node}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Generic game visual for games (Skull, Auction War)
function GenericGameVisual({ match, events }: { match: MatchDetail; events: MatchEvent[] }) {
  // Show key events in a timeline view
  const keyEvents = events.filter(e =>
    !['player_action', 'state_update'].includes(e.type)
  ).slice(-20)

  return (
    <div className="bg-surface-container-high rounded-xl p-6 ghost-border">
      <div className="flex items-center justify-center gap-6 mb-4">
        {match.players.map((p, i) => {
          const isWinner = match.result?.winner === p.player_id
          return (
            <div key={i} className={`text-center px-4 py-2 rounded-lg ${
              isWinner ? 'bg-tertiary/10 ring-1 ring-tertiary' : 'bg-surface-container-highest'
            }`}>
              <div className="text-sm font-medium text-on-surface">{p.agent_name}</div>
              {isWinner && <div className="text-xs text-tertiary mt-1">Winner</div>}
            </div>
          )
        })}
      </div>
      {keyEvents.length > 0 && (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {keyEvents.map((evt, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <EventBadge type={evt.type} />
              <span className="text-on-surface-variant flex-1">
                {evt.player_id && <span className="text-on-surface">{evt.player_id}: </span>}
                {JSON.stringify(evt.data || {}).slice(0, 120)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- PokerVisual: full table visualization ---

// Derive BTN / SB / BB position chips from seat index + hand number.
// True dealer button rotates each hand; AIFight events don't surface an explicit
// dealer seat, so we approximate: dealer = (handNum - 1) % n.
function positionsForSeat(
  n: number,
  seatIdx: number,
  handNum: number,
): SeatPosition[] {
  if (n < 2) return []
  const dealer = ((handNum - 1) % n + n) % n
  if (n === 2) {
    return seatIdx === dealer ? ['BTN', 'SB'] : ['BB']
  }
  const sb = (dealer + 1) % n
  const bb = (dealer + 2) % n
  if (seatIdx === dealer) return ['BTN']
  if (seatIdx === sb) return ['SB']
  if (seatIdx === bb) return ['BB']
  return []
}

function inferPokerPhase(
  communityCount: number,
  isShowdown: boolean,
): BoardPhase {
  if (isShowdown) return 'showdown'
  if (communityCount >= 5) return 'river'
  if (communityCount >= 4) return 'turn'
  if (communityCount >= 3) return 'flop'
  return 'preflop'
}

// Heads-up / 3-max blind schedule — rough default; real matches will update via events.
// This only feeds the pot strip visual; if missing, Board just omits the "Blinds" line.
function blindsForHand(handNum: number): { sb: number; bb: number; label: string } {
  if (handNum <= 5) return { sb: 200, bb: 400, label: 'L1' }
  if (handNum <= 10) return { sb: 400, bb: 800, label: 'L2' }
  return { sb: 800, bb: 1600, label: 'L3' }
}

// Helper: resolve player_id (like "p1") to agent name using match.players
function resolvePlayerName(match: MatchDetail, pid: string): string {
  for (const p of match.players) {
    if ((p.player_id || `p${p.position}`) === pid) return p.agent_name
  }
  return pid
}

// Anonymous nicknames for live matches (prevent identity-based cheating)
const ANON_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']

function PokerVisual({ match, events, allEvents, isLive }: { match: MatchDetail; events: MatchEvent[]; allEvents?: MatchEvent[]; isLive?: boolean }) {
  const players = match.players

  // Build agent_id (UUID) → player_id ("p0") mapping first.
  // Events store agent UUIDs as player_id, but match.players uses "p0","p1" etc.
  const agentToPlayer: Record<string, string> = {}
  for (const p of players) {
    const pid = p.player_id || `p${p.position}`
    if (p.agent_id) agentToPlayer[p.agent_id] = pid
  }
  const resolve = (eventPid: string | undefined): string => {
    if (!eventPid) return ''
    return agentToPlayer[eventPid] || eventPid
  }

  // Pre-scan ALL events to build a hand-number → player → cards map.
  // This allows showing hole cards at any replay step for completed matches.
  const allHandCards: Record<number, Record<string, { cards: string[]; hand?: string; folded?: boolean }>> = {}
  {
    let scanHand = 1
    for (const evt of allEvents || events) {
      if (evt.type === 'new_hand' && evt.data?.hand_num) scanHand = evt.data.hand_num as number
      if (evt.type === 'cards_dealt' && evt.data?.cards && evt.player_id) {
        if (!allHandCards[scanHand]) allHandCards[scanHand] = {}
        allHandCards[scanHand][resolve(evt.player_id)] = { cards: evt.data.cards as string[] }
      }
      if (evt.type === 'hand_result' && evt.data?.hands) {
        const hands = evt.data.hands as Record<string, { cards: string[]; hand?: string; folded?: boolean }>
        if (!allHandCards[scanHand]) allHandCards[scanHand] = {}
        for (const [pid, h] of Object.entries(hands)) {
          allHandCards[scanHand][resolve(pid)] = h
        }
      }
    }
  }

  // Accumulate state from events (up to current step)
  let communityCards: string[] = []
  let handNum = 1
  let maxHands = 10
  let chips: Record<string, number> = {}
  let bets: Record<string, number> = {} // cumulative bet this hand per player
  let roundBets: Record<string, number> = {} // per-round bets (reset on new betting round)
  let lastAction: Record<string, { action: string; amount?: number }> = {}
  let folded: Record<string, boolean> = {}
  let pot = 0
  let showdownHands: Record<string, { cards: string[]; hand?: string; folded?: boolean }> | null = null
  let handWinners: string[] = []
  let handReason = ''
  let matchResult: { winner: string; reason: string; hand: number } | null = null
  let hasDealt = false
  let currentTurn = '' // whose turn it is (from last action context)
  let allIn: Record<string, boolean> = {} // track all-in players

  // Initialize chips from match player count (10000 each) for hand 1
  for (const p of players) {
    const pid = p.player_id || `p${p.position}`
    chips[pid] = 10000
  }

  for (const evt of events) {
    if (evt.type === 'new_hand' && evt.data) {
      communityCards = []
      showdownHands = null
      handWinners = []
      handReason = ''
      lastAction = {}
      folded = {}
      allIn = {}
      pot = 0
      currentTurn = ''
      hasDealt = true
      if (evt.data.hand_num) handNum = evt.data.hand_num as number
      if (evt.data.max_hands) maxHands = evt.data.max_hands as number
      if (evt.data.chips) chips = { ...(evt.data.chips as Record<string, number>) }
      // Initialize bets from blind data (includes SB/BB already posted)
      if (evt.data.bets) {
        const blindBets = evt.data.bets as Record<string, number>
        bets = {}
        roundBets = {}
        for (const [agentId, amount] of Object.entries(blindBets)) {
          bets[resolve(agentId)] = amount
          roundBets[resolve(agentId)] = amount
        }
      } else {
        bets = {}
        roundBets = {}
      }
    }
    if (evt.type === 'game_start') {
      hasDealt = true
    }
    if (evt.type === 'community_cards' && evt.data?.cards) {
      communityCards = [...communityCards, ...(evt.data.cards as string[])]
      roundBets = {} // new betting round starts
    }
    if (evt.type === 'player_action' && evt.data) {
      const pid = resolve(evt.player_id)
      const action = evt.data.action as string
      const amount = evt.data.amount as number | undefined
      const totalBetFromEvent = evt.data.total_bet as number | undefined
      lastAction[pid] = { action, amount }
      currentTurn = pid
      if (totalBetFromEvent !== undefined) {
        // New format: use authoritative cumulative total_bet from backend
        bets[pid] = totalBetFromEvent
      } else if (amount !== undefined && action !== 'fold') {
        // Legacy fallback: compute from per-action amounts with round tracking
        if (action === 'call') {
          bets[pid] = (bets[pid] ?? 0) + amount
          roundBets[pid] = (roundBets[pid] ?? 0) + amount
        } else {
          // raise/allin amount is total bet for THIS round — compute increment
          const prevRound = roundBets[pid] ?? 0
          bets[pid] = (bets[pid] ?? 0) + (amount - prevRound)
          roundBets[pid] = amount
        }
      }
      if (action === 'fold') {
        folded[pid] = true
      }
      if (action === 'allin') {
        allIn[pid] = true
      }
    }
    if (evt.type === 'hand_result' && evt.data) {
      if (evt.data.pot) pot = evt.data.pot as number
      if (evt.data.hands) showdownHands = evt.data.hands as Record<string, { cards: string[]; hand?: string; folded?: boolean }>
      if (evt.data.winners) handWinners = evt.data.winners as string[]
      if (evt.data.reason) handReason = evt.data.reason as string
    }
    if (evt.type === 'match_result' && evt.data) {
      matchResult = {
        winner: evt.data.winner as string,
        reason: evt.data.reason as string,
        hand: evt.data.hand as number,
      }
      if (evt.data.chips) chips = { ...(evt.data.chips as Record<string, number>) }
    }
  }

  const totalBets = Object.values(bets).reduce((a, b) => a + b, 0)
  const displayPot = pot > 0 ? pot : totalBets

  const n = players.length
  const isShowdown = !!showdownHands || handWinners.length > 0 || !!matchResult
  const phase = inferPokerPhase(communityCards.length, isShowdown)
  const blinds = blindsForHand(handNum)
  const activeInHand = players.reduce((count, p) => {
    const pid = p.player_id || `p${p.position}`
    const busted = (chips[pid] ?? 0) <= 0 && matchResult?.winner !== pid
    if (busted) return count
    if (folded[pid]) return count
    return count + 1
  }, 0)

  let turnLabel = ''
  if (matchResult) turnLabel = 'match over'
  else if (handWinners.length > 0) turnLabel = 'hand complete'
  else if (currentTurn) turnLabel = 'to act'

  return (
    <div className="poker-stage poker-replay-visual">
      <div className="poker-stage-head">
        <div>
          <div className="poker-stage-title">Texas Hold&apos;em &middot; {n}-max</div>
          <div className="poker-stage-sub">
            Hand {handNum}{maxHands > 0 ? ` / ${maxHands}` : ''}
            {phase !== 'preflop' && <> &middot; {phase}</>}
            {turnLabel && <> &middot; {turnLabel}</>}
          </div>
        </div>
        <div className="poker-stage-right">
          <span>{activeInHand} in hand</span>
        </div>
      </div>

      <BoardV2
        communityCards={communityCards}
        phase={phase}
        pot={displayPot}
        handNum={handNum}
        maxHands={maxHands}
        levelLabel={blinds.label}
        blinds={{ sb: blinds.sb, bb: blinds.bb }}
        currentTurnLabel={turnLabel || undefined}
      />

      <div className="seats-zone">
        <div className="seats-head">
          <span>Seats</span>
          <span className="n">
            {n} player{n === 1 ? '' : 's'} &middot; {activeInHand} in hand
          </span>
        </div>

        <div className="seats" data-n={n}>
          {players.map((p, i) => {
            const pid = p.player_id || `p${p.position}`
            const isHandWinner = handWinners.includes(pid)
            const isMatchWinner = matchResult?.winner === pid
            const isWinner = isHandWinner || isMatchWinner
            const playerChips = chips[pid] ?? 0
            const playerBet = bets[pid] ?? 0
            const showdownHand = showdownHands?.[pid]
            const preScannedHand = allHandCards[handNum]?.[pid]
            const isFolded = !!folded[pid]
            const isBusted = playerChips <= 0 && !isWinner
            const isActivePlayer = currentTurn === pid && !isFolded && !isBusted && !matchResult && handWinners.length === 0

            const visibleCards: string[] | null = isLive
              ? (showdownHand?.cards ?? null)
              : (showdownHand?.cards ?? preScannedHand?.cards ?? null)

            let status: SeatStatus = 'active'
            if (isBusted) status = 'busted'
            else if (isFolded) status = 'folded'
            else if (isActivePlayer) status = 'acting'

            const displayName = isLive
              ? (ANON_NAMES[p.position] || `Player ${p.position + 1}`)
              : p.agent_name

            // Avatar identity. LIVE games are anonymized — seed by seat position
            // (never the agent id) and never show a real/uploaded/preset avatar,
            // so spectators can't fingerprint agents mid-match. Replay reveals it.
            const avatarSeed = isLive ? `seat-${p.position}` : `agent:${p.agent_id}`
            const avatarUrl = isLive ? undefined : p.avatar_url
            const avatarPreset = isLive ? undefined : p.avatar_preset
            const avatarMystery = isLive ? false : !!p.is_mystery

            const action = lastAction[pid]
            const handName = showdownHand?.hand
              ? `${showdownHand.hand}${showdownHand.folded ? ' (folded)' : ''}`
              : undefined

            return (
              <SeatCard
                key={pid}
                seatIndex={i}
                name={displayName}
                stack={playerChips}
                holeCards={visibleCards}
                hasDealt={hasDealt}
                lastAction={action}
                handName={handName}
                commit={playerBet}
                status={status}
                positions={positionsForSeat(n, i, handNum)}
                totalSeats={n}
                isWinner={isWinner}
                avatarSeed={avatarSeed}
                avatarUrl={avatarUrl}
                avatarPreset={avatarPreset}
                mystery={avatarMystery}
              />
            )
          })}
        </div>

        {handWinners.length > 0 && !matchResult && (
          <div
            style={{
              marginTop: 16,
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              letterSpacing: '0.06em',
              color: 'var(--color-ink-4)',
            }}
          >
            {handReason === 'all_folded' ? 'All folded' : 'Showdown'} &mdash; Winner:{' '}
            <span style={{ color: 'var(--color-terracotta-700)', fontWeight: 500 }}>
              {handWinners.map(w => isLive ? findAnonName(match, w) : resolvePlayerName(match, w)).join(', ')}
            </span>
          </div>
        )}
        {matchResult && (
          <div
            style={{
              marginTop: 16,
              padding: '14px 18px',
              borderTop: '1px solid var(--color-border-1)',
              textAlign: 'center',
            }}
          >
            <div
              className="serif"
              style={{ fontSize: 18, color: 'var(--color-ink-1)', letterSpacing: '-0.01em' }}
            >
              {matchResult.reason === 'opponent_eliminated'
                ? 'Match over \u2014 opponent eliminated'
                : `Match over \u2014 ${matchResult.hand} hands`}
            </div>
            <div
              style={{
                marginTop: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                color: 'var(--color-terracotta-700)',
                textTransform: 'uppercase',
              }}
            >
              Winner:{' '}
              <span style={{ color: 'var(--color-terracotta-700)', fontWeight: 500 }}>
                {isLive ? findAnonName(match, matchResult.winner) : resolvePlayerName(match, matchResult.winner)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DiceFace({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' }) {
  // Dot positions in a 3x3 grid (row, col) for each face value
  const dots: Record<number, [number, number][]> = {
    1: [[1,1]],
    2: [[0,2],[2,0]],
    3: [[0,2],[1,1],[2,0]],
    4: [[0,0],[0,2],[2,0],[2,2]],
    5: [[0,0],[0,2],[1,1],[2,0],[2,2]],
    6: [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2]],
  }
  const positions = dots[value] || []
  const box = size === 'sm' ? 'w-8 h-8 rounded-md p-1' : 'w-11 h-11 rounded-lg p-1.5'
  const dot = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2'
  return (
    <span className={`${box} inline-grid grid-cols-3 grid-rows-3 flex-shrink-0 bg-white shadow-md border border-gray-300`}>
      {Array.from({ length: 9 }).map((_, i) => {
        const r = Math.floor(i / 3)
        const c = i % 3
        const hasDot = positions.some(([pr, pc]) => pr === r && pc === c)
        return (
          <span key={i} className="flex items-center justify-center">
            {hasDot && <span className={`${dot} rounded-full bg-gray-900`} />}
          </span>
        )
      })}
    </span>
  )
}

const DIE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

function renderDiePips(face: number) {
  const active = new Set(DIE_PIPS[face] || [])
  return Array.from({ length: 9 }).map((_, i) => (
    <span key={i} className={`pip${active.has(i) ? '' : ' n'}`} />
  ))
}

function DieGlyph({ face, kind = 'face', extra = '' }: { face: number; kind?: 'bid' | 'mini' | 'face'; extra?: string }) {
  const base = kind === 'bid' ? 'bid-die' : kind === 'mini' ? 'mini-die' : 'die-face'
  return <div className={`${base}${extra ? ' ' + extra : ''}`}>{renderDiePips(face)}</div>
}

function LiarsDiceVisual({ match, events }: { match: MatchDetail; events: MatchEvent[] }) {
  const bids: { player: string; quantity: number; face: number }[] = []
  let challengeData: {
    challenger: string
    bidder: string
    bidQuantity: number
    bidFace: number
    actualCount: number
    bidMet: boolean
    allDice?: Record<string, number[]>
    loser: string
  } | null = null
  const diceByPlayer: Record<string, number> = {}
  const eliminated: Record<string, boolean> = {}
  match.players.forEach((p) => {
    diceByPlayer[p.player_id || `p${p.position}`] = 5
  })
  let round = 1

  const pidOf = (id: string) => {
    const p = match.players.find((pp) => pp.player_id === id || pp.agent_id === id)
    return p ? p.player_id || `p${p.position}` : id
  }

  for (const evt of events) {
    if (evt.type === 'round_start') {
      bids.length = 0
      challengeData = null
      if (evt.data?.round) round = evt.data.round as number
    }
    if (evt.type === 'bid' && evt.data) {
      bids.push({
        player: evt.player_id || '',
        quantity: evt.data.quantity as number,
        face: evt.data.face as number,
      })
    }
    if (evt.type === 'challenge' && evt.data) {
      challengeData = {
        challenger: (evt.data.challenger as string) || '',
        bidder: (evt.data.bidder as string) || '',
        bidQuantity: evt.data.bid_quantity as number,
        bidFace: evt.data.bid_face as number,
        actualCount: evt.data.actual_count as number,
        bidMet: evt.data.bid_met as boolean,
        allDice: evt.data.all_dice as Record<string, number[]> | undefined,
        loser: (evt.data.loser as string) || '',
      }
      if (challengeData.loser) {
        const lp = pidOf(challengeData.loser)
        diceByPlayer[lp] = Math.max(0, (diceByPlayer[lp] ?? 5) - 1)
      }
    }
    if (evt.type === 'player_eliminated' && (evt.data?.player || evt.player_id)) {
      const pid = pidOf((evt.data?.player as string) || evt.player_id || '')
      eliminated[pid] = true
      diceByPlayer[pid] = 0
    }
  }

  const getName = (id: string) => {
    const p = match.players.find((pp) => pp.player_id === id || pp.agent_id === id)
    return p?.agent_name || id
  }

  const totalDice = Object.values(diceByPlayer).reduce((a, b) => a + b, 0)
  const totalInitial = match.players.length * 5
  const lastBid = bids[bids.length - 1] || null

  // Next seat after lastBid's, skipping eliminated players
  let actingIdx = 0
  if (lastBid) {
    const lastBidPid = pidOf(lastBid.player)
    const lastSeat = match.players.findIndex(
      (p) => (p.player_id || `p${p.position}`) === lastBidPid
    )
    if (lastSeat >= 0) {
      for (let i = 1; i <= match.players.length; i++) {
        const seat = (lastSeat + i) % match.players.length
        const pid = match.players[seat].player_id || `p${match.players[seat].position}`
        if (!eliminated[pid]) {
          actingIdx = seat
          break
        }
      }
    }
  }

  // Seats grid (shared between normal view and showdown)
  const seatsGrid = (
    <div className="seats-zone">
      <div className="seats" data-n={match.players.length}>
        {match.players.map((p, i) => {
          const pid = p.player_id || `p${p.position}`
          const dice = diceByPlayer[pid] ?? 5
          const isElim = eliminated[pid] || dice === 0
          const isActing = i === actingIdx && !isElim && !challengeData
          const revealedDice =
            (challengeData?.allDice?.[pid] as number[] | undefined) ||
            (p.agent_id ? (challengeData?.allDice?.[p.agent_id] as number[] | undefined) : undefined)
          const cls = ['seat']
          if (isActing) cls.push('acting')
          if (isElim) cls.push('eliminated')
          const isLastBidder = lastBid && pidOf(lastBid.player) === pid
          return (
            <div key={pid} className={cls.join(' ')}>
              <div className="seat-row-1">
                <div className="seat-ident">
                  <SeatAvatar player={p} />
                  <div className="seat-name-wrap">
                    <div className="seat-name">{p.agent_name || pid}</div>
                    <div className="seat-num">Seat {i + 1}</div>
                  </div>
                </div>
                <span className="seat-flag">
                  {isElim ? 'out' : isActing ? 'to act' : 'in round'}
                </span>
              </div>

              {challengeData && revealedDice ? (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {revealedDice.map((v, k) => {
                    const hit = v === challengeData!.bidFace
                    const wild = v === 1 && challengeData!.bidFace !== 1
                    return <DieGlyph key={k} face={v} kind="face" extra={hit ? 'hit' : wild ? 'wild' : ''} />
                  })}
                </div>
              ) : (
                <div className="cup">
                  <div className="cup-dice">
                    {Array.from({ length: 5 }).map((_, k) => (
                      <div key={k} className={`cup-die${k < dice ? '' : ' lost'}`}>
                        ·
                      </div>
                    ))}
                  </div>
                  <div className="cup-count">
                    <span className="n">{dice}</span>/5
                  </div>
                </div>
              )}

              <div className="seat-action">
                <span className="act-label">last</span>
                {isElim ? (
                  <span className="act-val" style={{ color: 'var(--color-ink-5)' }}>
                    eliminated
                  </span>
                ) : isActing ? (
                  <span className="act-val">
                    thinking
                    <span className="thinking">
                      <i /><i /><i />
                    </span>
                  </span>
                ) : isLastBidder && lastBid ? (
                  <span className="act-val" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {lastBid.quantity} × <DieGlyph face={lastBid.face} kind="mini" />
                  </span>
                ) : (
                  <span className="act-val" style={{ color: 'var(--color-ink-5)' }}>
                    —
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  // ── Showdown view (after challenge) ──
  if (challengeData) {
    const cd = challengeData
    const allDiceFlat: number[] = []
    if (cd.allDice) {
      for (const dice of Object.values(cd.allDice)) allDiceFlat.push(...dice)
    }
    const targetFace = cd.bidFace
    const bidderName = getName(cd.bidder)
    const challengerName = getName(cd.challenger)
    const countedRule = targetFace === 1 ? '1s only' : `${targetFace}s + wild 1s`
    return (
      <div className="liars-dice-visual">
        <div className="showdown">
          <div className="showdown-head">
            <h3>
              Showdown — <em>challenge</em>
            </h3>
            <div className="showdown-claim">
              <strong style={{ color: 'var(--color-ink-1)' }}>{bidderName}</strong>{' '}
              claimed <strong>{cd.bidQuantity} × face {targetFace}</strong>
              {' · '}
              <strong style={{ color: 'var(--color-ink-1)' }}>{challengerName}</strong> challenged
            </div>
          </div>
          <div className="showdown-row">
            <div className="showdown-dice">
              {allDiceFlat.map((v, k) => {
                const hit = v === targetFace
                const wild = v === 1 && targetFace !== 1
                return <DieGlyph key={k} face={v} kind="face" extra={hit ? 'hit' : wild ? 'wild' : ''} />
              })}
            </div>
            <div className="showdown-tally">
              <div className="n">
                <span className="terra">{cd.actualCount}</span> / {cd.bidQuantity}
              </div>
              <div className="d">actual · claimed</div>
            </div>
          </div>
          <div className={`showdown-verdict${cd.bidMet ? '' : ' fail'}`}>
            <div className="showdown-verdict-main">
              <strong>{cd.bidMet ? 'Bid stands.' : 'Bid falls.'}</strong>
              <span>
                Claim was <strong>{cd.bidQuantity} × face {targetFace}</strong>; actual count was{' '}
                <strong>{cd.actualCount}</strong> ({countedRule}).
              </span>
            </div>
            <div className="showdown-verdict-loss">
              {cd.bidMet ? (
                <>
                  Actual reached the claim, so challenger <em>{challengerName}</em> loses 1 die.
                </>
              ) : (
                <>
                  Actual was short of the claim, so bidder <em>{bidderName}</em> loses 1 die.
                </>
              )}
            </div>
          </div>
        </div>
        {seatsGrid}
      </div>
    )
  }

  // ── Normal bid view ──
  return (
    <div className="liars-dice-visual">
      <div className="dice-board">
        <div className="dice-board-row">
          <div className="round-meta">
            <span className="round-chip">Round {round}</span>
            <span className="dice-left">
              <strong>{totalDice}</strong> dice · of {totalInitial}
            </span>
          </div>
          {lastBid ? (
            <div className="bid-hero">
              <div className="bid-big">
                <span className="bid-count">{lastBid.quantity}</span>
                <span className="bid-x">×</span>
                <DieGlyph face={lastBid.face} kind="bid" />
              </div>
              <div className="bid-caption">
                <em>
                  {lastBid.quantity} × {lastBid.face}s
                </em>
              </div>
            </div>
          ) : (
            <div className="bid-hero">
              <div className="bid-caption">
                <em>Awaiting first bid</em>
              </div>
            </div>
          )}
          <div className="acting-meta">
            <span className="acting-meta-label">To act</span>
            <span className="acting-meta-who">{match.players[actingIdx]?.agent_name || '—'}</span>
          </div>
        </div>
      </div>

      {bids.length > 0 && (
        <div className="bid-trail">
          <div className="bid-trail-head">
            <span>Bid history</span>
            <span>#{bids.length}</span>
          </div>
          <div className="trail-chips">
            {bids.slice(-6).flatMap((bid, i, arr) => {
              const isCur = i === arr.length - 1
              const chip = (
                <div key={`chip-${i}`} className={`bid-chip${isCur ? ' cur' : ''}`}>
                  <span className="who">{getName(bid.player)}</span>
                  <span>{bid.quantity} ×</span>
                  <DieGlyph face={bid.face} kind="mini" />
                </div>
              )
              return i > 0 ? [<div key={`sep-${i}`} className="bid-chip-sep" />, chip] : [chip]
            })}
          </div>
        </div>
      )}

      {seatsGrid}
    </div>
  )
}

// --- Shared Components ---

function EventBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    player_action: 'bg-tertiary/10 text-tertiary',
    card_dealt: 'bg-primary/10 text-primary',
    cards_dealt: 'bg-primary/10 text-primary',
    community_cards: 'bg-primary-container/15 text-primary-container',
    bet_placed: 'bg-tertiary/10 text-tertiary',
    hand_result: 'bg-primary-container/15 text-primary',
    game_over: 'bg-primary-container/15 text-primary',
    // Coup events
    action_declared: 'bg-tertiary/10 text-tertiary',
    challenge: 'bg-error/10 text-error',
    block: 'bg-primary-container/15 text-primary-container',
    influence_lost: 'bg-error/10 text-error',
    // Skull events
    disc_placed: 'bg-primary/10 text-primary',
    bid: 'bg-tertiary/10 text-tertiary',
    flip: 'bg-tertiary/15 text-tertiary',
    skull_revealed: 'bg-error/10 text-error',
    // Auction War events
    bid_placed: 'bg-tertiary/10 text-tertiary',
    round_result: 'bg-tertiary/10 text-tertiary',
    card_awarded: 'bg-primary-container/15 text-primary-container',
    // Shared
    round_start: 'bg-surface-container-highest text-on-surface-variant',
    settlement: 'bg-tertiary/10 text-tertiary',
  }
  const color = colors[type] || 'bg-surface-container-highest text-on-surface-variant'

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-label ${color}`}>
      {type}
    </span>
  )
}

function EventDetail({ event, match, isLive }: { event: MatchEvent; match?: MatchDetail; isLive?: boolean }) {
  const resolveName = (pid: string) => match ? (isLive ? findAnonName(match, pid) : findPlayerName(match, pid)) : pid
  const data = event.data
  if (!data || Object.keys(data).length === 0) return null

  switch (event.type) {
    case 'player_action':
      return <span className="text-on-surface">{String(data.action)}{data.amount != null ? ` (${data.amount})` : ''}{data.position != null ? ` at position ${data.position}` : ''}</span>
    case 'bet_placed':
      return <span className="text-tertiary">Bet: {String(data.amount)}</span>
    case 'card_dealt':
      return <span className="text-primary">{String(data.card)} (hand {String(data.hand)})</span>
    case 'cards_dealt':
      return <span className="text-primary">{Array.isArray(data.cards) ? (data.cards as string[]).join(' ') : JSON.stringify(data.cards)}</span>
    case 'community_cards':
      return <span className="text-primary-container">{String(data.phase)}: {Array.isArray(data.cards) ? (data.cards as string[]).join(' ') : ''}</span>
    case 'dealer_upcard':
      return <span className="text-on-surface">Upcard: {String(data.upcard)}</span>
    case 'dealer_reveal':
      return <span className="text-on-surface">Cards: {Array.isArray(data.cards) ? (data.cards as string[]).join(' ') : ''} (total: {String(data.total)})</span>
    case 'dealer_hit':
      return <span className="text-on-surface">{String(data.card)} (total: {String(data.total)})</span>
    case 'hand_bust':
      return <span className="text-error">Bust! Total: {String(data.total)}</span>
    case 'hand_split':
      return <span className="text-tertiary">Split hand {String(data.hand)} &rarr; {String(data.new_hand)}</span>
    case 'double_down':
      return <span className="text-primary">Double: {String(data.card)} (new bet: {String(data.new_bet)})</span>
    case 'settlement':
      return <span className="text-tertiary">Payout: {String(data.payout)}, Chips: {String(data.chips)}</span>
    case 'hand_result': {
      const winners = Array.isArray(data.winners) ? (data.winners as string[]) : [String(data.winners)]
      const winnerNames = winners.map(w => resolveName(w))
      return (
        <span className="text-primary">
          {data.reason === 'showdown' ? 'Showdown' : 'All folded'} — Winner: {winnerNames.join(', ')}
        </span>
      )
    }
    case 'match_result': {
      const winner = String(data.winner || '')
      return (
        <span className="text-primary font-semibold">
          Match Over — {resolveName(winner)} wins ({data.reason === 'opponent_eliminated' ? 'opponent eliminated' : `${data.hand} hands`})
        </span>
      )
    }
    case 'new_hand':
      return (
        <span className="text-tertiary">
          Hand {String(data.hand_num)} — Chips: {JSON.stringify(data.chips)}
        </span>
      )
    default:
      return <span className="text-on-surface-variant font-label text-[10px]">{JSON.stringify(data)}</span>
  }
}

function findPlayerName(match: MatchDetail, playerIdOrAgentId: string): string {
  for (const p of match.players) {
    if (p.agent_id === playerIdOrAgentId) return p.agent_name || p.player_id
  }
  for (const p of match.players) {
    if (p.player_id === playerIdOrAgentId) return p.agent_name || p.player_id
  }
  return playerIdOrAgentId.slice(0, 8)
}

function findAnonName(match: MatchDetail, playerIdOrAgentId: string): string {
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i]
    if (p.agent_id === playerIdOrAgentId || p.player_id === playerIdOrAgentId) {
      return ANON_NAMES[i] || `Player ${i + 1}`
    }
  }
  return ANON_NAMES[0] || 'Player'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

// ─── Exports used by the new ReplayPage shell ───
export {
  GameStateVisual,
  EventBadge,
  EventDetail,
  findPlayerName,
  findAnonName,
  resolvePlayerName,
  formatDuration,
  ANON_NAMES,
}
