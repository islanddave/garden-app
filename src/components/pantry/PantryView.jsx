// src/components/pantry/PantryView.jsx
// Put-Up B′ release 2 (V4 §2.5 The Pantry, §6.1, §6.6) — the Pantry segment's body: ONE list of put-ups
// and bought items (GET /api/pantry), grouped By place (default) or By what it is.
//
// ROW: name · place · where from · the batch it came from, by name ("from Petri Dish", plain words — the
// door to that batch is in the row sheet) · how many left ("about N g left" for weighed stock) · the
// discard-by chip with its basis words (jarWords.discardWords, through pantryRows.discardChip) · "From the garden"
// · ONE inline action — Used one (counted, more than one left) or Used it up. The open target and the
// inline action are SIBLINGS, never nested (V4 §6.6), each at least 48 px tall.
//
// IN PLACE, for the person who acted (V4 §2.5): after Used one / Used it up / Went bad / Gave it away
// the row reads "3 left · used one · Undo" until their next visit — no timer. The record of what they did
// lives in the PAGE (`recent`, handed in), so switching segments inside one visit keeps it, and a
// used-up row the server no longer lists stays on screen for its Undo (at full opacity, words in P.mid).
// A MOVE made from a row here is said in one line at the top — where it went, and what the server
// answered about its discard date (pantryRows.movedWords) — until it is closed or the next move.
//
// Put-Up UX pass R1, on the list: grouped By place a row does not repeat the place its heading names
// (pantryRows.inPlaceGroup); a row whose discard date is soon or past sets its discard line on the soon
// tint (putup/soonTint.js — the sentence is unchanged, the tint and the weight are two more channels
// beside its words); and an EMPTY Pantry offers the two ways to fill it, as secondary buttons, when the
// page hands them in (`onPutSomethingUp`, `onWalkPlace`) — neither handed in, it is the one line it was.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { listPantry, listBatchNames, undoUse, patchPantryItem, useJar, deletePantryItem } from '../../lib/pantryApi.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import SegmentedControl from '../forms/SegmentedControl.jsx'
import ErrorBanner from '../forms/ErrorBanner.jsx'
import Button from '../forms/Button.jsx'
import { SOON_CHIP_STYLE } from '../putup/soonTint.js'
import { DOOR_CTA } from './putSomethingUp.js'
import { WALK_TITLE } from './WalkPlace.jsx'
import PantryRowSheet from './PantryRowSheet.jsx'
import RefusalLine, { refusalOf } from './RefusalLine.jsx'
import {
  groupRows, rowKey, isItem, detailWords, discardChip, inlineAction, ACTION_LABELS, USED_ONE, USED_UP,
  afterUseWords, finishedByUse, movedWords, onlyUseSoon, isUseSoon,
} from './pantryRows.js'
import { BRIDGE_TEXT } from './pantryBridge.js'

export const GROUP_OPTIONS = [
  { value: 'place', label: 'By place' },
  { value: 'kind', label: 'By what it is' },
]
export const FROM_GARDEN_TEXT = 'From the garden'

// The list, loaded when `enabled`. `rows` is null until the first answer (or on a failure before any).
export function usePantryList({ fetch, group = 'place', enabled = true }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const load = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    Promise.resolve().then(() => listPantry(fetch, { group }))
      .then(r => { setRows(r); setError(false) })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [enabled, fetch, group])
  useEffect(() => { load() }, [load])
  return { rows, loading, error, reload: load }
}

