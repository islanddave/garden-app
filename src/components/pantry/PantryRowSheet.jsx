// src/components/pantry/PantryRowSheet.jsx
// Put-Up B′ release 2 (V4 §2.5 "Row sheet", §3.2, §6.3) — what opens when a Pantry row is tapped.
//
// A PUT-UP (jar), in this order: Move it… (the shipped move route) · Next time… (a batch jar writes the
// batch's `noted` stage row; a batchless jar appends a dated line to its notes) · Gave it away… (a use of a
// count, default 1, fate given_away) · Went bad (fate discarded) · Edit… (the shipped jar editor, with
// Remove… inside, two-step, refused with the server's reason) · then How it was made → (a put-up with no
// batch, only when the host hands in `onHowItWasMade` — the batch-builder lane wires it) or What went in →
// (a put-up that came from a batch the host can name, only when the host hands in `onOpenBatch`).
// A BOUGHT ITEM: Move it… (PATCH storage_location_id) · Edit… (name, how much, where it's from, when you
// got it, a discard date from the label, notes; Remove… inside, two-step). Used it up is the row's own
// inline action.
//
// WHAT A LABEL'S ENDING SAYS (Put-Up R2a, the ellipsis rule): "…" opens a step that asks before anything is
// written; "→" leaves the sheet; a bare label acts at the tap. So Went bad reads bare only where it acts at
// once, and the button INSIDE a panel (the Move panel's "Move it", the count panel's "Gave it away") is
// bare: it is the tap that writes.
//
// WENT BAD (Put-Up UX pass R1). With several of a counted put-up left (pantryRows.severalLeft — the test
// the row's own Used one hangs on) it reads "Went bad…" and opens the count panel at ALL that is left;
// otherwise (one left, a weighed bag, an uncounted row) it reads "Went bad" and acts at the tap. THE
// REQUEST: at the top of the stepper, and at every one tap, `{ all_remaining: true, fate: 'discarded' }`
// — "what is left right now", which holds on a server of any age and when the other phone has used one
// since; below the top, `{ count_used: n, fate: 'discarded' }`. Never both keys, and never a fallback to
// all_remaining after a refusal (that would discard more than was asked). THE KEY is the intent's: minted
// when the panel opens (or at the one tap), kept for a retry of the same count, replaced when the count
// changes — a retry after a lost answer is then the server's replay, not a second discard.
//
// BACK, one rule for the five panels (Move, Next time, Gave it away, Went bad, Edit): Back in a panel
// returns to the action list (the sheet's backIntercept, which re-arms the sheet's Back entry); Back on
// the list closes the sheet.
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
import { mintKey } from '../kitchen/idempotencyKey.js'
import { landAfterClose } from '../kitchen/sheetLanding.js'
import MoveJarSheet from '../putup/MoveJarSheet.jsx'
import { nextTimeWords } from '../putup/howItWasMade.js'
import { toYmd, parseYmd, putUpDateWords, sizeWords, qtyText } from '../putup/jarWords.js'
import { PUTUP_SOURCE_LABELS } from '../../lib/dropdownRegistry.js'
import Stepper, { stepperCount } from './Stepper.jsx'
import AmountField, { AMOUNT_WORDS, ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS, parseAmount, amountError } from './AmountField.jsx'
import WhereFromField, { whereFromError } from './WhereFromField.jsx'
import { isJar, discardChip, leftWords, amountWords, ageWords, effectiveBasis, severalLeft } from './pantryRows.js'

export const HOUSE_DETAIL_TEXT =
  'No published figure exists for candied fruit. This date is a house estimate, not a tested one. Set your own.'

