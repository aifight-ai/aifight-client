export type BoardPhase = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

type BoardV2Props = {
  communityCards: string[]
  phase: BoardPhase
  pot: number
  handNum: number
  maxHands: number
  levelLabel?: string
  blinds?: { sb: number; bb: number }
  currentTurnLabel?: string
}

const PHASES: BoardPhase[] = ['preflop', 'flop', 'turn', 'river', 'showdown']
const PHASE_TITLE: Record<BoardPhase, string> = {
  preflop: 'Pre-flop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
}

function parseBoardCard(code: string): { rank: string; suit: string; red: boolean } {
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

function BoardCardBig({ code }: { code?: string }) {
  if (!code) return <div className="card big pending" />
  const { rank, suit, red } = parseBoardCard(code)
  return (
    <div className={`card big${red ? ' red' : ''}`}>
      {rank}
      <span className="suit">{suit}</span>
    </div>
  )
}

export default function BoardV2({
  communityCards,
  phase,
  pot,
  handNum,
  maxHands,
  levelLabel,
  blinds,
  currentTurnLabel,
}: BoardV2Props) {
  const phaseIdx = PHASES.indexOf(phase)
  return (
    <div className="board-wrap">
      <div className="board-row">
        <div className="slot-left">
          <span className="phase-chip">{PHASE_TITLE[phase]}</span>
          <span className="hand-meta">
            Hand {handNum}
            {maxHands > 0 ? ` / ${maxHands}` : ''}
            {levelLabel ? ` · Level ${levelLabel}` : ''}
          </span>
          {currentTurnLabel && (
            <span className="hand-meta hand-meta-accent">{currentTurnLabel}</span>
          )}
        </div>
        <div className="board">
          {[0, 1, 2, 3, 4].map(i => (
            <BoardCardBig key={i} code={communityCards[i]} />
          ))}
        </div>
        <div className="slot-right">
          <div className="pot-big">
            <div className="d">Pot</div>
            <div className="n">{pot.toLocaleString()}</div>
            {blinds && (
              <div className="blinds">
                Blinds {blinds.sb.toLocaleString()} / {blinds.bb.toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="phases">
        {PHASES.map((p, i) => {
          const cls = ['phase']
          if (i < phaseIdx) cls.push('done')
          if (i === phaseIdx) cls.push('cur')
          return (
            <div key={p} className={cls.join(' ')}>
              {PHASE_TITLE[p]}
            </div>
          )
        })}
      </div>
    </div>
  )
}
