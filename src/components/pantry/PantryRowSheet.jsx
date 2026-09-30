// src/components/pantry/PantryRowSheet.jsx
// Put-Up B′ release 2 (V4 §2.5 "Row sheet", §3.2, §6.3) — what opens when a Pantry row is tapped.
//
// A PUT-UP (jar): Went bad (a use of what is left, fate discarded) · Gave it away (a use of a count,
// default 1, fate given_away) · Move it (the shipped move route) · Edit (the shipped jar editor, with
// Remove inside, two-step, refused with the server's reason) · Next time… (a batch jar writes the batch's
// `noted` stage row; a batchless jar appends a dated line to its notes) · How it was made → (only when
// the host hands in `onHowItWasMade` — the batch-builder lane wires it).
// A BOUGHT ITEM: Move it (PATCH storage_location_id) · Edit (name, when you got it, a discard date from
// the label, notes; Remove inside, two-step). Used it up is the row's own inline action.
//
// Every one-tap write reports back through `onUsed` so the ROW shows "… · Undo" in place for the person
// who acted (V4 §2.5); everything else through `onChanged`, and the host re-reads the list.
import React, { useEffect, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import RefusalLine, { refusalOf, refusalText } from './RefusalLine.jsx'
import { useJar, patchPantryItem, deletePantryItem, ensurePlaceId } from '../../lib/pantryApi.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import { labelChrome, inputChrome } from '../forms/formStyles.js'
import MoveJarSheet from '../putup/MoveJarSheet.jsx'
import { toYmd, parseYmd, putUpDateWords, sizeWords } from '../putup/jarWords.js'
import { PUTUP_SOURCE_LABELS } from '../../lib/dropdownRegistry.js'
import Stepper, { stepperCount } from './Stepper.jsx'
import { isJar, discardChip, leftWords, ageWords, effectiveBasis } from './pantryRows.js'

export const HOUSE_DETAIL_TEXT =
  'No published figure exists for candied fruit. This date is a house estimate, not a tested one. Set your own.'

const actionBtn = {
  display: 'block', width: '100%', minHeight: 48, textAlign: 'left', padding: '10px 12px', background: P.white,
  border: `1px solid ${P.border}`, borderRadius: T.radiusButton, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: T.type.base, fontWeight: 600, color: P.dark,
}

// "2 × 8 oz woozy · put up sometime in August · from Warner Farms · from Dark Green Zucchini" — the
// shipped jar row's words, said once in the sheet from the jar's own record.
export function jarRecordWords(rec, now = new Date()) {
  const parts = []
  const size = sizeWords(rec)
  if (size) parts.push(size)
  const date = rec.preserved_at_precision
    ? putUpDateWords(rec.preserved_at, rec.preserved_at_precision, { now })
    : putUpDateWords(rec.preserved_at, null, { approx: rec.preserved_at_approx === true, now })
  if (date) parts.push(date === 'not sure' ? 'put up: not sure' : `put up ${date}`)
  if (rec.source_kind && rec.source_kind !== 'own_garden') parts.push(`from ${rec.source_label || PUTUP_SOURCE_LABELS[rec.source_kind] || rec.source_kind}`)
  if (rec.planting_name) parts.push(`from ${rec.planting_name}${rec.planting_succession_order != null ? ` · wave ${rec.planting_succession_order}` : ''}`)
  return parts.join(' · ')
}


// `onHowItWasMade(row)` is the batch-builder lane's door (useHowItWasMade().open); `canHowItWasMade(row)`
// says whether this row may offer it (a put-up with no batch). Neither handed in → no door.
export default function PantryRowSheet({ row, fetch, onClose, onUsed, onChanged, JarEditor = null, onHowItWasMade = null, canHowItWasMade = null, now }) {
  if (!row) return null
  return <RowSheetOpen key={`${row.stock_kind}:${row.stock_id}`} row={row} fetch={fetch} onClose={onClose} onUsed={onUsed}
    onChanged={onChanged} JarEditor={JarEditor} onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade} now={now} />
}

