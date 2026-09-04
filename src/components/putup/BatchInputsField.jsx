// src/components/putup/BatchInputsField.jsx
// V5-INFLIGHTBATCH-001 item A — "what went into this batch", on the batch detail surface.
//
// INHERITED RULING 8 IS SATISFIED HERE, AND THIS PARAGRAPH EXISTS SO THE NEXT PANEL DOES NOT
// RE-LITIGATE IT. The killed harvest→put-up hook pushed FROM a harvest TO an unprompted offer: you
// logged a pick and the app volunteered a preservation flow you had not asked for. This walks the
// other way. The user has already opened a batch they started, and has tapped an affordance that
// says "what went into this?". Nothing here is offered on a harvest surface, nothing fires without a
// tap, and no pick is ever proposed as a batch input on its own. Same table, opposite direction.
//
// WHAT THIS COMPONENT WILL NOT DO, each for a stated reason:
//
//   · NO DATE-RANGE PICKER. The window comes from HarvestTimeframeChips — THE shared timeframe
//     control — mapped to {from,to} by chipToWindow. src/lib/harvestExport.js:19-21 carries the
//     standing ruling against minting arbitrary from/to, and there is no two-ended range control in
//     this app to copy even if there were not.
//
//   · NO 152-ROW SCROLLABLE LIST. Measured on prod 2026-09-04: a five-week pepper window is 152
//     harvest rows across 31 plantings, and the fan-in is growing. The surface shows a COUNT and a
//     WINDOW; the rows sit behind a deliberate second tap, on both sides of the add. (The
//     "139 rows / 30 plantings" in kitchenBatch.js:349-351 is real for 2026-07-28..09-01 — the row
//     count reproduces exactly — but the planting count for that window measures 28, and the whole
//     figure has drifted up since. Do not re-cite it as current.)
//
//   · NO VARIETY FILTER. Over 90 days prod carries 117 distinct varieties against 119 distinct
//     plantings — very nearly one variety per planting — so crop + planting already spans the axis
//     and a third control would be a second way to say the same thing.
//
//   · NO CROP LIST FROM crop_types. 159 slugs exist and only 32 have ever produced a harvest, so a
//     catalogue-sourced <Select> is 127 dead options. The options here are the intersection of
//     useCropTypes() — for the display name — with the crops that actually produced a harvest IN THE
//     CHOSEN WINDOW, read from the unpaged `aggregates.crop_list` block. The hook's default scope is
//     'garden' and that is the one wanted here: it drops the 'non_plant_food' classes (bread,
//     cheese, milk), none of which can appear in harvest_log, so the predicate can never offer one.
//     The aggregates block is used and the `entries` block is NOT: entries is 50-row paged and
//     counting it reproduces BUG-COMPOSETOTALS-001 (lambda/harvests/index.js:173, a per-crop figure
//     ~4x under the true one). aggregates is computed over the full filter range with no cursor.
//
//   · NO SILENT RETRY ACCOUNTING. ON CONFLICT DO NOTHING makes a re-run safe but silent, so a
//     failed write re-reads GET /:id and reports the TRUE total, never a delta. And the non-harvest
//     add is not idempotent at all — uq_kbi_batch_harvest is partial over harvest_log_id IS NOT NULL
//     — so every write path here holds a synchronous ref for the duration, not just a disabled
//     attribute. See writingRef below for why the attribute alone is not the guard.
//
// Every decision lives in batchInputs.js; this file paints and sequences. `nowMs` is a prop, never
// the wall clock: the window a chip resolves to has to be the same instant the rest of the surface
// was rendered against, and it is also what lets a test pin the window to a fixed literal.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { useCropTypes } from '../../hooks/useCropTypes.js'
import HarvestTimeframeChips from '../HarvestTimeframeChips.jsx'
import PlantingSelect from '../forms/PlantingSelect.jsx'
import { Field, Select, Input } from '../forms/index.js'
import { readDraft, writeDraft, clearDraft } from '../../lib/draftStash.js'
import {
  chipToWindow, describeWindow, predicateBody, explicitInputsBody, weightInputRow,
  readPreview, netCountLine, summariseInsert, summariseTrueCount, describeInputRow,
  rollUpGrams, describeRollUp, toggleDecision, committedIds, skippedCount,
  inputsDraftKey, WHOLE_PICK_NOTICE, ALL_TIME_REFUSAL, WEIGHT_UNITS, KITCHEN_INPUT_KINDS,
  INPUT_KIND_LABELS,
} from './batchInputs.js'

