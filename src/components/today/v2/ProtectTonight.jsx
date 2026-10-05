import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import Icon from '../../Icon.jsx'
import { skipMany, unskipMany } from '../careStore.js'
import { COVER_LEVELS } from '../../../lib/todayV2/protect.js'
import { tinted } from './SpotRow.jsx'
import { outlineBtn } from './PlantCareRow.jsx'
import { removeLogged, readLogged, claimedKeys, runEnd, runTake, runsEnded } from './needsCareStore.js'

// ProtectTonight — the body of the redesigned Today's Protect tonight (V5-TODAYREDESIGN-001 S5; plan-v2 §1.1 /
// §1.2, §2.3, §2.5, §4, §5.5–5.7; §13 SF1; Dave's D6: Protect keeps its existing Skip, no "Leave it out").
//
//   · on a frost or hard-freeze night, first: "Pick what's ripe first — log a harvest ›" → /log/harvest, the
//     harvest door TopChrome opens (§1.1; a chill night has none, §1.2);
//   · a TENDER planting (a `protect` card) is its own row card: name (→ its planting page), "{spot} · below N°F",
//     then Skip · 8 px · [Covered] · 8 px · [Brought in] — the 8 px between Covered and Brought in are dead space
//     (SF1), so a thumb aimed at one cannot land on the other;
//   · the nightshade mass of a cold night (`bring_in` / `optional` cards) is one COVER ROW per spot — "Bag Area 68",
//     "Cover or bring in tonight", [Cover all 68] — which opens to its plants.
// Write paths (§2.3), through useCareActions' V2 run (no toast, §11.1 C2): Covered and Cover all post `cover`
// (valid, batch-allowed, and it checks the cold card off for the day — daily-plan-read doneEvents.js); Brought in
// posts `brought_inside`, which the engine latches until `brought_outside`, so its done line says so (SF1): "Brought
// in · off the frost list until it goes back out". Skip goes into the one shared skip set, like every other Skip
// on Today. Every result is a done line with Undo in place, held for the visit (the visit record, record.protect),
// and speaks through the page's one status region; a failed write stays on its row as "Not logged" with Retry.
const RUN = { concurrency: 4, excludeInFlight: true }
const ONE = { concurrency: 1, excludeInFlight: true }
const COVER = 'cover'
const DONE = { covered: 'covered', brought: 'brought in · off the frost list until it goes back out', skipped: 'skipped' }

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
// A household member's row carries their name wherever the row is named (orchestrator, 2026-09-29): "(Jen)".
export const rowLabel = (row) => (row.owner ? `${row.name} (${row.owner})` : row.name)

