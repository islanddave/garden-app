// V5-INFLIGHTBATCH-001 — WHEN did it start, asked as ONE tap and NEVER as a grade.
//
// The panel's ruling (API-CONTRACT §3.5): never ask for a precision grade. Asking someone to rate
// the reliability of their own memory is a second decision stacked on the one already avoided, and
// `exact` vs `day` are not humanly distinguishable anyway. So precision is DERIVED from which chip
// was tapped — uncertainty is expressed by choosing a WIDER chip, which is a natural act.
//
// THE MAPPING IS FROZEN BY CONTRACT, not by this file's judgement:
//   [Today] [Yesterday] [A few days ago] [About a week] [2–3 weeks] [Longer / not sure] [Pick a date]
//   →  exact | day | day | week | week | unknown | day
// (The originating seat proposed day/day/week for the first three; the contract froze
// exact/day/day. Build to the contract — do not renegotiate it here.)
//
// `daysAgo` is the MIDPOINT of the window each chip's words describe (the seat pins "a few days" at
// 3–5 d and "2–3 weeks" at 14–21 d), because started_at stores a POINT and start_precision is what
// widens it back out for display. A midpoint minimises the worst-case error the widest-bound
// renderer has to carry.
import React from 'react'
import { P } from '../../lib/constants.js'
// Direct import, NOT via the forms barrel — the same idiom and the same reason CaptureFlow.jsx
// records for buttonChrome: formsPrimitivesFreeze.test.js pins the barrel's export set exactly, and
// labelChrome is shared chrome rather than a frozen primitive.
import { labelChrome, optionalMarkChrome } from '../forms/formStyles.js'
import Input from '../forms/Input.jsx'

export const START_CHIPS = Object.freeze([
  { id: 'today',     label: 'Today',             daysAgo: 0,    precision: 'exact' },
  { id: 'yesterday', label: 'Yesterday',         daysAgo: 1,    precision: 'day' },
  { id: 'fewdays',   label: 'A few days ago',    daysAgo: 4,    precision: 'day' },
  { id: 'aboutweek', label: 'About a week',      daysAgo: 7,    precision: 'week' },
  { id: 'twoweeks',  label: '2–3 weeks',         daysAgo: 18,   precision: 'week' },
  { id: 'longer',    label: 'Longer / not sure', daysAgo: null, precision: 'unknown' },
  { id: 'pickdate',  label: 'Pick a date',       daysAgo: null, precision: 'day' },
])

// Local-calendar parse. `new Date('2026-08-13')` parses as UTC and lands on the 12th west of
// Greenwich, which is the exact class of bug dateLocal.js exists to stop — build from parts.
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return isNaN(d.getTime()) ? null : d
}

