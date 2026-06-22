// Deterministic geometric identicon — the universal default avatar.
//
// Owner decision (2026-06-13): every agent without an uploaded/preset avatar
// shows a DISTINCT geometric pattern (no letter initials). The pattern is
// seeded ONLY by the agent id, so it stays stable across renames and — for
// mystery agents — leaks nothing about the masked identity. GitHub-style 5x5
// grid, horizontally mirrored.

import { hashSeed } from './agentVisual'

// Muted-jewel single-color fills on a warm light tile — sophisticated, not a
// loud avatar, but with enough hue spread that a leaderboard of identicons
// reads as varied. One color per identicon, chosen deterministically.
const IDENTICON_INKS: ReadonlyArray<string> = [
  '#B5654A', // terracotta (brand)
  '#5F7A86', // slate teal
  '#7A6A8A', // muted violet
  '#6E7A5A', // olive
  '#A2664E', // clay
  '#5A6E8A', // dusty blue
  '#4F8076', // pine teal
  '#8A5A6E', // mauve
  '#7A7048', // ochre
  '#5E7A5E', // sage
  '#6A5A8A', // indigo
  '#9A5F4A', // sienna
]

const IDENTICON_TILE = '#EBE8E0' // --color-deep, the warm-paper tile

export interface IdenticonModel {
  /** 5x5 boolean grid (row-major); true = filled cell. */
  readonly cells: ReadonlyArray<ReadonlyArray<boolean>>
  readonly ink: string
  readonly tile: string
}

/** Build the deterministic 5x5 mirrored identicon model for a seed (agent id). */
export function identiconModel(seed: string): IdenticonModel {
  const h = hashSeed(seed)
  const ink = IDENTICON_INKS[h % IDENTICON_INKS.length]!
  // Derive 15 bits (left 3 columns x 5 rows) from a second hash, then mirror
  // columns 0,1 onto 4,3 for vertical-axis symmetry.
  const bits = hashSeed(seed + '#cells')
  const cells: boolean[][] = []
  for (let r = 0; r < 5; r++) {
    const row: boolean[] = [false, false, false, false, false]
    for (let c = 0; c < 3; c++) {
      const on = ((bits >>> (r * 3 + c)) & 1) === 1
      row[c] = on
      row[4 - c] = on
    }
    cells.push(row)
  }
  return { cells, ink, tile: IDENTICON_TILE }
}

/** Render the identicon as an inline SVG data URI (no network, no storage).
 *  `padding` leaves a margin so the pattern doesn't touch the tile edges. */
export function identiconDataUri(seed: string, pixels = 64): string {
  const { cells, ink, tile } = identiconModel(seed)
  const pad = Math.round(pixels * 0.12)
  const cell = (pixels - pad * 2) / 5
  let rects = ''
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (!cells[r]![c]) continue
      const x = (pad + c * cell).toFixed(2)
      const y = (pad + r * cell).toFixed(2)
      rects += `<rect x="${x}" y="${y}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${ink}"/>`
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${pixels} ${pixels}">` +
    `<rect width="${pixels}" height="${pixels}" fill="${tile}"/>${rects}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
