// V4-PLANTINGUI-001 — up to 3 quick-actions: Water (one-tap log), Photo (deep-link), Status
// (inline picker). Frontend-only against existing endpoints:
//   Water  = POST /api/events {project_id, plant_id, event_type:'watering'}
//   Status = PUT  /api/plants/:id {status}  (COALESCE-partial, emits status_change audit event)
//   Photo  = deep-link to the existing log/capture flow.
// Operational confirmations via useOptionalToast (reward-UX operational carve-out only).
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { PLANT_STATUSES, PLANT_STATUS_MAP, statusLabel, P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'

const btn = (extra = {}) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '10px 12px',
  fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
  backgroundColor: P.white, color: P.green, whiteSpace: 'nowrap', flex: 1, minWidth: 0, ...extra,
})

export default function QuickActions({ planting, onLogged, onStatusChanged }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [watering, setWatering] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)

  if (!planting) return null
  const projectId = planting.project_id
  const plantId = planting.id

  async function handleWater() {
    if (watering) return
    setWatering(true)
    try {
      const ev = await fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, plant_id: plantId, event_type: 'watering' }),
      })
      toast.show({ message: 'Logged watering', tone: 'success' })
      if (onLogged) onLogged(ev)
    } catch (err) {
      toast.show({ message: "Couldn't log watering", tone: 'error' })
    } finally {
      setWatering(false)
    }
  }

  async function handleStatus(e) {
    const next = e.target.value
    if (!next || next === planting.status || savingStatus) return
    setSavingStatus(true)
    try {
      const updated = await fetch('/api/plants/' + plantId, {
        method: 'PUT',
        body: JSON.stringify({ status: next }),
      })
      toast.show({ message: `Status → ${statusLabel(next)}`, tone: 'success' })
      if (onStatusChanged) onStatusChanged(updated?.status ?? next)
    } catch (err) {
      toast.show({ message: "Couldn't change status", tone: 'error' })
    } finally {
      setSavingStatus(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, margin: '0 0 20px' }}>
      <button type="button" onClick={handleWater} disabled={watering}
        aria-label="Log watering for this planting" style={btn({ opacity: watering ? 0.6 : 1 })}>
        <Icon name="care.drop" size={18} decorative style={{ color: P.green }} />
        {watering ? 'Logging…' : 'Water'}
      </button>

      <Link to={`/log?project=${projectId}&plant=${plantId}`}
        aria-label="Add a photo for this planting" style={btn()}>
        <Icon name="media.camera" size={18} decorative style={{ color: P.green }} />
        Photo
      </Link>

      <span style={{ ...btn({ cursor: 'default', padding: 0, overflow: 'hidden' }) }}>
        <select value={planting.status || ''} onChange={handleStatus} disabled={savingStatus}
          aria-label="Change status"
          style={{ border: 'none', background: 'transparent', color: P.green, fontWeight: 600,
            fontSize: '0.85rem', padding: '10px 12px', width: '100%', cursor: 'pointer',
            appearance: 'menulist' }}>
          {!planting.status && <option value="">Set status…</option>}
          {PLANT_STATUSES.map(s => (
            <option key={s} value={s}>{PLANT_STATUS_MAP[s]?.emoji ?? ''} {statusLabel(s)}</option>
          ))}
        </select>
      </span>
    </div>
  )
}