function RowSheetOpen({ row, fetch, onClose, onUsed, onChanged, JarEditor, onHowItWasMade, canHowItWasMade, now }) {
  const [panel, setPanel] = useState(null)      // null | 'give' | 'move' | 'edit' | 'next'
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const jar = isJar(row)
  const nowDate = new Date(now ?? Date.now())

  async function use(action, body) {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      const r = await useJar(fetch, { preservation_log_id: row.stock_id, ...body })
      writingRef.current = false
      setBusy(false)
      onUsed?.({ row, action, use: r?.use ?? null, jar: r?.jar ?? null })
      onClose?.()
    } catch (e) {
      writingRef.current = false
      setBusy(false)
      setErr(refusalOf(e, "Couldn't update — try again."))
    }
  }

  // A jar's full record (GET /api/preservation/:id), read once when the sheet opens: the row carries
  // only what the list shows, and the sheet is where the rest is said — its size, its put-up date at its
  // precision ("around" for an estimate), where it came from and its notes — and what Edit opens on.
  const [rec, setRec] = useState(null)
  const [recFailed, setRecFailed] = useState(false)
  useEffect(() => {
    if (!jar) return undefined
    let alive = true
    Promise.resolve().then(() => fetch(`/api/preservation/${encodeURIComponent(row.stock_id)}`))
      .then(r => { if (alive) setRec(r && typeof r === 'object' ? r : null) })
      .catch(() => { if (alive) setRecFailed(true) })
    return () => { alive = false }
  }, [fetch, jar, row.stock_id])

  const detail = [row.place?.label, row.where_from, leftWords(row), ageWords(row, nowDate)].filter(Boolean).join(' · ')
  const chip = discardChip(row, nowDate)
  const recWords = rec ? jarRecordWords(rec, nowDate) : null

  if (panel === 'move') {
    return (
      <MoveJarSheet open jar={{ id: row.stock_id, label: row.name, storage_location_id: row.place?.id ?? null }} now={now}
        whenless={!jar}
        onSubmit={jar ? null : async ({ place }) => {
          const id = await ensurePlaceId(fetch, place)
          await patchPantryItem(fetch, row.stock_id, { storage_location_id: id })
        }}
        onClose={() => setPanel(null)} onMoved={() => { onChanged?.('moved'); onClose?.() }} />
    )
  }

  return (
    <Sheet open onClose={onClose} title={row.name || 'In the pantry'} size="full" busy={busy} armsBack>
      <div data-testid="row-sheet" data-row-key={`${row.stock_kind}:${row.stock_id}`} style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
        {detail && <p style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{detail}</p>}
        {recWords && <p data-testid="row-sheet-record" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{recWords}</p>}
        {(rec?.notes || (!jar && row.notes)) && (
          <p data-testid="row-sheet-notes" style={{ margin: 0, color: P.mid, fontSize: T.type.sm, whiteSpace: 'pre-wrap' }}>{rec?.notes || row.notes}</p>
        )}
        {chip && <p style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{chip}</p>}
        {jar && effectiveBasis(row) === 'house' && row.discard?.date && (
          <p role="note" data-testid="row-sheet-house" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{HOUSE_DETAIL_TEXT}</p>
        )}
        <RefusalLine err={err} testId="row-sheet-error" />

        {panel === null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-went-bad"
                onClick={() => use('went_bad', { all_remaining: true, fate: 'discarded' })}>Went bad</button>
            )}
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-give" onClick={() => setPanel('give')}>Gave it away</button>
            )}
            <button type="button" style={actionBtn} disabled={busy} data-testid="row-move" onClick={() => setPanel('move')}>Move it</button>
            <button type="button" style={actionBtn} disabled={busy} data-testid="row-edit" onClick={() => setPanel('edit')}>Edit</button>
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-next" onClick={() => setPanel('next')}>Next time…</button>
            )}
            {jar && typeof onHowItWasMade === 'function' && (typeof canHowItWasMade !== 'function' || canHowItWasMade(row)) && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-how"
                onClick={() => { onHowItWasMade(row); onClose?.() }}>How it was made →</button>
            )}
          </div>
        )}

        {panel === 'give' && (
          <GivePanel row={row} busy={busy} onCancel={() => setPanel(null)}
            onGive={(n) => use('gave_away', { count_used: n, fate: 'given_away' })} />
        )}
        {panel === 'next' && (
          <NextTimePanel row={row} fetch={fetch} onCancel={() => setPanel(null)}
            onSaved={() => { onChanged?.('noted'); onClose?.() }} />
        )}
        {panel === 'edit' && jar && (
          <JarEditPanel row={row} rec={rec} recFailed={recFailed} fetch={fetch} JarEditor={JarEditor} onCancel={() => setPanel(null)}
            onSaved={() => { onChanged?.('edited'); onClose?.() }} onRemoved={() => { onChanged?.('removed'); onClose?.() }} />
        )}
        {panel === 'edit' && !jar && (
          <ItemEditPanel row={row} fetch={fetch} onCancel={() => setPanel(null)}
            onSaved={() => { onChanged?.('edited'); onClose?.() }} onRemoved={() => { onChanged?.('removed'); onClose?.() }} />
        )}
      </div>
    </Sheet>
  )
}

