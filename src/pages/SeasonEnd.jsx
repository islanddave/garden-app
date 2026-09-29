// End of season — close out the plantings a frost finishes, in one pass. Reached from the More row
// "End of season" (src/lib/moreRegistry.js); an installed PWA has no address bar, so the row ships
// with this route.
//
// WHAT IS LISTED, and why, lives in src/lib/seasonEnd.js — the page only draws it. Two groups:
// finished plantings by location (collapsed until tapped, "Select N" / "Clear N" only once open and
// only over that group), and one collapsed "Still growing through frost" group whose rows tick one at
// a time. NOTHING IS PRE-TICKED and there is no page-wide select-all: the action is once a season, so
// every tick is one somebody looked at.
//
// THE WRITE is one PUT /api/plants/:id per planting with `{ status: 'ended' }` and nothing else — the
// PUT is a COALESCE partial update that records the status_change event in the same transaction
// (lambda/plants/index.js). 3 in flight; the confirm sheet stays open and busy with "Ending 3 of 7…".
// Saved rows leave the list; failed rows stay ticked, tagged "Didn't save", with Try again. After 3
// failures in a row the run sends nothing new (lie-fi hangs each write to the 15 s timeout), so the
// sheet lets go and every row not sent is a "Didn't save" too (runPool, src/lib/seasonEnd.js).
//
// UNDO is one, for the last batch: the house toast "Ended 7 plantings · Undo", and the same undo kept
// in the sticky bar until the page is left or something is ticked again. It PUTs each landed row back
// to ITS OWN prior status (a new status_change; nothing is deleted) and only rows that landed. Put-back
// rows come back ticked, as they were before End. A put-back that fails keeps Undo offered for exactly
// the rows still ended, and the bar names them when there are five or fewer.
//
// Today reads a stored plan that runs hourly only by day, so the copy says ended rows leave Today's list
// at its next update, within a few hours (TODAY_LAG_LINE).
//
// REWARD UX: a task surface. No celebration, no tally, no badges — the toast is the operational
// carve-out (ToastContext.jsx).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import { invalidatePrefix } from '../lib/dataCache.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { useHandedness } from '../hooks/useHandedness.js'
import useNearViewport from '../hooks/useNearViewport.js'
import { IMAGE_WINDOW_PAGE } from '../hooks/useImageWindow.js'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'
import Icon from '../components/Icon.jsx'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import EmptyState from '../components/forms/EmptyState.jsx'
import Button from '../components/forms/Button.jsx'
import SeasonEndConfirm from '../components/SeasonEndConfirm.jsx'
import {
  SEASON_END_PATH, LOCATIONS_PATH, plantPath, ENDED_STATUS, GROUP_STILL_GROWING,
  buildSeasonList, groupSelectAction, applyGroupSelect, plantingsPhrase, endBody, restoreBody,
  canRestore, runPool, progressLine, endResultLine, undoResultLine, TODAY_LAG_LINE, lastLoggedLabel,
} from '../lib/seasonEnd.js'

const STILL_GROWING_KEY = 'still-growing'
const THUMB_PX = T.space.lg * 2
const ROW_MIN = T.buttonMinHeight + T.space.sm
const BAR_BOTTOM = 'calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom))'
const rowIdOf = (el) => el.getAttribute('data-row-id')
// Every cached read an End, a Try again or an Undo falsifies (the FeedPage pattern): the planting rows,
// the status_change event each PUT records, and the dashboard's counts by status. Prefix invalidation
// only, as FeedPage does. Today's plan is a stored snapshot the cron rewrites, so a refetch there
// would return the same rows (TODAY_LAG_LINE).
const WRITE_INVALIDATE_PREFIXES = ['/api/plants', '/api/events', '/api/dashboard']
const invalidateAfterWrite = () => { for (const p of WRITE_INVALIDATE_PREFIXES) invalidatePrefix(p) }

