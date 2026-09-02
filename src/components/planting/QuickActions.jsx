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
import { todayLocalISO } from '../../lib/dateLocal.js'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import SaveSeedSheet from './SaveSeedSheet.jsx'

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

// V4-SAVESEEDBTN-001 — the seed action is FULL-WIDTH AND BELOW the row, and that is a layout
// decision rather than a style one. The row above is `flex: 1` peers: at 390px it already carries
// three of them whenever the sprout action shows, ~90px each before gaps, and jsdom returns 0 from
// getBoundingClientRect() so no vitest assertion in this repo can falsify a fourth. A full-width
// block underneath cannot overflow at any viewport width, so the unanswerable question does not
// have to be answered. Same border/radius/ink as btn() so it reads as one family, one tier down.
const seedBtn = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  width: '100%', minHeight: 44, marginTop: 8,
  border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '10px 12px',
  fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
  backgroundColor: P.white, color: P.green,
}

export default function QuickActions({ planting, onLogged }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [watering, setWatering] = useState(false)
  const [sprouting, setSprouting] = useState(false)
  const [sproutDateOpen, setSproutDateOpen] = useState(false)
  const [sproutDate, setSproutDate] = useState('')
  const [seedOpen, setSeedOpen] = useState(false)
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
  //
  // BUG-GERMDATEBATCH-001 — THE DATE IS NOW SENT, EXPLICITLY AND LOCALLY. This POST used to carry
  // no `event_date` at all, so lambda/events/index.js fell through to
  // `normalizeEventDate(body.event_date) ?? new Date().toISOString()` and stamped the SERVER's
  // instant. Two separate errors came out of that, and prod carries both:
  //
  //   1. TIMEZONE. `new Date()` in the Lambda is UTC, and germinated_at is a DATE column, so an
  //      evening tap in Conway files on TOMORROW. Measured on live prod 2026-08-20: 5 of the 17
  //      app-logged germinations (29.4%) are stamped a calendar day late — the whole 2026-07-31
  //      cluster was tapped at 22:55–23:13 EDT on 07-30. Purple Vienna Kohlrabi's famous
  //      "1 day to germinate" is really ZERO days: sown 07-30, tapped the same evening.
  //   2. CADENCE. Even with the timezone right, "now" is when Dave got round to LOGGING, not when
  //      the seed broke ground. All 18 stamped rows fall on exactly two dates across five sow
  //      dates, which is a batch-catch-up signature, not seed behaviour — and because the server
  //      stamp is set-once, the error was baked in permanently.
  //
  // (1) is fixed by sending todayLocalISO() — the viewer's wall-clock day, the same thing the
  // other one-tap logger in this app (today/CareNeeded.jsx) has always sent. (2) cannot be fixed
  // by a default, because only Dave knows which morning he saw the cotyledons; it is fixed by the
  // optional inline date below, and corrected after the fact by editing the germination event
  // itself (the events PUT re-derives the anchor — see lambda/events/index.js).
  //
  // `when` is the ONLY parameter and it is optional: the bare one-tap call passes nothing and is
  // still exactly one tap. Note the callers use `() => handleSprout()` rather than
  // `onClick={handleSprout}` — the latter would hand this function a React SyntheticEvent as
  // `when` and serialise garbage into event_date.
  async function handleSprout(when) {
    if (sprouting) return
    setSprouting(true)
    try {
      const ev = await fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId, plant_id: plantId, event_type: 'germination',
          event_date: when || todayLocalISO(),
        }),
      })
      toast.show({ message: 'Sprouted! 🌱', tone: 'success' })
      setSproutDateOpen(false)
      if (onLogged) onLogged(ev)
    } catch (err) {
      toast.show({ message: "Couldn't log germination", tone: 'error' })
    } finally {
      setSprouting(false)
    }
  }

  // V4-PHOTOQUICK-001: open the picker synchronously in THIS tap (a trusted gesture — iOS
  // suppresses a picker opened after navigation), then park the File and jump into the log form
  // pre-seeded to a photo event. No 'capture' attr — this site never had one, and as of
  // V4-HIDECAPTURE-001 that is the app-wide rule rather than this component's local choice.
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

  const today = todayLocalISO()
  // Earliest date the picker will offer. A sprout cannot precede its own sowing, and sown_at is the
  // one bound the record already knows. Optional — 0 of the 18 stamped prod rows lack it today, but
  // a planting created without a sow date simply gets no lower bound rather than a wrong one.
  const sownDay = typeof planting.sown_at === 'string' ? planting.sown_at.slice(0, 10) : null
  const showSprout = canMarkSprouted(planting)

  return (
    <div style={{ margin: '0 0 20px' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {showSprout && (
          <button type="button" onClick={() => handleSprout()} disabled={sprouting}
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

      {/* BUG-GERMDATEBATCH-001 — the "not today?" escape hatch, and the reason the one-tap survives.
          The button above is a GOOD affordance: usage went 5/269 plantings to 18 once
          BUG-SPROUTGATE-001 stopped rendering it on transplants. Making it ask for a date would
          undo that. So the tap keeps meaning "today" and this line — muted, below the row, opened
          only on purpose — is the way to say otherwise.

          Reward-UX (ambient over interrupt): no modal, no dialog role, no banner, no toast of its
          own, no haptic. It is a line of muted text in the same card, styled after the
          BUG-CADENCESIZE-001 vessel-gap copy: never a warning colour, never a badge, so it reads
          as a field noticed in passing rather than as a task. A date picker the user explicitly
          opened is in-context by construction; nothing here fires unprompted.

          Rendered under the same `showSprout` gate as the button, so a planting that may not be
          marked sprouted cannot reach the dated path either — one gate, not two that can drift. */}
      {showSprout && (
        <div style={{ marginTop: 6 }}>
          {sproutDateOpen ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label htmlFor={`sprout-date-${plantId}`} style={{ fontSize: '0.78rem', color: P.mid }}>
                Sprouted on
              </label>
              <input id={`sprout-date-${plantId}`} type="date" value={sproutDate}
                max={today} min={sownDay || undefined}
                onChange={e => setSproutDate(e.target.value)}
                style={{
                  border: `1px solid ${P.border}`, borderRadius: 8, padding: '5px 7px',
                  fontSize: '0.8rem', color: P.dark, backgroundColor: P.white, minWidth: 0,
                }} />
              <button type="button" onClick={() => handleSprout(sproutDate)}
                disabled={sprouting || !sproutDate}
                style={btn({
                  flex: '0 0 auto', padding: '5px 10px', fontSize: '0.78rem',
                  opacity: (sprouting || !sproutDate) ? 0.6 : 1,
                  backgroundColor: P.green, color: P.white, borderColor: P.green,
                })}>
                {sprouting ? 'Logging…' : 'Log'}
              </button>
              <button type="button" onClick={() => setSproutDateOpen(false)}
                style={{
                  background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
                  fontSize: '0.78rem', color: P.light,
                }}>
                Cancel
              </button>
            </div>
          ) : (
            // Seeded to today so the picker opens on a sensible day and a mis-tap costs nothing —
            // it produces exactly what the one-tap would have.
            // aria-label deliberately avoids the word "sprouted": the primary action's accessible
            // name is "Mark this planting as sprouted", and two buttons matching /sprouted/i in the
            // same component makes every existing getByRole query here ambiguous.
            <button type="button" onClick={() => { setSproutDate(today); setSproutDateOpen(true) }}
              aria-label="Log this sprout on an earlier date"
              style={{
                background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
                fontSize: '0.78rem', color: P.light, textDecoration: 'underline',
              }}>
              Sprouted on another day?
            </button>
          )}
        </div>
      )}

      {/* V4-SAVESEEDBTN-001 — the door to the seed surface, on the page where the seed comes from.
          Until now the ONLY link into /seeds/saved anywhere in src/ was a row inside the collapsed
          More sheet, and no route could create a seed lot at all: a lot had to be hand-built at
          /inventory/add first. Launched from here the parent plant is a parameter rather than a
          260-row picker — see SaveSeedSheet for the write shape.

          UNGATED, unlike the sprout action directly above it. That gate exists because "It
          sprouted!" ASSERTS something about the plant's state, so rendering it on a fruiting
          nursery transplant was a claim that was false. This button asserts nothing — it is an
          action the user initiates when they are holding seed, and only they know when that is.
          A lifecycle gate here would re-hide the door this whole change exists to open. */}
      <button type="button" onClick={() => setSeedOpen(true)}
        aria-label="Save seed from this planting" data-testid="save-seed-open" style={seedBtn}>
        <Icon name="event.seed_saved" size={18} decorative style={{ color: P.green }} />
        Save seed
      </button>

      {seedOpen && (
        <SaveSeedSheet planting={planting} onClose={() => setSeedOpen(false)} />
      )}
    </div>
  )
}
