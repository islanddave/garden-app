// AssigneePicker — PLANT-ASSIGN-001 caretaker assignment control.
// Self-contained: fetches the roster (useMembers, Clerk-backed /api/members) AND persists the change
// itself (PUT /api/{plants|projects}/{id} { assignee_user_id }), then calls onChanged(newValue) so the
// parent can keep its local entity state in sync. Keeps page wiring to a single mounted block.
//
// Operational surface (Reward-UX V101 §7): plain control, no celebration/streak/badge/interrupt.
// Inline styles + P palette (the app has no Tailwind). Value "" / null = Unassigned (for a planting that
// means "inherit from the project", surfaced via the inheritLabel hint).
//
// Props:
//   entityType: 'plant' | 'project'
//   entityId:   uuid
//   value:      current assignee_user_id (string) | null
//   onChanged:  (newValueOrNull) => void   — fired after a successful save
//   label:      string (default derived from entityType)
//   inheritLabel: optional string shown when value is null (e.g. "Inherits project: Tomatoes")
import React, { useState } from 'react'
import { useMembers } from '../hooks/useMembers.js'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

const PATH = { plant: '/api/plants/', project: '/api/projects/' }

export default function AssigneePicker({ entityType, entityId, value = null, onChanged, label, inheritLabel }) {
  const { members, loading, error } = useMembers()
  const { fetch } = useApiFetch()
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)

  const heading = label || (entityType === 'project' ? 'Caretaker (whole project)' : 'Caretaker (this planting)')
  const selId = `assignee-${entityType}-${entityId}`
  const current = value ?? ''

  async function onSelect(e) {
    const next = e.target.value === '' ? null : e.target.value
    if (next === (value ?? null)) return
    setSaving(true); setSaveErr(null)
    try {
      const base = PATH[entityType]
      if (!base) throw new Error('unknown entity type')
      await fetch(base + entityId, { method: 'PUT', body: JSON.stringify({ assignee_user_id: next }) })
      onChanged && onChanged(next)
    } catch (err) {
      setSaveErr(err?.message ?? 'Could not save caretaker')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={selId} style={{ fontSize: '0.78rem', fontWeight: 600, color: P.mid }}>
        <span aria-hidden="true" style={{ marginRight: 5 }}>🧑‍🌾</span>{heading}
      </label>
      <select
        id={selId}
        value={current}
        onChange={onSelect}
        disabled={loading || saving}
        style={{
          fontFamily: 'inherit', fontSize: '0.88rem', color: P.dark,
          padding: '7px 10px', borderRadius: 8, border: `1px solid ${P.border}`,
          background: P.white, minHeight: 40, maxWidth: 280,
        }}
      >
        <option value="">{entityType === 'plant' ? 'Inherit from project' : 'Unassigned'}</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>{m.display_name}</option>
        ))}
      </select>
      {loading && <span style={{ fontSize: '0.74rem', color: P.light }}>Loading caretakers…</span>}
      {saving && <span style={{ fontSize: '0.74rem', color: P.light }}>Saving…</span>}
      {value == null && inheritLabel && !saving && (
        <span style={{ fontSize: '0.74rem', color: P.light }}>{inheritLabel}</span>
      )}
      {(error || saveErr) && (
        <span style={{ fontSize: '0.74rem', color: '#b94a3a' }}>{saveErr || error}</span>
      )}
    </div>
  )
}
