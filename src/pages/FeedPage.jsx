// FeedPage — V3-FEED-001 full activity feed (/feed).
// The dashboard "Recent activity" card shows 20 collapsed entries; this is the full, paginated,
// filterable history. Raw events come from /api/events/feed (offset paginated); we accumulate and
// collapse the whole set each render so a Log-Many batch never splits across a page boundary.
// Critters earned at logging time surface inline (the seed of the V4 social-feed vision).
//
// V4-BATCHUNDO-001 — this page is also where a bulk log becomes DURABLY undoable. LogMany's undo has
// always lived inside its success block, so leaving that screen made a mis-scoped 30-to-157-row
// batch unrecoverable. The feed is the right home for the durable half and needed almost nothing to
// become it: feed.js already collapses a batch into ONE entry carrying batch_id and the exact
// item_count, so the row that needs the affordance already exists and already knows its batch.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, SELECTABLE_EVENT_TYPES } from '../lib/constants.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { collapseFeed, dedupeById, relativeTime, prettyEventType } from '../lib/feed.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import useScrollRestore from '../hooks/useScrollRestore.js'
import BatchUndoConfirm from '../components/BatchUndoConfirm.jsx'
import { BATCHES_PATH, batchUndoPath, undoableById, undoRowCount } from '../lib/batches.js'
import { invalidatePrefix } from '../lib/dataCache.js'

const PAGE = 30
// V4-SCROLLRESTORE-001 — how deep a back-navigation will re-request in ONE round trip. The server
// clamps /api/events/feed's limit at 100 (lambda/events/index.js), so this is the largest useful
// value; it covers three "Load more" presses. Past that the restore lands the user at the bottom of
// what did come back and they press Load more again, which is strictly better than page 1.
const MAX_RESTORED_ROWS = 90

// V4-BATCHUNDO-001 — every cached read the undo can falsify. The DELETE does far more than remove
// rows: inside one transaction it cascades harvest_log, re-parents photos and RECOMPUTES
// entity_memory's recency + next_water_at for every affected project AND planting. So a Today page
// still holding a cached daily plan would keep saying "watered yesterday" about a watering that no
// longer exists, and the next-water date it derives from it would be wrong in the direction that
// costs a plant. Prefix invalidation only — dataCache keys are `${identity}|${path}`, and the
// undo's blast radius is per-route, not per-key.
const UNDO_INVALIDATE_PREFIXES = ['/api/events', '/api/dashboard', '/api/daily-plan', '/api/harvests', '/api/plants']