// THE NAMES OF THE BATCHES the listed jars came from: { [batch id]: name } (Put-Up UX pass R1). The list
// read sends a jar's `batch_id` and nothing else about its batch, so the names are ONE more read — sent
// only when some row carries a batch_id, never once per row, and again only when a batch_id turns up that
// no earlier read was sent for (a jar given a batch by "How it was made" in this same visit). FAILURE IS
// ISOLATED: a read that fails, or a batch it does not list, leaves that jar exactly as it reads without a
// name — no words about its batch, no door to it. `enabled` false sends nothing.
const NO_NAMES = Object.freeze({})
export function useBatchNames({ fetch, rows, enabled = true }) {
  const [names, setNames] = useState(NO_NAMES)
  const askedRef = useRef(new Set())
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  // A string, so the effect below runs when the SET of batch ids changes and not on every re-read.
  const ids = useMemo(
    () => [...new Set((rows ?? []).map(r => r?.batch_id).filter(v => v != null && v !== '').map(String))].sort().join('\n'),
    [rows],
  )
  useEffect(() => {
    if (!enabled || !ids) return
    const wanted = ids.split('\n')
    if (wanted.every(id => askedRef.current.has(id))) return
    for (const id of wanted) askedRef.current.add(id)
    Promise.resolve().then(() => listBatchNames(fetch))
      .then(m => { if (mountedRef.current) setNames(prev => ({ ...prev, ...m })) })
      .catch(() => { /* the rows read as they do without a name */ })
  }, [enabled, fetch, ids])
  return names
}
export function batchNameOf(names, row) {
  return row?.batch_id != null ? (names?.[String(row.batch_id)] ?? null) : null
}

// A used-up row the server no longer lists stays where it was for the person who acted: each recent
// snapshot missing from `rows` goes back in after the last row of its group (or last, if its group is
// gone too).
export function mergeRecent(rows, recent) {
  const out = [...(rows ?? [])]
  const have = new Set(out.map(rowKey))
  for (const [k, entry] of Object.entries(recent ?? {})) {
    if (have.has(k) || !entry?.row) continue
    const g = String(entry.row.group_key ?? '')
    let at = -1
    out.forEach((r, i) => { if (String(r.group_key ?? '') === g) at = i })
    if (at === -1) out.push(entry.row); else out.splice(at + 1, 0, entry.row)
    have.add(k)
  }
  return out
}