const linkBtn = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none',
  border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit',
  color: P.green, fontSize: '0.82rem', fontWeight: 600,
}
const primaryBtn = {
  minHeight: T.tapMinHeight, padding: '8px 16px', borderRadius: T.radiusButton, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 700, color: P.white,
  background: P.green, border: `1px solid ${P.green}`,
}
const quietBtn = { ...linkBtn, fontWeight: 500, color: P.mid }
const noteText = { margin: '6px 0 0', color: P.light, fontSize: '0.78rem', lineHeight: 1.45 }

// An amount + its unit are TWO controls, and <Field> takes exactly one: it clones the generated id
// onto its first element child, so wrapping a row div would point `htmlFor` at the div and leave the
// input unlabelled. Same class as the Fragment trap Field.jsx:70-75 guards. So the label is written
// out here, aimed at the amount, and the unit carries its own aria-label.
function PairField({ label, htmlFor, help, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={htmlFor} style={{ display: 'block', marginBottom: 4, fontSize: '0.82rem', fontWeight: 600, color: P.mid }}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
      {help && <p style={noteText}>{help}</p>}
    </div>
  )
}

// The non-harvest kinds. 'harvest' is excluded on purpose: a harvest input needs a harvest_log_id
// (chk_kbi_harvest_pairing is a biconditional), and the predicate flow above is how one is reached.
// A free-text box that let someone type "harvest" would compose a body the server must refuse.
const OTHER_KINDS = KITCHEN_INPUT_KINDS.filter((k) => k !== 'harvest')

// The units a pantry or purchased item plausibly arrives in, all drawn from KITCHEN_QTY_UNITS and
// therefore all inside chk_kbi_qty_unit. Note what is NOT here: preservation_log.quantity_unit holds
// the plural forms 'quarts' and 'cups' in prod and has no CHECK of its own, so a unit copied
// verbatim off an existing jar would be refused by the database (BUG-PRESERVUNITNOCHECK-001).
const OTHER_UNITS = [...WEIGHT_UNITS, 'cup', 'qt', 'gal', 'count']

