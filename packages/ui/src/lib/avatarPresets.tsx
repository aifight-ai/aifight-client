// Avatar preset catalog — the built-in avatars an owner can pick (no upload
// needed). Owner decision: offer BOTH a Slack/Discord-style ICON set and an
// abstract GEOMETRIC set. Presets are rendered deterministically by the client
// (web + desktop share this via the @avatar alias) — the server stores only the
// preset id, never an image. So a preset costs zero storage and renders
// identically everywhere the AgentAvatar component is used.
//
// Stability contract: a preset `id` is persisted in agents.metadata. NEVER
// rename or repurpose an existing id — only add new ones. An unknown id falls
// back to the deterministic gradient+initials, so removing one degrades
// gracefully but silently changes a user's chosen look; treat ids as permanent.

import type { ComponentType } from 'react'
import {
  Anchor,
  Atom,
  Bird,
  Bot,
  Cat,
  Crown,
  Diamond,
  Dog,
  Feather,
  Fish,
  Flame,
  Ghost,
  Leaf,
  Moon,
  Rabbit,
  Rocket,
  Skull,
  Sparkles,
  Star,
  Sun,
  Swords,
  Zap,
} from 'lucide-react'

export type AvatarGradient = readonly [string, string]

export interface IconPreset {
  kind: 'icon'
  id: string
  Icon: ComponentType<{ size?: number | string; color?: string; strokeWidth?: number }>
  gradient: AvatarGradient
}

export type GeoMotif = 'rings' | 'diagonal' | 'dots' | 'triangles' | 'grid' | 'burst'

export interface GeoPreset {
  kind: 'geo'
  id: string
  gradient: AvatarGradient
  motif: GeoMotif
}

export type AvatarPreset = IconPreset | GeoPreset

// A small curated gradient palette (distinct hues, good white-icon contrast).
const G = {
  coral: ['#FF8A5B', '#E0533B'] as const,
  amber: ['#F6B24A', '#E07A1F'] as const,
  teal: ['#3FB7A6', '#1E7D78'] as const,
  ocean: ['#5AA9E6', '#2E6FB0'] as const,
  violet: ['#9B7DE0', '#6B4BB0'] as const,
  rose: ['#F177A8', '#C23E78'] as const,
  lime: ['#9CCB52', '#5E9A2E'] as const,
  slate: ['#6E7E92', '#3C4858'] as const,
  gold: ['#E8C15A', '#B8862B'] as const,
  plum: ['#B36BC9', '#7A3E9A'] as const,
}

// ICON presets — one curated icon ⇄ gradient pairing each. id = `icon-<name>`.
export const ICON_PRESETS: IconPreset[] = [
  { kind: 'icon', id: 'icon-rocket', Icon: Rocket, gradient: G.coral },
  { kind: 'icon', id: 'icon-bot', Icon: Bot, gradient: G.slate },
  { kind: 'icon', id: 'icon-cat', Icon: Cat, gradient: G.amber },
  { kind: 'icon', id: 'icon-dog', Icon: Dog, gradient: G.gold },
  { kind: 'icon', id: 'icon-bird', Icon: Bird, gradient: G.ocean },
  { kind: 'icon', id: 'icon-fish', Icon: Fish, gradient: G.teal },
  { kind: 'icon', id: 'icon-rabbit', Icon: Rabbit, gradient: G.rose },
  { kind: 'icon', id: 'icon-ghost', Icon: Ghost, gradient: G.violet },
  { kind: 'icon', id: 'icon-skull', Icon: Skull, gradient: G.slate },
  { kind: 'icon', id: 'icon-crown', Icon: Crown, gradient: G.gold },
  { kind: 'icon', id: 'icon-flame', Icon: Flame, gradient: G.coral },
  { kind: 'icon', id: 'icon-zap', Icon: Zap, gradient: G.amber },
  { kind: 'icon', id: 'icon-star', Icon: Star, gradient: G.violet },
  { kind: 'icon', id: 'icon-sparkles', Icon: Sparkles, gradient: G.plum },
  { kind: 'icon', id: 'icon-diamond', Icon: Diamond, gradient: G.ocean },
  { kind: 'icon', id: 'icon-leaf', Icon: Leaf, gradient: G.lime },
  { kind: 'icon', id: 'icon-feather', Icon: Feather, gradient: G.teal },
  { kind: 'icon', id: 'icon-moon', Icon: Moon, gradient: G.slate },
  { kind: 'icon', id: 'icon-sun', Icon: Sun, gradient: G.amber },
  { kind: 'icon', id: 'icon-swords', Icon: Swords, gradient: G.rose },
  { kind: 'icon', id: 'icon-anchor', Icon: Anchor, gradient: G.ocean },
  { kind: 'icon', id: 'icon-atom', Icon: Atom, gradient: G.plum },
]