export default function PantryView({
  fetch, group, onGroupChange, rows, loading, error, onReload, recent, onRecent,
  useSoonOnly = false, onClearUseSoon, JarEditor = null, onHowItWasMade = null, canHowItWasMade = null, completion = null, onCompletionDone,
  showBridge = false, onDismissBridge, onOpenBatch = null, onPutSomethingUp = null, onWalkPlace = null, now,
}) {
  const [openRow, setOpenRow] = useState(null)
  // The last move made from this list, said in place at the top (the place it went and what the server
  // answered about its date) until it is closed or the next move replaces it.
  const [moved, setMoved] = useState(null)
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const batches = useBatchNames({ fetch, rows })

  const shown = useMemo(() => {
    const merged = mergeRecent(rows ?? [], recent)
    return useSoonOnly ? merged.filter(r => recent?.[rowKey(r)] || onlyUseSoon([r]).length) : merged
  }, [recent, rows, useSoonOnly])
  const groups = useMemo(() => groupRows(shown), [shown])

  const record = useCallback((entry) => {
    onRecent?.(prev => ({ ...prev, [rowKey(entry.row)]: { ...entry, undone: false, err: null, undoKey: null } }))
    onReload?.()
  }, [onRecent, onReload])

  return (
    <div data-testid="pantry-view">
      {showBridge && (
        <div data-testid="pantry-bridge" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: T.space.md,
          padding: '4px 4px 4px 12px', background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
          <span style={{ flex: 1, fontSize: T.type.sm, color: P.green }}>{BRIDGE_TEXT}</span>
          <button type="button" data-testid="pantry-bridge-dismiss" aria-label="Dismiss — the Pantry note" onClick={onDismissBridge}
            style={{ minWidth: 48, minHeight: 48, background: 'none', border: 'none', color: P.green, fontSize: '1.1rem', cursor: 'pointer' }}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {completion && (
        <CompletionLine completion={completion} fetch={fetch} onDone={onCompletionDone} onChanged={onReload}
          onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade} />
      )}

      {moved && (
        <div role="status" data-testid="pantry-moved" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: T.space.md,
          padding: '4px 4px 4px 12px', background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: P.green, overflowWrap: 'anywhere' }}>{moved}</span>
          <button type="button" data-testid="pantry-moved-close" aria-label="Close — the moved line" onClick={() => setMoved(null)}
            style={{ minWidth: 48, minHeight: T.buttonMinHeight, background: 'none', border: 'none', color: P.mid, fontSize: '1.1rem', cursor: 'pointer' }}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      <div style={{ marginBottom: T.space.md }}>
        <SegmentedControl ariaLabel="Group by" small value={group} onChange={onGroupChange} options={GROUP_OPTIONS} />
      </div>

      {useSoonOnly && (
        <div style={{ marginBottom: T.space.md }}>
          <button type="button" onClick={onClearUseSoon} data-testid="putup-use-soon-chip" aria-label="Use soon — remove this filter"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 48, padding: '6px 16px', borderRadius: 999,
              border: `1px solid ${P.greenLight}`, backgroundColor: P.greenPale, color: P.green, fontSize: T.type.sm,
              fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>
            Use soon <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {loading && rows == null && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && rows == null && (
        <ErrorBanner>
          Couldn&rsquo;t load the pantry.{' '}
          <button type="button" onClick={onReload} style={{ minHeight: T.buttonMinHeight, background: 'none', border: 'none', color: 'inherit',
            textDecoration: 'underline', fontFamily: 'inherit', cursor: 'pointer' }}>Try again</button>
        </ErrorBanner>
      )}
      {rows != null && shown.length === 0 && (() => {
        const soonEmpty = useSoonOnly && (rows ?? []).length > 0
        // The two ways to fill an empty Pantry, when the page hands them in — SECONDARY buttons: the
        // screen's one filled button is the page header's.
        const canPutUp = !soonEmpty && typeof onPutSomethingUp === 'function'
        const canWalk = !soonEmpty && typeof onWalkPlace === 'function'
        return (
          <div data-testid={soonEmpty ? 'putup-use-soon-empty' : 'pantry-empty'} style={{ padding: '28px 18px', textAlign: 'center',
            color: P.mid, background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
            {soonEmpty ? 'Nothing to use soon right now.' : 'Nothing in the pantry yet.'}
            {(canPutUp || canWalk) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: T.space.md }}>
                {canPutUp && (
                  <Button variant="secondary" data-testid="pantry-empty-putup" onClick={() => onPutSomethingUp()}>{DOOR_CTA}</Button>
                )}
                {canWalk && (
                  <Button variant="secondary" data-testid="pantry-empty-walk" onClick={() => onWalkPlace()}>{WALK_TITLE}</Button>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {groups.map(g => (
        <section key={g.key} aria-label={g.label} data-testid={`pantry-group-${g.key}`}
          style={{ marginBottom: T.space.md, background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge, overflow: 'hidden' }}>
          <h2 style={{ margin: 0, padding: '10px 14px', fontSize: '1rem', fontWeight: 700, color: P.dark, borderBottom: `1px solid ${P.border}` }}>
            {g.label}
          </h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {g.rows.map(r => (
              <PantryRow key={rowKey(r)} row={r} fetch={fetch} recent={recent?.[rowKey(r)] ?? null} onRecent={onRecent}
                onRecord={record} onOpen={() => setOpenRow(r)} onReload={onReload} now={nowDate} batchName={batchNameOf(batches, r)} />
            ))}
          </ul>
        </section>
      ))}

      <PantryRowSheet row={openRow} fetch={fetch} onClose={() => setOpenRow(null)} now={now}
        JarEditor={JarEditor} onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade}
        onOpenBatch={onOpenBatch} canOpenBatch={(r) => batchNameOf(batches, r) != null}
        onUsed={record} onChanged={() => onReload?.()} onMoved={(m) => setMoved(movedWords({ ...m, now: nowDate }))} />
    </div>
  )
}

// One row. The open target (a button over the words) and the inline action are siblings.
export function PantryRow({ row, fetch, recent, onRecent, onRecord, onOpen, onReload, now, batchName = null }) {
  const [busy, setBusy] = useState(false)
  // A synchronous guard: two taps inside one frame both read `busy` false, and each use carries its own
  // key, so both would land (the shipped RecordRow's usingRef, kept).
  const writingRef = useRef(false)
  const [err, setErr] = useState(null)
  const key = rowKey(row)
  const action = inlineAction(row)
  const chip = discardChip(row, now)
  const soon = isUseSoon(row)
  const detail = detailWords(row, { now, batchName })

  async function act() {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      if (isItem(row)) {
        await patchPantryItem(fetch, row.stock_id, { used_up_at: 'now' })
        onRecord({ row, action: USED_UP, use: null, jar: null })
      } else {
        const r = await useJar(fetch, action === USED_ONE
          ? { preservation_log_id: row.stock_id, count_used: 1 }
          : { preservation_log_id: row.stock_id, all_remaining: true })
        onRecord({ row, action, use: r?.use ?? null, jar: r?.jar ?? null })
      }
    } catch (e) {
      setErr(refusalOf(e, "Couldn't update — try again."))
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }

  async function undo() {
    if (!recent || writingRef.current) return
    writingRef.current = true
    // One key per Undo, kept on the recent entry, so a retried Undo after a lost answer is a replay.
    const undoKey = recent.undoKey ?? mintKey()
    onRecent?.(prev => (prev[key] ? { ...prev, [key]: { ...prev[key], undoKey } } : prev))
    setBusy(true); setErr(null)
    try {
      if (isItem(row)) await patchPantryItem(fetch, row.stock_id, { used_up_at: null })
      else await undoUse(fetch, recent.use.id, { idempotencyKey: undoKey })
      onRecent?.(prev => { const next = { ...prev }; delete next[key]; return next })
      onReload?.()
    } catch (e) {
      setErr(refusalOf(e, "Couldn't undo that — try again."))
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }

  const canUndo = !!recent && (isItem(row) || !!recent.use?.id)
  const label = ACTION_LABELS[action]
  // A row that is still live after a use (Used one, some given away, some gone bad) keeps its action; one
  // the use finished (used up, all of it gone bad, nothing left) shows only its Undo.
  const finished = finishedByUse(recent)
  return (
    <li data-testid={`pantry-row-${key}`} style={{ borderTop: `1px solid ${P.cream}`, padding: '4px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
        <button type="button" onClick={onOpen} data-testid={`pantry-row-open-${key}`}
          style={{ flex: 1, minWidth: 0, minHeight: 48, textAlign: 'left', background: 'none', border: 'none', padding: '6px',
            cursor: 'pointer', fontFamily: 'inherit', color: P.dark }}>
          <span style={{ display: 'block', fontWeight: 600, fontSize: '0.92rem' }}>{row.name}</span>
          {detail && <span style={{ display: 'block', fontSize: T.type.sm, color: P.mid }}>{detail}</span>}
          {chip && !soon && <span data-testid={`pantry-row-chip-${key}`} style={{ display: 'block', fontSize: T.type.sm, color: P.mid, overflowWrap: 'anywhere' }}>{chip}</span>}
          {/* Soon or past: the same sentence, on the soon tint. The tint hugs the words (an inline box in
              its own line), so a long sentence wraps inside it. */}
          {chip && soon && (
            <span style={{ display: 'block', margin: '2px 0' }}>
              <span data-testid={`pantry-row-chip-${key}`} data-soon="true"
                style={{ ...SOON_CHIP_STYLE, display: 'inline-block', fontSize: T.type.sm, overflowWrap: 'anywhere' }}>{chip}</span>
            </span>
          )}
          {isItem(row) && typeof row.notes === 'string' && row.notes.trim() && (
            <span style={{ display: 'block', fontSize: T.type.sm, color: P.mid, overflowWrap: 'anywhere' }}>{row.notes.trim()}</span>
          )}
          {row.from_garden && (
            <span style={{ display: 'block', fontSize: T.type.sm, color: P.green }}>
              <span aria-hidden="true">🌿 </span>{FROM_GARDEN_TEXT}
            </span>
          )}
        </button>
        {!finished && label && (
          <button type="button" onClick={act} disabled={busy} data-testid={`pantry-row-action-${key}`}
            aria-label={`${label} — ${row.name}`}
            style={{ flexShrink: 0, alignSelf: 'center', minHeight: 48, minWidth: 48, padding: '0 12px', background: P.white,
              border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton, color: P.green, fontWeight: 700,
              fontFamily: 'inherit', fontSize: T.type.sm, cursor: busy ? 'default' : 'pointer' }}>
            {label}
          </button>
        )}
      </div>
      {recent && (
        <div role="status" data-testid={`pantry-row-done-${key}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 4px' }}>
          <span style={{ flex: 1, fontSize: T.type.sm, color: P.mid }}>{afterUseWords(recent)}</span>
          {canUndo && (
            <button type="button" onClick={undo} disabled={busy} data-testid={`pantry-row-undo-${key}`} aria-label={`Undo — ${row.name}`}
              style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.terra, fontWeight: 700,
                fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>
              Undo
            </button>
          )}
        </div>
      )}
      <RefusalLine err={err} testId={`pantry-row-error-${key}`} style={{ padding: '0 6px 4px' }} />
    </li>
  )
}

// The door's completion, in place on the Pantry (V4 §2.2): what was saved, in the server's words, with
// Undo (a soft delete of what was just made) and — for a put-up — How it was made → when wired.
function CompletionLine({ completion, fetch, onDone, onChanged, onHowItWasMade, canHowItWasMade }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [undone, setUndone] = useState(false)
  const id = completion.saved?.id
  async function undo() {
    if (busy || id == null) return
    setBusy(true); setErr(null)
    try {
      if (completion.route === 'item') await deletePantryItem(fetch, id)
      else await fetch(`/api/preservation/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setUndone(true)
      onChanged?.()
    } catch (e) {
      setErr(refusalOf(e, "Couldn't undo that — try again."))
    } finally { setBusy(false) }
  }
  const asRow = completion.route === 'jar' && completion.saved
    ? { stock_kind: 'put_up', stock_id: completion.saved.id, name: completion.saved.label ?? completion.text, batch_id: completion.saved.batch_id ?? null,
      place: completion.place ?? null }
    : null
  return (
    <div role="status" data-testid="pantry-completion" style={{ marginBottom: T.space.md, padding: '6px 8px 6px 12px',
      background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 160, fontSize: T.type.sm, color: undone ? P.mid : P.green }}>
          {undone ? `Undone — ${completion.text}` : completion.text}
        </span>
        {!undone && id != null && (
          <button type="button" onClick={undo} disabled={busy} data-testid="pantry-completion-undo" aria-label="Undo — what you just put up"
            style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.terra, fontWeight: 700,
              fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>Undo</button>
        )}
        {!undone && asRow && typeof onHowItWasMade === 'function' && (typeof canHowItWasMade !== 'function' || canHowItWasMade(asRow)) && (
          <button type="button" onClick={() => onHowItWasMade(asRow)} data-testid="pantry-completion-how"
            style={{ minHeight: 48, background: 'none', border: 'none', color: P.green, fontWeight: 700,
              fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>How it was made →</button>
        )}
        <button type="button" onClick={onDone} data-testid="pantry-completion-close" aria-label="Close — the saved line"
          style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.mid, cursor: 'pointer', fontSize: '1.1rem' }}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <RefusalLine err={err} testId="pantry-completion-error" />
    </div>
  )
}