// Went bad: the action's two labels, the panel's question, and what its filled button says — the count it
// will discard, so a panel that looks like Gave it away's (which starts at 1) cannot be mistaken for it.
export const WENT_BAD_LABEL = 'Went bad'
export const WENT_BAD_ASKS_LABEL = 'Went bad…'
export const WENT_BAD_QUESTION = 'How many went bad?'
export function wentBadCta(count, all) {
  return count >= all ? `All ${all} went bad` : `${count} went bad`
}
// A part count the server did not take (a server older than this client refuses any count for Went bad,
// in words written for a developer): nothing was written, the panel and its count stay.
export const WENT_BAD_PART_REFUSED_TEXT = "That didn't save. Try again in a few minutes."

const actionBtn = {
  display: 'block', width: '100%', minHeight: T.buttonMinHeight, textAlign: 'left', padding: '10px 12px', background: P.white,
  border: `1px solid ${P.border}`, borderRadius: T.radiusButton, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: T.type.base, fontWeight: 600, color: P.dark,
}

// "2 × 8 oz woozy · put up sometime in August · produce from Warner Farms" — the shipped jar row's words,
// said once in the sheet from the jar's own record. A put-up's source is where what WENT IN came from, not
// where the jar came from, so a source that is not the garden reads "produce from <name>" (Put-Up R2a); a
// planting reads "from <its name>", as it did.
export function jarRecordWords(rec, now = new Date()) {
  const parts = []
  const size = sizeWords(rec)
  if (size) parts.push(size)
  const date = rec.preserved_at_precision
    ? putUpDateWords(rec.preserved_at, rec.preserved_at_precision, { now })
    : putUpDateWords(rec.preserved_at, null, { approx: rec.preserved_at_approx === true, now })
  if (date) parts.push(date === 'not sure' ? 'put up: not sure' : `put up ${date}`)
  if (rec.source_kind && rec.source_kind !== 'own_garden') parts.push(`produce from ${rec.source_label || PUTUP_SOURCE_LABELS[rec.source_kind] || rec.source_kind}`)
  if (rec.planting_name) parts.push(`from ${rec.planting_name}${rec.planting_succession_order != null ? ` · wave ${rec.planting_succession_order}` : ''}`)
  return parts.join(' · ')
}


// A jar's notes AS THEY ARE READ: a "Next time…" line is stored with its day in brackets ("Next time
// (2026-09-02): less basil" — the shape the server and the batch builder find these lines by), and reads
// "Next time: less basil · Sep 2" (howItWasMade.nextTimeWords). Line by line; every other line, and the
// stored note itself, is untouched.
export function notesAsRead(notes, now = new Date()) {
  return String(notes ?? '').split(/\r?\n/).map(line => nextTimeWords(line, now)).join('\n')
}

// `onHowItWasMade(row)` is the batch-builder lane's door (useHowItWasMade().open); `canHowItWasMade(row)`
// says whether this row may offer it (a put-up with no batch). Neither handed in → no door.
// `onMoved({ row, place, saved })`: a move landed — the place tapped and the row the server answered (a
// put-up's jar, a bought item's item), for the host's in-place line. `onChanged('moved')` still follows.
// `onOpenBatch(id, origin)` is the page's opener for batch detail; `canOpenBatch(row)` says whether the
// host can name this row's batch (a batch it cannot name gets no door). Not handed in → no such action.
// THE SHEET LANDS FIRST: it closes, its own Back entry is consumed, and only then is the page told to
// open the batch (sheetLanding.landAfterClose) — a push from inside the armed sheet would strand that
// entry under the batch and cost a dead Back press. The origin it names is the Pantry.
export const WHAT_WENT_IN_LABEL = 'What went in →'
export const PANTRY_ORIGIN_LABEL = 'Pantry'
export default function PantryRowSheet({
  row, fetch, onClose, onUsed, onChanged, onMoved = null, JarEditor = null, onHowItWasMade = null, canHowItWasMade = null,
  onOpenBatch = null, canOpenBatch = null, now,
}) {
  if (!row) return null
  return <RowSheetOpen key={`${row.stock_kind}:${row.stock_id}`} row={row} fetch={fetch} onClose={onClose} onUsed={onUsed}
    onChanged={onChanged} onMoved={onMoved} JarEditor={JarEditor} onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade}
    onOpenBatch={onOpenBatch} canOpenBatch={canOpenBatch} now={now} />
}

