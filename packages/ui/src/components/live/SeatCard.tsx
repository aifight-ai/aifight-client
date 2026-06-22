import type { ReactNode } from 'react'
import { identiconDataUri } from '../../lib/identicon'
import { AvatarPresetTile, getAvatarPreset } from '../../lib/avatarPresets'

export type SeatPosition = 'BTN' | 'SB' | 'BB'
export type SeatStatus = 'active' | 'acting' | 'folded' | 'busted'

type SeatCardProps = {
  seatIndex: number
  name: string
  rating?: number
  stack: number
  holeCards: string[] | null
  hasDealt?: boolean
  lastAction?: { action: string; amount?: number }
  handName?: string
  commit?: number
  status: SeatStatus
  positions: SeatPosition[]
  totalSeats: number
  isWinner?: boolean
  /** Avatar identity seed. In LIVE games pass an anonymous, position-derived
   *  seed (never the real agent id) so spectators can't track agents. */
  avatarSeed?: string
  /** Owner-set avatar image (replay only; never in live or for mystery). */
  avatarUrl?: string | null
  /** Owner-chosen built-in preset id (replay only; never in live or for mystery). */
  avatarPreset?: string | null
  /** Mystery agent → id-seeded identicon instead of initials. */
  mystery?: boolean
}

const ACTION_LABEL: Record<string, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  raise: 'raise',
  allin: 'all-in',
  bet: 'bet',
  small_blind: 'small blind',
  big_blind: 'big blind',
}

function parseCardForSeat(code: string): { rank: string; suit: string; red: boolean } {
  if (!code || code.length < 2) return { rank: '?', suit: '', red: false }
  const rankPart = code.slice(0, -1)
  const suitChar = code.slice(-1).toLowerCase()
  const rankMap: Record<string, string> = { T: '10' }
  const rank = rankMap[rankPart] || rankPart
  const suits: Record<string, { sym: string; red: boolean }> = {
    h: { sym: '\u2665', red: true },
    d: { sym: '\u2666', red: true },
    c: { sym: '\u2663', red: false },
    s: { sym: '\u2660', red: false },
  }
  const s = suits[suitChar] || { sym: suitChar, red: false }
  return { rank, suit: s.sym, red: s.red }
}

function HoleCardSm({ code, hidden }: { code?: string; hidden?: boolean }) {
  if (hidden || !code) {
    return <div className="card sm hidden" />
  }
  const { rank, suit, red } = parseCardForSeat(code)
  return (
    <div className={`card sm${red ? ' red' : ''}`}>
      {rank}
      <span className="suit">{suit}</span>
    </div>
  )
}

export default function SeatCard({
  seatIndex,
  name,
  rating,
  stack,
  holeCards,
  hasDealt = true,
  lastAction,
  handName,
  commit = 0,
  status,
  positions,
  isWinner = false,
  avatarSeed,
  avatarUrl,
  avatarPreset,
  mystery = false,
}: SeatCardProps) {
  const classes = ['seat']
  if (status === 'acting') classes.push('acting')
  if (status === 'folded') classes.push('folded')
  if (status === 'busted') classes.push('busted')
  if (isWinner) classes.push('winner')

  // Avatar identity (rounded square, CSS-sized). Precedence: uploaded image >
  // chosen preset > deterministic geometric identicon (no initials). Seeded by
  // `avatarSeed` so a rename keeps the pattern and live games stay anonymous
  // (position-seeded, never the agent id). Mystery seats ignore avatarUrl/preset
  // and always take the identicon so identity can never leak.
  const seed = avatarSeed || name || 'agent'
  const presetDef = !mystery && !avatarUrl ? getAvatarPreset(avatarPreset) : null
  const avatarImg = !mystery && avatarUrl ? avatarUrl : presetDef ? null : identiconDataUri(seed, 64)
  const showCommit = commit > 0 && status !== 'folded' && status !== 'busted'

  let flag = 'in hand'
  if (status === 'busted') flag = 'out'
  else if (status === 'folded') flag = 'folded'
  else if (status === 'acting') flag = 'to act'

  let actionNode: ReactNode = <span className="act-val muted">—</span>
  if (status === 'busted') {
    actionNode = <span className="act-val fold">out of chips</span>
  } else if (status === 'folded') {
    actionNode = <span className="act-val fold">fold</span>
  } else if (status === 'acting') {
    actionNode = (
      <span className="act-val">
        thinking
        <span className="thinking"><i /><i /><i /></span>
      </span>
    )
  } else if (lastAction) {
    const label = ACTION_LABEL[lastAction.action] || lastAction.action
    const hasAmount =
      lastAction.action !== 'fold' &&
      lastAction.action !== 'check' &&
      lastAction.amount !== undefined
    const amt = hasAmount ? ` ${(lastAction.amount as number).toLocaleString()}` : ''
    actionNode = <span className="act-val">{label}{amt}</span>
  }

  let holeContent: ReactNode = null
  if (holeCards && holeCards.length > 0) {
    holeContent = holeCards.slice(0, 2).map((c, i) => <HoleCardSm key={i} code={c} />)
  } else if (holeCards === null && hasDealt && status !== 'busted') {
    holeContent = (
      <>
        <HoleCardSm hidden />
        <HoleCardSm hidden />
      </>
    )
  }

  return (
    <div className={classes.join(' ')} data-seat={seatIndex}>
      {showCommit && <div className="commit">{commit.toLocaleString()}</div>}

      <div className="seat-row-1">
        <div className="seat-ident">
          <div className="seat-avatar">
            {avatarImg ? (
              <img src={avatarImg} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' }} />
            ) : presetDef ? (
              <AvatarPresetTile preset={presetDef} size="fill" />
            ) : null}
          </div>
          <div className="seat-name-wrap">
            <div className="seat-name" title={name}>
              {isWinner && <span className="seat-crown" aria-hidden>♛ </span>}
              {name}
            </div>
            <div className="seat-num">
              Seat {seatIndex + 1}
              {rating !== undefined && (
                <>
                  <span className="seat-num-sep"> · </span>
                  <span className="seat-rating">★{Math.round(rating)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span className="seat-flag">{flag}</span>
      </div>

      <div className="seat-row-2">
        <div className="stack">
          <div className="stack-n">{stack.toLocaleString()}</div>
          <div className="stack-d">stack</div>
        </div>
        <div className="hole">{holeContent}</div>
      </div>

      <div className="seat-row-3">
        <div className="seat-pos-chips">
          {positions.length > 0
            ? positions.map(p => (
                <span key={p} className={`pos-chip ${p.toLowerCase()}`}>{p}</span>
              ))
            : <span className="seat-pos-empty">&nbsp;</span>}
        </div>
        {actionNode}
      </div>

      {handName && (
        <div className="seat-hand-name">{handName}</div>
      )}
    </div>
  )
}
