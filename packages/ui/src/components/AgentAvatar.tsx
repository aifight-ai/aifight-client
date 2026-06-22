// The one canonical agent avatar, used everywhere an agent is shown:
// dashboard, agent profile, leaderboard, live seats, replay. Owner decision:
// rounded SQUARE (not circle), and the avatar follows the agent across every
// surface.
//
// Render contract (precedence):
//   1. uploaded avatarUrl       -> the agent's real image
//   2. chosen preset            -> deterministic icon/geo tile
//   3. otherwise (DEFAULT)      -> deterministic geometric identicon seeded by
//                                  id (NO letter initials — owner decision)
//
// Mystery masking note: for a masked agent the SERVER must never send a real
// name or a real avatarUrl (it would leak identity in live games); this
// component is the last line of defense — when `mystery` is set it ALWAYS
// renders the id-seeded identicon, ignoring avatarUrl and preset.

import { useMemo } from 'react'
import { agentAvatarRadius } from '../lib/agentVisual'
import { identiconDataUri } from '../lib/identicon'
import { AvatarPresetTile, getAvatarPreset } from '../lib/avatarPresets'

export type AgentStatus = 'online' | 'offline' | 'in_match' | 'in_queue' | string

export interface AgentAvatarProps {
  /** Agent name; drives the initials + non-mystery gradient seed. */
  name?: string | null
  /** Stable agent id; preferred seed (so a rename keeps the same color) and
   *  the ONLY seed for mystery identicons. */
  agentId?: string | null
  /** Real avatar image URL (uploaded). Wins over preset/initials/identicon. */
  avatarUrl?: string | null
  /** Chosen built-in preset id (rendered deterministically; see avatarPresets). */
  preset?: string | null
  /** Masked/anonymous agent: never render name-derived OR owner-chosen visuals. */
  mystery?: boolean
  /** Pixel size of the square tile. */
  size?: number
  /** Optional live-status dot in the corner. */
  status?: AgentStatus
  /** Extra ring/shadow for hero placements. */
  elevated?: boolean
  className?: string
  title?: string
}

const STATUS_DOT: Record<string, string> = {
  online: 'var(--color-ok)',
  in_match: 'var(--color-terracotta)',
  in_queue: 'var(--color-terracotta)',
  offline: 'var(--color-ink-5)',
}

export function AgentAvatar({
  name,
  agentId,
  avatarUrl,
  preset,
  mystery = false,
  size = 40,
  status,
  elevated = false,
  className,
  title,
}: AgentAvatarProps) {
  const seed = (agentId && agentId.length > 0 ? agentId : name) || 'agent'
  const radius = agentAvatarRadius(size)

  // A chosen avatar (uploaded image or preset) wins. Otherwise EVERY agent —
  // including mystery ones — falls back to the deterministic id-seeded geometric
  // identicon (owner decision: no letter initials anywhere). Mystery agents
  // ALWAYS take the identicon path, ignoring avatarUrl/preset, as the last line
  // of defense against an identity leak.
  const presetDef = !mystery && !avatarUrl ? getAvatarPreset(preset) : null
  const useIdenticon = mystery || (!avatarUrl && !presetDef)
  const identicon = useMemo(
    () => (useIdenticon ? identiconDataUri(seed, Math.max(64, size * 2)) : null),
    [useIdenticon, seed, size],
  )

  const tileStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    overflow: 'hidden',
    position: status ? 'relative' : undefined,
    boxShadow: elevated ? 'var(--shadow-paper-1)' : undefined,
  }

  let inner: React.ReactNode
  if (identicon) {
    inner = (
      <img
        src={identicon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, display: 'block', borderRadius: radius }}
      />
    )
  } else if (avatarUrl) {
    inner = (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'cover', display: 'block', borderRadius: radius }}
      />
    )
  } else {
    inner = <AvatarPresetTile preset={presetDef!} size={size} />
  }

  return (
    <div className={className} style={tileStyle} title={title ?? undefined} aria-hidden={!title}>
      {inner}
      {status && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: Math.max(8, Math.round(size * 0.26)),
            height: Math.max(8, Math.round(size * 0.26)),
            borderRadius: '50%',
            background: STATUS_DOT[status] ?? 'var(--color-ink-5)',
            border: '2px solid var(--color-canvas)',
          }}
        />
      )}
    </div>
  )
}

export default AgentAvatar
