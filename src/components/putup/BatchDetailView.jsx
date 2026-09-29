// src/components/putup/BatchDetailView.jsx
// V5-KBCLOSE-001 — one batch, opened on purpose: what went in, what happened to it, what came out.
//
// CONTROLLED. This component issues no GET for its OWN data — `batch` / `inputs` / `stages` /
// `outputs` arrive already fetched, and `onChanged` walks back up to whoever owns the fetch. That is
// the same contract GoingNowView holds and it is what keeps the page's invalidation path intact.
// The hosted BatchInputsField reads for its OWN action (the crop vocabulary its add flow offers) and
// that is a different thing: it is handed `inputs`, so it never re-reads the batch this page fetched.
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
import React, { useCallback, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import {
  describeAge, describeStage, isSuspended, startPromptState, START_CHIPS, startChipPatch,
  pickedDatePatch, startPatchViolatesPairing, pausePatch, PAUSE_CTA, RESUME_CTA,
} from './goingNow.js'
import { describeOutcome } from './batchClose.js'
import BatchCloseField from './BatchCloseField.jsx'
import BatchInputsField from './BatchInputsField.jsx'
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

// Exported and still bound to KITCHEN_INPUT_KINDS, but no longer rendered here: BatchInputsField
// owns the inputs section since 20260904 and formats a row through batchInputs.js's own
// describeInputRow. Kept rather than deleted because the parity assertion over INPUT_KIND_LABELS is
// a live guard against a vocabulary drifting from the Lambda's, and it needs a caller to test.
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

// The line under a row: what was observed (the cue), what was noted — and, when the READING is the
// row's subject, the row's own label too. Put-Up 1a's Check on it writes ONE row per check-in, so a
// visit that read the pH AND moved the crock is one `moved` row labelled "Moved to Fridge" that also
// carries the reading; stageRowText leads with the reading, and without this the move would vanish
// from the log.
export function stageRowDetail(row) {
  if (!row) return ''
  const label = row.ph_reading != null ? row.label : null
  return [label, row.cue_observed, row.note].filter(Boolean).join(' · ')
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

function todayYMD() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const actionLink = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none',
  border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green,
  fontSize: '0.78rem',
}

// ── the missing-datum CTA — MOVED HERE from the Going-now card in Put-Up 1a (V4 §2.3) ───────────
// The card is left with at most three quiet actions, and setting a start date is a desk decision
// about the batch rather than a check-in, so it lives on the batch's own surface. Unchanged in every
// other respect: the shipped "Set parent plant →" shape (SavedSeeds.jsx:955-958), same ink as any
// other line, never a badge and never a warning colour — an unknown start is a permanent, acceptable
// terminal state. Expands IN PLACE, so it is not a dismissable layer and needs no registry entry.
function SetStartDate({ batch, fetch, onChanged }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [picked, setPicked] = useState('')

  const save = useCallback(async (patch) => {
    // The client-side restatement of chk_kitchen_batch_start_pairing. A patch that could never
    // commit is caught here rather than surfacing as an opaque 400 from a route the user cannot see.
    if (!patch || startPatchViolatesPairing(patch)) { setErr("That start doesn't make sense — pick another."); return }
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(patch) })
      setOpen(false)
      onChanged?.()
    } catch {
      setErr("Couldn't save that — try again.")
    } finally { setBusy(false) }
  }, [batch.id, fetch, onChanged])

  if (!open) {
    return (
      <button type="button" data-testid="batch-set-start" onClick={() => setOpen(true)} style={actionLink}>
        Set a start date →
      </button>
    )
  }

  return (
    <div data-testid="batch-start-chips" style={{ marginTop: 6 }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{err}</div>}
      {/* Ruling 5: NEVER ask for a precision grade. The grade is derived from WHICH CHIP was tapped;
          uncertainty is expressed by choosing a wider chip. "Longer / not sure" is a first-class
          answer, not a decline. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {START_CHIPS.map(chip => (
          <button key={chip.value} type="button" disabled={busy}
            data-testid={`batch-start-chip-${chip.value}`}
            onClick={() => save(startChipPatch(chip.value, Date.now()))}
            style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy ? 'default' : 'pointer',
              background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
              fontFamily: 'inherit', fontSize: T.type.sm, color: P.dark }}>
            {chip.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginTop: 8 }}>
        <input type="date" aria-label="Pick a start date" value={picked} max={todayYMD()}
          onChange={e => setPicked(e.target.value)}
          style={{ minHeight: T.tapMinHeight, padding: '6px 10px', fontFamily: 'inherit',
            fontSize: T.type.sm, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white }} />
        <button type="button" disabled={busy || !picked} data-testid="batch-start-pick-save"
          onClick={() => save(pickedDatePatch(picked))}
          style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy || !picked ? 'default' : 'pointer',
            background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
            fontWeight: 700, color: picked ? P.green : P.light }}>
          Use this date
        </button>
        <button type="button" onClick={() => { setOpen(false); setErr(null) }}
          style={{ minHeight: T.tapMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── pause / pick back up — MOVED HERE from the Going-now card in Put-Up 1a (V4 §2.3) ────────────
// A one-tap MERGE PUT on suspended_at. No confirm: it is reversible by the same control it was taken
// with, and a confirm on a reversible act is the tax that teaches people to stop reading confirms.
// Pausing is a DIFFERENT ANSWER and not a worse one, so it is an ordinary line, never an alarm. The
// instant is the surface's injected `nowMs`, so a test pins the PUT body to a fixed literal.
function PauseToggle({ batch, nowMs, fetch, onChanged }) {
  const paused = isSuspended(batch)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const toggle = useCallback(async () => {
    const patch = pausePatch(paused, nowMs)
    if (!patch) { setErr("Couldn't save that — try again."); return }
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(patch) })
      onChanged?.()
    } catch {
      // The row stays exactly as it was and says so. There is no offline queue in this app.
      setErr("Couldn't save that — try again.")
    } finally { setBusy(false) }
  }, [batch.id, fetch, nowMs, onChanged, paused])

  return (
    <div>
      <button type="button" data-testid="batch-pause" disabled={busy} onClick={toggle}
        style={{ ...actionLink, cursor: busy ? 'default' : 'pointer' }}>
        {paused ? RESUME_CTA : PAUSE_CTA}
      </button>
      {/* P.terra on a role="alert" error string is the one permitted use of it on this surface, and
          data-alarm-ink-exempt marks it for the alarm-ink sweep, which is about the BODY never
          reddening for a batch that is fine. */}
      {err && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-pause-error"
          style={{ color: P.terra, fontSize: '0.78rem', marginTop: 4 }}>{err}</div>
      )}
    </div>
  )
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
  // For the two WRITES this surface makes itself (start date, pause). It still issues no GET for its
  // own data — that contract is about reads, and BatchCloseField already writes the same way.
  const { fetch } = useApiFetch()
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
  const closed = !!batch.closed_at
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
      {/* The start-date door, on a batch nobody was ever asked about (start_precision NULL). Not on a
          closed batch: the merge PUT refuses a closed row, and a door that can only fail is noise. */}
      {!closed && startPromptState(batch) === 'prompt' && (
        <SetStartDate batch={batch} fetch={fetch} onChanged={onChanged} />
      )}

      <Section title="What went in" testId="batch-detail-inputs">
        {/* L4's field IS this section (integrated 20260904). It renders the same count and the same
            behind-a-tap list this lane wrote, plus the remove and the add flows — a superset — so
            shipping both put two counts, two doors and two lists of one batch's inputs on one screen.
            The subset went. `inputs` is handed DOWN rather than re-fetched: the page already holds
            GET /:id, and a child re-read is how one screen ends up with two copies that disagree.
            Normalised through `inputRows` on purpose — a non-array prop must degrade to an empty
            section, never flip the child back into fetching for itself.
            The whole-pick caveat is not repeated here: every bare pick row L4 renders already says
            "— the whole pick" on its own line, and the add flow states it in full. */}
        <BatchInputsField batchId={batch.id} inputs={inputRows} onChanged={onChanged} nowMs={nowMs} />
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
                {stageRowDetail(row) && (
                  <div data-testid="batch-detail-stage-detail" style={{ color: P.light, fontSize: T.type.xs }}>
                    {stageRowDetail(row)}
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
        {/* Pause sits with the other decision about the batch as a whole, above the terminal one. */}
        {!closed && <PauseToggle batch={batch} nowMs={nowMs} fetch={fetch} onChanged={onChanged} />}
        <BatchCloseField batch={batch} onChanged={onChanged} />
      </div>
    </div>
  )
}
