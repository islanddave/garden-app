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
// These are guarded by PutUpBatchDetail.test.jsx's own sweep, over THIS root testid. The shipped
// sweeps are scoped to `going-now-view` and would stay green over every one of them.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import {
  describeAge, describeStage, isSuspended, startPromptState, START_CHIPS, startChipPatch,
  pickedDatePatch, startPatchViolatesPairing, PAUSE_CTA, RESUME_CTA,
} from './goingNow.js'
import { describeOutcome } from './batchClose.js'
import BatchCloseField from './BatchCloseField.jsx'
import { closedEnding } from './ClosedBatchesView.jsx'
import { preservedOn } from './JarPicker.jsx'
import WhatWentIn, { FromGarden } from './WhatWentIn.jsx'
import SaltBlock from './SaltBlock.jsx'
import JarHeatRow from './JarHeatRow.jsx'
import RecipeRefRow from './RecipeRefRow.jsx'
import BatchRecipeRow, { SaveAsRecipe, MadeAsWrittenButton, useMadeAsWritten } from '../recipes/BatchRecipeRow.jsx'
import StageEditSheet from './StageEditSheet.jsx'
import ShuSheet from './ShuSheet.jsx'
import KindQuestion from './KindQuestion.jsx'
import { kindLabel } from '../kitchen/KindChips.jsx'
import Button from '../forms/Button.jsx'
import CheckOnItSheet from './CheckOnItSheet.jsx'
import CheckInSaved from './CheckInSaved.jsx'
import LineAdder from './LineAdder.jsx'
import { CHECK_ON_IT_CTA, CHECK_IN_ACTS } from './goingNow.js'
import { lineWords, nextOrdinal } from './lines.js'
import { shuRangeWords } from './fermentMath.js'
import PutItUpSheet from './PutItUpSheet.jsx'
import { PUT_IT_UP_CTA } from './putItUp.js'
import { useUndoPutUp, UNDO_PUT_UP_CTA, UNDONE_TEXT } from './PutUpStub.jsx'
import { putUpDateWords, countedSize, sizeWords, ESTIMATED_PRECISIONS } from './jarWords.js'
import { describeRefusal, hasJarsText, REFUSAL_CODES } from '../../lib/putUpErrors.js'

// Local copies of two private vocabularies. STAGE_KIND_LABELS is not exported from goingNow.js and
// KITCHEN_INPUT_KINDS lives in the Lambda; both are bound to their sources by parity assertions in
// BatchDetailView.test.jsx rather than by hope — the app has already shipped one bug where two
// hand-maintained copies of one vocabulary disagreed.
//
// Release F: the table covers EVERY kind a stage row can carry — the Lambda's KITCHEN_STAGE_KINDS_ALL
// (the 1b history kinds folded in; the parity test binds it). Words, never a status: a pause is a
// different answer, not a worse one, and "Picked back up" is the card's own word for resuming. A void
// row never renders (liveStages drops it) — its word is here only so the table is total.
const STAGE_KIND_LABELS = {
  started: 'Started', tended: 'Tended', moved: 'Moved', finished: 'Finished', failed: 'Failed',
  reopened: 'Reopened', paused: 'Paused', resumed: 'Picked back up', noted: 'Next time', put_up: 'Put up',
  void: 'Taken back',
}

