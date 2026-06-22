// AvatarPicker — owner-facing avatar chooser for an agent. Two ways to set one:
//   · pick a built-in preset (icon or geometric) from the gallery, or
//   · upload an image (the server center-crops + resizes; we just POST the file).
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
      const res = await acts.upload(file)
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
