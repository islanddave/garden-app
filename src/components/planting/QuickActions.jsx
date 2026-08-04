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

// BUG-SPROUTGATE-001 — the sprout action used to gate on `!planting.germinated_at` ALONE, and that
// stamp exists on 5 of 269 live plantings, so the celebratory button rendered on 264 of them:
// 113 vegetative, 58 fruiting, 30 harvested, 20 flowering, and all 107 nursery transplants. A plant
// you bought as a transplant never sprouts for you; a fruiting plant already did. The stamp's
// ABSENCE is not evidence of pre-emergence — it is the normal state of a garden whose germination
// capture (CAL-2) landed long after most plantings were created.
//
// The gate is therefore three predicates, all of which must hold:
//   1. not already stamped        (unchanged — the set-once server stamp)
//   2. lifecycle stage is pre/at emergence
//   3. origin is not "acquired already growing"
//
// Stage: 'seed' is pre-emergence. 'seedling' is KEPT deliberately — it is the one stage where the
// event is both true and still unrecorded (a planting advanced by hand via StatusPicker never got
// germinated_at, and the germination event does NOT write status, so this is the only route left to
// capture it). Everything from 'vegetative' onward is hidden, per Dave's list. Legacy vocabulary
// ('sprouting'/'seeding' — see iconStatus.js) is accepted; it does not appear in live data.
// 'rooting' is EXCLUDED: a cutting striking roots is vegetative propagation, not germination.
const PRE_SPROUT_STATUSES = new Set(['seed', 'seedling', 'sprouting', 'seeding'])

// Origin is a DENY-list, not an allow-list, because source_type went free-text in V4-SOURCEFREE-001
// (no server allowlist, DB CHECK dropped) — an allow-list would silently suppress the button for any
// value added to dropdownRegistry later. These seven all describe a plant that arrived already
// growing, so no germination of Dave's is ever pending on them. 'volunteer' is here because a
// self-sown plant is only discovered AFTER it has emerged. NULL / 'unknown' / free-text fall
// through to the stage gate, which is what actually carries the reduction.
const NON_SOWN_ORIGINS = new Set([
  'nursery_transplant', 'division', 'volunteer', 'gift', 'cutting_taken', 'rescued', 'plant_swap',
])

/** BUG-SPROUTGATE-001 — may this planting still be marked as sprouted? Pure; exported for test. */
export function canMarkSprouted(planting) {
  if (!planting) return false
  if (planting.germinated_at) return false
  if (!PRE_SPROUT_STATUSES.has(planting.status)) return false
  if (NON_SOWN_ORIGINS.has(planting.source_type)) return false
  return true
}

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
  const [sprouting, setSprouting] = useState(false)
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

  // CAL-2 germination one-tap — Reward-UX: a one-time celebratory "It sprouted!" action that
  // vanishes once germinated_at is set. Rendered only when canMarkSprouted() holds
  // (BUG-SPROUTGATE-001 — see the gate above). Posts a germination event; the server stamps
  // germinated_at set-once (event-driven) and does NOT touch status. Mirrors handleWater.
  async function handleSprout() {
    if (sprouting) return
    setSprouting(true)
    try {
      const ev = await fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, plant_id: plantId, event_type: 'germination' }),
      })
      toast.show({ message: 'Sprouted! 🌱', tone: 'success' })
      if (onLogged) onLogged(ev)
    } catch (err) {
      toast.show({ message: "Couldn't log germination", tone: 'error' })
    } finally {
      setSprouting(false)
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
      {canMarkSprouted(planting) && (
        <button type="button" onClick={handleSprout} disabled={sprouting}
          aria-label="Mark this planting as sprouted"
          style={btn({ opacity: sprouting ? 0.6 : 1, backgroundColor: P.green, color: P.white, borderColor: P.green })}>
          {sprouting ? 'Logging…' : 'It sprouted! 🌱'}
        </button>
      )}
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