function RowSheetOpen({ row, fetch, onClose, onUsed, onChanged, onMoved, JarEditor, onHowItWasMade, canHowItWasMade, onOpenBatch, canOpenBatch, now }) {
  const [panel, setPanel] = useState(null)      // null | 'move' | 'next' | 'give' | 'went-bad' | 'edit'
  const [busy, setBusy] = useState(false)
  const [panelBusy, setPanelBusy] = useState(false)   // the Move panel's write, in flight
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  // The one-tap Went bad's key: minted at the first tap and kept, so a retry after a lost answer is the
  // server's replay of that use rather than a second one.
  const wentBadKeyRef = useRef(null)
  const jar = isJar(row)
  const asksHowMany = severalLeft(row)
  const nowDate = new Date(now ?? Date.now())

  // `key`: the intent's own idempotency key, when the caller holds one (else pantryApi mints one per
  // call). `part`: a Went bad of fewer than all that is left — its uncoded refusal is said in plain words.
  async function use(action, body, { key = null, part = false } = {}) {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      const r = await useJar(fetch, { preservation_log_id: row.stock_id, ...body, ...(key ? { idempotency_key: key } : {}) })
      writingRef.current = false
      setBusy(false)
      onUsed?.({ row, action, use: r?.use ?? null, jar: r?.jar ?? null })
      onClose?.()
    } catch (e) {
      writingRef.current = false
      setBusy(false)
      setErr(part && e?.status === 400 && !describeRefusal(e)
        ? WENT_BAD_PART_REFUSED_TEXT : refusalOf(e, "Couldn't update — try again."))
    }
  }

  function wentBadAtOnce() {
    if (!wentBadKeyRef.current) wentBadKeyRef.current = mintKey()
    use('went_bad', { all_remaining: true, fate: 'discarded' }, { key: wentBadKeyRef.current })
  }
  // The panel's confirm: all that is left is "what is left right now"; fewer is a count.
  function wentBadCount(n, all, key) {
    if (n >= all) use('went_bad', { all_remaining: true, fate: 'discarded' }, { key })
    else use('went_bad', { count_used: n, fate: 'discarded' }, { key, part: true })
  }
  const openPanel = (p) => { setErr(null); setPanel(p) }
  const closePanel = () => { setErr(null); setPanel(null) }

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

  const detail = [row.place?.label, row.where_from, leftWords(row), amountWords(row), ageWords(row, nowDate)].filter(Boolean).join(' · ')
  const chip = discardChip(row, nowDate)
  const recWords = rec ? jarRecordWords(rec, nowDate) : null

  return (
    <Sheet open onClose={onClose} title={row.name || 'In the pantry'} size="full" busy={busy || panelBusy} armsBack
      backIntercept={panel ? () => { closePanel(); return true } : null}>
      <div data-testid="row-sheet" data-row-key={`${row.stock_kind}:${row.stock_id}`} style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
        {detail && <p style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{detail}</p>}
        {recWords && <p data-testid="row-sheet-record" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{recWords}</p>}
        {(rec?.notes || (!jar && row.notes)) && (
          <p data-testid="row-sheet-notes" style={{ margin: 0, color: P.mid, fontSize: T.type.sm, whiteSpace: 'pre-wrap' }}>{notesAsRead(rec?.notes || row.notes, nowDate)}</p>
        )}
        {chip && <p style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{chip}</p>}
        {jar && effectiveBasis(row) === 'house' && row.discard?.date && (
          <p role="note" data-testid="row-sheet-house" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{HOUSE_DETAIL_TEXT}</p>
        )}
        <RefusalLine err={err} testId="row-sheet-error" />

        {/* The order is the thumb's: what is done most and undone easily first, the discard below it. */}
        {panel === null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" style={actionBtn} disabled={busy} data-testid="row-move" onClick={() => openPanel('move')}>Move it…</button>
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-next" onClick={() => openPanel('next')}>Next time…</button>
            )}
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-give" onClick={() => openPanel('give')}>Gave it away…</button>
            )}
            {jar && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-went-bad"
                onClick={asksHowMany ? () => openPanel('went-bad') : wentBadAtOnce}>
                {asksHowMany ? WENT_BAD_ASKS_LABEL : WENT_BAD_LABEL}
              </button>
            )}
            <button type="button" style={actionBtn} disabled={busy} data-testid="row-edit" onClick={() => openPanel('edit')}>Edit…</button>
            {jar && typeof onHowItWasMade === 'function' && (typeof canHowItWasMade !== 'function' || canHowItWasMade(row)) && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-how"
                onClick={() => { onHowItWasMade(row); onClose?.() }}>How it was made →</button>
            )}
            {jar && row.batch_id != null && typeof onOpenBatch === 'function' && (typeof canOpenBatch !== 'function' || canOpenBatch(row)) && (
              <button type="button" style={actionBtn} disabled={busy} data-testid="row-what-went-in"
                onClick={() => landAfterClose(onClose, () => onOpenBatch(row.batch_id, { label: PANTRY_ORIGIN_LABEL }))}>
                {WHAT_WENT_IN_LABEL}
              </button>
            )}
          </div>
        )}

        {/* Move it — a panel, like the others (it rides this sheet's one Back entry). The rule line reads
            the row's STORED basis and date and the kind of place it is in now. A bought item moves by a
            PATCH of its place, with no When. What the write answered goes to the host through `onMoved` —
            AFTER the sheet has closed and its Back entry is consumed (landAfterClose): the host brings its
            line into view, and a scroll made while that entry is still being popped is undone by the pop. */}
        {panel === 'move' && (
          <MoveJarSheet open now={now} whenless={!jar} onBusyChange={setPanelBusy}
            jar={{ id: row.stock_id, label: row.name, storage_location_id: row.place?.id ?? null, storage_kind: row.place?.kind ?? null,
              use_by_target: row.discard?.date ?? null, use_by_basis: row.discard?.basis ?? null }}
            onSubmit={jar ? null : async ({ place }) => {
              const id = await ensurePlaceId(fetch, place)
              const r = await patchPantryItem(fetch, row.stock_id, { storage_location_id: id })
              return r?.item ?? r
            }}
            onClose={closePanel}
            onMoved={({ saved, place }) => {
              onChanged?.('moved')
              landAfterClose(onClose, () => onMoved?.({ row, place, saved }))
            }} />
        )}
        {panel === 'give' && (
          <CountPanel row={row} busy={busy} idPrefix="give" start="one" question="How many did you give away?"
            label="How many given away" cta="Gave it away" onCancel={closePanel}
            onConfirm={(n, _all, key) => use('gave_away', { count_used: n, fate: 'given_away' }, { key })} />
        )}
        {panel === 'went-bad' && (
          <CountPanel row={row} busy={busy} idPrefix="went-bad" start="all" question={WENT_BAD_QUESTION}
            label="How many went bad" cta={wentBadCta} onCancel={closePanel} onConfirm={wentBadCount} />
        )}
        {panel === 'next' && (
          <NextTimePanel row={row} fetch={fetch} onCancel={closePanel}
            onSaved={() => { onChanged?.('noted'); onClose?.() }} />
        )}
        {panel === 'edit' && jar && (
          <JarEditPanel row={row} rec={rec} recFailed={recFailed} fetch={fetch} JarEditor={JarEditor} onCancel={closePanel}
            onSaved={() => { onChanged?.('edited'); onClose?.() }} onRemoved={() => { onChanged?.('removed'); onClose?.() }} />
        )}
        {panel === 'edit' && !jar && (
          <ItemEditPanel row={row} fetch={fetch} onCancel={closePanel}
            onSaved={() => { onChanged?.('edited'); onClose?.() }} onRemoved={() => { onChanged?.('removed'); onClose?.() }} />
        )}
      </div>
    </Sheet>
  )
}