export default function BatchInputsField({ batchId, onChanged, nowMs }) {
  const { fetch } = useApiFetch()
  // NO OPTIONS, DELIBERATELY. useCropTypes defaults to scope 'garden', which is the scope this
  // surface wants — a harvest_log row cannot be a loaf of bread, so the 'non_plant_food' classes
  // must never be offerable here — and `putUpFoodClassGating.test.js:110` forbids any call site but
  // PutUp's crop field from NAMING a scope at all, whatever value it names. Restating the default
  // reds that guard, and the guard is right: the default is the safe one and PutUp is the one
  // surface that opts out of it.
  const { cropTypes } = useCropTypes()
  const draftKey = inputsDraftKey(batchId)

  const [mode, setMode] = useState(null)
  const [showRows, setShowRows] = useState(false)
  const [inputs, setInputs] = useState([])
  const [detailError, setDetailError] = useState(null)

  // Restored ONCE, in the initializers. A failed write must not cost the user the selections they
  // made to reach it (there is no offline queue and none is possible — apiFetch needs a Clerk bearer
  // out of a React hook), and a deploy reloads the app under them several times a day.
  const stash = readDraft(draftKey) ?? {}
  const [chip, setChip] = useState(() => stash.chip ?? '7d')
  const [cropSlug, setCropSlug] = useState(() => stash.cropSlug ?? '')
  const [plantingId, setPlantingId] = useState(() => stash.plantingId ?? '')
  const [weightAmount, setWeightAmount] = useState(() => stash.weightAmount ?? '')
  const [weightUnit, setWeightUnit] = useState(() => stash.weightUnit ?? 'lb')

  const [windowCrops, setWindowCrops] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const [decisions, setDecisions] = useState(() => new Map())
  const [showChooser, setShowChooser] = useState(false)

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [addError, setAddError] = useState(null)

  const [otherKind, setOtherKind] = useState('pantry')
  const [otherLabel, setOtherLabel] = useState('')
  const [otherQty, setOtherQty] = useState('')
  const [otherUnit, setOtherUnit] = useState('')
  const [otherError, setOtherError] = useState(null)

  const win = useMemo(() => chipToWindow(chip, nowMs), [chip, nowMs])

  // HarvestExportSheet's sequence guard (:106,:117,:148). Two chip taps in flight would otherwise
  // let the first response land after the second and paint a crop list for a window nobody chose.
  const runRef = useRef(0)

  // THE DOUBLE-SUBMIT GUARD, and it is a REF rather than the `busy` state on purpose. A non-harvest
  // input is not idempotent — uq_kbi_batch_harvest is partial over harvest_log_id IS NOT NULL, so
  // the server cannot dedupe a repeated pantry row and inserts a second one every time. `busy` only
  // becomes true after React commits, so two taps delivered inside one frame (the ordinary Android
  // double-tap) would both read `busy === false` and both post. A ref set synchronously before the
  // first await is visible to the second call immediately, which is the only thing that closes that
  // window. `busy` stays, but its job is painting the disabled state, not exclusion.
  const writingRef = useRef(false)

  const loadDetail = useCallback(async () => {
    try {
      const row = await fetch(`/api/kitchen-batches/${batchId}`)
      setInputs(Array.isArray(row?.inputs) ? row.inputs : [])
      setDetailError(null)
      return Array.isArray(row?.inputs) ? row.inputs.length : null
    } catch {
      setDetailError("Couldn't read what is in this batch.")
      return null
    }
  }, [batchId, fetch])

  useEffect(() => { loadDetail() }, [loadDetail])

  // The crop universe for the CHOSEN window, crop-unfiltered. Passing the selected crop back into
  // this call would collapse crop_list to that one crop and strand the user on it — the trap
  // useHarvestFilterOptions.js:7-11 documents. null = not established; [] = established and empty.
  useEffect(() => {
    if (mode !== 'picks') return undefined
    let alive = true
    const seq = ++runRef.current
    setWindowCrops(null)
    fetch(`/api/harvests?include=aggregates&timeframe=${encodeURIComponent(chip)}`)
      .then((data) => {
        if (!alive || seq !== runRef.current) return
        const list = data?.aggregates?.crop_list
        setWindowCrops(Array.isArray(list) ? list : [])
      })
      .catch(() => { if (alive && seq === runRef.current) setWindowCrops([]) })
    return () => { alive = false }
  }, [chip, fetch, mode])

  const cropOptions = useMemo(() => {
    if (!Array.isArray(windowCrops)) return []
    const named = new Map((cropTypes ?? []).map((c) => [c.slug, c.display_name]))
    return windowCrops
      .filter((c) => c && c.crop_type_slug)
      // The garden vocabulary supplies the label; the server's own display_name is the fallback so a
      // slug the catalogue has not curated still renders as a name rather than vanishing.
      .map((c) => ({ value: c.crop_type_slug, label: named.get(c.crop_type_slug) ?? c.display_name ?? c.crop_type_slug }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
  }, [windowCrops, cropTypes])

  const stashNow = useCallback((over = {}) => {
    writeDraft(draftKey, { chip, cropSlug, plantingId, weightAmount, weightUnit, ...over })
  }, [draftKey, chip, cropSlug, plantingId, weightAmount, weightUnit])

  const resetPreview = useCallback(() => {
    setPreview(null); setPreviewError(null); setShowChooser(false); setResult(null); setAddError(null)
  }, [])

  const runPreview = useCallback(async () => {
    if (!win) { setPreviewError(ALL_TIME_REFUSAL); setPreview(null); return }
    const { error, body } = predicateBody({ cropSlug, plantingId, from: win.from, to: win.to, preview: true })
    if (error) { setPreviewError(error); setPreview(null); return }
    setPreviewing(true); setPreviewError(null); setResult(null); setAddError(null)
    const seq = ++runRef.current
    try {
      const res = await fetch(`/api/kitchen-batches/${batchId}/inputs`, {
        method: 'POST', body: JSON.stringify(body),
      })
      if (seq !== runRef.current) return
      const read = readPreview(res)
      // A dry run that cannot be read is NOT zero matches. Reporting 0 here would invite the user to
      // widen a window that already matched everything they wanted.
      if (!read) { setPreviewError("Couldn't read that count — try again."); setPreview(null); return }
      setPreview(read)
    } catch {
      if (seq === runRef.current) { setPreviewError("Couldn't check that — try again."); setPreview(null) }
    } finally {
      if (seq === runRef.current) setPreviewing(false)
    }
  }, [batchId, cropSlug, fetch, plantingId, win])

  // The ids the chooser decides over, and they are HARVEST_LOG ids on purpose: a subset commit goes
  // out through the explicit form, which takes harvest rows by harvest_log_id, so the id a decision
  // is keyed to has to be the id the write will carry. `id` is the fallback because the dry-run arm
  // resolves harvest_log rows and its own primary key is that same id. Present only when the arm
  // returns rows; when it returns a bare count there is nothing to key a decision to and the net
  // line degenerates to "N matched − 0 skipped → N will be added", which is still true.
  const matchedIds = useMemo(
    () => (Array.isArray(preview?.rows) ? preview.rows.map((r) => String(r?.harvest_log_id ?? r?.id ?? '')) : []),
    [preview],
  )
  const committed = useMemo(() => committedIds(matchedIds, decisions), [matchedIds, decisions])
  const skipped = useMemo(() => skippedCount(matchedIds, decisions), [matchedIds, decisions])
  // Derived from the RESOLVED rows, never from decisions.size — BUG-PHOTOSELSTALE-001 is exactly the
  // gap between a Map that counts decisions and a button that posts a list.
  const willAdd = matchedIds.length > 0 ? committed.length : (preview?.matched ?? 0)
  const rollup = useMemo(() => rollUpGrams(preview?.rows), [preview])

  const commitPredicate = useCallback(async () => {
    if (writingRef.current || !win) return
    // TWO WRITE SHAPES, ONE DECISION. The predicate form is preferred and is what runs whenever the
    // user has skipped nothing: it is a single INSERT..SELECT with the ownership predicate bound
    // INSIDE it, so there is no read-then-write gap in which a harvest could be archived or
    // re-owned between the count and the write. But the predicate cannot express a SUBSET, so the
    // moment a row is unticked the same set goes out through the explicit form instead — that form
    // takes harvest rows by harvest_log_id and is covered by the same uq_kbi_batch_harvest partial
    // index, so it stays idempotent. Skipping is honoured, never silently discarded.
    const subset = matchedIds.length > 0 && skipped > 0
    const { error, body } = subset
      ? explicitInputsBody(committed.map((id) => ({ input_kind: 'harvest', harvest_log_id: id })))
      : predicateBody({ cropSlug, plantingId, from: win.from, to: win.to })
    if (error) { setAddError(error); return }
    writingRef.current = true
    setBusy(true); setAddError(null); setResult(null)
    try {
      const res = await fetch(`/api/kitchen-batches/${batchId}/inputs`, {
        method: 'POST', body: JSON.stringify(body),
      })
      const weightRow = weightInputRow({ amount: weightAmount, unit: weightUnit })
      if (weightRow) {
        const built = explicitInputsBody([weightRow])
        // Not idempotent: this row carries no harvest_log_id, so the partial unique index does not
        // cover it and a repeat would insert a second copy. It is cleared below on success so a
        // later add cannot re-post it.
        if (built.body) await fetch(`/api/kitchen-batches/${batchId}/inputs`, { method: 'POST', body: JSON.stringify(built.body) })
      }
      setResult(summariseInsert(res ?? {}))
      setPreview(null); setShowChooser(false)
      setWeightAmount('')
      clearDraft(draftKey)
      await loadDetail()
      onChanged?.()
    } catch {
      // The write may have committed and the response may have been dropped. `inserted` cannot be
      // recovered — but the total can, and the total is true either way.
      const total = await loadDetail()
      setAddError(summariseTrueCount({ total }) ?? "That didn't go through — try again.")
      stashNow()
      onChanged?.()
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batchId, committed, cropSlug, draftKey, fetch, loadDetail, matchedIds, onChanged,
    plantingId, skipped, stashNow, weightAmount, weightUnit, win])

  const commitOther = useCallback(async () => {
    if (writingRef.current) return
    const { error, body } = explicitInputsBody([{
      input_kind: otherKind, label: otherLabel, qty: otherQty, qty_unit: otherUnit || null,
    }])
    if (error) { setOtherError(error); return }
    writingRef.current = true
    setBusy(true); setOtherError(null); setResult(null)
    try {
      const res = await fetch(`/api/kitchen-batches/${batchId}/inputs`, {
        method: 'POST', body: JSON.stringify(body),
      })
      setResult(summariseInsert(res ?? {}))
      setOtherLabel(''); setOtherQty(''); setOtherUnit('')
      await loadDetail()
      onChanged?.()
    } catch {
      const total = await loadDetail()
      setOtherError(summariseTrueCount({ total }) ?? "That didn't go through — try again.")
      onChanged?.()
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batchId, fetch, loadDetail, onChanged, otherKind, otherLabel, otherQty, otherUnit])

  const removeInput = useCallback(async (id) => {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); setDetailError(null)
    try {
      await fetch(`/api/kitchen-batches/${batchId}/inputs/${id}`, { method: 'DELETE' })
      await loadDetail()
      onChanged?.()
    } catch {
      setDetailError("Couldn't take that one out — try again.")
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batchId, fetch, loadDetail, onChanged])

  const windowLine = describeWindow(win)
  const netLine = netCountLine({ matched: preview?.matched ?? 0, skipped })

  return (
    <div data-testid="batch-inputs-field" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: '0.95rem', fontWeight: 700, color: P.dark }}>
        What went into this?
      </h3>

      <p data-testid="batch-inputs-count" style={{ margin: 0, color: P.mid, fontSize: '0.84rem' }}>
        {inputs.length === 0
          ? 'Nothing written down yet.'
          : `${inputs.length} ${inputs.length === 1 ? 'thing' : 'things'} written down.`}
      </p>
      {detailError && (
        <p role="alert" data-testid="batch-inputs-detail-error" style={{ ...noteText, color: P.terra }}>{detailError}</p>
      )}

      {/* The list is behind a deliberate second tap. A five-week pepper window is 152 rows today and
          rising, and a scrollable wall of them is the discoverability failure this feature exists to
          avoid, not a rendering of it. */}
      {inputs.length > 0 && (
        <button type="button" data-testid="batch-inputs-reveal" style={linkBtn}
          onClick={() => setShowRows((v) => !v)}>
          {showRows ? 'Hide the list' : `Show all ${inputs.length}`}
        </button>
      )}
      {showRows && (
        <ul data-testid="batch-inputs-list" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
          {inputs.map((row) => (
            <li key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: `1px solid ${P.border}` }}>
              <span style={{ color: P.mid, fontSize: '0.8rem' }}>{describeInputRow(row)}</span>
              <button type="button" disabled={busy} data-testid={`batch-inputs-remove-${row.id}`}
                onClick={() => removeInput(row.id)} style={{ ...quietBtn, color: busy ? P.light : P.mid }}>
                Take it out
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" data-testid="batch-inputs-open-picks" style={linkBtn}
          onClick={() => { setMode(mode === 'picks' ? null : 'picks'); resetPreview() }}>
          Add picks from the garden
        </button>
        <button type="button" data-testid="batch-inputs-open-other" style={linkBtn}
          onClick={() => { setMode(mode === 'other' ? null : 'other'); setOtherError(null) }}>
          Add something else
        </button>
      </div>

      {mode === 'picks' && (
        <div data-testid="batch-inputs-picks" style={{ marginTop: 8 }}>
          <HarvestTimeframeChips
            value={chip}
            onChange={(v) => { setChip(v); setCropSlug(''); resetPreview(); stashNow({ chip: v, cropSlug: '' }) }}
            ariaLabel="Which picks"
          />
          {windowLine
            ? <p data-testid="batch-inputs-window" style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.82rem' }}>Picks {windowLine}.</p>
            : <p data-testid="batch-inputs-window-refusal" role="status" style={{ margin: '0 0 8px', color: P.terra, fontSize: '0.82rem' }}>{ALL_TIME_REFUSAL}</p>}

          <Field label="Crop" htmlFor="kbi-crop" optional
            help="Only crops with a pick in this window are listed.">
            <Select id="kbi-crop" value={cropSlug} aria-label="Crop"
              disabled={cropOptions.length === 0}
              onChange={(e) => { setCropSlug(e.target.value); resetPreview(); stashNow({ cropSlug: e.target.value }) }}>
              <option value="">— Any crop —</option>
              {cropOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          {windowCrops != null && cropOptions.length === 0 && (
            <p data-testid="batch-inputs-no-crops" style={noteText}>
              Nothing was picked in this window, so there is no crop to narrow to.
            </p>
          )}

          <Field label="From which planting?" htmlFor="kbi-planting" optional>
            <PlantingSelect id="kbi-planting" value={plantingId}
              onChange={(id) => { setPlantingId(id || ''); resetPreview(); stashNow({ plantingId: id || '' }) }}
              cropSlug={cropSlug || undefined} sort="sown" labelFormat="wave" emptyMeaning="none"
              aria-label="From which planting" data-testid="kbi-planting-select" />
          </Field>

          <button type="button" data-testid="batch-inputs-preview" disabled={previewing || busy || !win}
            style={{ ...primaryBtn, opacity: (previewing || busy || !win) ? 0.5 : 1 }}
            onClick={runPreview}>
            {previewing ? 'Counting…' : 'Check what that matches'}
          </button>

          {previewError && (
            <p role="alert" data-testid="batch-inputs-preview-error" style={{ ...noteText, color: P.terra }}>{previewError}</p>
          )}

          {preview && (
            <div data-testid="batch-inputs-preview-result" style={{ marginTop: 10 }}>
              {/* ScopeChecklist's net-count contract: rendered continuously and aria-live, so a
                  toggle is ANNOUNCED rather than only shown, and the user is never asked to compute
                  the set difference themselves. */}
              <p data-testid="batch-inputs-net-count" aria-live="polite"
                style={{ margin: '0 0 4px', color: P.dark, fontSize: '0.86rem', fontWeight: 700 }}>
                {netLine}
              </p>
              {windowLine && (
                <p data-testid="batch-inputs-preview-window" style={{ margin: '0 0 6px', color: P.mid, fontSize: '0.8rem' }}>
                  Picks {windowLine}.
                </p>
              )}
              {rollup && (
                <p data-testid="batch-inputs-rollup" style={{ margin: '0 0 6px', color: P.mid, fontSize: '0.8rem' }}>
                  {describeRollUp(rollup)}
                </p>
              )}
              <p data-testid="batch-inputs-whole-pick" style={noteText}>{WHOLE_PICK_NOTICE}</p>

              {/* The one number that survives the whole-pick over-attribution: what the cook
                  actually put on a scale. Optional, and it goes in as its own `other` input row. */}
              <PairField label="How much went in altogether?" htmlFor="kbi-weight"
                help="The number you actually weighed, if you have one.">
                <Input id="kbi-weight" type="text" inputMode="decimal" value={weightAmount}
                  aria-label="Total weight" style={{ width: 96 }}
                  onChange={(e) => { setWeightAmount(e.target.value); stashNow({ weightAmount: e.target.value }) }} />
                <Select value={weightUnit} aria-label="Weight unit" style={{ width: 96 }}
                  onChange={(e) => { setWeightUnit(e.target.value); stashNow({ weightUnit: e.target.value }) }}>
                  {WEIGHT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </Select>
              </PairField>

              {matchedIds.length > 0 && (
                <button type="button" data-testid="batch-inputs-choose" style={linkBtn}
                  onClick={() => setShowChooser((v) => !v)}>
                  {showChooser ? 'Hide the picks' : `Look at the ${matchedIds.length}`}
                </button>
              )}
              {showChooser && (
                <ul data-testid="batch-inputs-chooser" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
                  {preview.rows.map((row, i) => {
                    const id = matchedIds[i]
                    const on = committed.includes(id)
                    return (
                      <li key={id} style={{ padding: '4px 0', borderBottom: `1px solid ${P.border}` }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: T.tapMinHeight, cursor: 'pointer', fontSize: '0.8rem', color: P.mid }}>
                          <input type="checkbox" checked={on} data-testid={`batch-inputs-pick-${id}`}
                            onChange={() => setDecisions((prev) => toggleDecision(prev, id))}
                            style={{ width: 20, height: 20 }} />
                          <span>{describeInputRow(row)}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}

              <div style={{ marginTop: 10 }}>
                <button type="button" data-testid="batch-inputs-commit" disabled={busy || willAdd === 0}
                  style={{ ...primaryBtn, opacity: (busy || willAdd === 0) ? 0.5 : 1 }} onClick={commitPredicate}>
                  {busy ? 'Adding…' : `Add ${willAdd} ${willAdd === 1 ? 'pick' : 'picks'}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'other' && (
        <div data-testid="batch-inputs-other" style={{ marginTop: 8 }}>
          <Field label="What kind?" htmlFor="kbi-other-kind">
            <Select id="kbi-other-kind" value={otherKind} aria-label="What kind"
              onChange={(e) => { setOtherKind(e.target.value); setOtherError(null) }}>
              {OTHER_KINDS.map((k) => <option key={k} value={k}>{INPUT_KIND_LABELS[k]}</option>)}
            </Select>
          </Field>
          <Field label="What was it?" htmlFor="kbi-other-label">
            <Input id="kbi-other-label" type="text" value={otherLabel} aria-label="What was it"
              onChange={(e) => { setOtherLabel(e.target.value); setOtherError(null) }} />
          </Field>
          <PairField label="How much?" htmlFor="kbi-other-qty">
            <Input id="kbi-other-qty" type="text" inputMode="decimal" value={otherQty}
              aria-label="How much" style={{ width: 96 }}
              onChange={(e) => { setOtherQty(e.target.value); setOtherError(null) }} />
            <Select value={otherUnit} aria-label="Unit" style={{ width: 110 }}
              onChange={(e) => { setOtherUnit(e.target.value); setOtherError(null) }}>
              <option value="">— unit —</option>
              {OTHER_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>
          </PairField>
          {/* Disabled while in flight, and that is not decoration: a non-harvest input carries no
              harvest_log_id, uq_kbi_batch_harvest is partial over harvest_log_id IS NOT NULL, so a
              second POST of the same row inserts a second row every time. The server cannot dedupe
              this one — the guard has to live here. */}
          <button type="button" data-testid="batch-inputs-other-save" disabled={busy}
            style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }} onClick={commitOther}>
            {busy ? 'Adding…' : 'Add it'}
          </button>
          {otherError && (
            <p role="alert" data-testid="batch-inputs-other-error" style={{ ...noteText, color: P.terra }}>{otherError}</p>
          )}
        </div>
      )}

      {result && (
        <p data-testid="batch-inputs-result" role="status" style={{ margin: '8px 0 0', color: P.mid, fontSize: '0.84rem' }}>{result}</p>
      )}
      {addError && (
        <p role="alert" data-testid="batch-inputs-error" style={{ ...noteText, color: P.terra }}>{addError}</p>
      )}
    </div>
  )
}