// Put-Up release 1b — the Log is the history AS IT STANDS: a void row and the row it voids are both
// left out (an undone check-in or put-up is gone, not "undone"), exactly as every stage LATERAL in the
// view skips them. contract-F §2.1 returns void rows in `stages`, so this filter is the client's.
export function liveStages(rows) {
  const list = Array.isArray(rows) ? rows : []
  const voided = new Set(list.filter(r => r?.stage_kind === 'void' && r.voids_id).map(r => r.voids_id))
  return list.filter(r => r && r.stage_kind !== 'void' && !voided.has(r.id))
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

export function stageRowText(row, nowMs = Date.now()) {
  if (!row) return ''
  // (a) A reading is the row's subject when there is one. ph_read_at is when it was MEASURED, which
  // is the half that carries the information; entered_at is when it was typed.
  if (row.ph_reading != null) {
    const at = shortDate(row.ph_read_at)
    return at ? `pH ${row.ph_reading} · read ${at}` : `pH ${row.ph_reading}`
  }
  const label = row.label || STAGE_KIND_LABELS[row.stage_kind] || 'Logged'
  // An estimated entry (1b's entered_precision) says its window, never an invented day; an undated one
  // (precision `unknown`, entered_at NULL) is just its label.
  const at = ESTIMATED_PRECISIONS.has(row.entered_precision) && row.entered_at
    ? putUpDateWords(localYmd(row.entered_at), row.entered_precision, { now: new Date(nowMs) })
    : shortDate(row.entered_at)
  return at ? `${label} · ${at}` : label
}

function localYmd(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The line under a row: what was observed (the cue), what was noted — and, when the READING is the
// row's subject, the row's own label too. Put-Up 1a's Check on it writes ONE row per check-in, so a
// visit that read the pH AND moved the crock is one `moved` row labelled "Moved to Fridge" that also
// carries the reading; stageRowText leads with the reading, and without this the move would vanish
// from the log.
//
// Release F (06 §4 item 6) extends it with what F rows carry, as words — acts as their words ("Topped
// up brine · Skimmed the top"), a top-up as "+250 ml", Made as "made 910 g in all", mash as "mash in
// 180 g", the start's amount as "about 448 g in it". One line, quiet ink, no glyphs or ticks, never a
// count or a series.
export function stageRowDetail(row) {
  if (!row) return ''
  const label = row.ph_reading != null ? row.label : null
  const acts = Array.isArray(row.acts)
    ? CHECK_IN_ACTS.filter(a => row.acts.includes(a.value)).map(a => a.label) : []
  const amt = row.amount != null ? Math.round(Number(row.amount) * 100) / 100 : null
  let amount = null
  if (amt != null && row.stage_kind === 'tended' && row.amount_unit) amount = `+${amt} ${row.amount_unit}`
  if (amt != null && row.stage_kind === 'started' && row.amount_unit) amount = `about ${amt} ${row.amount_unit} in it`
  if (amt != null && row.stage_kind === 'put_up') amount = `made ${amt} g in all`
  const mash = row.mash_in_g != null ? `mash in ${Math.round(Number(row.mash_in_g) * 100) / 100} g` : null
  return [label, row.cue_observed, ...acts, amount, mash, row.note].filter(Boolean).join(' · ')
}

export function outputRowText(row, nowMs = Date.now()) {
  if (!row) return ''
  // Put-Up release 1b: a jar from a sitting carries its name, its container and its date at the
  // precision it was stored (jarWords.js), and may have no size at all. A pre-1b linked jar keeps
  // exactly the words it had.
  if (row.put_up_stage_id || row.label || row.container_label || row.preserved_at_precision) {
    const parts = []
    if (row.label) parts.push(row.label)
    const n = Number(row.package_count)
    const size = countedSize(Number.isFinite(n) && n >= 1 ? n : 1, row)
    if (size) parts.push(size)
    const on = putUpDateWords(row.preserved_at, row.preserved_at_precision, { approx: row.preserved_at_approx === true, now: new Date(nowMs) })
    if (on) parts.push(`put up ${on}`)
    if (row.is_raw === true) parts.push('raw')
    if (row.in_oil === true) parts.push('in oil')
    if (row.ph_reading != null) parts.push(`pH ${row.ph_reading}`)
    return parts.join(' · ') || 'A put-up'
  }
  // A linked jar from before 1b. Contract-F A3: its quantity is the TOTAL, so it is never said beside
  // its count as if per-container ("3 pint · 3 packages" read as three pints each) — countedSize says
  // "3 containers · 3 pint in all".
  const parts = []
  const size = row.package_count != null ? countedSize(row.package_count, row) : sizeWords(row)
  if (size) parts.push(size)
  const on = preservedOn(row.preserved_at)
  if (on) parts.push(on)
  // use_by_target / use_by_status are deliberately absent here for the same reason they are absent
  // from JarPicker: beside an outcome, a shelf-life date reads as an endorsement.
  return parts.join(' · ') || 'A put-up'
}

// What came out, by sitting: each put_up stage row that still stands, with its jars; then any jar
// linked by the shipped JarPicker (no sitting, no Undo). A jar whose sitting is not in the live log
// (it was voided) is not shown under a sitting that is gone.
export function outputSittings(outputs, stages) {
  const jars = Array.isArray(outputs) ? outputs : []
  const sittings = liveStages(stages).filter(r => r.stage_kind === 'put_up')
  const ids = new Set(sittings.map(r => r.id))
  return {
    sittings: sittings.map(st => ({ stage: st, jars: jars.filter(j => j?.put_up_stage_id === st.id) })),
    linked: jars.filter(j => !j?.put_up_stage_id || !ids.has(j.put_up_stage_id)),
  }
}

function todayYMD() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const actionLink = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, minWidth: 44, background: 'none',
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
          style={{ minHeight: T.buttonMinHeight, padding: '6px 12px', cursor: busy || !picked ? 'default' : 'pointer',
            background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
            fontWeight: 700, color: picked ? P.green : P.light }}>
          Use this date
        </button>
        <button type="button" onClick={() => { setOpen(false); setErr(null) }}
          style={{ minHeight: T.buttonMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── pause / pick back up — MOVED HERE from the Going-now card in Put-Up 1a (V4 §2.3) ────────────
// One tap, one stage row (release 1b; see toggle below). No confirm: it is reversible by the same control
// it was taken with, and a confirm on a reversible act is the tax that teaches people to stop reading
// confirms. Pausing is a DIFFERENT ANSWER and not a worse one, so it is an ordinary line, never an alarm.
function PauseToggle({ batch, fetch, onChanged }) {
  const paused = isSuspended(batch)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // Put-Up release 1b (V4 Appendix A; the 1b Lambda's stateStage): a pause is ONE write — POST
  // /:id/stages {stage_kind: 'paused'|'resumed'} moves suspended_at AND writes the history row in one
  // statement, whose WHERE is the state precondition. The merge PUT of suspended_at is no longer used
  // here: it moved the column with no history row, and a row posted after it would be refused (the
  // batch would already be paused). A refusal (a double tap, a stale tab) says so in the server's words.
  const toggle = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/stages`, { method: 'POST', body: JSON.stringify({
        stage_kind: paused ? 'resumed' : 'paused',
      }) })
      onChanged?.()
    } catch (e) {
      // The row stays exactly as it was and says so. There is no offline queue in this app.
      setErr(describeRefusal(e)?.text ?? "Couldn't save that — try again.")
    } finally { setBusy(false) }
  }, [batch.id, fetch, onChanged, paused])

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

// ── one sitting in What came out, with its Undo (V4 §2.3 "Undo that put-up", no timer) ──────────────
// Release F adds, per sitting: "Mash in" beside "Made … in all" (both editable through the sitting's own
// Log entry, 06 §3.7), the lines added at the end (to every jar, or to one), a way to add one more even
// after bottling (06 §3.13: final-step additions, fresh or cooked, per Dave), and per jar its heat
// estimate (worked out from the sitting, or typed) and "from the garden".
function JarRow({ batchId, jar, nowMs, gardenNames, lines, onChanged }) {
  const [shuOpen, setShuOpen] = useState(false)
  const { fetch } = useApiFetch()
  const heat = shuRangeWords(jar.shu_est_low, jar.shu_est_high)
  const added = (lines ?? []).filter(l => l.output_id === jar.id)
  return (
    <li data-testid="batch-detail-output" data-jar-id={jar.id} style={{ padding: '2px 0', color: P.mid, fontSize: T.type.sm }}>
      <span data-testid="batch-detail-output-text">{outputRowText(jar, nowMs)}</span>
      {jar.cooked === true && <span> · cooked after blending</span>}
      {added.length > 0 && <span data-testid="batch-detail-output-added"> · added at the end: {added.map(l => lineWords(l)).join(', ')}</span>}
      {gardenNames.length > 0 && <FromGarden testId="batch-detail-output-garden" />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span data-testid="batch-detail-output-heat" style={{ color: P.light, fontSize: '0.78rem' }}>
          {heat ? `heat ${heat}${jar.shu_est_basis === 'typed' ? ' (typed)' : jar.shu_est_basis === 'computed' ? ' (worked out)' : ''}` : 'heat not worked out'}
        </span>
        <button type="button" style={{ ...actionLink, fontSize: '0.74rem' }} data-testid="batch-detail-output-work-it-out" onClick={() => setShuOpen(true)}>
          Work it out
        </button>
      </div>
      <ShuSheet open={shuOpen} batchId={batchId} scope="jar" id={jar.id} title={`Heat · ${jar.label ?? 'this jar'}`}
        onClose={() => setShuOpen(false)} onSaved={() => { setShuOpen(false); onChanged?.() }}
        onType={async (r) => {
          await fetch(`/api/preservation/${jar.id}`, { method: 'PATCH', body: JSON.stringify({ shu_est_low: r.low, shu_est_high: r.high }) })
          setShuOpen(false); onChanged?.()
        }} />
    </li>
  )
}

function Sitting({ batchId, stage, jars, lines, onChanged, nowMs, gardenNames, onEdit }) {
  const { fetch } = useApiFetch()
  const { undo, busy, err, done } = useUndoPutUp({ batchId, stageId: stage.id, onUndone: onChanged })
  const [adding, setAdding] = useState(false)
  const [toJar, setToJar] = useState(null)
  const [addErr, setAddErr] = useState(null)
  const when = stageRowText({ ...stage, label: null }, nowMs)
  const sittingLines = (lines ?? []).filter(l => l.put_up_stage_id === stage.id && l.output_id == null)
  const facts = [
    stage.amount != null ? `made ${Math.round(Number(stage.amount) * 100) / 100} g in all` : null,
    stage.mash_in_g != null ? `mash in ${Math.round(Number(stage.mash_in_g) * 100) / 100} g` : null,
  ].filter(Boolean)
  const addLine = async (body) => {
    setAddErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batchId}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: [{
        ...body, put_up_stage_id: stage.id, ...(toJar ? { output_id: toJar } : {}), ordinal: nextOrdinal(lines),
      }] }) })
      setAdding(false)
      onChanged?.()
      return true
    } catch (e) {
      setAddErr(describeRefusal(e)?.text ?? "Couldn't add that — try again. What you typed is still here.")
      return false
    }
  }
  return (
    <li data-testid="batch-detail-sitting" data-stage-id={stage.id} style={{ padding: '6px 0', borderTop: `1px solid ${P.cream}` }}>
      <button type="button" data-testid="batch-detail-sitting-head" onClick={() => onEdit?.(stage)}
        style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: T.tapMinHeight, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
        <div style={{ color: P.dark, fontSize: T.type.sm, fontWeight: 600 }}>{when}</div>
        {facts.length > 0 && (
          <div data-testid="batch-detail-sitting-facts" style={{ color: P.light, fontSize: T.type.xs }}>{facts.join(' · ')}</div>
        )}
      </button>
      {sittingLines.length > 0 && (
        <div data-testid="batch-detail-sitting-added" style={{ color: P.mid, fontSize: '0.78rem' }}>
          added at the end to every jar: {sittingLines.map(l => lineWords(l)).join(', ')}
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {jars.map(j => (
          <JarRow key={j.id} batchId={batchId} jar={j} nowMs={nowMs} gardenNames={gardenNames} lines={lines} onChanged={onChanged} />
        ))}
      </ul>
      {!done && (
        adding ? (
          <div data-testid="batch-detail-sitting-adder" style={{ marginTop: 6 }}>
            {jars.length > 1 && (
              <div role="radiogroup" aria-label="Added to" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                {[{ id: null, label: 'Every jar' }, ...jars.map(j => ({ id: j.id, label: j.label ?? 'This jar' }))].map(o => (
                  <button key={o.id ?? 'all'} type="button" role="radio" aria-checked={toJar === o.id} data-testid={`batch-detail-sitting-to-${o.id ?? 'all'}`}
                    onClick={() => setToJar(o.id)}
                    style={{ minHeight: T.buttonMinHeight, padding: '6px 14px', borderRadius: T.radiusPill, fontFamily: 'inherit', fontSize: T.type.sm,
                      border: `1px solid ${toJar === o.id ? P.green : P.border}`, background: toJar === o.id ? P.green : P.white,
                      color: toJar === o.id ? P.white : P.dark, cursor: 'pointer' }}>{o.label}</button>
                ))}
              </div>
            )}
            <LineAdder lines={lines} onAdd={addLine} idPrefix={`sitting-add-${stage.id}`} forms={['fresh', 'cooked']}
              label="What was added at the end?" addLabel="Add it" />
            {addErr && <div role="alert" data-alarm-ink-exempt="error" style={{ color: P.terra, fontSize: '0.78rem' }}>{addErr}</div>}
            <button type="button" style={{ ...actionLink, color: P.light }} onClick={() => { setAdding(false); setAddErr(null) }}>Cancel</button>
          </div>
        ) : (
          <button type="button" style={actionLink} data-testid="batch-detail-sitting-add" onClick={() => setAdding(true)}>
            + Something added at the end
          </button>
        )
      )}
      {/* B′: no Undo on a sitting that wrote no jars of its own — How it was made →'s, whose jars were
          logged before the batch (the server says so with has_own_jars, and refuses nothing_put_up_here).
          An older server sends no flag: the Undo stays, as it always was. */}
      {stage.has_own_jars === false ? null : done ? (
        <div role="status" style={{ color: P.mid, fontSize: '0.78rem' }}>{UNDONE_TEXT}</div>
      ) : (
        <button type="button" data-testid="batch-detail-undo-putup" disabled={busy} onClick={undo}
          style={{ ...actionLink, cursor: busy ? 'default' : 'pointer' }}>
          {UNDO_PUT_UP_CTA}
        </button>
      )}
      {err && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-detail-undo-error"
          style={{ color: P.terra, fontSize: '0.78rem' }}>{err}</div>
      )}
    </li>
  )
}

// ── a put-up PICKED for this batch (BUG-BATCHREMOVEDEADEND-001) ─────────────────────────────────────
// The close sheet's "Which put-ups came out of it?" (and How it was made →) link a put-up that was
// already in the Pantry: batch_id alone, no sitting, so no Undo. "Take it off this batch" is its door —
// the server's repair path for a wrong pick at close (DELETE /:id/outputs/:plid), which no screen called
// before this — and the only way such a batch can then be removed. One tap, no confirm: the put-up itself
// is not touched, and the row that answers puts it back (POST /:id/outputs).
//
// The next read no longer carries the put-up, so its "Taken off · Undo" row is held by the batch surface
// until navigation, the shape What went in's "Taken out · Undo" has.
export const TAKE_OFF_CTA = 'Take it off this batch'
export const TAKEN_OFF_TEXT = 'Taken off — it’s still in the Pantry.'
export const NOT_ON_BATCH_TEXT = 'That one isn’t on this batch any more.'
export const CANT_PUT_BACK_TEXT = 'Couldn’t put it back — it was removed, or picked for another batch since.'

// A held row yields to the read once the read has CONFIRMED it. `gone` is set the first time a read of the
// batch lacks the put-up; after that, a read that carries it again wins and the row is dropped — it was
// linked again by a path this row never heard from (an Undo that landed while its answer was lost, a second
// close that picked it, the other person). A `back` row is dropped as soon as the read carries the put-up.
// Until a read has confirmed a take-off the row masks the read: that is the window while its re-read is in
// flight. Without this a "Taken off" row could outlive the truth, hide the put-up's door and leave Remove
// this batch refused with nothing to tap — the dead end this door exists to remove. Returns the SAME array
// when nothing changed.
export function reconcileTakenOff(entries, batchId, readIds) {
  let changed = false
  const next = []
  for (const t of entries) {
    if (t.batchId !== batchId) { next.push(t); continue }
    const inRead = readIds.has(t.jar.id)
    if (inRead && (t.back || t.gone)) { changed = true; continue }
    if (!inRead && !t.back && !t.gone) { changed = true; next.push({ ...t, gone: true }); continue }
    next.push(t)
  }
  return changed ? next : entries
}

// Code-unit order, as the database compares a date and a uuid (never a locale's collation).
const readOrder = (a, b) => { const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0 }

function PickedJar({ batchId, jar, nowMs, fetch, onTakenOff, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const takeOff = useCallback(async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batchId}/outputs/${jar.id}`, { method: 'DELETE' })
      // Stays busy: the row is replaced by its "Taken off" row as soon as the parent hears.
      onTakenOff?.(jar)
    } catch (e) {
      // 404: someone else took it off, or the put-up was removed — the row is stale, so re-read.
      if (e?.status === 404) { setErr(NOT_ON_BATCH_TEXT); onChanged?.() }
      else setErr(describeRefusal(e)?.text ?? "Couldn't take it off — try again.")
      setBusy(false)
    }
  }, [batchId, busy, fetch, jar, onChanged, onTakenOff])
  return (
    <li data-testid="batch-detail-output" data-jar-id={jar.id} style={{ padding: '4px 0', color: P.mid, fontSize: T.type.sm }}>
      <span data-testid="batch-detail-output-text">{outputRowText(jar, nowMs)}</span>
      {/* A sitting's jar is never offered this: the server refuses it (put_up_jar), and Undo is its door. */}
      {!jar.put_up_stage_id && (
        <div>
          <button type="button" data-testid="batch-detail-output-take-off" disabled={busy} onClick={takeOff}
            style={{ ...actionLink, cursor: busy ? 'default' : 'pointer' }}>
            {TAKE_OFF_CTA}
          </button>
        </div>
      )}
      {err && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-detail-output-error"
          style={{ color: P.terra, fontSize: '0.78rem' }}>{err}</div>
      )}
    </li>
  )
}

function TakenOffJar({ batchId, jar, nowMs, fetch, onPutBack, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const putBack = useCallback(async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batchId}/outputs`, { method: 'POST', body: JSON.stringify({
        preservation_log_ids: [jar.id],
      }) })
      // The route SKIPS a put-up it cannot link and answers 200 with the count: removed, on another batch
      // by now — or ALREADY ON THIS ONE (an earlier Undo landed and its answer was lost). The count cannot
      // say which, so the batch is read again: if the put-up is on it, this row gives way to the read.
      // An older answer with no count is taken at its word.
      if (answer && Number(answer.linked) === 0) { setErr(CANT_PUT_BACK_TEXT); setBusy(false); onChanged?.(); return }
      onPutBack?.(jar)
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't put it back — try again.")
      setBusy(false)
    }
  }, [batchId, busy, fetch, jar, onChanged, onPutBack])
  return (
    <li data-testid="batch-detail-output-taken-off" data-jar-id={jar.id} style={{ padding: '4px 0', color: P.light, fontSize: T.type.sm }}>
      <s>{outputRowText(jar, nowMs)}</s>
      <div role="status" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, color: P.mid, fontSize: '0.78rem' }}>
        <span>{TAKEN_OFF_TEXT}</span>
        <button type="button" data-testid="batch-detail-output-put-back" disabled={busy} onClick={putBack}
          style={{ ...actionLink, cursor: busy ? 'default' : 'pointer' }}>Undo</button>
      </div>
      {err && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-detail-output-error"
          style={{ color: P.terra, fontSize: '0.78rem' }}>{err}</div>
      )}
    </li>
  )
}

// ── Remove this batch (V4 §2.3: started by mistake) — two-step, refused while it has jars ───────────
// `blockers` ({ sitting, picked }) is what this surface can see holding the batch: has_jars does not say
// which kind of jar, and each kind has its own door (putUpErrors.hasJarsText).
function RemoveBatch({ batch, fetch, onRemoved, blockers }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const remove = useCallback(async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'DELETE' })
      onRemoved?.()
    } catch (e) {
      // has_jars names the door for the jars this batch has (putUpErrors.hasJarsText); every other code,
      // the server's words.
      const r = describeRefusal(e)
      setErr(r?.code === REFUSAL_CODES.HAS_JARS ? hasJarsText(blockers) : r?.text ?? "Couldn't remove it — try again.")
      setBusy(false)
    }
  }, [batch.id, blockers, busy, fetch, onRemoved])
  if (!confirming) {
    return (
      <button type="button" data-testid="batch-remove" onClick={() => setConfirming(true)}
        style={{ ...actionLink, color: P.light }}>Remove this batch</button>
    )
  }
  return (
    <div data-testid="batch-remove-confirm" style={{ marginTop: 4 }}>
      <div style={{ color: P.mid, fontSize: '0.78rem' }}>Remove “{batch.label}”? Only for a batch started by mistake.</div>
      <div style={{ display: 'flex', gap: T.space.md }}>
        <button type="button" data-testid="batch-remove-yes" disabled={busy} onClick={remove}
          style={{ ...actionLink, color: P.terra, fontWeight: 700 }}>Remove it</button>
        <button type="button" data-testid="batch-remove-no" disabled={busy} onClick={() => { setConfirming(false); setErr(null) }}
          style={{ ...actionLink, color: P.light }}>Keep it</button>
      </div>
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-remove-error"
        style={{ color: P.terra, fontSize: '0.78rem' }}>{err}</div>}
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

// `refreshFailed` (release F): the page's re-read after a write failed while this batch was already on
// screen. The body stays — it is still the batch, a write earlier — and one quiet line says the refresh
// did not land, with Try again (`onRetry`, disabled while `refreshing`). `error` is only ever a batch
// that never opened.
//
// Put-Up UX pass R1 (D15) — THE ACTION ROW. The two everyday acts, Check on it and Put it up, sit in one
// row under the title instead of a screen and a half down in the Log and What came out. On a batch that
// is going (or paused) Check on it is the page's one filled button and Put it up the secondary beside it;
// on a finished batch Check on it is the secondary and nothing is filled — a batch that ended in September
// has no loudest thing. Their testids did not change, and Put it up is still absent on a finished batch.
// What each one answers with ("Saved · Undo", the put-up's words) shows under the row it was tapped in.
// `onOpenRecipe(id, origin)` (optional; the page's opener) is handed to the recipe row.
export default function BatchDetailView({ batch, inputs, stages, outputs, loading, error, nowMs, onChanged, onRemoved,
  refreshFailed = false, refreshing = false, onRetry, onOpenRecipe }) {
  // For the WRITES this surface makes itself (start date, pause, remove). It still issues no GET for its
  // own data — that contract is about reads, and BatchCloseField already writes the same way.
  const { fetch } = useApiFetch()
  // Put it up from the batch's own surface. Completion here is the new sitting in What came out (V4
  // §2.4); the stub's words (with the label hint) sit under the action row until the next visit.
  const [putUpOpen, setPutUpOpen] = useState(false)
  const [stubText, setStubText] = useState(null)
  // Release F: Jar & heat's disclosure (never opened by itself; closed when a line add starts), the
  // [Salt] chip's hand-off to the Salt block, the stage being edited and its "Saved · Undo", and Check
  // on it from the action row.
  const [jarOpen, setJarOpen] = useState(false)
  const [saltFocus, setSaltFocus] = useState(0)
  const [editing, setEditing] = useState(null)
  const [stageSaved, setStageSaved] = useState(null)       // { stageId, undo }
  const [checking, setChecking] = useState(false)
  const [checkSaved, setCheckSaved] = useState(null)       // stage id of the check-in just saved
  const [logErr, setLogErr] = useState(null)
  // Put-ups taken off a batch this visit, client-held: [{ batchId, jar, back, gone }]. `back` is an Undo
  // whose re-read has not landed yet; `gone`, a take-off a read has confirmed (reconcileTakenOff). Each entry
  // names its batch because this surface is not remounted per batch.
  const [takenOff, setTakenOff] = useState([])
  const heldBatchId = batch?.id
  useEffect(() => {
    if (!heldBatchId) return
    const readIds = new Set((Array.isArray(outputs) ? outputs : []).map(j => j?.id))
    setTakenOff(t => reconcileTakenOff(t, heldBatchId, readIds))
  }, [heldBatchId, outputs])
  const undoRef = useRef(false)
  // "Made it as written" has two doors here (the recipe row's link, and a button in the empty What went
  // in block), so they share one write and one key set. Called before the early returns: a hook.
  const asWritten = useMadeAsWritten({ batch, inputs, onChanged })
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
  // days wrong — this repo shipped exactly that assertion once. The kind leads, in its chip's word; a
  // kind with no chip (the legacy `age`, anything unknown) and no kind at all print nothing.
  const meta = [kindLabel(batch.kind), ageText, stage?.label, stage?.since].filter(Boolean).join(' · ')

  const outcomeText = describeOutcome(batch)
  const closed = !!batch.closed_at
  const inputRows = Array.isArray(inputs) ? inputs : []
  const stageRows = liveStages(stages)
  const { sittings, linked } = outputSittings(outputs, stages)
  // A picked put-up is shown from the read until it is taken off, then from `takenOff` until the read
  // carries it again (an Undo): never both, and never neither while a re-read is in flight.
  // Reconciled against THIS read before anything is drawn (the effect above stores the same answer), so a
  // row never paints once from a state the read has already overtaken.
  const readIds = new Set((Array.isArray(outputs) ? outputs : []).map(j => j?.id))
  const off = reconcileTakenOff(takenOff, batch.id, readIds).filter(t => t.batchId === batch.id)
  const linkedIds = new Set(linked.map(j => j.id))
  const picked = linked.filter(j => !off.some(t => t.jar.id === j.id && !t.back))
  const offRows = off.filter(t => !t.back || !linkedIds.has(t.jar.id))
  // One list. The read's rows stay exactly as it ordered them (preserved_at DESC, id DESC — getBatch) and
  // each held row goes back in where that order puts it, so a row answers where it was tapped instead of
  // dropping to the end of the list.
  const pickedRows = picked.map(jar => ({ jar, state: 'picked' }))
  for (const t of offRows) {
    const at = pickedRows.findIndex(r => (readOrder(r.jar.preserved_at, t.jar.preserved_at) || readOrder(r.jar.id, t.jar.id)) < 0)
    pickedRows.splice(at < 0 ? pickedRows.length : at, 0, { jar: t.jar, state: t.back ? 'back' : 'off' })
  }
  // What holds Remove this batch. A pieced batch (How it was made →: a put_up row that wrote no jar of its
  // own) lets go of its picked put-ups itself, so there they hold nothing.
  const pieced = sittings.some(s => s.stage.has_own_jars === false)
  const blockers = {
    sitting: (Array.isArray(outputs) ? outputs : []).filter(j => j?.put_up_stage_id).length,
    // A put-up put back whose re-read is not here yet is on the batch: it counts.
    picked: pieced ? 0 : pickedRows.filter(r => r.state !== 'off' && !r.jar.put_up_stage_id).length,
  }
  const gardenNames = Array.isArray(batch.garden_names) ? batch.garden_names : []

  const undoStageEdit = async () => {
    if (!stageSaved || undoRef.current) return
    undoRef.current = true
    setLogErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/stages/${stageSaved.stageId}`, { method: 'PATCH', body: JSON.stringify(stageSaved.undo) })
      setStageSaved(null)
      onChanged?.()
    } catch (e) {
      setLogErr(describeRefusal(e)?.text ?? "Couldn't undo that — try again.")
    } finally { undoRef.current = false }
  }

  return (
    <div data-testid="batch-detail-view" data-batch-id={batch.id}>
      <div data-testid="batch-detail-title" style={{ fontWeight: 700, color: P.dark, fontSize: T.type.lg }}>
        {batch.label}
      </div>
      {meta && (
        <div data-testid="batch-detail-meta" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>{meta}</div>
      )}
      {refreshFailed && (
        // Quiet ink, on purpose: nothing was lost — the write landed, only its read-back did not.
        <div role="status" data-testid="batch-detail-refresh-failed"
          style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 3, color: P.mid, fontSize: T.type.sm }}>
          <span>Couldn’t refresh this batch —</span>
          <button type="button" data-testid="batch-detail-refresh-retry" disabled={refreshing} onClick={() => onRetry?.()}
            style={{ ...actionLink, cursor: refreshing ? 'default' : 'pointer' }}>
            {refreshing ? 'Trying again…' : 'Try again'}
          </button>
        </div>
      )}
      {isSuspended(batch) && (
        <div data-testid="batch-detail-paused" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>
          Paused since {shortDate(batch.suspended_at) ?? 'earlier'}
        </div>
      )}
      {outcomeText && (
        // Past fact, never fed to a computation. The label comes from the TOTAL table in
        // batchClose.js; the raw enum never reaches this DOM. The SAME string the closed list's row
        // says for this batch (closedEnding): "closed Sep 11 · 6 put-ups" there cannot open onto
        // "Put it up · closed Sep 11" here.
        <div data-testid="batch-detail-outcome" style={{ marginTop: 3, color: P.mid, fontSize: T.type.sm }}>
          {closedEnding(batch, { label: outcomeText })}
        </div>
      )}
      {batch.outcome_note && (
        <div data-testid="batch-detail-outcome-note" style={{ marginTop: 3, color: P.light, fontSize: T.type.sm }}>
          {batch.outcome_note}
        </div>
      )}
      {/* The action row. 12px apart, wrapping onto a second line rather than shrinking under 48px. */}
      <div data-testid="batch-detail-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: T.space.sm }}>
        <Button variant={closed ? 'secondary' : 'primary'} data-testid="batch-detail-check" onClick={() => setChecking(true)}>
          {CHECK_ON_IT_CTA}
        </Button>
        {/* A batch gets NEW jars only through a sitting (V4 §2.4). Not on a closed batch: a new sitting
            there is refused, and Reopen lives with the ending. */}
        {!closed && (
          <Button variant="secondary" data-testid="batch-detail-put-up" onClick={() => setPutUpOpen(true)}>
            {PUT_IT_UP_CTA}
          </Button>
        )}
      </div>
      {/* In place: each act answers where it was tapped. */}
      {checkSaved && <CheckInSaved key={checkSaved} batchId={batch.id} stageId={checkSaved} onUndone={onChanged} />}
      {stubText && (
        <div role="status" data-testid="batch-detail-putup-stub" style={{ color: P.mid, fontSize: '0.82rem', marginTop: 4 }}>
          {stubText}
        </div>
      )}
      {/* Release F (06 §3.10): the kind question, inline, on open AND closed batches alike, while the
          kind is unanswered — the Ferment fields appear with no navigation once it is. */}
      {batch.kind == null && <KindQuestion batch={batch} fetch={fetch} onChanged={onChanged} idPrefix="batch-kind" />}
      {/* The start-date door, on a batch nobody was ever asked about (start_precision NULL). Release F
          (06 §3.13, Dave 15:55 "as we go"): offered on a finished batch too — the merge PUT takes
          content writes after close, so the door can land there now. */}
      {startPromptState(batch) === 'prompt' && (
        <SetStartDate batch={batch} fetch={fetch} onChanged={onChanged} />
      )}
      <RecipeRefRow batch={batch} onChanged={onChanged} />
      {/* The recipe row alone: Save as recipe is mounted down beside Pause and the ending. */}
      <BatchRecipeRow batch={batch} inputs={inputRows} onChanged={onChanged} onOpenRecipe={onOpenRecipe}
        saveAsRecipe={false} asWritten={asWritten} />

      <Section title="What went in" testId="batch-detail-inputs">
        {/* Release F: What went in is WhatWentIn (the reworked field) with the Salt block inside it,
            always reachable. `inputs` is handed DOWN rather than re-fetched: the page already holds
            GET /:id, and a child re-read is how one screen ends up with two copies that disagree.
            Keyed by the batch: what it holds for the visit (the opened add row, "Saved · Undo", a line
            taken out) belongs to this batch and to no other. */}
        <WhatWentIn batch={batch} lines={inputRows} gardenNames={gardenNames} onChanged={onChanged} key={batch.id}
          onSaltTap={() => setSaltFocus(n => n + 1)} onLineStart={() => setJarOpen(false)}
          asWrittenSlot={<MadeAsWrittenButton asWritten={asWritten} />}
          saltSlot={<SaltBlock batch={batch} lines={inputRows} onChanged={onChanged} focusSeq={saltFocus} />} />
      </Section>

      <JarHeatRow batch={batch} stages={stages} lines={inputRows} onChanged={onChanged} open={jarOpen}
        onToggle={() => setJarOpen(o => !o)} />

      <Section title="Log" testId="batch-detail-stages">
        {stageRows.length === 0 ? (
          <div data-testid="batch-detail-stages-empty" style={{ color: P.light, fontSize: T.type.sm }}>
            Nothing logged yet.
          </div>
        ) : (
          <ul data-testid="batch-detail-stages-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {stageRows.map(row => (
              <li key={row.id} data-testid="batch-detail-stage" style={{ borderBottom: `1px solid ${P.cream}` }}>
                {/* Every entry is editable (06 §3.7): the whole 48px row is the target. */}
                <button type="button" data-testid="batch-detail-stage-edit" onClick={() => setEditing(row)}
                  style={{ display: 'block', width: '100%', minHeight: T.buttonMinHeight, textAlign: 'left', padding: '4px 0',
                    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <div style={{ color: P.dark, fontSize: T.type.sm }}>{stageRowText(row, nowMs)}</div>
                  {(stageRowDetail(row) || row.edited_at) && (
                    <div data-testid="batch-detail-stage-detail" style={{ color: P.light, fontSize: T.type.xs }}>
                      {[stageRowDetail(row), row.edited_at ? 'edited' : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </button>
                {stageSaved?.stageId === row.id && (
                  <div role="status" data-testid="stage-saved" style={{ color: P.mid, fontSize: '0.78rem' }}>
                    Saved <button type="button" style={{ ...actionLink, minWidth: 44 }} data-testid="stage-saved-undo" onClick={undoStageEdit}>Undo</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {logErr && <div role="alert" data-alarm-ink-exempt="error" style={{ color: P.terra, fontSize: '0.78rem' }}>{logErr}</div>}
      </Section>

      <Section title="What came out" testId="batch-detail-outputs">
        {sittings.length === 0 && pickedRows.length === 0 ? (
          <div data-testid="batch-detail-outputs-empty" style={{ color: P.light, fontSize: T.type.sm }}>
            No put-ups linked to this batch.
          </div>
        ) : (
          <ul data-testid="batch-detail-outputs-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sittings.map(({ stage: st, jars }) => (
              <Sitting key={st.id} batchId={batch.id} stage={st} jars={jars} lines={inputRows} onChanged={onChanged} nowMs={nowMs}
                gardenNames={gardenNames} onEdit={setEditing} />
            ))}
            {pickedRows.map(({ jar, state }) => (state === 'picked' ? (
              <PickedJar key={jar.id} batchId={batch.id} jar={jar} nowMs={nowMs} fetch={fetch} onChanged={onChanged}
                onTakenOff={(j) => {
                  setTakenOff(t => [...t.filter(x => x.jar.id !== j.id), { batchId: batch.id, jar: j, back: false }])
                  onChanged?.()
                }} />
            ) : state === 'back' ? (
              // Put back, its re-read not here yet: the row as it will read, with nothing to tap.
              <li key={`back-${jar.id}`} data-testid="batch-detail-output" data-jar-id={jar.id}
                style={{ padding: '4px 0', color: P.mid, fontSize: T.type.sm }}>
                <span data-testid="batch-detail-output-text">{outputRowText(jar, nowMs)}</span>
              </li>
            ) : (
              <TakenOffJar key={`off-${jar.id}`} batchId={batch.id} jar={jar} nowMs={nowMs} fetch={fetch} onChanged={onChanged}
                onPutBack={(j) => {
                  setTakenOff(t => t.map(x => (x.jar.id === j.id ? { ...x, back: true, gone: false } : x)))
                  onChanged?.()
                }} />
            )))}
          </ul>
        )}
        {/* Put it up's door is in the action row under the title; the sheet it opens is mounted here. */}
        <PutItUpSheet open={putUpOpen} batch={{ ...batch, outputs }} lines={inputRows} now={nowMs}
          onClose={() => setPutUpOpen(false)} onChanged={onChanged}
          onDone={({ stub }) => { setPutUpOpen(false); setStubText(stub); onChanged?.() }} />
      </Section>

      <div style={{ marginTop: T.space.md }}>
        {/* Pause sits with the other decision about the batch as a whole, above the terminal one. */}
        {!closed && <PauseToggle batch={batch} fetch={fetch} onChanged={onChanged} />}
        <BatchCloseField batch={batch} onChanged={onChanged} />
        {/* Save as recipe, with the other things said about the batch as a whole (it used to sit above
            What went in, between the title and the first line). Its own row. */}
        <div data-testid="batch-detail-save-as-recipe">
          <SaveAsRecipe batch={batch} onChanged={onChanged} />
        </div>
        {/* Last and quietest: removing is for a batch started by mistake, never an ending. */}
        <RemoveBatch batch={batch} fetch={fetch} onRemoved={onRemoved ?? onChanged} blockers={blockers} />
      </div>

      <StageEditSheet open={!!editing} batch={batch} stage={editing} now={nowMs} onClose={() => setEditing(null)}
        onSaved={({ stage: st, undo }) => { setEditing(null); setStageSaved({ stageId: st.id, undo }); onChanged?.() }} />
      {/* No `now`: nowMs is this surface's display instant, taken once when the batch opened, and the
          sheet stamps the check-in (entered_at, and a pH's read time) with the instant it is SAVED. */}
      <CheckOnItSheet open={checking} batch={batch} onClose={() => setChecking(false)}
        onSaved={(body, answer) => { setChecking(false); setCheckSaved(answer?.stage?.id ?? null); onChanged?.() }} />
    </div>
  )
}