// ONE count panel for the two uses that ask how many. `start`: 'one' (Gave it away) or 'all' (Went bad —
// all that is left, where + is disabled). `cta` is the filled button's words, or a function of the count
// and of all that is left. `onConfirm(count, all, key)`: `all` is what the row says is left (null when it
// carries no count) and `key` the idempotency key of THIS count — minted when the panel opens, kept while
// the count stands, replaced when it changes, so a retry of one count is one use on the server.
function CountPanel({ row, busy, idPrefix, start, question, label, cta, onCancel, onConfirm }) {
  const max = row.count_left != null && Number(row.count_left) >= 1 ? Number(row.count_left) : null
  const [n, setN] = useState(() => (start === 'all' && max != null ? String(max) : '1'))
  const [key, setKey] = useState(() => mintKey())
  const countOf = (v) => Math.min(stepperCount(v), max ?? Infinity)
  const count = countOf(n)
  const change = (v) => {
    if (countOf(v) !== count) setKey(mintKey())
    setN(v)
  }
  return (
    <div data-testid={`${idPrefix}-panel`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={labelChrome} aria-hidden="true">{question}</span>
      <Stepper value={n} onChange={change} name={row.name} idPrefix={idPrefix} max={max} disabled={busy} label={label} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" data-testid={`${idPrefix}-save`} loading={busy} loadingLabel="Saving…"
          onClick={() => onConfirm(count, max, key)}>{typeof cta === 'function' ? cta(count, max) : cta}</Button>
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
    return <Button variant="secondary" data-testid={`${testId}-remove`} disabled={busy} onClick={() => setConfirm(true)}>Remove…</Button>
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

// A bought item's Edit, in this order: name, how much, where it's from, when you got it, a discard date
// from the label, notes. ONE PATCH of what changed (presence-sentinel); an untouched field is an absent key.
//
// HOW MUCH and WHERE IT'S FROM (Put-Up R2a) are the door's own controls, and each is a PAIR on the wire:
// quantity_value + quantity_unit, source_kind + source_label. A pair travels WHOLE or not at all — the
// server refuses one key without the other — and clearing a pair sends `null, null`. The amount goes as a
// JSON number. Both open on what the LIST ROW carries (there is no read of one item). Where it's from is
// not drawn on an item that came from a planting: its origin is the planting, and the server refuses any
// other source for it.
export const ITEM_WHERE_FROM_HEADING = "Where it's from"
// The typed name as it is stored: the garden has none, and a blank one is none.
function sourceLabelOf({ kind, label }) {
  if (kind == null || kind === 'own_garden') return null
  return String(label ?? '').trim() || null
}
function ItemEditPanel({ row, fetch, onCancel, onSaved, onRemoved }) {
  const [seed] = useState(() => ({
    name: String(row.name ?? ''),
    amount: row.quantity_value != null && row.quantity_unit
      ? { value: qtyText(row.quantity_value), unit: row.quantity_unit } : { value: '', unit: null },
    source: { kind: row.source_kind ?? null, label: typeof row.source_label === 'string' ? row.source_label : '' },
    acquired: row.acquired_at ? toYmd(parseYmd(row.acquired_at)) : '',
    useBy: row.discard?.basis === 'typed' && row.discard?.date ? toYmd(parseYmd(row.discard.date)) : '',
    notes: typeof row.notes === 'string' ? row.notes : '',
  }))
  const [name, setName] = useState(seed.name)
  const [amount, setAmount] = useState(seed.amount)
  const [source, setSource] = useState(seed.source)
  const [acquired, setAcquired] = useState(seed.acquired)
  const [useBy, setUseBy] = useState(seed.useBy)
  const [notes, setNotes] = useState(seed.notes)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Which control the refusal on screen is about ('amount' | 'source'), so it is the one marked.
  const [errOn, setErrOn] = useState(null)
  const base = useId()
  // An item that came from a planting has no where-from to correct.
  const fromPlanting = row.plant_id != null && row.plant_id !== ''
  // A stored unit outside the two lists stays on the row as its own chosen chip (it is never dropped).
  const listed = [...ITEM_AMOUNT_UNITS, ...MORE_ITEM_AMOUNT_UNITS].some(o => o.value === seed.amount.unit)
  const moreUnits = seed.amount.unit == null || listed ? MORE_ITEM_AMOUNT_UNITS
    : [...MORE_ITEM_AMOUNT_UNITS, { label: seed.amount.unit, value: seed.amount.unit }]

  function refuse(text, on) {
    setErr(text); setErrOn(on)
    // The two controls' own field ids (AmountField: `${idPrefix}-value`; WhereFromField: `${idPrefix}-source-label`).
    document.getElementById(on === 'amount' ? 'item-edit-amount-value' : 'item-edit-source-label')?.focus()
  }

  async function save() {
    const patch = {}
    if (name.trim() !== seed.name.trim()) {
      if (!name.trim()) { setErr('Give it a name.'); setErrOn(null); return }
      patch.name = name.trim()
    }
    const amountRefused = amountError(amount, AMOUNT_WORDS)
    if (amountRefused) { refuse(amountRefused, 'amount'); return }
    const was = seed.amount.unit == null ? null : parseAmount(seed.amount.value)
    const now = amount.unit == null ? null : parseAmount(amount.value)
    if (now !== was || amount.unit !== seed.amount.unit) {
      patch.quantity_value = now
      patch.quantity_unit = now == null ? null : amount.unit
    }
    if (!fromPlanting) {
      const sourceRefused = whereFromError(source)
      if (sourceRefused) { refuse(sourceRefused, 'source'); return }
      if (source.kind !== seed.source.kind || sourceLabelOf(source) !== sourceLabelOf(seed.source)) {
        patch.source_kind = source.kind
        patch.source_label = sourceLabelOf(source)
      }
    }
    if (acquired !== seed.acquired) {
      patch.acquired_at = acquired || null
      patch.acquired_precision = acquired ? 'day' : null
    }
    if (useBy !== seed.useBy) patch.use_by_target = useBy || null
    if (notes !== seed.notes) patch.notes = notes.trim() || null
    if (!Object.keys(patch).length) { onCancel(); return }
    setBusy(true); setErr(null); setErrOn(null)
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
  const field = { ...inputChrome(false), width: '100%', minHeight: T.buttonMinHeight }
  return (
    <div data-testid="item-edit-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label htmlFor={`${base}-name`} style={labelChrome}>Name</label>
        <input id={`${base}-name`} data-testid="item-edit-name" type="text" value={name} disabled={busy} maxLength={120}
          onChange={e => setName(e.target.value)} style={field} />
      </div>
      <AmountField value={amount.value} unit={amount.unit} onChange={setAmount} label={AMOUNT_WORDS.label} placeholder={AMOUNT_WORDS.placeholder}
        clearLabel={AMOUNT_WORDS.clearLabel} units={ITEM_AMOUNT_UNITS} moreUnits={moreUnits} idPrefix="item-edit-amount" disabled={busy}
        invalid={errOn === 'amount'} />
      {!fromPlanting && (
        <WhereFromField kind={source.kind} label={source.label} onChange={setSource} heading={ITEM_WHERE_FROM_HEADING} idPrefix="item-edit"
          disabled={busy} invalid={errOn === 'source'} />
      )}
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
