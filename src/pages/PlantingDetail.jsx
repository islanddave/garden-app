// PlantingDetail — V3-NAV-001 (Lane C / PR2). The dedicated detail page for a single planting.
// Route: /projects/:id/plantings/:plantingId  (matches the /projects/:id/... family; :id is the
// project, :plantingId the planting). Static-imported + route-ErrorBoundary-wrapped in App.jsx,
// mirroring EventDetail (the app uses no React.lazy).
//
// Data: GET /api/plants/:plantingId returns the full enriched record (variety_ref, status,
// sown_at, transplanted_at, qty_*, source_*/lineage_note, project_id, project_name,
// featured_photo_view_url, next_water_at/last_watered_at/watering_interval_days). Planting-scoped
// event log: GET /api/events?project_id=:id&plant_id=:plantingId — the HS-2 server-side filter.
//
// V200 Slice 5b: the header is now a full-bleed photo HERO (HeroPhoto) carrying the planting name
// (rendered AS the page <h1>), lifecycle status, a gold key-fact pill, and a Details pill that
// opens a tabbed Details fly-up (Basics/Care/More). The old flat "Details" card is GONE — its
// rows live in the fly-up. A GrowthStrip narrates the plant's photo timeline; the Photos grid and
// the hero both open the shared Lightbox gallery.
//
// A11y: status is multi-channel (icon + label + color via PlantStatusBadge, never color alone);
// sticky section headers give a jump anchor for the flat single-column layout; scroll-to-top on
// mount (BrowserRouter doesn't reset scroll on push); breadcrumb is arbitrary-depth.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { resolvePager, resolveSwipe } from '../lib/plantingSequence.js'
import AssigneePicker from '../components/AssigneePicker.jsx'
import { P } from '../lib/constants.js'
import Icon from '../components/Icon.jsx'
import { formatQty } from '../lib/format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import Lightbox from '../components/Lightbox.jsx'
import { useOptionalToast } from '../context/ToastContext.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { PLANT_SOURCE_LABELS , PLANT_CONTAINER_TYPE_LABELS } from '../lib/dropdownRegistry.js'
import HeroPhoto from '../components/planting/HeroPhoto.jsx'
import QuickActions from '../components/planting/QuickActions.jsx'
import LifeStoryTimeline from '../components/planting/LifeStoryTimeline.jsx'
import CropCard from '../components/planting/CropCard.jsx'
import CareStatus from '../components/CareStatus.jsx'
import GrowthStrip from '../components/planting/GrowthStrip.jsx'
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import HarvestFromPlanting from '../components/planting/HarvestFromPlanting.jsx'
import { formatBotanical } from '../lib/keyFact.js'
import { buildLifeStory } from '../lib/lifeStory.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'



function fmtDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function PlantingDetail() {
  const { id: projectId, plantingId } = useParams()
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const [savingFeatured, setSavingFeatured] = useState(null)  // V4-PHOTOFEATURE-001: photo id in flight
  const ux = useUxFlow(FLOWS.OPEN_PLANTING)
  const navigate = useNavigate()
  // PLANTING-PAGER refs: commit-lock (ignore paging until the target settles), a deferred
  // focus-move to the pager after a paged planting loads, the pager DOM node, and swipe start.
  const navLockRef = useRef(false)
  const pendingFocusRef = useRef(false)
  const pagerRef = useRef(null)
  const swipeRef = useRef(null)

  const [planting, setPlanting] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [unarchiving, setUnarchiving] = useState(false)  // V3-ARCHIVE-001: planting restore path
  const [refreshKey, setRefreshKey] = useState(0)  // V4-PLANTINGUI-001: bump to refetch events after a quick-log

  // V200 Slice 5b — Details fly-up (tabbed) + Lightbox gallery state.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [tab, setTab] = useState('basics')
  const [lightboxIndex, setLightboxIndex] = useState(null)  // null = closed

  // Event log has its OWN lifecycle (DoD: don't conflate filtered-empty with failed-load).
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState(null)

  // V3-PHOTOMULTI-001 (V1, display-only): every photo linked to THIS planting — uploaded directly
  // (plant_id) or attached to one of its events (event_id). No backend/migration: read the
  // project's photos (same source as the Photo Library) and filter client-side.
  const [photos, setPhotos] = useState([])
  const [photosLoading, setPhotosLoading] = useState(true)

  // Scroll-to-top on open AND on every paging change. PlantingDetail does NOT remount when only
  // the :plantingId param changes (same <Route element>), so this MUST key on plantingId — a
  // mount-only effect would leave a paged planting scrolled to the previous offset.
  useEffect(() => { window.scrollTo(0, 0) }, [plantingId])

  // PLANTING-PAGER navigation — history REPLACE so Back returns to the originating Garden list
  // instead of replaying every paged step. Commit-locked (navLockRef) until the target loads.
  const go = useCallback((href) => {
    if (!href || navLockRef.current) return
    navLockRef.current = true
    pendingFocusRef.current = true
    navigate(href, { replace: true })
  }, [navigate])

  // Release the commit-lock + move focus to the pager once a paged-to planting has loaded. Keyed
  // on `loading` (the fetch effect flips it) so the lock spans the whole load, not just the nav.
  useEffect(() => {
    if (loading) return
    navLockRef.current = false
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false
      try { pagerRef.current?.focus() } catch { /* jsdom / detached node */ }
    }
  }, [loading, plantingId])

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
    // V4-UNSCOPEDROUTES-001: project_id omitted when the planting has none (CaptureFlow rows) —
    // a literal "project_id=null" param would silently match nothing.
    fetch(planting.project_id
      ? `/api/events?project_id=${planting.project_id}&plant_id=${planting.id}`
      : `/api/events?plant_id=${planting.id}`)
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
  }, [planting, fetch, refreshKey])

  // Planting photos (V1 display-only). V4-PHOTOGALLERY-001: the gallery shows every photo ATTACHED to
  // this planting — directly via plant_id, OR through one of its events — no matter which container the
  // photo lives in. The photos Lambda's ?attachedTo=<plantingId> resolves that union server-side (one
  // canonical predicate), so a plant_id-attached photo in a parent/sibling container now appears; the
  // old ?project_id fetch only saw photos in the planting's OWN container and hid the rest. Exclusion of
  // other plantings' photos is now the server's job (WHERE-scoped), so the client just de-dups + sorts.
  // `events` stays in deps as a freshness trigger: logging a new event-photo re-fetches the attached set.
  useEffect(() => {
    if (!planting) return
    let cancelled = false
    setPhotosLoading(true)
    Promise.resolve(fetch(`/api/photos?attachedTo=${planting.id}`))
      .then(data => {
        if (cancelled) return
        const seen = new Set()
        const mine = (data ?? [])
          .filter(p => (seen.has(p.id) ? false : seen.add(p.id)))
        mine.sort((a, b) => String(b.created_at || b.taken_at || '').localeCompare(String(a.created_at || a.taken_at || '')))
        setPhotos(mine)
        setPhotosLoading(false)
      })
      .catch(() => { if (!cancelled) { setPhotos([]); setPhotosLoading(false) } })
    return () => { cancelled = true }
  }, [planting, events, fetch])

  // ── Planting pager (group-bounded prev/next) ───────────────────────────────────────────────
  // Sequence is captured on tap in Garden and read here from a module singleton. null when there
  // is no in-session sequence, <2 items, or this planting isn't in it → no pager, gestures/keys
  // inert. resolvePager only needs plantingId, so it's safe above the load/404 guards.
  const pager = resolvePager(plantingId)
  const prevHref = pager?.prevHref
  const nextHref = pager?.nextHref
  const pagerActive = !!pager && lightboxIndex == null && !detailsOpen && !notFound && !error

  // Keyboard fallback: ArrowLeft/ArrowRight page prev/next. Suppressed while a modal (Lightbox /
  // Details sheet) is open, or focus is in an editable / radiogroup control, so it never hijacks
  // the Lightbox's own arrow keys (Lightbox binds document keydown) or the Details tab radiogroup.
  useEffect(() => {
    if (!pagerActive) return
    function onKey(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      if (t?.closest?.('[role="radiogroup"]')) return
      e.preventDefault()
      go(e.key === 'ArrowLeft' ? prevHref : nextHref)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pagerActive, prevHref, nextHref, go])

  // ── State 1: loading ──────────────────────────────────────────────────────────────────────
  if (loading) return <Shell><div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div></Shell>

  // ── State 3: 404 / not found / ownership mismatch ──────────────────────────────────────────
  if (notFound) {
    return (
      <Shell>
        <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: 'Planting', href: null }]} />
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
            <Icon name="lifecycle.sprout" size={40} decorative style={{ color: P.greenLight }} />
          </div>
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

  // V3-ARCHIVE-001: restore an archived planting. Plantings were archivable only from the Garden row
  // (with a 6s Undo); after that window an archived planting was hidden everywhere with no restore path.
  // Mirror ProjectDetail: an Archived badge + Unarchive here make a by-id-reachable archived planting recoverable.
  async function handleUnarchive() {
    setUnarchiving(true)
    try {
      const res = await fetch('/api/plants/' + plantingId + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: false }) })
      setPlanting(prev => ({ ...prev, archived_at: res?.archived_at ?? null }))
    } catch (err) {
      console.error('unarchive failed', err)
    } finally {
      setUnarchiving(false)
    }
  }

  const pl = planting
  const name = pl.name || 'Planting'
  const variety = pl.variety_ref?.name
  // First-harvest date: prefer a stored field, else derive from the event log (first_harvest,
  // then any harvest). Events are ORDER BY event_date DESC, so the LAST matching row is earliest.
  const firstHarvestStored = pl.first_harvest_at ?? null
  const firstHarvestEvent = !firstHarvestStored ? deriveFirstHarvest(events) : null
  const firstHarvest = firstHarvestStored ?? firstHarvestEvent
  const botanical = formatBotanical(pl.variety_ref)

  // V4-PHOTOFEATURE-001 — swap the planting's featured (profile) photo. Backend validates the
  // photo is linked to this plant (plants PUT / V2-PHOTO-F1).
  async function setFeatured(ph) {
    if (!ph?.id || savingFeatured || ph.id === planting?.featured_photo_id) return
    setSavingFeatured(ph.id)
    try {
      const updated = await fetch('/api/plants/' + plantingId, {
        method: 'PUT', body: JSON.stringify({ featured_photo_id: ph.id }),
      })
      setPlanting(prev => ({ ...prev, featured_photo_id: updated?.featured_photo_id ?? ph.id, featured_photo_view_url: ph.view_url }))
      toast?.show?.({ message: 'Featured photo updated', tone: 'success' })
    } catch {
      toast?.show?.({ message: "Couldn't set featured photo", tone: 'error' })
    } finally {
      setSavingFeatured(null)
    }
  }

  // ── Gallery: one shared image list for the hero + Photos grid + GrowthStrip. The featured
  // hero photo is index 0 (unshifted if not already represented in the photo set). ──────────
  const galleryFromPhotos = photos.map(p => ({ src: p.view_url, view_url: p.view_url, id: p.id, alt: p.caption || name, caption: p.caption }))
  const featuredUrl = pl.featured_photo_view_url
  const featuredInSet = pl.featured_photo_id != null && photos.some(p => p.id === pl.featured_photo_id)
  const galleryImages = featuredUrl && !featuredInSet
    ? [{ src: featuredUrl, view_url: featuredUrl, id: pl.featured_photo_id, alt: `${name} photo`, caption: null }, ...galleryFromPhotos]
    : galleryFromPhotos
  // Map a `photos[]` entry to its index inside galleryImages (offset by the unshifted hero).
  const photoIndexOffset = (featuredUrl && !featuredInSet) ? 1 : 0
  // GrowthStrip wants OLDEST-first; photos[] is newest-first, so reverse a shallow copy and
  // carry each photo's gallery index along for thumb -> Lightbox open.
  const growthPhotos = photos
    .map((p, i) => ({ ...p, galleryIndex: i + photoIndexOffset }))
    .slice()
    .reverse()

  // ── Tabbed Details rows (moved out of the old flat card into the fly-up). Each row is
  // [label, value]; only rows with a value render. Per-tab empty -> "Nothing recorded yet.";
  // whole-set empty -> the legacy "No additional details recorded yet." copy. ───────────────
  const basicsRows = [
    ['Variety', variety],
    ['Botanical', botanical ? (botanical.italic ? <i>{botanical.text}</i> : botanical.text) : null],
    ['Location', pl.location_path
      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="facet.location" size={15} decorative style={{ color: P.light }} />{pl.location_path}
        </span>
      : null],
    ['Quantity', pl.quantity > 1 ? `×${formatQty(pl.quantity)}` : null],
    ['Started with', pl.qty_initial && pl.qty_initial !== pl.quantity ? `×${formatQty(pl.qty_initial)}` : null],
    ['Sown', fmtDate(pl.sown_at) ? `${fmtDate(pl.sown_at)}${pl.sown_at_approx ? ' (approx.)' : ''}` : null],
    ['Transplanted', fmtDate(pl.transplanted_at) ? `${fmtDate(pl.transplanted_at)}${pl.transplanted_at_approx ? ' (approx.)' : ''}` : null],
    ['Source', PLANT_SOURCE_LABELS[pl.source_type] ?? (pl.source_type || null)],
    ['Pot / bag', pl.container_type ? (PLANT_CONTAINER_TYPE_LABELS[pl.container_type] ?? pl.container_type) : null],
    ['Pot size', pl.container_size || null],
  ].filter(([, v]) => v)

  const careRows = [
    ['Next watering', renderNextWatering(pl)],
    ['Last watered', fmtDate(pl.last_watered_at)],
    ['Watering interval', Number.isFinite(pl.watering_interval_days) ? `Every ${pl.watering_interval_days} day${pl.watering_interval_days === 1 ? '' : 's'}` : null],
    ['Light', pl.variety_ref?.sun_requirements || null],
    ['Care notes', pl.care_notes || null],
    ['Soil notes', pl.soil_notes || null],
  ].filter(([, v]) => v)

  const moreRows = [
    ['Source ref', pl.source_ref],
    ['Generation', pl.source_generation],
    ['Source planting', pl.parent_plant_id && pl.parent_plant_name
      ? <Link to={`/plantings/${pl.parent_plant_id}`} style={{ color: P.green, textDecoration: 'none' }}>{pl.parent_plant_name} ›</Link>
      : null],
    ['Lineage', pl.lineage_note],
    ['Notes', pl.notes],
    ['First harvest', fmtDate(firstHarvest)],
  ].filter(([, v]) => v)

  const tabsEmpty = basicsRows.length === 0 && careRows.length === 0 && moreRows.length === 0
  const activeRows = tab === 'basics' ? basicsRows : tab === 'care' ? careRows : moreRows
  const tabLabel = tab === 'basics' ? 'Basics' : tab === 'care' ? 'Care' : 'More'

  // PLANTING-PAGER swipe (Pointer Events only — iOS Safari ≥13 / Chrome Android both support them;
  // gated to pointerType 'touch' so a desktop mouse-drag never pages). touch-action:pan-y on the
  // wrapper hands vertical scroll to the compositor and keeps horizontal pointermove flowing.
  function onPointerDown(e) {
    if (e.pointerType !== 'touch' || !pagerActive) { swipeRef.current = null; return }
    if (e.target?.closest?.('[data-hscroll]')) { swipeRef.current = null; return } // let hscrollers own it
    swipeRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX }
  }
  function onPointerUp(e) {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s || e.pointerType !== 'touch' || !pagerActive) return
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0
    const dir = resolveSwipe(e.clientX - s.x, e.clientY - s.y, s.startX, vw)
    if (dir === 'next') go(nextHref)
    else if (dir === 'prev') go(prevHref)
  }
  function onPointerCancel() { swipeRef.current = null }

  return (
    <Shell>
      <div
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ touchAction: 'pan-y', overscrollBehaviorX: 'contain' }}
      >
      {/* SR-only live announcement of the current planting + position — SPA route changes are
          otherwise silent to screen readers. */}
      <div role="status" aria-live="polite" style={srOnly}>
        {pager ? `${name}, ${pager.index + 1} of ${pager.total}` : ''}
      </div>
      {/* PLANTING-PAGER — group-bounded prev/next. Swipe is primary (wrapper above); these
          always-visible buttons + the N/M · group label are the discoverable fallback and the
          keyboard/desktop path. Rendered only when a Garden group sequence was captured on tap. */}
      {pager && (
        <nav aria-label="Planting pager" style={pagerBar}>
          <button type="button" onClick={() => go(prevHref)} aria-label="Previous planting" style={pagerBtn}>‹</button>
          <div ref={pagerRef} tabIndex={-1} style={pagerLabel}>
            <span style={{ fontWeight: 700 }}>{pager.index + 1} / {pager.total}</span>
            {pager.ctxLabel && <span style={{ color: P.light, marginLeft: 8 }}>{pager.ctxLabel}</span>}
          </div>
          <button type="button" onClick={() => go(nextHref)} aria-label="Next planting" style={pagerBtn}>›</button>
        </nav>
      )}
      <Breadcrumb
        path={[
          { label: 'Home', href: '/dashboard' },
          // V4-UNSCOPEDROUTES-001: record-sourced (the canonical route has no project param).
          // V4-PROJHIDE-001: drop the project crumb entirely when projects aren't user-facing. Flag OFF
          // spreads the one-element array back in, so the path is byte-identical.
          ...(PROJECTS_HIDDEN ? [] : [{ label: pl.project_name || 'Project', href: pl.project_id ? `/projects/${pl.project_id}` : null }]),
          { label: name, href: null },
        ]}
      />

      {/* V200 Slice 5b — full-bleed photo hero (carries the page <h1>, status, key-fact + Details pill). */}
      <HeroPhoto
        planting={pl}
        src={pl.featured_photo_view_url}
        photoId={pl.featured_photo_id}
        alt={`${name} photo`}
        onOpenLightbox={(i) => setLightboxIndex(i ?? 0)}
        onOpenDetails={() => { setTab('basics'); setDetailsOpen(true) }}
        onStatusChanged={(status) => setPlanting(prev => ({ ...prev, status }))}
      />

      {/* Secondary affordances row — Edit + (archived) Unarchive. Primary name/status live ON the
          hero; the Favorite is the single hero heart now (dup removed), and the caretaker control
          moved below the Event log. Row margin tightened since it usually carries only Edit. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
        flexWrap: 'wrap', margin: '10px 0 14px' }}>
        {pl.archived_at && (
          <span style={{ backgroundColor: P.greenPale, color: P.green, border: `1px solid ${P.greenLight}`, fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600, marginRight: 'auto' }}>
            Archived
          </span>
        )}
        {pl.archived_at && (
          <button onClick={handleUnarchive} disabled={unarchiving} aria-label="Unarchive this planting"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: P.white, color: P.green,
              border: `1px solid ${P.greenLight}`, borderRadius: 8, padding: '8px 14px', fontSize: '0.85rem',
              fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Icon name="action.archive" size={16} decorative style={{ color: P.green }} />
            {unarchiving ? 'Working…' : 'Unarchive'}
          </button>
        )}
        {/* V3-EDIT-001: edit affordance — deep-links to the Garden PlantingEditor for this planting. */}
        <Link
          to={`/garden?edit=${plantingId}`}
          aria-label="Edit this planting"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            backgroundColor: P.white, color: P.green,
            border: `1px solid ${P.greenLight}`, borderRadius: 8,
            padding: '8px 14px', fontSize: '0.85rem', fontWeight: 600,
            textDecoration: 'none', whiteSpace: 'nowrap',
          }}
        >
          <Icon name="action.edit" size={16} decorative style={{ color: P.green }} />
          Edit
        </Link>
      </div>

      {/* Slice 5a — live care band: renders only when this planting needs water (calm → null). */}
      <CareStatus nextWaterAt={pl.next_water_at} locationType={pl.location_type} />

      {/* V4-PLANTINGUI-001 — primary quick-actions: water / photo. (V4-STATUSTAP-001: status
          moved to the hero StatusPicker.) */}
      <QuickActions
        planting={pl}
        onLogged={(ev) => {
          setRefreshKey(k => k + 1)
          // Optimistic field updates so the UI reacts before the next full record load; the reload
          // then restores engine-computed values. Preserves all other fields.
          //  • watering/rain → clear next_water_at (care band goes calm; avoids a refetch race)
          //  • germination (CAL-2) → stamp germinated_at so the "It sprouted!" quick-action hides
          //    and the Life-story 🌱 milestone lights up immediately.
          setPlanting(prev => {
            if (!prev) return prev
            const type = ev?.event_type
            const next = { ...prev }
            if (type === 'watering' || type === 'rain') next.next_water_at = null
            if (type === 'germination' && !prev.germinated_at) {
              next.germinated_at = ev?.event_date ?? new Date().toISOString()
              next.germinated_at_approx = false
            }
            return next
          })
        }}
      />

      {/* V4-PLANTINGUI-001 — per-crop slot: maturity/harvest + cultivar attrs + projected facets. */}
      <CropCard planting={pl} />

      {/* V4-PLANTINGUI-001 — life-story milestone spine (lifecycle arc; full Event log remains below). */}
      {buildLifeStory(pl).length > 0 && (
        <>
          <SectionHeader>Life story</SectionHeader>
          <div style={cardStyle}>
            <LifeStoryTimeline planting={pl} />
          </div>
        </>
      )}

      {/* ── Growth (V200 Slice 5b — before/after compare + time-lapse over the photo timeline) ── */}
      {(photosLoading || photos.length > 0) && (
        <>
          <SectionHeader>Growth</SectionHeader>
          <div style={cardStyle}>
            {photosLoading ? (
              <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading photos…</div>
            ) : (
              <GrowthStrip
                photos={growthPhotos}
                onOpen={(idx) => setLightboxIndex(idx)}
                indexBase={growthPhotos[0]?.galleryIndex ?? 0}
              />
            )}
          </div>
        </>
      )}

      {/* ── Harvested (V4-HARVESTQTY-001) — the near end of the spine, immediately upstream of Put
          up: how much actually came off this planting, recent + cumulative. Renders
          UNCONDITIONALLY for the same reason Put up does — "nothing yet" on a planting you are
          looking at is itself the answer, and hiding it would make the section appear only after a
          harvest exists, which reads as a bug. Self-fetches; does not widen /api/plants/:id. ── */}
      <SectionHeader>Harvested</SectionHeader>
      <div style={cardStyle}>
        <HarvestFromPlanting planting={pl} fetch={fetch} />
        {/* V4-HARVESTVIEW-001 S4b: crop-filtered jump to the Harvests page (design §2.3). Shown only
            when the crop key resolves, since the destination is filtered by crop_type_slug. */}
        {pl.variety_ref?.crop_type_slug && (
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Link to={`/harvests?crop=${encodeURIComponent(pl.variety_ref.crop_type_slug)}`} style={{ color: P.green, textDecoration: 'none', fontSize: '0.82rem', fontWeight: 700 }}>
              All harvests →
            </Link>
          </div>
        )}
      </div>

      {/* ── Put up (V4-PUTUPLINK-001) — the far end of the spine: what this planting yielded that is
          still in the stores. Renders UNCONDITIONALLY (unlike Growth/Photos, which hide when empty):
          the empty state carries the "log a put-up from this planting" affordance, which is exactly
          the moment worth prompting — you are looking at the planting you just picked from. ── */}
      <SectionHeader>Put up</SectionHeader>
      <div style={cardStyle}>
        <PutUpFromPlanting planting={pl} fetch={fetch} />
      </div>

      {/* ── Photos (V3-PHOTOMULTI-001 V1: every photo for this planting; tap -> Lightbox gallery) ── */}
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
                {photos.map((ph, i) => (
                  <figure key={ph.id} style={{ margin: 0 }}>
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(i + photoIndexOffset)}
                      aria-label={`Open ${ph.caption || `${name} photo`}`}
                      style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    >
                      <img
                        src={ph.view_url}
                        alt={ph.caption || `${name} photo`}
                        style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, border: `1px solid ${P.border}`, display: 'block' }}
                      />
                    </button>
                    {ph.caption && (
                      <figcaption style={{ marginTop: 4, fontSize: '0.72rem', color: P.light, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {ph.caption}
                      </figcaption>
                    )}
                    {ph.id === planting?.featured_photo_id ? (
                      <div style={{ marginTop: 4, fontSize: '0.7rem', fontWeight: 700, color: P.gold }}>★ Featured</div>
                    ) : (
                      <button type="button" onClick={() => setFeatured(ph)} disabled={savingFeatured != null}
                        style={{ marginTop: 4, fontSize: '0.7rem', fontWeight: 600, color: P.green, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
                        {savingFeatured === ph.id ? 'Setting…' : 'Set as featured'}
                      </button>
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
                to={`/events/${ev.id}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: 12, alignItems: 'flex-start' }}
              >
                <span aria-hidden="true" style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  backgroundColor: P.cream, border: `1px solid ${P.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem',
                }}>
                  <Icon name={`event.${ev.event_type}`} size={18} decorative style={{ color: P.green }} />
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

      {/* PLANT-ASSIGN-001: per-planting caretaker override, relocated below the Event log (Dave:
          rarely-changed control doesn't need top billing — "set it right there"). Sticky
          SectionHeader gives the flat layout a jump-anchor so it stays discoverable below a long log. */}
      <SectionHeader>Caretaker</SectionHeader>
      <div style={cardStyle}>
        {/* V4-PROJHIDE-001: the inherit label references the project — use a project-neutral label when
            projects aren't user-facing (the underlying inheritance is unchanged). Flag OFF is unchanged. */}
        <AssigneePicker entityType="plant" entityId={pl.id} value={pl.assignee_user_id ?? null} onChanged={(v) => setPlanting(prev => ({ ...prev, assignee_user_id: v }))} inheritLabel={PROJECTS_HIDDEN ? 'Inherits the default caretaker' : (pl.project_name ? `Inherits project: ${pl.project_name}` : 'Inherits the project caretaker')} />
      </div>

      {/* ── V200 Slice 5b — tabbed Details fly-up (Basics / Care / More). The Sheet owns the
          dialog contract (role=dialog/aria-modal/focus-trap+restore/Esc). ──────────────────── */}
      <Sheet open={detailsOpen} title="Details" onClose={() => setDetailsOpen(false)}>
        <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SegmentedControl
            options={[
              { value: 'basics', label: 'Basics' },
              { value: 'care', label: 'Care' },
              { value: 'more', label: 'More' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Detail sections"
          />
          <div role="group" aria-label={tabLabel}>
            {tabsEmpty ? (
              <p style={{ margin: 0, color: P.light, fontSize: '0.88rem' }}>No additional details recorded yet.</p>
            ) : activeRows.length === 0 ? (
              <p style={{ margin: 0, color: P.light, fontSize: '0.88rem' }}>Nothing recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {activeRows.map(([label, value]) => (
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
        </div>
      </Sheet>

      {/* V4-THEME-001 — shared Lightbox gallery (hero + Photos grid + GrowthStrip thumbs feed it). */}
      <Lightbox
        open={lightboxIndex != null}
        images={galleryImages}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onSetFeatured={setFeatured}
        featuredId={pl.featured_photo_id}
      />
      </div>
    </Shell>
  )
}

// Render the "Next watering" cell for the Care tab: formatted date + an "Overdue" marker when
// the schedule is in the past. Returns null when there is no scheduled watering.
function renderNextWatering(pl) {
  const next = pl?.next_water_at
  if (!next) return null
  const label = fmtDate(next)
  if (!label) return null
  const overdue = new Date(next).getTime() < Date.now()
  return overdue
    ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {label}
        <span style={{ color: P.terra, fontWeight: 600, fontSize: '0.78rem' }}>Overdue</span>
      </span>
    : label
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
const pagerBar = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '0 0 12px' }
const pagerBtn = {
  width: 44, height: 44, minWidth: 44, borderRadius: 8, border: `1px solid ${P.greenLight}`,
  background: P.white, color: P.green, fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
const pagerLabel = { flex: 1, textAlign: 'center', fontSize: '0.85rem', color: P.dark, outline: 'none' }
const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}
