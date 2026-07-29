// AvatarPicker — owner-facing avatar chooser for an agent. Two ways to set one:
//   · pick a built-in preset (icon or geometric) from the gallery, or
//   · upload an image (downscaled here first; the server still center-crops,
//     resizes and re-validates — the client is an optimization, never a guard).
// Plus a "use auto" clear that drops back to the deterministic fallback.
//
// Used in three places with DIFFERENT auth paths, so the network calls are
// injected as `actions` rather than hard-wired:
//   · web personal dashboard drawer — owner-cookie endpoints (ownerAvatarActions).
//   · enterprise dashboard — org-scoped endpoints (manage_agents permission).
//   · desktop app — Electron IPC → bridge X-API-Key endpoints.
// The component owns its busy/error state and calls onChanged() after a
// successful mutation so the parent can refresh the agent.

import { useRef, useState } from 'react'
import { AgentAvatar } from './AgentAvatar'
import { ICON_PRESETS, GEO_PRESETS } from '../lib/avatarPresets'

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024

// Longest edge we send. The largest rendered avatar is 256px, so 512 leaves 2×
// headroom for a future retina/bigger bucket while making a phone photo
// (4032×3024 ≈ 12M px, ~6 MB) arrive as ~0.26M px and a couple hundred KB.
//
// Why downscale here at all: the server must decode the WHOLE image before it
// can crop, and that decode is where the memory goes (a 16.7M px PNG expands to
// ~64 MiB). Shrinking first means a real user's upload never costs the server
// that — and their upload finishes far quicker on a slow connection too.
// This is NOT a security control: an attacker just posts to the API directly,
// which is what the server-side pixel cap + decode concurrency limit are for.
const MAX_UPLOAD_EDGE = 512

/**
 * Returns a downscaled copy of `file` when it is larger than MAX_UPLOAD_EDGE,
 * else the original untouched (no needless re-encode / quality loss).
 * Any failure falls back to the original — the server re-validates regardless.
 */
export async function downscaleForUpload(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file // undecodable here (e.g. exotic colour profile) — let the server judge
  }
  try {
    const { width, height } = bitmap
    if (width <= MAX_UPLOAD_EDGE && height <= MAX_UPLOAD_EDGE) return file
    const scale = MAX_UPLOAD_EDGE / Math.max(width, height)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx === null) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    // Keep JPEG for JPEG sources (photos compress far better that way); use PNG
    // for everything else so logos keep their transparency.
    const isJpeg = /^image\/jpe?g$/i.test(file.type)
    const type = isJpeg ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92))
    if (blob === null || blob.size === 0) return file
    if (blob.size >= file.size) return file // re-encode did not help — send the original
    const name = file.name.replace(/\.[^.]+$/, '') + (isJpeg ? '.jpg' : '.png')
    return new File([blob], name, { type })
  } finally {
    bitmap.close?.()
  }
}

/** The three avatar mutations, decoupled from any specific auth path. */
export interface AvatarActions {
  setPreset: (presetId: string) => Promise<void>
  clear: () => Promise<void>
  upload: (file: File) => Promise<{ avatar_url: string }>
}

export interface AvatarPickerProps {
  agentId: string
  name: string
  avatarUrl?: string | null
  preset?: string | null
  /** Auth-specific network calls (owner-cookie / org-scoped / desktop IPC). Required. */
  actions: AvatarActions
  /** Called after any successful change so the parent can refetch the agent. */
  onChanged?: () => void
}

export function AvatarPicker({ agentId, name, avatarUrl, preset, actions, onChanged }: AvatarPickerProps) {
  const [curUrl, setCurUrl] = useState<string | null>(avatarUrl ?? null)
  const [curPreset, setCurPreset] = useState<string | null>(preset ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const acts = actions

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pickPreset = (id: string) =>
    run(async () => {
      await acts.setPreset(id)
      setCurPreset(id)
      setCurUrl(null)
    })

  const clear = () =>
    run(async () => {
      await acts.clear()
      setCurPreset(null)
      setCurUrl(null)
    })

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (e.target) e.target.value = '' // allow re-selecting the same file
    if (!file) return
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setError('请上传 PNG / JPG / WebP 图片')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('图片太大（上限 6MB）')
      return
    }
    run(async () => {
      const res = await acts.upload(await downscaleForUpload(file))
      setCurUrl(res.avatar_url)
      setCurPreset(null)
    })
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <AgentAvatar name={name} agentId={agentId} avatarUrl={curUrl} preset={curPreset} size={64} elevated />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            上传图片
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (!curUrl && !curPreset)} onClick={clear}>
            用自动头像
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFile} style={{ display: 'none' }} />
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--color-err)' }}>{error}</div>}

      <PresetGrid label="图标" presets={ICON_PRESETS.map((p) => p.id)} name={name} selected={curPreset} busy={busy} onPick={pickPreset} />
      <PresetGrid label="几何" presets={GEO_PRESETS.map((p) => p.id)} name={name} selected={curPreset} busy={busy} onPick={pickPreset} />
    </div>
  )
}

function PresetGrid({
  label,
  presets,
  name,
  selected,
  busy,
  onPick,
}: {
  label: string
  presets: string[]
  name: string
  selected: string | null
  busy: boolean
  onPick: (id: string) => void
}) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-ink-5)', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))', gap: 8 }}>
        {presets.map((id) => {
          const active = selected === id
          return (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => onPick(id)}
              title={id}
              aria-pressed={active}
              style={{
                padding: 3,
                borderRadius: 12,
                border: `2px solid ${active ? 'var(--color-terracotta)' : 'transparent'}`,
                background: 'transparent',
                cursor: busy ? 'default' : 'pointer',
                lineHeight: 0,
              }}
            >
              <AgentAvatar name={name} agentId={id} preset={id} size={40} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default AvatarPicker