const page = { minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }
// The bottom pad clears the sticky bar at its tallest (result line + selection line).
const column = { maxWidth: 700, margin: '0 auto', padding: `${T.space.lg}px ${T.space.md}px ${T.space.lg * 8}px` }
const title = { margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }
const lede = { margin: `${T.space.xs}px 0 0`, color: P.dark, fontSize: T.type.md }
const aside = { margin: `${T.space.xs}px 0 ${T.space.md}px`, color: P.mid, fontSize: T.type.sm }
const groupBox = { borderBottom: `1px solid ${P.border}` }
const groupHead = { display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.buttonMinHeight }
const groupToggle = {
  flex: 1, minWidth: 0, minHeight: T.buttonMinHeight, display: 'flex', alignItems: 'center', gap: T.space.sm,
  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
  color: P.dark, fontSize: T.type.md, fontWeight: 700, fontFamily: 'inherit',
}
const groupCount = { color: P.mid, fontWeight: 400 }
const selectBtn = {
  minHeight: T.buttonMinHeight, padding: `0 ${T.space.md}px`, borderRadius: T.radiusButton,
  border: `1px solid ${P.border}`, background: P.white, color: P.green, fontSize: T.type.sm2,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const rowBtn = {
  width: '100%', minHeight: ROW_MIN, display: 'flex', alignItems: 'center', gap: T.space.sm,
  padding: `${T.space.xs}px 0`, background: 'transparent', border: 'none', borderTop: `1px solid ${P.border}`,
  cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: P.dark,
}
const thumbBox = {
  flexShrink: 0, width: THUMB_PX, height: THUMB_PX, borderRadius: T.radiusField, overflow: 'hidden',
  backgroundColor: P.photoPlaceholder, position: 'relative',
}
const thumbImg = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const rowText = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }
const rowName = { fontSize: T.type.md, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowMeta = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: T.space.xs, color: P.mid, fontSize: T.type.sm }
const tag = (tone) => ({
  fontSize: T.type.xs2, fontWeight: 700, color: tone === 'warn' ? P.terra : P.greenDeep,
  border: `1px solid ${tone === 'warn' ? P.alertBorder : P.border}`, borderRadius: T.radiusBadge,
  padding: T.badgePadXs, backgroundColor: tone === 'warn' ? P.alert : P.white,
})
const checkBox = (on) => ({
  flexShrink: 0, width: T.space.lg + T.space.xs, height: T.space.lg + T.space.xs, borderRadius: T.radiusField,
  border: `2px solid ${on ? P.green : P.border}`, backgroundColor: on ? P.green : P.white, color: P.white,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
})
const skeleton = { height: T.buttonMinHeight, margin: `${T.space.xs}px 0`, borderRadius: T.radiusField, backgroundColor: P.photoPlaceholder }
const bar = {
  position: 'fixed', left: 0, right: 0, bottom: BAR_BOTTOM, zIndex: 60,
  backgroundColor: P.white, borderTop: `1px solid ${P.border}`, boxShadow: '0 -2px 10px rgba(0,0,0,0.08)',
}
const barInner = { maxWidth: 700, margin: '0 auto', padding: `${T.space.sm}px ${T.space.md}px`, display: 'flex', flexDirection: 'column', gap: T.space.sm }
const barRow = { display: 'flex', alignItems: 'center', gap: T.space.sm, flexWrap: 'wrap' }
const barText = { flex: 1, minWidth: 0, color: P.dark, fontSize: T.type.sm2 }
const barSub = { display: 'block', color: P.mid, fontSize: T.type.sm }
const linkBtn = {
  minHeight: T.buttonMinHeight, padding: `0 ${T.space.sm}px`, background: 'transparent', border: 'none',
  color: P.green, fontSize: T.type.sm2, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
}

function Row({ item, checked, failed, withPhoto, hand, onToggle }) {
  const stillGrowing = item.kind === GROUP_STILL_GROWING
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-testid="season-end-row"
      data-row-id={item.id}
      onClick={() => onToggle(item.id)}
      style={{ ...rowBtn, flexDirection: hand === 'left' ? 'row-reverse' : 'row' }}
    >
      <span style={thumbBox} aria-hidden="true">
        {withPhoto && item.photo && <PhotoView photo={item.photo} tier={TIER.THUMB} alt="" decoding="async" style={thumbImg} />}
      </span>
      <span style={rowText}>
        <span style={rowName}>{item.name}</span>
        <span style={rowMeta}>
          <PlantStatusBadge status={item.status} />
          {stillGrowing && <span>{item.locationName} ·</span>}
          <span>{lastLoggedLabel(item.lastLoggedAt)}</span>
          {stillGrowing && (
            <span data-testid="season-end-tag" style={tag()}>{item.band === 'hardy' ? 'Takes frost' : 'Takes light frost'}</span>
          )}
          {failed && <span data-testid="season-end-failed" style={tag('warn')}>Didn’t save</span>}
        </span>
      </span>
      <span style={checkBox(checked)} aria-hidden="true">
        {checked && <Icon name="action.check" size={18} decorative />}
      </span>
    </button>
  )
}

