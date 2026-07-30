// FeedPage — V3-FEED-001 full activity feed (/feed).
// The dashboard "Recent activity" card shows 20 collapsed entries; this is the full, paginated,
// filterable history. Raw events come from /api/events/feed (offset paginated); we accumulate and
// collapse the whole set each render so a Log-Many batch never splits across a page boundary.
// Critters earned at logging time surface inline (the seed of the V4 social-feed vision).
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, EVENT_TYPES } from '../lib/constants.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { collapseFeed, dedupeById, relativeTime, prettyEventType } from '../lib/feed.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

const PAGE = 30

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

  useEffect(() => {
    let on = true
    fetch('/api/projects')
      .then(d => { if (on) setProjects(d ?? []) })
      .catch(() => {})
    return () => { on = false }
  }, [fetch])

  const buildQuery = useCallback((off) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE))
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
    setLoading(true); setError(null)
    fetch(buildQuery(0))
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
  }, [fetch, buildQuery])

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

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Activity', href: null }]} />
        <h1 style={{ margin: '0 0 16px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Activity</h1>

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
            {EVENT_TYPES.map(t => <option key={t} value={t}>{prettyEventType(t)}</option>)}
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