export default function ProtectTonight({ protect, record, update, announce, writesHeld = false }) {
  const slice = record?.protect || null
  const setSlice = useCallback((fn) => update((r) => ({ ...r, protect: fn(r.protect || {}) })), [update])
  const { actions } = protect
  const rowsDone = slice?.rowsDone || {}
  const batches = slice?.batches || {}
  const failed = slice?.failed || {}
  const [busy, setBusy] = useState(null)       // { spot, done, total } while a Cover all runs
  const [undoing, setUndoing] = useState(null) // a batch id or a row key
  const [focusId, setFocusId] = useState(null)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!focusId || !rootRef.current) return
    const el = rootRef.current.querySelector(`[data-focus-id="${focusId.replace(/"/g, '\\"')}"]`)
    if (el) el.focus({ preventScroll: true })
    setFocusId(null)
  }, [focusId, record])

  const byKey = useMemo(() => new Map(protect.allEnriched.map((r) => [r.key, r])), [protect.allEnriched])
  const active = useMemo(() => new Set(protect.rows.map((r) => r.key)), [protect.rows])
  // The visit's held order (§2.2); a row that appears mid-visit (an afternoon refetch) is appended.
  const held = slice?.order || []
  const keys = [...held, ...protect.rows.map((r) => r.key).filter((k) => !held.includes(k))]
  const plantKeys = keys.filter((k) => byKey.has(k) && !COVER_LEVELS.has(byKey.get(k).level))
  const spots = []
  {
    const seen = new Map()
    for (const k of keys) {
      const r = byKey.get(k)
      if (!r || !COVER_LEVELS.has(r.level)) continue
      let s = seen.get(r.spotKey)
      if (!s) { s = { key: r.spotKey, name: r.spotName, parentPath: r.parentPath, keys: [] }; seen.set(r.spotKey, s); spots.push(s) }
      s.keys.push(k)
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────────────────
  // Review 4160.2 IMPORTANT-2: while the page holds its writes (a seeded Back remount still revalidating, TodayV2
  // writesHeld), Covered, Brought in, Cover all, Retry and Skip post and skip nothing, and their controls are inert.
  // Review 4162.1 IMPORTANT-A (Cover all's twin): every write claims its keys before it posts, and each is logged or
  // released as its own POST answers (protect.claim, useTodayLogged), so a run still going when V2 unmounts (keepalive)
  // is left out of the Back remount instead of offered again, and a cover that then fails comes back on the list that
  // is on screen. Undo un-writes, as before. No batch goes on the record at the start: the remount builds no cover row
  // for a spot whose keys are all claimed, so there is no line to draw it on.
  const claim = protect.claim
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // A Cover all's result on the record: its batch (the spot's "covered N" and its one Undo) and each failure's Retry.
  const land = (r) => setSlice((s) => ({
    ...s,
    batches: { ...(s.batches || {}), [newId()]: { spot: r.spot, name: r.name, kind: 'covered', created: r.created } },
    failed: { ...(s.failed || {}), ...Object.fromEntries(r.failed.map((k) => [k, 'covered'])) },
  }))
  // One that ended with this body gone (the section closed, or the page left mid-run and come Back to) parked its
  // result (coverSpot, below); the body then on screen lands it — a failure not logged or taken again since — and
  // says it through this page's status region when the run's own page is gone. (The page's hook is subscribed to the
  // store, so a run's end redraws this body; before paint, so the spot never shows without its result.)
  useLayoutEffect(() => {
    for (const [id] of runsEnded(protect.logKey)) {
      const r = runTake(id)
      if (!r) continue
      const now = readLogged(protect.logKey)
      const taken = claimedKeys(protect.logKey)
      land({ ...r, failed: r.failed.filter((k) => !now.has(k) && !taken.has(k)) })
      if (r.by !== claim) announce(r.said)
    }
  })
  const plantRun = async (row, kind) => {
    if (writesHeld) return
    const res = await actions.runBulk('brought_inside', new Set([row.key]), kind === 'covered' ? { ...ONE, ...claim, bodyEventType: COVER } : { ...ONE, ...claim })
    if (res.created.length) {
      setSlice((s) => {
        const f = { ...(s.failed || {}) }; delete f[row.key]
        return { ...s, failed: f, rowsDone: { ...(s.rowsDone || {}), [row.key]: { kind, created: res.created[0] } } }
      })
      announce(kind === 'covered' ? `Covered: ${rowLabel(row)}.` : `Brought in: ${rowLabel(row)} — off the frost list until it goes back out.`)
      setFocusId('protect:' + row.key)
    } else if (res.failed.length) {
      setSlice((s) => ({ ...s, failed: { ...(s.failed || {}), [row.key]: kind } }))
      announce(`${rowLabel(row)} not logged. Retry is on the row.`)
    }
  }
  const skip = (row) => {
    if (writesHeld) return
    skipMany([row.key], protect.getToken)
    setSlice((s) => ({ ...s, rowsDone: { ...(s.rowsDone || {}), [row.key]: { kind: 'skipped' } } }))
    announce(`Skipped ${rowLabel(row)} for tonight.`)
    setFocusId('protect:' + row.key)
  }
  const undoRow = async (row) => {
    const d = rowsDone[row.key]
    if (!d) return
    setUndoing(row.key)
    if (d.kind === 'skipped') unskipMany([row.key], protect.getToken)
    else {
      const { undone } = await actions.undoMany([d.created], { concurrency: 1 })
      if (!undone.length) { setUndoing(null); announce(`Couldn’t undo ${rowLabel(row)} — the log is still saved.`); return }
      removeLogged(protect.logKey, [row.key])
    }
    setSlice((s) => { const n = { ...(s.rowsDone || {}) }; delete n[row.key]; return { ...s, rowsDone: n } })
    setUndoing(null)
    announce(`Undone: ${rowLabel(row)}.`)
    setFocusId('protect:' + row.key)
  }
  const coverSpot = async (spot, keysNow) => {
    if (writesHeld) return
    const want = new Set(keysNow)
    if (!want.size) return
    setBusy({ spot: spot.key, done: 0, total: want.size })
    announce(`Covering ${want.size} in ${spot.name}…`)
    let spoke = Date.now()
    const res = await actions.runBulk('brought_inside', want, {
      ...RUN, ...claim, bodyEventType: COVER,
      onProgress: (p) => {
        setBusy({ spot: spot.key, done: p.done, total: p.total })
        if (Date.now() - spoke >= 5000) { spoke = Date.now(); announce(`${p.done} of ${p.total} covered in ${spot.name}.`) }
      },
    })
    setBusy(null)
    const landed = { spot: spot.key, name: spot.name, created: res.created, failed: res.failed }
    const fails = res.failed.length
    const said = `Covered ${res.created.length} in ${spot.name}.` + (fails ? ` ${fails} not logged — Retry is on the spot.` : '')
    announce(said)
    if (!alive.current) { runEnd(newId(), { list: protect.logKey, ...landed, said, by: claim }); return }
    land(landed)
    setFocusId(fails ? 'protect-retry:' + spot.key : 'protect-spot:' + spot.key)
  }
  const undoBatch = async (bid) => {
    const b = batches[bid]
    if (!b) return
    setUndoing(bid)
    const { undone, failed: stuck } = await actions.undoMany(b.created, { concurrency: 4 })
    removeLogged(protect.logKey, undone.map((x) => x.key))
    setSlice((s) => {
      const n = { ...(s.batches || {}) }
      if (stuck.length) n[bid] = { ...b, created: stuck, undoFailed: stuck.length }
      else delete n[bid]
      return { ...s, batches: n }
    })
    setUndoing(null)
    announce(`Undone: ${undone.length} covered in ${b.name}.` + (stuck.length ? ` ${stuck.length} could not be undone — those logs are still saved.` : ''))
    setFocusId('protect-spot:' + b.spot)
  }
  const toggleSpot = (key) => setSlice((s) => {
    const open = new Set(s.open || [])
    if (open.has(key)) open.delete(key); else open.add(key)
    return { ...s, open: [...open] }
  })

  // ── render ───────────────────────────────────────────────────────────────────────────────────────────────
  const plantRow = (k, inCard) => {
    const r = byKey.get(k)
    if (rowsDone[k]) return <ProtectDoneLine key={k} row={r} done={rowsDone[k]} inCard={inCard} onUndo={() => undoRow(r)} undoBusy={undoing === k} />
    if (!active.has(k)) return null
    return (
      <ProtectRow key={k} row={r} inCard={inCard} failed={failed[k]} pending={actions.pendingKeys.has(k)} held={writesHeld}
        onSkip={skip} onCover={(x) => plantRun(x, 'covered')} onBring={(x) => plantRun(x, 'brought')} />
    )
  }
  const spotRow = (s) => {
    const remaining = s.keys.filter((k) => active.has(k) && !rowsDone[k])
    const bs = Object.entries(batches).filter(([, b]) => b.spot === s.key)
    const last = bs[bs.length - 1]
    const covered = bs.reduce((n, [, b]) => n + b.created.length, 0)
    if (!remaining.length && last) {
      const stuck = last[1].undoFailed
      return (
        <li key={s.key} data-testid="protect-done-line" data-spot={s.name} style={{ ...cardRow, ...doneRow }}>
          <Icon name="action.check" size={16} decorative style={{ color: P.green, flexShrink: 0 }} />
          <span tabIndex={-1} data-focus-id={'protect-spot:' + s.key} style={doneText}>
            <span style={{ fontWeight: 600, color: P.dark }}>{s.name}</span>
            <span style={{ color: P.mid }}>{` · covered ${covered}`}{stuck ? ` · ${stuck} could not be undone` : ''}</span>
          </span>
          <button type="button" onClick={() => undoBatch(last[0])} disabled={undoing === last[0]} aria-label={`Undo: ${s.name} covered ${covered}`} style={outlineBtn}>Undo</button>
        </li>
      )
    }
    const open = (slice?.open || []).includes(s.key)
    const b = busy && busy.spot === s.key ? busy : null
    const retry = remaining.some((k) => failed[k])
    const partial = covered ? [`covered ${covered}`, retry ? `${remaining.filter((k) => failed[k]).length} not logged` : null].filter(Boolean).join(' · ') : null
    return (
      <CoverSpotRow key={s.key} spot={s} n={remaining.length} open={open} busy={b} retry={retry} partial={partial} held={writesHeld}
        onToggle={() => toggleSpot(s.key)} onCover={() => coverSpot(s, remaining)}
        undo={last ? { onClick: () => undoBatch(last[0]), busy: undoing === last[0], label: `Undo: ${s.name} covered ${covered}` } : null}>
        {s.keys.map((k) => plantRow(k, true))}
      </CoverSpotRow>
    )
  }

  return (
    <div ref={rootRef} data-testid="protect-body" style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>
      {protect.pick && (
        // BUG-LINKICONBLUE-001: an explicit ink on a <Link> holding an <Icon>.
        <Link to="/log/harvest" data-testid="protect-pick" style={pickLink}>
          <Icon name="lifecycle.fruit" size={18} decorative style={{ flexShrink: 0 }} />
          <span>Pick what’s ripe first — log a harvest ›</span>
        </Link>
      )}
      <ul style={list}>
        {plantKeys.map((k) => plantRow(k, false))}
        {spots.map(spotRow)}
      </ul>
    </div>
  )
}

function ProtectRow({ row, inCard, failed, pending, onSkip, onCover, onBring, held }) {
  const who = rowLabel(row)
  const href = (row.projectId && row.plantingId) ? '/projects/' + row.projectId + '/plantings/' + row.plantingId : '/garden'
  const meta = [row.spotName, row.threshold != null ? `below ${row.threshold}°F` : null].filter(Boolean).join(' · ')
  return (
    <li data-testid="protect-row" data-key={row.key} style={inCard ? inRow : cardRow}>
      <Link to={href} data-focus-id={'protect:' + row.key} style={bodyLink}>
        <span style={nameStyle}>{row.name}{row.owner && <span style={ownerStyle}>{` (${row.owner})`}</span>}</span>
        {failed
          ? <span style={failStyle}>Not logged</span>
          : meta && <span style={metaStyle}>{meta}</span>}
      </Link>
      {failed ? (
        <div style={controls}>
          <button type="button" onClick={held ? undefined : () => (failed === 'covered' ? onCover(row) : onBring(row))} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={`Retry: ${who}`} style={outlineBtn}>Retry</button>
        </div>
      ) : (
        <>
          <button type="button" onClick={held ? undefined : () => onSkip(row)} aria-disabled={held ? 'true' : undefined} aria-label={`Skip ${who} tonight`} style={skipCell}>Skip</button>
          {/* SF1: the 8 px between Covered and Brought in is dead space (the flex gap), never a control. */}
          <div data-testid="protect-controls" style={controls}>
            <button type="button" onClick={held ? undefined : () => onCover(row)} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={`Covered: ${who}`} style={outlineBtn}>Covered</button>
            <button type="button" onClick={held ? undefined : () => onBring(row)} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={`Brought in: ${who}`} style={tinted}>Brought in</button>
          </div>
        </>
      )}
    </li>
  )
}

function ProtectDoneLine({ row, done, inCard, onUndo, undoBusy }) {
  const who = rowLabel(row)
  const word = DONE[done.kind] || done.kind
  return (
    <li data-testid="protect-row-done" data-key={row.key} style={{ ...(inCard ? inRow : cardRow), ...doneRow }}>
      <Icon name="action.check" size={16} decorative style={{ color: P.green, flexShrink: 0 }} />
      <span tabIndex={-1} data-focus-id={'protect:' + row.key} style={doneText}>
        <span style={{ fontWeight: 600, color: P.dark }}>{who}</span>
        <span style={{ color: P.mid }}>{' · ' + word}</span>
      </span>
      <button type="button" onClick={onUndo} disabled={undoBusy} aria-label={`Undo: ${who} ${done.kind === 'brought' ? 'brought in' : word}`} style={outlineBtn}>Undo</button>
    </li>
  )
}

// A spot's cover row (§4 "Protect spot cover row"): the same row anatomy as Needs care's spot rows — the
// disclosure is a heading's button, the action its sibling behind 8 px of dead space — one level under the band.
function CoverSpotRow({ spot, n, open, onToggle, onCover, busy, retry, partial, undo, held, children }) {
  const panelId = useId()
  const text = busy ? `Covering ${busy.done} of ${busy.total}…` : retry ? `Retry ${n}` : (n === 1 ? 'Cover 1' : `Cover all ${n}`)
  const name = busy ? text : retry ? `Retry: cover ${n} in ${spot.name}` : `${n === 1 ? 'Cover 1' : 'Cover all ' + n} in ${spot.name}`
  return (
    <li data-testid="protect-spot" data-spot={spot.name} data-count={n} style={{ ...cardRow, flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
        <h3 style={{ margin: 0, flex: 1, minWidth: 0, display: 'flex' }}>
          <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle} data-focus-id={'protect-spot:' + spot.key} style={hit}>
            <span style={{ display: 'block' }}>
              {spot.parentPath && <span style={{ fontSize: T.type.sm, fontWeight: 400, color: P.mid }}>{spot.parentPath + ' › '}</span>}
              <span style={{ fontSize: T.type.md, fontWeight: 600, color: P.dark }}>{spot.name}</span>
              <span style={{ fontSize: T.type.sm, fontWeight: 700, color: P.dark, fontVariantNumeric: 'tabular-nums' }}>{' ' + n}</span>
              <span aria-hidden="true" style={{ fontSize: T.type.xs, color: P.light }}>{open ? ' ▾' : ' ▸'}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: T.type.sm, color: P.mid }}>
              {partial && <Icon name="action.check" size={14} decorative style={{ color: P.green }} />}
              {partial ? partial.replace(/^./, (x) => x.toUpperCase()) : 'Cover or bring in tonight'}
            </span>
          </button>
        </h3>
        {n > 0 && (
          <div style={{ ...controls, paddingRight: 6 }}>
            <button type="button" data-testid="protect-cover-all" data-focus-id={'protect-retry:' + spot.key}
              onClick={busy || held ? undefined : onCover} aria-disabled={busy || held ? 'true' : undefined} aria-label={name} style={tinted}>{text}</button>
          </div>
        )}
      </div>
      {undo && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 6px 6px' }}>
          <button type="button" onClick={undo.onClick} disabled={undo.busy} aria-label={undo.label} style={outlineBtn}>Undo</button>
        </div>
      )}
      {open && <ul id={panelId} style={panelList}>{children}</ul>}
    </li>
  )
}