// Local midnight, n days back. setHours BEFORE setDate so the arithmetic is on wall-clock days: a
// DST boundary changes the day's length, not its date.
function localMidnightDaysAgo(n, now) {
  const d = new Date(now.getTime())
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// The four start-columns, resolved from the tap. THE DB BICONDITIONAL IS ENFORCED HERE and nowhere
// else on this path — chk_kitchen_batch_start_pairing is
//   (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')
// so a payload that pairs them wrongly is a 500, not a validation message. The three legal states:
//   • never asked           → both null            (nothing was tapped and the photo knows nothing)
//   • asked, doesn't know   → null + 'unknown'     ("Longer / not sure")
//   • a date with its grade → date + exact..week   (any other chip, or the photo's own column)
// The first two are DIFFERENT CLAIMS and the schema is deliberately three-valued about them.
//
// THE PHOTO IS THE DEFAULT, and it is `photos.taken_at` — the COLUMN, read off the registered row —
// never EXIF read here. stripImageFile() destroys DateTimeOriginal before every PUT, so by the time
// anything on this page could look at the bytes the timestamp is gone; the upload hook reads it from
// the ORIGINAL file and the column is where it survives. Graded `day`, not `hour`/`exact`, for a
// stated reason: taken_at is a zone-less capture time reinterpreted in whatever zone the browser was
// in, so the hour is not trustworthy even when the day is. It is populated on only 127 of 1,396 live
// rows, so this is a good default, never a guarantee — the both-null fallback below is the common
// case, and it is honest rather than a gap.
export function resolveStart({ chip = null, pickedDate = '', photoTakenAt = null, photoId = null, now = new Date() } = {}) {
  const spec = START_CHIPS.find(c => c.id === chip) ?? null

  if (spec?.precision === 'unknown') {
    return { started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null }
  }
  if (spec?.id === 'pickdate') {
    const d = parseLocalDate(pickedDate)
    // Tapped but not filled in is not a claim — fall through to the photo default rather than
    // freezing the flow on a field the user opened and thought better of.
    if (d) return { started_at: d.toISOString(), start_precision: 'day', start_anchor_kind: 'manual', start_anchor_id: null }
  } else if (spec?.id === 'today') {
    // The instant, not local midnight: 'exact' has to mean the moment it says it means, and "Today"
    // in this flow is pack time — the batch is being started as it is recorded.
    return { started_at: now.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null }
  } else if (spec) {
    return {
      started_at: localMidnightDaysAgo(spec.daysAgo, now).toISOString(),
      start_precision: spec.precision,
      // 'memory' is the honest anchor for a relative chip and legitimately carries no id.
      start_anchor_kind: 'memory', start_anchor_id: null,
    }
  }

  const taken = photoTakenAt ? new Date(photoTakenAt) : null
  if (taken && !isNaN(taken.getTime())) {
    return {
      started_at: taken.toISOString(), start_precision: 'day',
      start_anchor_kind: 'photo', start_anchor_id: photoId ?? null,
    }
  }
  return { started_at: null, start_precision: null, start_anchor_kind: null, start_anchor_id: null }
}

// Is this batch being recorded AT PACK TIME? The salt/brine ask is gated on this and on nothing
// else: it is the one number that sets both the safety margin and the rate, the cook is holding it
// right now, and it is gone forever if asked a week later. Asking a back-dated batch for it would
// harvest a guess, which is worse than a null.
// Nothing tapped counts as pack time — the untouched default of this flow is "I am recording a thing
// I just made", which is the whole reason the card exists.
export function isPackTime({ chip = null, pickedDate = '', now = new Date() } = {}) {
  if (chip === null) return true
  if (chip === 'today') return true
  if (chip === 'pickdate') {
    const d = parseLocalDate(pickedDate)
    return !!d && sameLocalDay(d, now)
  }
  return false
}

// ≥48px targets and the active/inactive treatment copied from HarvestTimeframeChips — this is the
// app's chip row, not a new one.
const chipStyle = (active) => ({
  padding: '6px 14px', minHeight: 48, borderRadius: 20, fontSize: '0.82rem', fontWeight: 600,
  cursor: 'pointer', border: `1px solid ${active ? P.green : P.border}`,
  backgroundColor: active ? P.greenPale : P.white, color: active ? P.green : P.mid,
})

export default function StartChips({ value = null, onChange, pickedDate = '', onPickedDateChange, idPrefix = 'kb-start' }) {
  return (
    <div>
      {/* NOT wrapped in <Field>: Field takes exactly one control child and clones label association
          onto it, and this is a group of seven buttons plus a conditional date input. role="group"
          + aria-label is what the shipped chip row (HarvestTimeframeChips) uses for the same shape.
          Marked optional in the visible label because nothing here is required — the ADHD ruling is
          that the user must never submit-to-discover which fields they could have skipped. */}
      <span style={labelChrome} id={`${idPrefix}-label`}>
        When did it start?<span style={optionalMarkChrome}>optional</span>
      </span>
      <div role="group" aria-labelledby={`${idPrefix}-label`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {START_CHIPS.map(c => {
          const active = value === c.id
          return (
            <button key={c.id} type="button" data-testid={`${idPrefix}-${c.id}`} aria-pressed={active}
              onClick={() => onChange(active ? null : c.id)} style={chipStyle(active)}>
              {c.label}
            </button>
          )
        })}
      </div>
      {value === 'pickdate' && (
        <Input type="date" data-testid={`${idPrefix}-date`} aria-label="Start date"
          value={pickedDate} onChange={e => onPickedDateChange(e.target.value)}
          style={{ marginTop: 8 }} />
      )}
    </div>
  )
}
