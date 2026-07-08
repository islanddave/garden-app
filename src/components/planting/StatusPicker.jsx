// V4-STATUSTAP-001 — tappable planting-status control for the photo hero overlay.
// Renders the PlantStatusBadge (or a "Set status" pill when unset) with a transparent native
// <select> overlaid at inset:0, so a tap opens the native status menu (native picker UX + full
// keyboard/AT operability) while the visible face is the multi-channel badge. Encapsulates the
// status change — PUT /api/plants/:id {status} (COALESCE-partial, emits a status_change audit
// event) + an operational toast (Reward-UX operational carve-out) — so it can live on the hero.
// Replaces the redundant status <select> formerly in QuickActions (a single status control now).
import React, { useState } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { PLANT_STATUSES, statusLabel, P } from '../../lib/constants.js'
import PlantStatusBadge from '../PlantStatusBadge.jsx'
import Icon from '../Icon.jsx'

export default function StatusPicker({ planting, onStatusChanged }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [saving, setSaving] = useState(false)
  if (!planting) return null
  const plantId = planting.id
  const status = planting.status || ''

  async function handleChange(e) {
    const next = e.target.value
    if (!next || next === planting.status || saving) return
    setSaving(true)
    try {
      const updated = await fetch('/api/plants/' + plantId, {
        method: 'PUT',
        body: JSON.stringify({ status: next }),
      })
      toast?.show?.({ message: `Status → ${statusLabel(next)}`, tone: 'success' })
      if (onStatusChanged) onStatusChanged(updated?.status ?? next)
    } catch {
      toast?.show?.({ message: "Couldn't change status", tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* SC 2.4.7: the overlaid select is opacity:0, which also hides its own focus ring, so we
          draw a visible focus indicator on the WRAPPER via :focus-within (needs a real class —
          inline styles can't express pseudo-classes). Reads on the dark hero scrim. */}
      <style>{`.v4-statuspicker:focus-within{outline:2px solid #fff;outline-offset:2px;border-radius:12px;}`}</style>
      <span className="v4-statuspicker" style={{ position: 'relative', display: 'inline-flex',
        alignItems: 'center', minHeight: 32, opacity: saving ? 0.6 : 1 }}>
        {status ? (
          // aria-hidden: the <select> already announces the current status via its selected value,
          // so the visible badge is decorative to AT (avoids a double announcement — SC 4.1.2).
          <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <PlantStatusBadge status={status} size="lg" />
          </span>
        ) : (
          <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
            backgroundColor: P.white, color: P.dark, borderRadius: 12, padding: '5px 12px',
            minHeight: 32, fontSize: '0.78rem', fontWeight: 600 }}>
            <Icon name="action.edit" size={14} decorative style={{ color: P.dark }} />
            Set status
          </span>
        )}
        <select
          value={status}
          onChange={handleChange}
          disabled={saving}
          aria-label="Change planting status"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0,
            padding: 0, border: 'none', opacity: 0, cursor: 'pointer',
            appearance: 'none', WebkitAppearance: 'none' }}
        >
          {!status && <option value="">Set status…</option>}
          {PLANT_STATUSES.map(s => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
      </span>
    </>
  )
}