// GEO presets — abstract gradient + motif, no icon. id = `geo-<name>`.
export const GEO_PRESETS: GeoPreset[] = [
  { kind: 'geo', id: 'geo-aurora', gradient: G.teal, motif: 'rings' },
  { kind: 'geo', id: 'geo-dusk', gradient: G.violet, motif: 'diagonal' },
  { kind: 'geo', id: 'geo-ember', gradient: G.coral, motif: 'burst' },
  { kind: 'geo', id: 'geo-tide', gradient: G.ocean, motif: 'dots' },
  { kind: 'geo', id: 'geo-meadow', gradient: G.lime, motif: 'triangles' },
  { kind: 'geo', id: 'geo-orchid', gradient: G.rose, motif: 'grid' },
  { kind: 'geo', id: 'geo-sand', gradient: G.gold, motif: 'diagonal' },
  { kind: 'geo', id: 'geo-storm', gradient: G.slate, motif: 'rings' },
]

const PRESET_BY_ID: Map<string, AvatarPreset> = new Map(
  [...ICON_PRESETS, ...GEO_PRESETS].map((p) => [p.id, p]),
)

/** Look up a preset by id; null when the id is unknown (→ caller falls back). */
export function getAvatarPreset(id: string | null | undefined): AvatarPreset | null {
  if (!id) return null
  return PRESET_BY_ID.get(id) ?? null
}

export function gradientCss(g: AvatarGradient): string {
  return `linear-gradient(135deg, ${g[0]}, ${g[1]})`
}

// ─── preset tile rendering (shared by AgentAvatar + the picker) ─────────────

const INK = 'rgba(255,255,255,0.82)'

function MotifSvg({ motif }: { motif: GeoMotif }) {
  const common = { stroke: INK, strokeWidth: 5, fill: 'none' as const }
  let shapes: React.ReactNode
  switch (motif) {
    case 'rings':
      shapes = (
        <>
          <circle cx="50" cy="50" r="30" {...common} />
          <circle cx="50" cy="50" r="16" {...common} />
        </>
      )
      break
    case 'diagonal':
      shapes = (
        <>
          <line x1="-10" y1="40" x2="60" y2="-30" {...common} />
          <line x1="10" y1="120" x2="120" y2="10" {...common} />
          <line x1="40" y1="120" x2="120" y2="40" {...common} />
        </>
      )
      break
    case 'dots':
      shapes = [20, 50, 80].flatMap((cy) =>
        [20, 50, 80].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="6" fill={INK} />),
      )
      break
    case 'triangles':
      shapes = (
        <>
          <polygon points="50,18 78,68 22,68" {...common} strokeLinejoin="round" />
          <polygon points="50,40 64,68 36,68" fill={INK} />
        </>
      )
      break
    case 'grid':
      shapes = (
        <>
          {[28, 50, 72].map((p) => (
            <line key={`h${p}`} x1="10" y1={p} x2="90" y2={p} {...common} strokeWidth={3} />
          ))}
          {[28, 50, 72].map((p) => (
            <line key={`v${p}`} x1={p} y1="10" x2={p} y2="90" {...common} strokeWidth={3} />
          ))}
        </>
      )
      break
    case 'burst':
      shapes = [0, 45, 90, 135].map((deg) => (
        <line
          key={deg}
          x1="50"
          y1="50"
          x2={50 + 42 * Math.cos((deg * Math.PI) / 180)}
          y2={50 + 42 * Math.sin((deg * Math.PI) / 180)}
          {...common}
        />
      ))
      break
  }
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block' }} aria-hidden>
      {shapes}
    </svg>
  )
}

/** Full-bleed preset content (gradient + icon/motif). The parent supplies the
 *  rounded-square clip; this fills it edge to edge.
 *
 *  Pass a numeric `size` for fixed-size placements (AgentAvatar, picker), or
 *  `size="fill"` to stretch to the parent box — used by CSS-sized replay/live
 *  seat avatars where the pixel size is responsive and not known here. */
export function AvatarPresetTile({ preset, size }: { preset: AvatarPreset; size: number | 'fill' }) {
  const fill = size === 'fill'
  const dim = fill ? '100%' : size
  return (
    <div
      style={{
        width: dim,
        height: dim,
        background: gradientCss(preset.gradient),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {preset.kind === 'icon' ? (
        <preset.Icon size={fill ? '52%' : Math.round((size as number) * 0.52)} color="#fff" strokeWidth={2.1} />
      ) : (
        <div style={{ width: '74%', height: '74%' }}>
          <MotifSvg motif={preset.motif} />
        </div>
      )}
    </div>
  )
}
