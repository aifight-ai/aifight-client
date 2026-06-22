// Shared deterministic visual identity for AI agents.
//
// One canonical place for: initials, gradient color, and identicon seed —
// so the dashboard, leaderboard, agent profile, live seats, and replay all
// render the SAME agent the SAME way. Previously the initials logic was
// duplicated in web (getAgentInitials) and desktop (initialsOf), each with a
// single-word bug ("Alpha" -> "AL" instead of "A").
//
// Avatar render contract used everywhere (see AgentAvatar):
//   real image (avatarUrl) -> mystery identicon (seeded by id) -> gradient+initials
// Mystery agents NEVER seed their visual from the name (it would leak the
// masked identity); they seed from the agent id only.

/** Initials for an agent name. Single word -> first letter only (fixes the
 *  old "Alpha" -> "AL" bug); multi-word -> first letter of the first two
 *  words. Empty/garbage -> "AI". Always uppercase. */
export function agentInitials(name: string | null | undefined): string {
  const clean = (name ?? '').trim()
  if (!clean) return 'AI'
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    // Single token: take the first letter only. A CJK or single-glyph name
    // takes that one glyph; a long single word still reads as one letter,
    // which pairs better with the gradient tile than two cramped letters.
    return [...parts[0]][0]!.toUpperCase()
  }
  return `${[...parts[0]][0] ?? ''}${[...parts[1]][0] ?? ''}`.toUpperCase()
}

/** Stable 32-bit FNV-1a hash of a string. Used to pick a gradient and to
 *  seed the identicon — same input always yields the same visual. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Curated gradient pairs — sophisticated, muted, on the warm-paper editorial
// palette (terracotta-led) plus a handful of cool/neutral families so a
// roster of agents reads as distinct without looking like a rainbow. Each is
// [from, to] for a 135deg linear-gradient. Tuned to carry white serif
// initials at WCAG-comfortable contrast.
const AGENT_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#FF8A3D', '#D85C00'], // terracotta (brand)
  ['#F2994A', '#C4621A'], // amber clay
  ['#E0726B', '#A8443D'], // dusty coral
  ['#6F9FE0', '#3A5FA8'], // editorial blue
  ['#5FB3A1', '#2E7665'], // muted teal
  ['#9A8CD0', '#5F4FA0'], // soft violet
  ['#7FA86F', '#4C7A3C'], // sage green
  ['#D08AA8', '#9A4D6E'], // dusty rose
  ['#C9A14A', '#917019'], // antique gold
  ['#7C8CA0', '#4A586B'], // slate (neutral fallback family)
]

/** Pick a deterministic gradient pair for a seed (prefer the agent id, fall
 *  back to the name). Same seed -> same colors, forever, no storage. */
export function agentGradient(seed: string): readonly [string, string] {
  return AGENT_GRADIENTS[hashSeed(seed) % AGENT_GRADIENTS.length]!
}

/** CSS `background` value for the gradient tile. */
export function agentGradientCss(seed: string): string {
  const [from, to] = agentGradient(seed)
  return `linear-gradient(135deg, ${from}, ${to})`
}

/** Border radius (px) for the rounded-square avatar tile at a given pixel
 *  size. Owner decision: rounded square everywhere, not circles. Scales so
 *  small chips and large heroes keep the same visual softness. */
export function agentAvatarRadius(size: number): number {
  return Math.max(4, Math.round(size * 0.28))
}