export default function SeasonEnd() {
  const { fetch: apiFetch } = useApiFetch()
  const toast = useOptionalToast()
  const hand = useHandedness()

  const [rows, setRows] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [failedIds, setFailedIds] = useState(() => new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [progress, setProgress] = useState(null)       // { verb, done, total } while a batch runs
  const [batch, setBatch] = useState(null)             // { items: [{ ...item, prevStatus }] } — the undo
  const [result, setResult] = useState(null)           // { line, sub, retry } — the bar's result line
  // Refs, not state, for the in-flight guard: a disabled button is applied by a render that has not
  // flushed, so two taps in one batch would both start a run (BUG-RUNBULKPARTIALUNDO-001).
  const inFlightRef = useRef(false)
  const batchRef = useRef(null)
  const toastIdRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [plantsBody, locBody] = await Promise.all([apiFetch(SEASON_END_PATH), apiFetch(LOCATIONS_PATH)])
      // Fail closed on a shape this page did not ask for: a list it cannot trust is not shown.
      if (!Array.isArray(plantsBody?.plants) || !Array.isArray(locBody?.locations)) throw new Error('unexpected response')
      setRows(plantsBody.plants)
      setLocations(locBody.locations)
    } catch {
      setRows([])
      setLoadError('Couldn’t load your plantings.')
    }
    setLoading(false)
  }, [apiFetch])

  useEffect(() => { load() }, [load])

  // Leaving the page ends the undo offer everywhere, the toast included.
  useEffect(() => () => { if (toastIdRef.current != null) toast.dismiss?.(toastIdRef.current) }, [toast])

  const list = useMemo(() => buildSeasonList(rows, locations), [rows, locations])
  const itemsById = useMemo(() => {
    const m = new Map()
    for (const g of list.finished) for (const it of g.rows) m.set(it.id, it)
    for (const it of list.stillGrowing) m.set(it.id, it)
    return m
  }, [list])
  const selectedItems = useMemo(() => [...selected].map((id) => itemsById.get(id)).filter(Boolean), [selected, itemsById])

  const dropUndoOffer = useCallback(() => {
    batchRef.current = null
    setBatch(null)
    setResult(null)
    if (toastIdRef.current != null) { toast.dismiss?.(toastIdRef.current); toastIdRef.current = null }
  }, [toast])

  const toggle = useCallback((id) => {
    if (inFlightRef.current) return
    if (!selected.has(id)) dropUndoOffer()            // ticking again ends the last batch's undo
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setFailedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [selected, dropUndoOffer])

  const toggleGroup = (key) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const groupSelect = (groupRows) => {
    if (inFlightRef.current) return
    const action = groupSelectAction(groupRows, selected)
    if (!action.clears) dropUndoOffer()
    setSelected((prev) => applyGroupSelect(prev, action))
    if (action.clears) setFailedIds((prev) => new Set([...prev].filter((id) => !action.ids.includes(id))))
  }

  const clearAll = () => {
    if (inFlightRef.current) return
    setSelected(new Set())
    setFailedIds(new Set())
  }

  // Ends `items`. A run while an undo is still offered is a retry of that batch's failed rows, or an End
  // of the rows a partial undo put back (ticking anything new drops the offer). Either way its landed
  // rows join the same undo, where every row keeps its own prior status.
  const endItems = useCallback(async (items) => {
    if (inFlightRef.current || items.length === 0) return
    inFlightRef.current = true
    setProgress({ verb: 'Ending', done: 0, total: items.length })
    const results = await runPool(items, (it) => apiFetch(plantPath(it.id), { method: 'PUT', body: JSON.stringify(endBody()) }), {
      onProgress: (done, total) => setProgress({ verb: 'Ending', done, total }),
    })
    const landed = items.filter((_, i) => results[i].ok).map((it) => ({ ...it, prevStatus: it.status }))
    const failed = items.filter((_, i) => !results[i].ok).map((it) => it.id)
    const landedIds = new Set(landed.map((it) => it.id))
    setRows((prev) => prev.map((r) => (landedIds.has(r.id) ? { ...r, status: ENDED_STATUS } : r)))
    setSelected((prev) => new Set([...prev].filter((id) => !landedIds.has(id))))
    setFailedIds(new Set(failed))
    const merged = [...(batchRef.current?.items ?? []), ...landed]
    const nextBatch = merged.length ? { items: merged } : null
    batchRef.current = nextBatch
    setBatch(nextBatch)
    setResult({
      line: endResultLine(merged.length, failed.length),
      sub: merged.length ? TODAY_LAG_LINE : null,
      retry: failed.length > 0,
    })
    if (landed.length) {
      invalidateAfterWrite()
      if (toastIdRef.current != null) toast.dismiss?.(toastIdRef.current)
      toastIdRef.current = toast.showUndo?.({
        message: `Ended ${plantingsPhrase(merged.length)}`, detail: TODAY_LAG_LINE, onUndo: () => undoRef.current?.(),
      }) ?? null
    }
    setProgress(null)
    setConfirmOpen(false)
    inFlightRef.current = false
  }, [apiFetch, toast])

  const undo = useCallback(async () => {
    const current = batchRef.current
    if (inFlightRef.current || !current) return
    inFlightRef.current = true
    batchRef.current = null
    setBatch(null)
    if (toastIdRef.current != null) { toast.dismiss?.(toastIdRef.current); toastIdRef.current = null }
    const targets = current.items.filter((it) => canRestore(it.prevStatus))
    setProgress({ verb: 'Putting back', done: 0, total: targets.length })
    const results = await runPool(targets, (it) => apiFetch(plantPath(it.id), { method: 'PUT', body: JSON.stringify(restoreBody(it.prevStatus)) }), {
      onProgress: (done, total) => setProgress({ verb: 'Putting back', done, total }),
    })
    const back = new Map(targets.filter((_, i) => results[i].ok).map((it) => [it.id, it.prevStatus]))
    setRows((prev) => prev.map((r) => (back.has(r.id) ? { ...r, status: back.get(r.id) } : r)))
    setSelected((prev) => new Set([...prev, ...back.keys()]))
    // A put-back that failed leaves its row ended and off the list, so the offer stays for exactly those
    // rows (each still carrying its own prior status), and the bar names them when there are few.
    const unrestored = targets.filter((_, i) => !results[i].ok)
    const nextBatch = unrestored.length ? { items: unrestored } : null
    batchRef.current = nextBatch
    setBatch(nextBatch)
    const stillEndedNames = current.items.filter((it) => !back.has(it.id)).map((it) => it.name)
    setResult({ line: undoResultLine(back.size, current.items.length, stillEndedNames), sub: null, retry: false })
    if (back.size) invalidateAfterWrite()
    setProgress(null)
    inFlightRef.current = false
  }, [apiFetch, toast])
  const undoRef = useRef(undo)
  useEffect(() => { undoRef.current = undo }, [undo])

  const retryFailed = () => endItems(selectedItems.filter((it) => failedIds.has(it.id)))

  // Photos are windowed, rows are not (the My seeds pattern, BUG-PHOTOTHUMB-001): a thumbnail mounts
  // for the first IMAGE_WINDOW_PAGE open rows, or once its row comes within reach of the viewport.
  const listRef = useRef(null)
  const openRows = useMemo(() => [
    ...list.finished.filter((g) => expanded.has(g.key)).flatMap((g) => g.rows),
    ...(expanded.has(STILL_GROWING_KEY) ? list.stillGrowing : []),
  ], [list, expanded])
  const inReach = useNearViewport(listRef, {
    selector: '[data-testid="season-end-row"]', keyOf: rowIdOf, resetKey: [...expanded].sort().join('|'),
  })
  const imageRank = useMemo(() => new Map(openRows.map((it, n) => [it.id, n])), [openRows])
  const withPhoto = (id) => (imageRank.get(id) ?? Infinity) < IMAGE_WINDOW_PAGE || inReach.has(String(id))

  const empty = !loading && !loadError && list.finished.length === 0 && list.stillGrowing.length === 0
  const running = !!progress
  const barVisible = !loading && !loadError && (selectedItems.length > 0 || !!result || !!batch || running)

  const renderRows = (items) => items.map((it) => (
    <Row key={it.id} item={it} checked={selected.has(it.id)} failed={failedIds.has(it.id)}
      withPhoto={withPhoto(it.id)} hand={hand} onToggle={toggle} />
  ))

  return (
    <div style={page}>
      <div style={column}>
        <h1 style={title}>End of season</h1>
        <p style={lede}>Tick what’s done for the year.</p>
        <p style={aside}>Plants that go dormant or live indoors aren’t listed.</p>

        {loading ? (
          <div role="status" aria-label="Loading your plantings" data-testid="season-end-loading">
            <div style={skeleton} /><div style={skeleton} /><div style={skeleton} />
          </div>
        ) : (
          <AsyncRegion error={loadError} onRetry={load} retryLabel="Try again" errorTitle={null}
            empty={empty} emptyLabel={<EmptyState title="Nothing left to end." body="Every outdoor planting a frost finishes is already ended." />}>
            <div ref={listRef} data-testid="season-end-list">
              {list.finished.map((g) => {
                const open = expanded.has(g.key)
                const ticked = g.rows.filter((r) => selected.has(r.id)).length
                const action = groupSelectAction(g.rows, selected)
                return (
                  <section key={g.key} style={groupBox} data-testid="season-end-group" data-group={g.label}>
                    <div style={groupHead}>
                      <button type="button" aria-expanded={open} onClick={() => toggleGroup(g.key)} style={groupToggle}>
                        <Icon name="action.chevron" size={18} decorative style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                        <span>{g.label} <span style={groupCount}>· {g.rows.length}{ticked ? ` · ${ticked} ticked` : ''}</span></span>
                      </button>
                      {open && (
                        <button type="button" data-testid="season-end-group-select" onClick={() => groupSelect(g.rows)} style={selectBtn}>
                          {action.verb} {action.count}
                        </button>
                      )}
                    </div>
                    {open && renderRows(g.rows)}
                  </section>
                )
              })}
              {list.stillGrowing.length > 0 && (() => {
                const open = expanded.has(STILL_GROWING_KEY)
                const ticked = list.stillGrowing.filter((r) => selected.has(r.id)).length
                return (
                  <section style={groupBox} data-testid="season-end-still-growing-group">
                    <div style={groupHead}>
                      <button type="button" aria-expanded={open} onClick={() => toggleGroup(STILL_GROWING_KEY)} style={groupToggle}>
                        <Icon name="action.chevron" size={18} decorative style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                        <span>Still growing through frost <span style={groupCount}>· {list.stillGrowing.length}{ticked ? ` · ${ticked} ticked` : ''}</span></span>
                      </button>
                    </div>
                    {open && (
                      <>
                        <p style={{ ...aside, margin: `0 0 ${T.space.sm}px` }}>These take a frost. Tick them one at a time once a hard freeze is done with them.</p>
                        {renderRows(list.stillGrowing)}
                      </>
                    )}
                  </section>
                )
              })()}
            </div>
          </AsyncRegion>
        )}
      </div>

      {barVisible && (
        <div style={bar} data-testid="season-end-bar">
          <div style={barInner}>
            {running && !confirmOpen && (
              <div role="status" style={barText} data-testid="season-end-bar-progress">{progressLine(progress.verb, progress.done, progress.total)}</div>
            )}
            {!running && (result || batch) && (
              <div style={barRow}>
                <span role="status" style={barText} data-testid="season-end-result">
                  {result?.line}
                  {result?.sub && <span style={barSub}>{result.sub}</span>}
                </span>
                {result?.retry && selectedItems.some((it) => failedIds.has(it.id)) && (
                  <button type="button" style={linkBtn} data-testid="season-end-retry" onClick={retryFailed}>Try again</button>
                )}
                {batch && (
                  <button type="button" style={linkBtn} data-testid="season-end-undo" onClick={() => undo()}>Undo</button>
                )}
              </div>
            )}
            {selectedItems.length > 0 && (
              <div style={barRow}>
                <span style={barText} data-testid="season-end-count">{selectedItems.length} selected</span>
                <button type="button" style={linkBtn} onClick={clearAll} disabled={running}>Clear</button>
                <Button data-testid="season-end-open-confirm" onClick={() => setConfirmOpen(true)} disabled={running}>
                  End {plantingsPhrase(selectedItems.length)}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <SeasonEndConfirm
        open={confirmOpen}
        items={selectedItems}
        progress={progress && progress.verb === 'Ending' ? progress : null}
        onConfirm={() => endItems(selectedItems)}
        onCancel={() => { if (!inFlightRef.current) setConfirmOpen(false) }}
      />
    </div>
  )
}
