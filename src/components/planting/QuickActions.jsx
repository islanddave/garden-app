// V4-PLANTINGUI-001 — quick-actions: Water (one-tap log) + Photo (deep-link). Frontend-only
// against existing endpoints:
//   Water  = POST /api/events {project_id, plant_id, event_type:'watering'}
//   Photo  = deep-link to the existing log/capture flow.
// V4-STATUSTAP-001: the status control moved to the hero (StatusPicker) — the redundant inline
// status <select> that lived here was removed so status has a single home.
// Operational confirmations via useOptionalToast (reward-UX operational carve-out only).
import React, { useState, useRef } from 'react'
import { useOverlayNavigate } from '../../context/OverlayContext.jsx'
import { setPendingCapture } from '../../lib/pendingCapture.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'

const btn = (extra = {}) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '10px 12px',
  fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
  backgroundColor: P.white, color: P.green, whiteSpace: 'nowrap', flex: 1, minWidth: 0, ...extra,
})

export default function QuickActions({ planting, onLogged }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [watering, setWatering] = useState(false)
  const navigate = useOverlayNavigate()
  const photoInputRef = useRef(null)

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

  // V4-PHOTOQUICK-001: open the picker synchronously in THIS tap (a trusted gesture — iOS
  // suppresses a picker opened after navigation), then park the File and jump into the log form
  // pre-seeded to a photo event. No 'capture' attr so iOS offers Take Photo OR Choose.
  function openPhotoPicker() {
    const el = photoInputRef.current
    if (el) el.click()
  }
  function onPhotoPicked(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPendingCapture(file)
    navigate(`/log?project=${projectId}&plant=${plantId}&event_type=photo&fromquick=1`)
  }

  return (
    <div style={{ display: 'flex', gap: 8, margin: '0 0 20px' }}>
      <button type="button" onClick={handleWater} disabled={watering}
        aria-label="Log watering for this planting" style={btn({ opacity: watering ? 0.6 : 1 })}>
        <Icon name="care.drop" size={18} decorative style={{ color: P.green }} />
        {watering ? 'Logging…' : 'Water'}
      </button>

      <button type="button" onClick={openPhotoPicker}
        aria-label="Add a photo for this planting" style={btn()}>
        <Icon name="media.camera" size={18} decorative style={{ color: P.green }} />
        Photo
      </button>
      <input ref={photoInputRef} type="file" accept="image/*" onChange={onPhotoPicked}
        style={{ display: 'none' }} />
    </div>
  )
}