export default function FeedPage() {
  const { fetch } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [filters, setFilters] = useState({ project_id: '', event_type: '', from: '', to: '' })
  const [rawEvents, setRawEvents] = useState([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  // V4-BATCHUNDO-001 state. `undoable` is a Map id -> batch built from GET /api/events/batches, and
  // it is the ONLY undoability test available to the client: the endpoint already filters to the
  // viewer's own, not-yet-undone, complete batches and caps at ten, so a batch missing from it would
  // 404 on the DELETE. Rendering the affordance from "this row has a batch_id" instead would put a
  // button that cannot work on every historical batch in the feed.
  const [undoable, setUndoable] = useState(() => new Map())
  const [batchesState, setBatchesState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [undoTarget, setUndoTarget] = useState(null)          // { batch, count } — the confirm's subject
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState(null)

  useEffect(() => {
    let on = true
    fetch('/api/projects')
      .then(d => { if (on) setProjects(d ?? []) })
      .catch(() => {})
    return () => { on = false }
  }, [fetch])

  // The undoable set. Fetched ONCE per mount and deliberately not refetched on filter changes — the
  // set is scoped to the viewer, not to the filtered view, and re-requesting it every time a date
  // input changes would be three round trips for an answer that did not move. A failure here must
  // NOT be swallowed the way the projects fetch above swallows its own: silently rendering no Undo
  // buttons is indistinguishable from "nothing is undoable", which is a lie the user cannot see
  // through. It sets 'error' and the notice below says so.
  useEffect(() => {
    let on = true
    setBatchesState('loading')
    fetch(BATCHES_PATH)
      .then(d => { if (on) { setUndoable(undoableById(d)); setBatchesState('ready') } })
      .catch(() => { if (on) { setUndoable(new Map()); setBatchesState('error') } })
    return () => { on = false }
  }, [fetch])

  // V4-SCROLLRESTORE-001: restore the scroll offset once the rows are committed, and carry the
  // user's paging DEPTH across the navigation. Scroll alone is not enough here — "Load more" pages
  // are client-accumulated, so a remount that fetched only page 1 gives the browser a document a
  // third the height it had, the restore gets clamped, and the place is lost regardless of how well
  // the offset was remembered. This is the one-problem-not-two coupling the ticket names.
  const { restoredState, saveState } = useScrollRestore({ id: 'feed', ready: !loading })
  useEffect(() => { saveState(rawEvents.length) }, [rawEvents.length, saveState])
  // Identity, not value: setFilters always produces a fresh object, so this stays true for exactly
  // the initial filter state — and stays true across StrictMode's double effect run, which a
  // "first run" flag would not.
  const initialFiltersRef = useRef(filters)

  const buildQuery = useCallback((off, limit = PAGE) => {
    const p = new URLSearchParams()
    p.set('limit', String(limit))
    p.set('offset', String(off))
    if (filters.project_id) p.set('project_id', filters.project_id)
    if (filters.event_type) p.set('event_type', filters.event_type)
    if (filters.from) p.set('from', `${filters.from}T00:00:00`)
    if (filters.to) p.set('to', `${filters.to}T23:59:59`)
    return `/api/events/feed?${p.toString()}`
  }, [filters])

  // Load (or reload on filter change) — resets to page 0.
  useEffect(() => {
    let on = true
    // On a BACK-navigation to the untouched filter set, ask for the depth the user had paged to in
    // one request rather than one page. A filter change is a different list, so it always starts at
    // PAGE. `restoredState` is only non-undefined when there is also a real offset to restore, so a
    // user who never scrolled never pays for a bigger query.
    const depth = filters === initialFiltersRef.current
      ? Math.min(Math.max(Number(restoredState) || 0, PAGE), MAX_RESTORED_ROWS)
      : PAGE
    setLoading(true); setError(null)
    fetch(buildQuery(0, depth))
      .then(res => {
        if (!on) return
        const evs = res?.events ?? []
        setRawEvents(evs)
        setOffset(evs.length)
        setHasMore(res?.has_more ?? false)
      })
      .catch(err => { if (on) setError(err.message || 'Failed to load activity') })
      .finally(() => { if (on) setLoading(false) })
    return () => { on = false }
  }, [fetch, buildQuery, filters, restoredState])

  async function loadMore() {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(buildQuery(offset))
      const evs = res?.events ?? []
      setRawEvents(prev => dedupeById([...prev, ...evs]))
      setOffset(o => o + evs.length)
      setHasMore(res?.has_more ?? false)
    } catch (err) {
      setError(err.message || 'Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  const items = useMemo(() => collapseFeed(dedupeById(rawEvents)), [rawEvents])
  const anyFilter = filters.project_id || filters.event_type || filters.from || filters.to
  const set = (k) => (e) => setFilters(f => ({ ...f, [k]: e.target.value }))

  // V4-BATCHUNDO-001 — the honest states, and each one is gated on RELEVANCE. A feed with no batch
  // rows on screen gets no notice at all: a line about bulk logs above a list containing none is
  // noise on a browse surface. When batch rows ARE visible, the absence of Undo buttons has three
  // different causes and the user cannot tell them apart from the absence itself, so name it.
  const hasBatchRow = useMemo(() => items.some(ev => (ev.batch_count ?? 1) > 1 && ev.batch_id), [items])
  const undoNotice = !hasBatchRow ? null
    : batchesState === 'loading' ? 'Checking which bulk logs can still be undone…'
    : batchesState === 'error' ? 'Couldn’t check which bulk logs can be undone — reload to try again.'
    // Ten is the server's cap, not a total, so this says "your last ten" rather than implying the
    // feature only ever had these to offer.
    : undoable.size === 0 ? 'None of the bulk logs below can still be undone — only your last ten can be.'
    : null

  async function confirmUndo() {
    const target = undoTarget
    if (!target || undoBusy) return
    setUndoBusy(true)
    setUndoError(null)
    try {
      await fetch(batchUndoPath(target.batch.id), { method: 'DELETE' })
      // Drop the batch's rows locally rather than refetching — the server answer IS the confirmation,
      // and a refetch would fight the accumulated "Load more" pages. Offset moves with them: the
      // server's list no longer contains these rows, so leaving offset where it was would make the
      // next page start N rows deeper and silently skip that many.
      let removed = 0
      setRawEvents(prev => {
        const kept = prev.filter(r => String(r?.batch_id ?? '') !== target.batch.id)
        removed = prev.length - kept.length
        return kept
      })
      setOffset(o => Math.max(0, o - removed))
      setUndoable(prev => { const m = new Map(prev); m.delete(target.batch.id); return m })
      for (const prefix of UNDO_INVALIDATE_PREFIXES) invalidatePrefix(prefix)
      setUndoTarget(null)
    } catch (err) {
      // The sheet STAYS OPEN and the row STAYS PUT. An optimistic removal here would show the user
      // exactly what a successful undo looks like while the entries are still in the database —
      // the one outcome this feature must never produce. 404 is the expected, explicable failure
      // (already undone elsewhere, or aged past the server's ten), so it gets its own sentence
      // instead of the Lambda's bare "Not found".
      setUndoError(err?.status === 404
        ? 'That bulk log can’t be undone any more — it may already have been undone.'
        : (err?.message || 'That didn’t go through — the entries are still there.'))
    } finally {
      setUndoBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Activity', href: null }]} />
        <h1 style={{ margin: '0 0 16px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Activity</h1>

        {undoNotice && (
          <div data-testid="batch-undo-notice" style={{ margin: '-8px 0 14px', fontSize: '0.8rem', color: batchesState === 'error' ? P.terra : P.light }}>
            {undoNotice}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {/* V4-PROJHIDE-001: the project filter is hidden when projects aren't user-facing (event-type +
              date filters remain). filters.project_id stays '' so no project filter is applied. Flag OFF
              renders the select exactly as before. */}
          {!PROJECTS_HIDDEN && (
          <select aria-label="Filter by project" value={filters.project_id} onChange={set('project_id')} style={selStyle}>
            <option value="">All projects</option>
            <ProjectOptions projects={projects} />
          </select>
          )}
          <select aria-label="Filter by event type" value={filters.event_type} onChange={set('event_type')} style={selStyle}>
            <option value="">All event types</option>
            {SELECTABLE_EVENT_TYPES.map(t => <option key={t} value={t}>{prettyEventType(t)}</option>)}
          </select>
          <label style={dateWrap}>From <input type="date" aria-label="From date" value={filters.from} onChange={set('from')} style={dateStyle} /></label>
          <label style={dateWrap}>To <input type="date" aria-label="To date" value={filters.to} onChange={set('to')} style={dateStyle} /></label>
          {anyFilter && (
            <button type="button" onClick={() => setFilters({ project_id: '', event_type: '', from: '', to: '' })} style={clearBtn}>
              Clear
            </button>
          )}
        </div>

        {error && <div style={{ padding: 16, color: P.terra, fontSize: '0.88rem' }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10 }}>
            <div style={{ fontSize: '2.4rem', marginBottom: 10 }}>🌱</div>
            <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark }}>No activity {anyFilter ? 'matches these filters' : 'yet'}</p>
            <p style={{ margin: 0, color: P.light, fontSize: '0.85rem' }}>
              {anyFilter ? 'Try clearing the filters.' : 'Log an event and it will show up here.'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, overflow: 'hidden' }}>
              {items.map((ev, i) => {
                const isBatch = (ev.batch_count ?? 1) > 1
                const species = ev.critter_species_id ? SPECIES_BY_ID[ev.critter_species_id] : null
                // Membership in the server's set, not "looks like a batch" — see the state comment.
                const undoBatch = isBatch && ev.batch_id ? undoable.get(String(ev.batch_id)) : null
                const undoCount = undoBatch ? undoRowCount(undoBatch, ev.batch_count) : null
                // V4-PROJHIDE-001: drop the project_name row label when projects aren't user-facing —
                // prefer a planting name (forward-compatible if the feed adds one), else a neutral em
                // dash. Flag OFF keeps the exact prior project_name label.
                const target = isBatch
                  ? `${ev.batch_count} plantings`
                  : (PROJECTS_HIDDEN ? (ev.plant_name ?? '—') : (ev.project_name ?? '—'))
                const inner = (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: i < items.length - 1 ? `1px solid ${P.border}` : 'none', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={typeBadge}>{isBatch ? `${prettyEventType(ev.event_type)} × ${ev.batch_count}` : prettyEventType(ev.event_type)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: P.dark, fontSize: '0.875rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{target}</div>
                        {ev.notes && <div style={{ fontSize: '0.78rem', color: P.light, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.notes}</div>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {species && (
                        <span title={`Spotted ${species.name}`} aria-label={`Spotted ${species.name}`} style={critterChip}>🦋 {species.name}</span>
                      )}
                      <span style={{ fontSize: '0.75rem', color: P.light, whiteSpace: 'nowrap' }}>{relativeTime(ev.created_at)}</span>
                      {/* V4-BATCHUNDO-001 — opens the confirm; it never deletes on its own tap. 44px
                          minimum on both axes: this sits at the right edge of a 390px row where the
                          thumb already is, so an undersized target here is a mis-tap generator on
                          the one control in this page that removes data. */}
                      {undoBatch && (
                        <button
                          type="button"
                          data-testid={`batch-undo-open-${undoBatch.id}`}
                          onClick={() => { setUndoError(null); setUndoTarget({ batch: undoBatch, count: undoCount }) }}
                          aria-label={`Undo this bulk log of ${undoCount ?? ev.batch_count} entries`}
                          style={undoBtn}
                        >
                          Undo
                        </button>
                      )}
                    </div>
                  </div>
                )
                // Single-event rows deep-link to their event detail; batch rows are not individually addressable.
                return (!isBatch && ev.project_id)
                  ? <Link key={ev.id} to={`/projects/${ev.project_id}/events/${ev.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{inner}</Link>
                  : <div key={ev.id}>{inner}</div>
              })}
            </div>
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button type="button" onClick={loadMore} disabled={loadingMore} style={moreBtn}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Rendered at PAGE level, not inside the row: a fly-up nested in the list would sit inside
          the list container's stacking and overflow context, which is how a sheet ends up clipped
          (BUG-PICKERCLIP-001). Sheet returns null when closed, so the body unmounts on Cancel and
          no stale count can survive into the next batch's confirm. */}
      <BatchUndoConfirm
        open={!!undoTarget}
        batch={undoTarget?.batch ?? null}
        count={undoTarget?.count ?? null}
        busy={undoBusy}
        error={undoError}
        onCancel={() => { if (!undoBusy) { setUndoTarget(null); setUndoError(null) } }}
        onConfirm={confirmUndo}
      />
    </div>
  )
}

const selStyle = { flex: '1 1 140px', minWidth: 0, padding: '8px 10px', borderRadius: 8, border: `1px solid ${P.border}`, backgroundColor: P.white, color: P.dark, fontSize: '0.85rem', fontFamily: 'inherit' }
const dateWrap = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: P.light }
const dateStyle = { padding: '7px 8px', borderRadius: 8, border: `1px solid ${P.border}`, backgroundColor: P.white, color: P.dark, fontSize: '0.82rem', fontFamily: 'inherit' }
const clearBtn = { padding: '8px 12px', borderRadius: 8, border: `1px solid ${P.border}`, background: P.white, color: P.green, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
const typeBadge = { fontSize: '0.72rem', fontWeight: 600, color: P.green, backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10, padding: '2px 9px', flexShrink: 0, whiteSpace: 'nowrap' }
const critterChip = { fontSize: '0.7rem', fontWeight: 600, color: '#8a6d1f', backgroundColor: '#faf3da', border: '1px solid #e7d9a8', borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }
const moreBtn = { padding: '10px 24px', borderRadius: 8, border: `1px solid ${P.greenLight}`, background: P.white, color: P.green, fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
// Quiet chrome on purpose — this is a browse surface, and a red button on ten rows of a scrolling
// list reads as an alarm. The weight belongs in the confirm, which is where the number is.
const undoBtn = { minWidth: 44, minHeight: 44, padding: '0 12px', borderRadius: 8, border: `1px solid ${P.border}`, background: P.white, color: P.mid, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }
