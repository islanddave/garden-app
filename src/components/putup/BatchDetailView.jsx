// src/components/putup/BatchDetailView.jsx
// V5-KBCLOSE-001 — one batch, opened on purpose: what went in, what happened to it, what came out.
//
// CONTROLLED. This component issues NO GET of its own — `batch` / `inputs` / `stages` / `outputs`
// arrive already fetched, and `onChanged` walks back up to whoever owns the fetch. That is the same
// contract GoingNowView holds and it is what keeps the page's invalidation path intact.
// `nowMs` is a PROP for the same reason it is on GoingNowView: ONE instant per render, so two lines
// cannot disagree mid-paint and a test can pin an age to a fixed literal.
//
// ⚠ THE RULINGS THIS SURFACE INHERITS — read the absences as hard as the presences:
//   • NO age-derived readiness. No "due", no remaining days, no progress element, no "day 12 of 21".
//   • NOTHING about acidification, shelf stability, or whether any reading is good.
//   • NO urgency tone — the three alarm inks stay off this body. The one permitted use is a
//     role="alert" string inside an editor, exactly as on the card.
//   • THE STAGE LOG IS A LOG. No count, no "N stages", no streak, no tick or check glyph, and never
//     a filtered pH-only sub-view: four pH numbers alone in a column is a series, and a series is a
//     trend. One interleaved chronology, newest first, as the server ordered it.
//   • A stage row carrying a pH reading renders THE READING and the time it was READ as its primary
//     text — never `stage_kind` alone. Every reading is written as `tended`, so labelling by kind
//     turns a ferment checked eight times into eight identical "Tended" lines, which is the unbroken
//     run of absent failure signs the ruling forbids, drawn as a list instead of counted.
//
// These are guarded by BatchDetailView.test.jsx's own sweep, over THIS root testid. The shipped
// sweeps are scoped to `going-now-view` and would stay green over every one of them.
import React, { useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { describeAge, describeStage, isSuspended } from './goingNow.js'
import { describeOutcome } from './batchClose.js'
import BatchCloseField from './BatchCloseField.jsx'
import { preservedOn } from './JarPicker.jsx'

// Local copies of two private vocabularies. STAGE_KIND_LABELS is not exported from goingNow.js and
// KITCHEN_INPUT_KINDS lives in the Lambda; both are bound to their sources by parity assertions in
// BatchDetailView.test.jsx rather than by hope — the app has already shipped one bug where two
// hand-maintained copies of one vocabulary disagreed.
const STAGE_KIND_LABELS = {
  started: 'Started', tended: 'Tended', moved: 'Moved', finished: 'Finished', failed: 'Failed',
}
const INPUT_KIND_LABELS = {
  harvest: 'Pick', purchased: 'Bought', pantry: 'Pantry', other: 'Other',
}

// "Sep 3" — month and day only, the same register the card uses. Returns null rather than an
// Invalid Date string, so a line that cannot be dated does not render half-formed.
function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function inputRowText(row) {
  if (!row) return ''
  const parts = [INPUT_KIND_LABELS[row.input_kind] || 'Input']
  if (row.label) parts.push(row.label)
  // qty arrives as a STRING off the bigint/numeric boundary; it is rendered, never compared and
  // never summed. A NULL pair is not zero — the DDL's own idiom is "unrecorded, assume the whole
  // thing" — so it contributes no segment at all rather than a "0".
  if (row.qty != null && row.qty_unit) parts.push(`${row.qty} ${row.qty_unit}`)
  if (row.is_byproduct === true) parts.push('offcut')
  return parts.join(' · ')
}

export function stageRowText(row) {
  if (!row) return ''
  // (a) A reading is the row's subject when there is one. ph_read_at is when it was MEASURED, which
  // is the half that carries the information; entered_at is when it was typed.
  if (row.ph_reading != null) {
    const at = shortDate(row.ph_read_at)
    return at ? `pH ${row.ph_reading} · read ${at}` : `pH ${row.ph_reading}`
  }
  const label = row.label || STAGE_KIND_LABELS[row.stage_kind] || 'Logged'
  const at = shortDate(row.entered_at)
  return at ? `${label} · ${at}` : label
}

export function outputRowText(row) {
  if (!row) return ''
  const parts = []
  if (row.quantity_value != null && row.quantity_unit) parts.push(`${row.quantity_value} ${row.quantity_unit}`)
  if (row.package_count != null) parts.push(Number(row.package_count) === 1 ? '1 package' : `${row.package_count} packages`)
  const on = preservedOn(row.preserved_at)
  if (on) parts.push(on)
  // use_by_target / use_by_status are deliberately absent here for the same reason they are absent
  // from JarPicker: beside an outcome, a shelf-life date reads as an endorsement.
  return parts.join(' · ') || 'A put-up'
}

function Section({ title, testId, children }) {
  return (
    <section data-testid={testId} style={{ marginTop: T.space.md }}>
      <h3 style={{ margin: '0 0 4px', color: P.light, fontSize: T.type.xs, fontWeight: 700,
        letterSpacing: '0.3px', textTransform: 'uppercase' }}>{title}</h3>
      {children}
    </section>
  )
}

export default function BatchDetailView({ batch, inputs, stages, outputs, loading, error, nowMs, onChanged }) {
  const [showInputs, setShowInputs] = useState(false)

  if (loading) {
    return (
      <div data-testid="batch-detail-view">
        <div data-testid="batch-detail-loading" style={{ color: P.light, fontSize: T.type.sm }}>Opening that batch…</div>
      </div>
    )
  }
  if (error) {
    return (
      <div data-testid="batch-detail-view">
        <div role="alert" data-testid="batch-detail-error" style={{ color: P.terra, fontSize: T.type.sm }}>
          Couldn’t open that batch.
        </div>
      </div>
    )
  }
  if (!batch) {
    return (
      <div data-testid="batch-detail-view">
        <div data-testid="batch-detail-missing" style={{ color: P.light, fontSize: T.type.sm }}>
          That batch isn’t here any more.
        </div>
      </div>
    )
  }

  const age = describeAge(batch, nowMs)
  const stage = describeStage(batch, nowMs)
  const ageText = age == null
    ? null
    : age.kind === 'elapsed'
      ? (age.approx ? `about ${age.text}` : age.text)
      : (shortDate(age.at) ? `first recorded ${shortDate(age.at)}` : null)
  // ONE joined string, full-literal assertable. A `toContain` on a fragment passes on a value ten
  // days wrong — this repo shipped exactly that assertion once.
  const meta = [ageText, stage?.label, stage?.since].filter(Boolean).join(' · ')

  const outcomeText = describeOutcome(batch)
  const closedOn = shortDate(batch.closed_at)
  const inputRows = Array.isArray(inputs) ? inputs : []
  const stageRows = Array.isArray(stages) ? stages : []
  const outputRows = Array.isArray(outputs) ? outputs : []

  return (
    <div data-testid="batch-detail-view" data-batch-id={batch.id}>
      <div data-testid="batch-detail-title" style={{ fontWeight: 700, color: P.dark, fontSize: T.type.lg }}>
        {batch.label}
      </div>
      {meta && (
        <div data-testid="batch-detail-meta" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>{meta}</div>
      )}
      {isSuspended(batch) && (
        <div data-testid="batch-detail-paused" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>
          Paused since {shortDate(batch.suspended_at) ?? 'earlier'}
        </div>
      )}
      {outcomeText && (
        // Past fact, never fed to a computation. The label comes from the TOTAL table in
        // batchClose.js; the raw enum never reaches this DOM.
        <div data-testid="batch-detail-outcome" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>
          {closedOn ? `${outcomeText} · closed ${closedOn}` : outcomeText}
        </div>
      )}
      {batch.outcome_note && (
        <div data-testid="batch-detail-outcome-note" style={{ marginTop: 3, color: P.light, fontSize: T.type.sm }}>
          {batch.outcome_note}
        </div>
      )}

      <Section title="What went in" testId="batch-detail-inputs">
        <div data-testid="batch-detail-inputs-count" style={{ color: P.mid, fontSize: T.type.sm }}>
          {/* Counted off the RESOLVED rows, not off the view's `input_count` — that column arrives
              as a STRING off the bigint boundary, and a retry after a dropped write reports a delta
              rather than the truth. The count is the headline BECAUSE the rows are not: 139 picks is
              the measured fan-in and a scrollable list of them answers nothing a cook asks. No
              roll-up either — inputs[] carries no weight, and a total over `qty` would sum
              incompatible units. */}
          {inputRows.length === 1 ? '1 thing went in' : `${inputRows.length} things went in`}
        </div>
        {inputRows.length > 0 && (
          <button type="button" data-testid="batch-detail-inputs-toggle" aria-expanded={showInputs}
            onClick={() => setShowInputs(v => !v)}
            style={{ minHeight: T.tapMinHeight, background: 'none', border: 'none', padding: '2px 8px 2px 0',
              cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
            {showInputs ? 'Hide what went in' : 'List them →'}
          </button>
        )}
        {showInputs && (
          <>
            <ul data-testid="batch-detail-inputs-list" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
              {inputRows.map(row => (
                <li key={row.id} data-testid="batch-detail-input"
                  style={{ padding: '4px 0', color: P.mid, fontSize: T.type.sm }}>{inputRowText(row)}</li>
              ))}
            </ul>
            <p style={{ margin: '4px 0 0', color: P.light, fontSize: T.type.xs, lineHeight: 1.45 }}>
              A pick listed with no amount counts as the whole pick.
            </p>
          </>
        )}
        {/* L4 mounts <BatchInputsField batchId={batch.id} onChanged={onChanged} nowMs={nowMs} /> here.
            Its file is not this lane's to create, so the import is deliberately absent rather than
            stubbed with a placeholder component that would have to be deleted on integration. */}
      </Section>

      <Section title="Log" testId="batch-detail-stages">
        {stageRows.length === 0 ? (
          <div data-testid="batch-detail-stages-empty" style={{ color: P.light, fontSize: T.type.sm }}>
            Nothing logged yet.
          </div>
        ) : (
          <ul data-testid="batch-detail-stages-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {stageRows.map(row => (
              <li key={row.id} data-testid="batch-detail-stage" style={{ padding: '4px 0' }}>
                <div style={{ color: P.dark, fontSize: T.type.sm }}>{stageRowText(row)}</div>
                {(row.cue_observed || row.note) && (
                  <div data-testid="batch-detail-stage-detail" style={{ color: P.light, fontSize: T.type.xs }}>
                    {[row.cue_observed, row.note].filter(Boolean).join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="What came out" testId="batch-detail-outputs">
        {outputRows.length === 0 ? (
          <div data-testid="batch-detail-outputs-empty" style={{ color: P.light, fontSize: T.type.sm }}>
            No put-ups linked to this batch.
          </div>
        ) : (
          <ul data-testid="batch-detail-outputs-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {outputRows.map(row => (
              <li key={row.id} data-testid="batch-detail-output"
                style={{ padding: '4px 0', color: P.mid, fontSize: T.type.sm }}>{outputRowText(row)}</li>
            ))}
          </ul>
        )}
      </Section>

      <div style={{ marginTop: T.space.md }}>
        <BatchCloseField batch={batch} onChanged={onChanged} />
      </div>
    </div>
  )
}
