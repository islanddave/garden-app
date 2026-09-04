// src/components/putup/BatchCloseField.jsx
// V5-KBCLOSE-001 — "what happened to it?", the one terminal act in the kitchen-batch feature.
//
// ⚠ THE LINE THIS COMPONENT HOLDS (FOODSAFETY-RULING-V101, preservation seat):
// The app RECORDS what happened. It never scores, colours, gates, compares, or asserts that the
// batch completed. There is no label here that says a batch "went to plan" — that clause was struck
// because it is the app supplying a completion determination, offered on a batch with zero pH rows
// and zero recorded cue. Nothing on this surface names acidification, shelf stability, or whether a
// reading is good, and the guard for that is a sweep over BOTH steps of the sheet in
// BatchCloseField.test.jsx — the form <Note>s unmount on submit, which is exactly how a prior sweep
// in this repo went vacuous.
//
// WHY A <Sheet> AND NOT THE CARD'S INLINE-EXPAND IDIOM. EndStatusOffer.jsx is the shipped precedent
// for exactly this interaction — "the server committed the row; now OFFER a terminal choice;
// declining leaves it as it was" — and the six-outcome picker plus a cue field plus a jar list does
// not fit one 390x500 keyboard-open viewport, which is why the flow is STAGED and not merely tall.
// Sheet registers with DismissRegistry on our behalf, so no DIALOG_SURFACES entry is owed; it does
// owe a SHEET_SITES entry in modalSurfaceFreeze.static.test.js (that file belongs to another lane —
// see the lane report for the exact entry).
//
// `busy={saving}` IS MANDATORY, not decorative: close is NOT idempotent (a second POST is a 409) and
// a stray backdrop tap or an Escape mid-write would otherwise discard the surface over the top of an
// in-flight write.
//
// ONE REQUEST. `cue_observed` rides on the close body and the SERVER writes the `finished` stage row
// from it, in the same statement as the close and gated on the `closed` CTE — so the close and its
// row cannot land apart, and there is nothing for a client-side second write to add. An earlier draft
// posted that row from here (at the base commit, validateClose whitelisted three keys and dropped the
// rest behind a 200, so a cue on the close body would have looked saved and would not have been);
// keeping both would now write TWO `finished` rows for one act.
import React, { useCallback, useEffect, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import JarPicker from './JarPicker.jsx'
import { useApiFetch } from '../../lib/api.js'
import { readDraft, writeDraft, clearDraft } from '../../lib/draftStash.js'
import {
  CLOSE_ACTION_LABEL, CUE_QUESTION, KEPT_QUESTION, OUTCOME_SLUGS,
  closePatch, cuePlaceholder, outcomesForKept,
} from './batchClose.js'

// A permanent identifier, exactly like PutUp's own 'put-up' key: renaming it orphans live drafts in
// a tab that is mid-close. A deploy reloads the app with no user action several times a day and this
// is the longest-dwell surface the feature adds.
export const CLOSE_DRAFT_KEY = 'put-up/batch-close'

const STEP_KEPT = 'kept'
const STEP_OUTCOME = 'outcome'

function emptyState() {
  return { step: STEP_KEPT, kept: null, outcome: null, note: '', cue: '', ids: [] }
}

export default function BatchCloseField({ batch, onChanged }) {
  const { fetch } = useApiFetch()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(STEP_KEPT)
  const [kept, setKept] = useState(null)
  const [outcome, setOutcome] = useState(null)
  const [note, setNote] = useState('')
  const [cue, setCue] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const batchId = batch?.id ?? null

  const reset = useCallback(() => {
    const e = emptyState()
    setStep(e.step); setKept(e.kept); setOutcome(e.outcome); setNote(e.note); setCue(e.cue)
    setSelected(new Set())
    setErr(null)
  }, [])

  const openSheet = useCallback(() => {
    reset()
    // Scoped to the batch it was typed against: a stash restored onto a DIFFERENT batch would put
    // one cook's cue on another batch's record, which is worse than losing it.
    const draft = readDraft(CLOSE_DRAFT_KEY)
    if (draft && draft.batchId === batchId) {
      setStep(draft.step === STEP_OUTCOME ? STEP_OUTCOME : STEP_KEPT)
      setKept(typeof draft.kept === 'boolean' ? draft.kept : null)
      setOutcome(draft.outcome ?? null)
      setNote(typeof draft.note === 'string' ? draft.note : '')
      setCue(typeof draft.cue === 'string' ? draft.cue : '')
      setSelected(new Set(Array.isArray(draft.ids) ? draft.ids : []))
    }
    setOpen(true)
  }, [batchId, reset])

  const dirty = outcome != null || note !== '' || cue !== '' || selected.size > 0

  useEffect(() => {
    if (!open || !batchId) return
    if (!dirty) { clearDraft(CLOSE_DRAFT_KEY); return }
    writeDraft(CLOSE_DRAFT_KEY, { batchId, step, kept, outcome, note, cue, ids: [...selected] })
  }, [open, batchId, dirty, step, kept, outcome, note, cue, selected])

  const toggleJar = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const chooseKept = useCallback((v) => {
    setKept(v)
    setOutcome(null)
    if (!v) setSelected(new Set())
    setStep(STEP_OUTCOME)
    setErr(null)
  }, [])

  const submit = useCallback(async () => {
    const patch = closePatch({ outcome, note, cue, outputIds: [...selected] })
    if (!patch) { setErr('Pick what happened to it first.'); return }
    setSaving(true)
    setErr(null)
    try {
      // ONE request. A retry re-sends the same body; the close is not idempotent, so a retry after a
      // dropped response answers 409, which is handled below and is the honest reading of "it landed".
      await fetch(`/api/kitchen-batches/${batchId}/close`, { method: 'POST', body: JSON.stringify(patch) })
      clearDraft(CLOSE_DRAFT_KEY)
      setOpen(false)
      reset()
      onChanged?.()
    } catch (e) {
      // Nothing is cleared and the sheet stays open: there is no offline queue in this app and none
      // is possible, so a clear failure is the honest answer — but it must keep what was entered.
      setErr(e?.status === 409
        ? 'This batch is already closed — reload to see it.'
        : 'Couldn’t record that — the batch is still open. Try again; what you picked is still here.')
    } finally {
      setSaving(false)
    }
  }, [batchId, cue, fetch, note, onChanged, outcome, reset, selected])

  // A closed batch has no close affordance. Reopening is a different act on a different surface.
  if (!batch || batch.closed_at) return null

  if (!open) {
    return (
      <button type="button" data-testid="batch-close-open" onClick={openSheet}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
        {CLOSE_ACTION_LABEL} →
      </button>
    )
  }

  // Step 2 only ever renders after a Yes/No, so the offered set is always the 2 or the 4 — the six
  // never appear together on one surface.
  const offered = outcomesForKept(kept)

  return (
    <Sheet
      open
      onClose={() => setOpen(false)}
      title={CLOSE_ACTION_LABEL}
      closeLabel="Leave this batch going"
      size="full"
      busy={saving}
      dirty={dirty}
      armsBack
    >
      <div data-testid="batch-close-sheet" style={{ padding: '4px 18px 8px' }}>
        {step === STEP_KEPT && (
          <div data-testid="batch-close-step-kept">
            <p style={{ margin: '0 0 12px', color: P.dark, fontSize: T.type.md, fontWeight: 600 }}>
              {KEPT_QUESTION}
            </p>
            <div style={{ display: 'grid', gap: T.space.sm }}>
              <SelectChip active={kept === true} touch data-testid="batch-close-kept-yes"
                onClick={() => chooseKept(true)}>Yes</SelectChip>
              <SelectChip active={kept === false} touch data-testid="batch-close-kept-no"
                onClick={() => chooseKept(false)}>No</SelectChip>
            </div>
            <p style={{ margin: '12px 0 0', color: P.light, fontSize: T.type.xs, lineHeight: 1.45 }}>
              Recording this closes the batch. You can still add to its log afterwards.
            </p>
          </div>
        )}

        {step === STEP_OUTCOME && (
          <div data-testid="batch-close-step-outcome">
            <p style={{ margin: '0 0 12px', color: P.dark, fontSize: T.type.md, fontWeight: 600 }}>
              {CLOSE_ACTION_LABEL}
            </p>
            <div style={{ display: 'grid', gap: T.space.sm }} role="group" aria-label={CLOSE_ACTION_LABEL}>
              {offered.map(o => (
                <SelectChip
                  key={o.value}
                  active={outcome === o.value}
                  touch
                  onClick={() => { setOutcome(o.value); setErr(null) }}
                  // The testid segment comes from OUTCOME_SLUGS, never from the value or the label:
                  // `discarded_spoiled` in an attribute is a machine value in the DOM.
                  data-testid={`batch-close-outcome-${OUTCOME_SLUGS[o.value]}`}
                >
                  {o.label}
                </SelectChip>
              ))}
            </div>

            <label htmlFor="kb-close-cue"
              style={{ display: 'block', margin: '16px 0 4px', color: P.mid, fontSize: T.type.sm, fontWeight: 600 }}>
              {CUE_QUESTION}
            </label>
            {/* Free text, never a picklist, never validated, never read back into any decision — that
                is what keeps it a record and not an assessment. The placeholder is an EXAMPLE of an
                observation, keyed off `kind`; it is not a test the batch has to pass. */}
            <input id="kb-close-cue" type="text" value={cue} data-testid="batch-close-cue"
              placeholder={cuePlaceholder(batch.kind)}
              onChange={e => setCue(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', minHeight: T.tapMinHeight, padding: '6px 10px',
                fontFamily: 'inherit', fontSize: T.type.sm, border: `1px solid ${P.border}`,
                borderRadius: T.radiusButton, background: P.white }} />

            <label htmlFor="kb-close-note"
              style={{ display: 'block', margin: '14px 0 4px', color: P.mid, fontSize: T.type.sm, fontWeight: 600 }}>
              Anything worth remembering?
            </label>
            <textarea id="kb-close-note" rows={2} value={note} data-testid="batch-close-note"
              onChange={e => setNote(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontFamily: 'inherit',
                fontSize: T.type.sm, border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
                background: P.white }} />

            {kept && (
              <>
                <p style={{ margin: '16px 0 0', color: P.mid, fontSize: T.type.sm, fontWeight: 600 }}>
                  Which put-ups came out of it?
                </p>
                <JarPicker batchId={batchId} selected={selected} onToggle={toggleJar} />
              </>
            )}

            {err && (
              <div role="alert" data-testid="batch-close-error"
                style={{ marginTop: 12, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>
            )}

            <div style={{ display: 'grid', gap: T.space.sm, marginTop: 16 }}>
              <Button variant="primary" disabled={!outcome} loading={saving} loadingLabel="Recording…"
                onClick={submit} data-testid="batch-close-submit">
                Record it
              </Button>
              <button type="button" onClick={() => { setStep(STEP_KEPT); setErr(null) }} disabled={saving}
                data-testid="batch-close-back"
                style={{ width: '100%', minHeight: T.tapMinHeight, background: 'none', border: 'none',
                  color: P.mid, fontFamily: 'inherit', fontSize: '0.84rem', fontWeight: 600,
                  cursor: saving ? 'default' : 'pointer' }}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}