// ── styles (plan-v2 §4; tokens P / T — every size on the T ramp, the visual census reads them) ─────────────────
// A row is 48 px, its border included (the mockup's row cards, §12 A): the row sets the 48, and the name link and
// the Skip cell STRETCH to it (46 inside the border — still over the 44 floor) rather than each asking for 48 of
// their own, which made every row 50 and pushed Needs care 10 px further down a frost night's first screen.
const list = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: T.space.xs }
const panelList = { listStyle: 'none', margin: 0, padding: 0 }
const cardRow = { listStyle: 'none', background: P.white, border: '1px solid ' + P.border, borderRadius: T.radiusCard, overflow: 'clip', display: 'flex', alignItems: 'stretch', minHeight: 48, boxSizing: 'border-box' }
const inRow = { listStyle: 'none', display: 'flex', alignItems: 'stretch', minHeight: 48, boxSizing: 'border-box', borderTop: '1px solid ' + P.border }
const doneRow = { alignItems: 'center', gap: 8, padding: '0 6px 0 10px' }
const doneText = { flex: 1, minWidth: 0, fontSize: T.type.sm, outline: 'none' }
const bodyLink = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, padding: '4px 10px', textDecoration: 'none', color: P.dark }
const nameStyle = { fontSize: T.type.base, fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }
const ownerStyle = { fontWeight: 400, color: P.mid }
const metaStyle = { fontSize: T.type.xs, color: P.mid }
const failStyle = { fontSize: T.type.xs, color: P.severityUrgent, fontWeight: 600 }
const skipCell = {
  flexShrink: 0, width: 48, marginRight: 8, border: 'none', borderLeft: '1px solid ' + P.border,
  background: 'none', color: P.mid, cursor: 'pointer', fontSize: T.type.xs, fontFamily: 'inherit',
}
const controls = { display: 'flex', alignItems: 'center', gap: 8, paddingRight: 6, flexShrink: 0 }
const hit = {
  flex: 1, minWidth: 0, minHeight: 48, padding: `6px ${T.space.sm}px`, display: 'flex', flexDirection: 'column', justifyContent: 'center',
  gap: 2, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, overflowWrap: 'anywhere',
}
const pickLink = {
  display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.tapMinHeight, textDecoration: 'none',
  color: P.green, fontWeight: 600, fontSize: T.type.sm,
}
