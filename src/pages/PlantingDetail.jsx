// PlantingDetail — V3-NAV-001 (Lane C / PR2). The dedicated detail page for a single planting.
// Route: /projects/:id/plantings/:plantingId  (matches the /projects/:id/... family; :id is the
// project, :plantingId the planting). Static-imported + route-ErrorBoundary-wrapped in App.jsx,
// mirroring EventDetail (the app uses no React.lazy).
//
// Data: GET /api/plants/:plantingId returns the full enriched record (variety_ref, status,
// sown_at, transplanted_at, qty_*, source_*/lineage_note, project_id, project_name,
// featured_photo_view_url). Planting-scoped event log: GET /api/events?project_id=:id&
// plant_id=:plantingId — the HS-2 server-side filter, so the LIMIT scopes to THIS planting
// (no silent "no events" lie on busy projects).
//
// Four planting states (DoD): loading · fetch-error · 404 (not found / not in household /
// ownership mismatch → friendly + back-link) · empty-but-exists. The event log tracks its OWN
// loading/error/empty so a filtered-empty log is never confused with a failed-to-load page.
//
// A11y: status is multi-channel (icon + label + color via PlantStatusBadge, never color alone);
// sticky section headers give a jump anchor for the flat single-column layout; scroll-to-top on
// mount (BrowserRouter doesn't reset scroll on push); breadcrumb is arbitrary-depth.
import React, { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { EVENT_TYPE_META } from '../lib/eventTypes.js'
import { formatQty } from '../lib/format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'
import ZoomableImage from '../components/ZoomableImage.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { PLANT_SOURCE_LABELS } from '../lib/dropdownRegistry.js'



function fmtDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function PlantingDetail() {
  const { id: projectId, plantingId } = useParams()
  const { fetch } = useApiFetch()
  const ux = useUxFlow(FLOWS.OPEN_PLANTING)

  const [planting, setPlanting] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notFound, setNotFound] = useState(false)

  // Event log has its OWN lifecycle (DoD: don't conflate filtered-empty with failed-load).
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState(null)

  // V3-PHOTOMULTI-001 (V1, display-only): every photo linked to THIS planting — uploaded directly
  // (plant_id) or attached to one of its events (event_id). No backend/migration: read the
  // project's photos (same source as the Photo Library) and filter client-side.
  const [photos, setPhotos] = useState([])
  const [photosLoading, setPhotosLoading] = useState(true)

  // Scroll-to-top on mount — BrowserRouter doesn't reset scroll on push, so without this the
  // page opens mid-scroll when tapped from far down a list.
  useEffect(() => { window.scrollTo(0, 0) }, [])

  // Load the planting record. 404 (or ownership mismatch) → friendly not-found, not a thrown error.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    fetch('/api/plants/' + plantingId)
      .then(data => {
        if (cancelled) return
        // Ownership guard: the URL's project segment must match the planting's real project.
        // A hand-edited /projects/<other>/plantings/<id> resolves the planting but to the wrong
        // project → treat as not-found (404 semantics, NOT 403 — don't leak existence).
        if (!data || (projectId && data.project_id && data.project_id !== projectId)) {
          setNotFound(true)
          setLoading(false)
          return
        }
        setPlanting(data)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        // The by-id endpoint 404s when the id isn't in the household → friendly not-found.
        if (err?.status === 404) setNotFound(true)
        else setError(err?.message || 'Failed to load this planting.')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [plantingId, projectId, fetch])

  // Telemetry: fire OPEN_PLANTING once the planting actually resolves (the page truly opened).
  const reachedRef = useRef(false)
  useEffect(() => {
    if (planting && !reachedRef.current) {
      reachedRef.current = true
      ux.step(0, 'opened', { planting_id: planting.id, project_id: planting.project_id })
    }
  }, [planting])  // eslint-disable-line react-hooks/exhaustive-deps

  // Planting-scoped event log via the HS-2 server filter. Only fetch once we have a confirmed,
  // owned planting (so a wrong-project URL never fires a misleading events query).
  useEffect(() => {
    if (!planting) return
    let cancelled = false
    setEventsLoading(true)
    setEventsError(null)
    fetch(`/api/events?project_id=${planting.project_id}&plant_id=${planting.id}`)
      .then(data => {
        if (cancelled) return
        setEvents(data ?? [])
        setEventsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // Friendly fixed copy — don't leak raw fetch errors into the grower-facing log.
        setEventsError("Couldn't load this planting's events.")
        setEventsLoading(false)
      })
    return () => { cancelled = true }
  }, [planting, fetch])

  // Planting photos (V1 display-only). Once the planting is owned, read the project's photos and
  // keep those linked to THIS planting (directly via plant_id, or through one of its events).
  useEffect(() => {
    if (!planting) return
    let cancelled = false
    setPhotosLoading(true)
    Promise.resolve(fetch(`/api/photos?project_id=${planting.project_id}`))
      .then(data => {
        if (cancelled) return
        const evIds = new Set((events || []).map(e => e.id))
        const seen = new Set()
        const mine = (data ?? [])
          .filter(p => p.plant_id === planting.id || (p.event_id && evIds.has(p.event_id)))
          .filter(p => (seen.has(p.id) ? false : seen.add(p.id)))
        mine.sort((a, b) => String(b.created_at || b.taken_at || '').localeCompare(String(a.created_at || a.taken_at || '')))
        setPhotos(mine)
        setPhotosLoading(false)
      })
      .catch(() => { if (!cancelled) { setPhotos([]); setPhotosLoading(false) } })
    return () => { cancelled = true }
  }, [planting, events, fetch])

  // ── State 1: loading ──────────────────────────────────────────────────────────────────────
  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>

  // ── State 3: 404 / not found / ownership mismatch ──────────────────────────────────────────
  if (notFound) {
    return (
      <Shell>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Planting', href: null }]} />
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ fontSize: '2.4rem', marginBottom: 10 }}>🪴</div>
          <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
            Planting not found
          </p>
          <p style={{ margin: '0 0 20px', color: P.light, fontSize: '0.88rem' }}>
            This planting no longer exists, or it isn’t part of this project.
          </p>
          <Link to={projectId ? `/projects/${projectId}` : '/garden'} style={btnLink}>
            Back to {projectId ? 'project' : 'garden'}
          </Link>
        </div>
      </Shell>
    )
  }

  // ── State 2: fetch-error (loaded but failed) ───────────────────────────────────────────────
  if (error) {
    return (
      <Shell>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Planting', href: null }]} />
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px' }}>
          <p style={{ margin: '0 0 16px', color: P.terra, fontSize: '0.9rem' }}>{error}</p>
          <Link to={projectId ? `/projects/${projectId}` : '/garden'} style={btnLink}>
            Back to {projectId ? 'project' : 'garden'}
          </Link>
        </div>
      </Shell>
    )
  }

  if (!planting) return null

  const pl = planting
  const variety = pl.variety_ref?.name
  // First-harvest date: prefer a stored field, else derive from the event log (first_harvest,
  // then any harvest). Events are ORDER BY event_date DESC, so the LAST matching row is earliest.
  const firstHarvestStored = pl.first_harvest_at ?? null
  const firstHarvestEvent = !firstHarvestStored ? deriveFirstHarvest(events) : null
  const firstHarvest = firstHarvestStored ?? firstHarvestEvent

  // Grower / lifecycle fields — all null-tolerant; only rows with a value render.
  const detailRows = [
    ['Variety', variety],
    ['Species', pl.variety_ref?.species],
    ['Location', pl.location_path ? `📍 ${pl.location_path}` : null],
    ['Quantity', pl.quantity > 1 ? `×${formatQty(pl.quantity)}` : null],
    ['Started with', pl.qty_initial && pl.qty_initial !== pl.quantity ? `×${formatQty(pl.qty_initial)}` : null],
    ['Sown', fmtDate(pl.sown_at) ? `${fmtDate(pl.sown_at)}${pl.sown_at_approx ? ' (approx.)' : ''}` : null],
    ['Transplanted', fmtDate(pl.transplanted_at) ? `${fmtDate(pl.transplanted_at)}${pl.transplanted_at_approx ? ' (approx.)' : ''}` : null],
    ['First harvest', fmtDate(firstHarvest)],
    ['Source', PLANT_SOURCE_LABELS[pl.source_type] ?? (pl.source_type || null)],
    ['Source ref', pl.source_ref],
    ['Generation', pl.source_generation],
    ['Source planting', pl.parent_plant_id && pl.parent_plant_name
      ? <Link to={`/projects/${pl.parent_project_id}/plantings/${pl.parent_plant_id}`} style={{ color: P.green, textDecoration: 'none' }}>{pl.parent_plant_name} ›</Link>
      : null],
    ['Lineage', pl.lineage_note],
    ['Notes', pl.notes],
  ].filter(([, v]) => v)

  return (
    <Shell>
      <Breadcrumb
        path={[
          { label: 'Home', href: '/dashboard' },
          { label: pl.project_name || 'Project', href: projectId ? `/projects/${projectId}` : null },
          { label: pl.name || 'Planting', href: null },
        ]}
      />

      {/* Header — status reachable without scrolling, multi-channel. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 22 }}>
        {pl.featured_photo_view_url
          ? <ZoomableImage src={pl.featured_photo_view_url} alt={`${pl.name || 'Planting'} photo`} loading="lazy"
              style={{ width: 64, height: 64, borderRadius: 10, objectFit: 'cover', flexShrink: 0, border: `1px solid ${P.border}` }} />
          : <span aria-hidden="true" style={{ width: 64, height: 64, flexShrink: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem', backgroundColor: P.greenPale, borderRadius: 10 }}>🌱</span>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{ margin: '0 0 8px', color: P.green, fontSize: '1.4rem', fontWeight: 700, wordBreak: 'break-word' }}>
            {pl.name || 'Planting'}
          </h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {pl.status && <PlantStatusBadge status={pl.status} size="lg" />}
            {pl.quantity > 1 && (
              <span style={{ fontSize: '0.82rem', color: P.green, fontWeight: 600 }}>×{formatQty(pl.quantity)}</span>
            )}
            {variety && <span style={{ fontSize: '0.85rem', color: P.mid }}>{variety}</span>}
          </div>
        </div>
        {/* Actions: Log event (V3-LOG-001) + Edit (V3-EDIT-001), stacked. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, alignSelf: 'flex-start' }}>
          <Link
            to={`/log?project=${pl.project_id}&plant=${pl.id}`}
            aria-label="Log an event for this planting"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              backgroundColor: P.green, color: P.white,
              border: `1px solid ${P.green}`, borderRadius: 8,
              padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
              textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >
            📝 Log event
          </Link>
          {/* V3-FAV-001: favorite this planting (entity_type=plant = garden_node id). Ambient star,
              no interrupt — Reward-UX compliant. Sits before the Edit affordance in the header. */}
          <FavoriteToggle entityType="plant" entityId={pl.id} size="1.4rem" />
          {/* V3-EDIT-001: edit affordance — deep-links to the Garden PlantingEditor for this planting. */}
          <Link
            to={`/garden?edit=${plantingId}`}
            aria-label="Edit this planting"
            style={{
              flexShrink: 0, alignSelf: 'flex-start',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              backgroundColor: P.white, color: P.green,
              border: `1px solid ${P.greenLight}`, borderRadius: 8,
              padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
              textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >
            ✏️ Edit
          </Link>
        </div>
      </div>

      {/* ── Details ───────────────────────────────────────────────────────────────────────── */}
      <SectionHeader>Details</SectionHeader>
      <div style={cardStyle}>
        {detailRows.length === 0 ? (
          <p style={{ margin: 0, color: P.light, fontSize: '0.88rem' }}>No additional details recorded yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {detailRows.map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {label}
                </div>
                <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5, wordBreak: 'break-word' }}>{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Photos (V3-PHOTOMULTI-001 V1: every photo for this planting, display-only) ── */}
      {(photosLoading || photos.length > 0) && (
        <>
          <SectionHeader>
            Photos
            {!photosLoading && photos.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({photos.length})</span>
            )}
          </SectionHeader>
          <div style={cardStyle}>
            {photosLoading ? (
              <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading photos…</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
                {photos.map(ph => (
                  <figure key={ph.id} style={{ margin: 0 }}>
                    <ZoomableImage
                      src={ph.view_url}
                      alt={ph.caption || `${pl.name || 'Planting'} photo`}
                      loading="lazy"
                      style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, border: `1px solid ${P.border}`, display: 'block' }}
                    />
                    {ph.caption && (
                      <figcaption style={{ marginTop: 4, fontSize: '0.72rem', color: P.light, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {ph.caption}
                      </figcaption>
                    )}
                  </figure>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Event log (planting-scoped, HS-2) ─────────────────────────────────────────────── */}
      <SectionHeader>
        Event log
        {!eventsLoading && !eventsError && events.length > 0 && (
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({events.length})</span>
        )}
      </SectionHeader>
      <div style={cardStyle}>
        {eventsLoading ? (
          <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading events…</div>
        ) : eventsError ? (
          <div style={{ padding: '8px 0', color: P.terra, fontSize: '0.875rem' }}>{eventsError}</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>
            No events logged for this planting yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {events.map(ev => (
              <Link
                key={ev.id}
                to={`/projects/${pl.project_id}/events/${ev.id}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: 12, alignItems: 'flex-start' }}
              >
                <span aria-hidden="true" style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  backgroundColor: P.cream, border: `1px solid ${P.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem',
                }}>
                  {EVENT_TYPE_META[ev.event_type]?.emoji ?? '📝'}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>
                    {ev.title || (ev.event_type || '').replace(/_/g, ' ')}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 1 }}>
                    {fmtDate(ev.event_date) ?? ''}
                  </div>
                  {ev.notes && (
                    <p style={{ margin: '4px 0 0', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5 }}>{ev.notes}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Shell>
  )
}

// Derive the earliest harvest from a DESC-ordered event list: prefer a first_harvest event,
// else the earliest 'harvest'. Returns an event_date string or null.
function deriveFirstHarvest(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const firsts = events.filter(e => e.event_type === 'first_harvest')
  const pool = firsts.length ? firsts : events.filter(e => e.event_type === 'harvest')
  if (!pool.length) return null
  // Events arrive DESC by event_date; the last element is the earliest.
  return pool[pool.length - 1].event_date ?? null
}

// Sticky section header — jump affordance for the flat single-column layout. Sticks under the
// app TopBar (52px) so the user always sees which section they're scrolling within.
function SectionHeader({ children }) {
  return (
    <h2 style={{
      position: 'sticky', top: 52, zIndex: 2,
      margin: '24px 0 12px', padding: '6px 0',
      fontSize: '0.95rem', fontWeight: 700, color: P.dark,
      backgroundColor: P.cream,
    }}>
      {children}
    </h2>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}

const cardStyle = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24 }
const btnLink = { backgroundColor: P.green, color: P.white, textDecoration: 'none', borderRadius: 6, padding: '9px 18px', fontSize: '0.88rem', fontWeight: 600, display: 'inline-block' }