function GivePanel({ row, busy, onCancel, onGive }) {
  const [n, setN] = useState('1')
  const max = row.count_left != null && Number(row.count_left) >= 1 ? Number(row.count_left) : null
  return (
    <div data-testid="give-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={labelChrome} aria-hidden="true">How many did you give away?</span>
      <Stepper value={n} onChange={setN} name={row.name} idPrefix="give" max={max} disabled={busy} label="How many given away" />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" data-testid="give-save" loading={busy} loadingLabel="Saving…"
          onClick={() => onGive(Math.min(stepperCount(n), max ?? Infinity))}>Gave it away</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

// "Next time…" (V4 §2.5): a batch jar writes its batch's `noted` stage row (the shipped stages route); a
// batchless jar appends a dated line to its own notes (the PATCH's notes_append).
function NextTimePanel({ row, fetch, onCancel, onSaved }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const id = `next-${useId()}`
  async function save() {
    const note = text.trim()
    if (!note) { setErr('Write what to do next time.'); return }
    setBusy(true); setErr(null)
    try {
      if (row.batch_id) {
        await fetch(`/api/kitchen-batches/${encodeURIComponent(row.batch_id)}/stages`, {
          method: 'POST', body: JSON.stringify({ stage_kind: 'noted', note }),
        })
      } else {
        await fetch(`/api/preservation/${encodeURIComponent(row.stock_id)}`, {
          method: 'PATCH', body: JSON.stringify({ notes_append: `Next time (${toYmd(new Date())}): ${note}` }),
        })
      }
      setBusy(false)
      onSaved()
    } catch (e) {
      setBusy(false)
      setErr(refusalOf(e, "Couldn't save that — what you wrote is kept. Try again."))
    }
  }
  return (
    <div data-testid="next-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={id} style={labelChrome}>Next time…</label>
      <textarea id={id} data-testid="next-text" value={text} disabled={busy} onChange={e => setText(e.target.value)}
        style={{ width: '100%', minHeight: 72, fontFamily: 'inherit', fontSize: T.type.base }} />
      <RefusalLine err={err} testId="next-error" />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" data-testid="next-save" loading={busy} loadingLabel="Saving…" onClick={save}>Save</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

// Remove, two-step (V4 §2.5: "logged by mistake"; refused on a jar with uses or live lines, with the
// server's reason and its path).
function RemoveTwoStep({ onRemove, busy, testId }) {
  const [confirm, setConfirm] = useState(false)
  if (!confirm) {
    return <Button variant="secondary" data-testid={`${testId}-remove`} disabled={busy} onClick={() => setConfirm(true)}>Remove</Button>
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: T.type.sm, color: P.mid }}>Logged by mistake?</span>
      <Button variant="danger" data-testid={`${testId}-remove-confirm`} loading={busy} loadingLabel="Removing…" onClick={onRemove}>Yes, remove it</Button>
      <Button variant="secondary" data-testid={`${testId}-remove-cancel`} disabled={busy} onClick={() => setConfirm(false)}>Keep it</Button>
    </div>
  )
}

// A jar's Edit is the shipped jar editor (the page's RowEditor, handed in as `JarEditor`) over the full
// jar (GET /api/preservation/:id): the Pantry row carries only what the list shows.
function JarEditPanel({ row, rec, recFailed, fetch, JarEditor, onCancel, onSaved, onRemoved }) {
  const [busy, setBusy] = useState(false)
  // The editor's refusal (a string or describeRefusal's object — the shipped editor renders both), and
  // Remove's, kept apart so each says its own thing where it happened.
  const [editErr, setEditErr] = useState(null)
  const [removeErr, setRemoveErr] = useState(null)

  async function saveEdit(patch) {
    if (!patch) { onCancel(); return }
    setBusy(true); setEditErr(null)
    try {
      await fetch(`/api/preservation/${encodeURIComponent(row.stock_id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setBusy(false)
      onSaved()
    } catch (e) {
      setBusy(false)
      setEditErr(describeRefusal(e) ?? refusalText(e, "Couldn't update — try again."))
    }
  }
  async function remove() {
    setBusy(true); setRemoveErr(null)
    try {
      await fetch(`/api/preservation/${encodeURIComponent(row.stock_id)}`, { method: 'DELETE' })
      setBusy(false)
      onRemoved()
    } catch (e) {
      setBusy(false)
      setRemoveErr(refusalOf(e, "Couldn't remove — try again."))
    }
  }
  return (
    <div data-testid="jar-edit-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {recFailed && <div role="alert" style={{ color: P.terra, fontSize: T.type.sm }}>Couldn&rsquo;t open that one — try again.</div>}
      {!rec && !recFailed && <div style={{ color: P.light, fontSize: T.type.sm }}>Opening&hellip;</div>}
      {rec && JarEditor && <JarEditor rec={rec} onCancel={onCancel} onSave={saveEdit} busy={busy} err={editErr} />}
      <RemoveTwoStep onRemove={remove} busy={busy} testId="jar-edit" />
      <RefusalLine err={removeErr} testId="jar-edit-error" />
    </div>
  )
}

// A bought item's Edit: name, when you got it, a discard date from the label, notes. ONE PATCH of what
// changed (presence-sentinel); an untouched field is an absent key.
function ItemEditPanel({ row, fetch, onCancel, onSaved, onRemoved }) {
  const [seed] = useState(() => ({
    name: String(row.name ?? ''),
    acquired: row.acquired_at ? toYmd(parseYmd(row.acquired_at)) : '',
    useBy: row.discard?.basis === 'typed' && row.discard?.date ? toYmd(parseYmd(row.discard.date)) : '',
    notes: typeof row.notes === 'string' ? row.notes : '',
  }))
  const [name, setName] = useState(seed.name)
  const [acquired, setAcquired] = useState(seed.acquired)
  const [useBy, setUseBy] = useState(seed.useBy)
  const [notes, setNotes] = useState(seed.notes)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const base = useId()

  async function save() {
    const patch = {}
    if (name.trim() !== seed.name.trim()) {
      if (!name.trim()) { setErr('Give it a name.'); return }
      patch.name = name.trim()
    }
    if (acquired !== seed.acquired) {
      patch.acquired_at = acquired || null
      patch.acquired_precision = acquired ? 'day' : null
    }
    if (useBy !== seed.useBy) patch.use_by_target = useBy || null
    if (notes !== seed.notes) patch.notes = notes.trim() || null
    if (!Object.keys(patch).length) { onCancel(); return }
    setBusy(true); setErr(null)
    try {
      await patchPantryItem(fetch, row.stock_id, patch)
      setBusy(false)
      onSaved()
    } catch (e) {
      setBusy(false)
      setErr(refusalOf(e, "Couldn't update — try again."))
    }
  }
  async function remove() {
    setBusy(true); setErr(null)
    try {
      await deletePantryItem(fetch, row.stock_id)
      setBusy(false)
      onRemoved()
    } catch (e) {
      setBusy(false)
      setErr(refusalOf(e, "Couldn't remove — try again."))
    }
  }
  const field = { ...inputChrome(false), width: '100%', minHeight: 44 }
  return (
    <div data-testid="item-edit-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label htmlFor={`${base}-name`} style={labelChrome}>Name</label>
        <input id={`${base}-name`} data-testid="item-edit-name" type="text" value={name} disabled={busy} maxLength={120}
          onChange={e => setName(e.target.value)} style={field} />
      </div>
      <div>
        <label htmlFor={`${base}-got`} style={labelChrome}>When you got it</label>
        <input id={`${base}-got`} data-testid="item-edit-acquired" type="date" value={acquired} disabled={busy}
          onChange={e => setAcquired(e.target.value)} style={{ ...field, maxWidth: 220 }} />
      </div>
      <div>
        <label htmlFor={`${base}-useby`} style={labelChrome}>Discard by (from the label)</label>
        <input id={`${base}-useby`} data-testid="item-edit-useby" type="date" value={useBy} disabled={busy}
          onChange={e => setUseBy(e.target.value)} style={{ ...field, maxWidth: 220 }} />
      </div>
      <div>
        <label htmlFor={`${base}-notes`} style={labelChrome}>Notes</label>
        <textarea id={`${base}-notes`} data-testid="item-edit-notes" value={notes} disabled={busy}
          onChange={e => setNotes(e.target.value)} style={{ width: '100%', minHeight: 60, fontFamily: 'inherit', fontSize: T.type.base }} />
      </div>
      <RefusalLine err={err} testId="item-edit-error" />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" data-testid="item-edit-save" loading={busy} loadingLabel="Saving…" onClick={save}>Save</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      <RemoveTwoStep onRemove={remove} busy={busy} testId="item-edit" />
    </div>
  )
}
