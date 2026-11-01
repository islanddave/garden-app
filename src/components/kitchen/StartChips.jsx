// WHEN did it start, asked as ONE tap and NEVER as a grade — the shared Start sheet's chip row.
//
// Never ask for a precision grade (API-CONTRACT §3.5): rating the reliability of one's own memory is a
// second decision stacked on the one already avoided, and `exact` vs `day` are not humanly
// distinguishable anyway. So precision is DERIVED from which chip was tapped — uncertainty is expressed
// by choosing a wider chip, which is a natural act.
//
// The chips are the four below, Today preselected. The Going-now "Set a start date →" editor (on batch
// detail) keeps its own six chips in goingNow.js; src/__tests__/startChipParity.test.js binds the labels
// the two tables share.
//
//     Today (preselected) · Yesterday · Earlier… · Not sure
//
// "Earlier…" opens the six estimate windows, each storing its window's START plus one precision word.
// Every precision stored must be in the live CHECK chk_kitchen_batch_start_precision (exact · hour · day ·
// week · month · unknown · season · year). The windows are computed from today and hidden when empty —
// the SAME windows Put it up's Earlier… offers (putup/putItUp.js estimateChips), so one estimate means one
// thing. "Not sure" is the other legal state of the biconditional: no date + `unknown`
// (chk_kitchen_batch_start_pairing).
import React from 'react'
// Direct import, NOT via the forms barrel: formsPrimitivesFreeze.test.js pins the barrel's export set
// exactly, and labelChrome is shared chrome rather than a frozen primitive.
import { labelChrome, optionalMarkChrome } from '../forms/formStyles.js'
import Input from '../forms/Input.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { estimateChips } from '../putup/putItUp.js'

// `daysAgo` and `precision` are stated on the rows that resolve to a fixed day, so the parity test can
// read them beside goingNow.js's table; Earlier… resolves through EARLIER_CHIPS instead.
export const SHEET_START_CHIPS = Object.freeze([
  { id: 'today',     label: 'Today',     daysAgo: 0,    precision: 'exact' },
  { id: 'yesterday', label: 'Yesterday', daysAgo: 1,    precision: 'day' },
  { id: 'earlier',   label: 'Earlier…' },
  { id: 'unsure',    label: 'Not sure',  daysAgo: null, precision: 'unknown' },
])
// Every Earlier… choice this row can ever show. Which of them are shown TODAY is estimateChips(now):
// a window that is empty is hidden (Earlier this year, before May).
export const EARLIER_CHIPS = Object.freeze([
  { id: 'this_month',   label: 'This month',        precision: 'month' },
  { id: 'last_month',   label: 'Last month',        precision: 'month' },
  { id: 'two_three',    label: '2–3 months ago',    precision: 'season' },
  { id: 'earlier_year', label: 'Earlier this year', precision: 'year' },
  { id: 'last_year',    label: 'Last year',         precision: 'year' },
  { id: 'pickdate',     label: 'Pick a date',       precision: 'day' },
])
export const START_ERRORS = Object.freeze({
  earlier: 'Pick when it started — or tap Not sure.',
  pickdate: 'Pick the date it started — or tap Not sure.',
  future: "That date hasn't happened yet — pick another.",
})

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

function localYmd(d) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// { start } — the four start columns, always satisfying chk_kitchen_batch_start_pairing:
//     (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')
// — or { error } naming the half-answer that cannot be stored (Earlier… tapped with nothing under it,
// or a picked date that is empty, malformed or in the future). A half-answer is refused rather than
// quietly stored as "never asked": the chip row always holds an answer, Today by default.
//   Today      -> the instant, exact ("Today" in this sheet is pack time: it is being recorded as made)
//   Yesterday  -> local midnight yesterday, day
//   This month / Last month / 2–3 months ago / Earlier this year / Last year -> the window's START at
//              local midnight, at its precision (derived dates start from the earliest the estimate
//              allows); a window that is empty today is refused like an unanswered Earlier…
//   Pick a date -> that local calendar day, day, anchored 'manual'
//   Not sure   -> no date + unknown
export function resolveSheetStart({ chip = 'today', earlier = null, pickedDate = '', now = new Date() } = {}) {
  if (chip === 'today') {
    return { start: { started_at: now.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null } }
  }
  if (chip === 'yesterday') {
    return { start: { started_at: localMidnightDaysAgo(1, now).toISOString(), start_precision: 'day', start_anchor_kind: 'memory', start_anchor_id: null } }
  }
  if (chip === 'unsure') {
    return { start: { started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null } }
  }
  if (chip !== 'earlier') return { error: START_ERRORS.earlier }
  const win = earlier && earlier !== 'pickdate' ? estimateChips(now).find(c => c.id === earlier) : null
  if (win) {
    return { start: { started_at: win.start.toISOString(), start_precision: win.precision, start_anchor_kind: 'memory', start_anchor_id: null } }
  }
  if (earlier === 'pickdate') {
    const d = parseLocalDate(pickedDate)
    if (!d) return { error: START_ERRORS.pickdate }
    if (d.getTime() > localMidnightDaysAgo(0, now).getTime()) return { error: START_ERRORS.future }
    return { start: { started_at: d.toISOString(), start_precision: 'day', start_anchor_kind: 'manual', start_anchor_id: null } }
  }
  return { error: START_ERRORS.earlier }
}

// The chip row. An OPTIONAL single-select (role="group" + aria-pressed) that always holds an
// answer — Today until another is tapped — so re-tapping the chosen chip keeps it: "Not sure" is how
// "I don't know" is said, not an empty row. 48px touch chips, 8px gaps: the house SelectChip `touch`.
// NOT wrapped in <Field>: Field takes exactly one control child, and this is a group of buttons plus a
// conditional date input. `label` / `dateLabel`: the batch detail's stage edit asks the
// same question of a Log entry — "When was this?" — through this same row.
export function SheetStartChips({
  value = 'today', onChange, earlier = null, onEarlierChange, pickedDate = '', onPickedDateChange,
  disabled = false, idPrefix = 'start-when', now = new Date(), label = 'When did it start?', dateLabel = 'Start date',
}) {
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">
        {label}<span style={optionalMarkChrome}>optional</span>
      </span>
      <div role="group" aria-label={label} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {SHEET_START_CHIPS.map(c => (
          <SelectChip key={c.id} touch active={value === c.id} disabled={disabled} data-testid={`${idPrefix}-${c.id}`}
            onClick={() => { if (value !== c.id) onChange?.(c.id) }}>
            {c.label}
          </SelectChip>
        ))}
      </div>
      {value === 'earlier' && (
        <div role="group" aria-label="Earlier…" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {EARLIER_CHIPS.filter(c => estimateChips(now).some(w => w.id === c.id)).map(c => (
            <SelectChip key={c.id} touch active={earlier === c.id} disabled={disabled} data-testid={`${idPrefix}-${c.id}`}
              onClick={() => onEarlierChange?.(earlier === c.id ? null : c.id)}>
              {c.label}
            </SelectChip>
          ))}
        </div>
      )}
      {value === 'earlier' && earlier === 'pickdate' && (
        <Input type="date" data-testid={`${idPrefix}-date`} aria-label={dateLabel} value={pickedDate}
          max={localYmd(now)} disabled={disabled}
          onChange={e => onPickedDateChange?.(e.target.value)} style={{ marginTop: 8, maxWidth: 220 }} />
      )}
    </div>
  )
}
