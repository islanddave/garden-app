import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import PhotoUpload from '../components/PhotoUpload.jsx'
import PhotoImg from '../components/PhotoImg.jsx'
import { invalidatePrefix as invalidatePhotoLists } from '../lib/dataCache.js'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'
import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import { photoLoadErrorMessage } from '../components/PhotosWall.jsx'
import FacebookShareSheet from '../components/FacebookShareSheet.jsx'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

// ---- Photo Library ----
// Browse all photos, upload standalone photos (event_id = null),
// tag / un-tag photos against projects, locations, and plants.
// Photos Lambda GET returns view_url (signed S3 URL) and project_name inline.
// Filter modes 'standalone' and 'untagged' are applied client-side.
// NOTE: photos Lambda POST requires only storage_path; the DB CHECK photos_must_have_parent
// admits any one of project/location/plant/event. The upload form enforces one-of
// project/space/planting (V4-PHOTOLOCFIND-001) — a bare parentless upload would violate the CHECK.
//
// V2-PHOTO-F1 Session 2 (2026-05-13): refactored to use shared <PhotoUpload>
// component + useUploadPhoto hook. The component owns the 3-step presign/PUT/POST
// dance and preview lifecycle. We still own project_id/plant_id/location_id
// selection and caption/is_public — they flow in via the `linkage`/`caption`/
// `is_public` props. errorMode="surface" preserves the prior loud-error UX.

export default function PhotoLibrary() {
  const { fetch: apiFetch } = useApiFetch()

  const [photos,        setPhotos]        = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)  // V3-PHOTODBG-001: visible load-failure state
  const [projects,      setProjects]      = useState([])
  const [locations,     setLocations]     = useState([])

  const [filterProject,  setFilterProject]  = useState('')
  const [filterLocation, setFilterLocation] = useState('')  // V4-PHOTOLOCFIND-001: space filter (server-side subtree)
  const [filterMode,     setFilterMode]     = useState('all')

  const [showUpload,     setShowUpload]     = useState(false)
  const [uploadForm,     setUploadForm]     = useState({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
  const [plantsForUpload, setPlantsForUpload] = useState([])
  const [uploadErr,      setUploadErr]      = useState(null)

  const [modal,          setModal]          = useState(null)
  const [tagForm,        setTagForm]        = useState({ project_id: '', location_id: '', plant_id: '' })
  const [plantsForModal, setPlantsForModal] = useState([])
  const [tagging,        setTagging]        = useState(false)
  const [tagErr,         setTagErr]         = useState(null)

  // V4-FBSHARE-001 — multi-select + Facebook Page share
  const [selectMode,  setSelectMode]  = useState(false)
  const [selected,    setSelected]    = useState(() => new Set())
  const [shareOpen,   setShareOpen]   = useState(false)
  const [sharePhotos, setSharePhotos] = useState([])

  // BUG-PHOTOTHUMB-001 — EXPLICIT windowing, because neither browser mechanism works here.
  // Measured on the live page (2026-07-27): with loading="lazy", 0 of 120 images were ever
  // REQUESTED — not slow, never fetched — which is why the tab sat blank and then filled all at
  // once when something finally forced a layout recalc. Flipping the same elements to eager loaded
  // them instantly, so the URLs and thumbs were always fine; native lazy simply never fires on this
  // absolutely-positioned grid. Flipping ALL 120 to eager instead FROZE the renderer. So the count
  // has to be bounded by us: render a window, grow it on scroll. Also gives the page the "more as
  // you scroll" behavior it lacked when the server limit was cut to 30.
  const PAGE = 24
  const [shown, setShown] = useState(PAGE)
  useEffect(() => { setShown(PAGE) }, [filterProject, filterLocation, filterMode])
  useEffect(() => {
    // Scroll listener rather than IntersectionObserver: IO is the same viewport-intersection
    // machinery native lazy depends on, and that is precisely what is not firing on this layout.
    function onScroll() {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        setShown(s => (s < photos.length ? s + PAGE : s))
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // a short first page must still be able to grow without a scroll
    return () => window.removeEventListener('scroll', onScroll)
  }, [photos.length])

  // ---- Initial data load ----
  useEffect(() => {
    Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/locations/with-path'),
    ]).then(([proj, locs]) => {
      setProjects(proj ?? [])
      setLocations((locs ?? []).filter(l => l.is_active))
    }).catch(() => {})
  }, [apiFetch])

  // ---- Load plants when upload project changes (project-scoped mode — the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // V4-PROJHIDE-001: unscoped fetch below
    if (!uploadForm.project_id) { setPlantsForUpload([]); return }
    apiFetch('/api/plants?project_id=' + uploadForm.project_id)
      .then(data => setPlantsForUpload(data ?? []))
      .catch(() => setPlantsForUpload([]))
  }, [apiFetch, uploadForm.project_id])

  // ---- Load plants when modal project changes (project-scoped mode — the default). ----
  useEffect(() => {
    if (PROJECTS_HIDDEN) return // V4-PROJHIDE-001: unscoped fetch below
    if (!tagForm.project_id) { setPlantsForModal([]); return }
    apiFetch('/api/plants?project_id=' + tagForm.project_id)
      .then(data => setPlantsForModal(data ?? []))
      .catch(() => setPlantsForModal([]))
  }, [apiFetch, tagForm.project_id])

  // V4-PROJHIDE-001: with the project chooser hidden, both photo pickers (upload + tag modal) list
  // EVERY live planting from the UNSCOPED source — there is no project step to scope them. project_id
  // is then DERIVED from the chosen plant at onChange (see the pickers below). Fetched once; unarchived.
  useEffect(() => {
    if (!PROJECTS_HIDDEN) return
    apiFetch('/api/plants')
      .then(data => {
        const live = (data ?? []).filter(p => !p.archived_at)
        setPlantsForUpload(live); setPlantsForModal(live)
      })
      .catch(() => { setPlantsForUpload([]); setPlantsForModal([]) })
  }, [apiFetch])

  // ---- Photos query ----
  const loadPhotos = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = filterProject ? `?project_id=${filterProject}`
             : filterLocation ? `?location_id=${filterLocation}`
             : ''
    try {
      let data = await apiFetch('/api/photos' + qs) ?? []
      if (filterMode === 'standalone') data = data.filter(p => !p.event_id)
      // V4-PHOTOLOCFIND-001: a photo attached to ANY parent (event/project/zone/planting) is a
      // finished photo — untagged means attached to nothing (V002 E2: valid untagged photos must
      // not read as unfinished work; the old predicate flagged every deliberate location photo).
      // V4-SPACEPHOTO-001: the space arm is UNCONDITIONAL, deliberately NOT behind
      // SPACE_PHOTOS_ENABLED. space_id becomes non-null the moment the migration + Lambda land,
      // which is independent of this client flag — and this is a PWA, so a stale cached bundle
      // would keep flagging every deliberate space photo as unfinished work. Provably inert until
      // then: no photo row carries space_id today, so the extra conjunct is always true.
      if (filterMode === 'untagged')   data = data.filter(p => !p.event_id && !p.project_id && !p.location_id && !p.plant_id && !p.space_id)
      setPhotos(data)
    } catch (err) {
      setPhotos([])
      setError(err)   // apiFetch throws with .status on non-2xx; surface instead of masking as empty
    }
    setLoading(false)
  }, [apiFetch, filterProject, filterLocation, filterMode])

  useEffect(() => { loadPhotos() }, [loadPhotos])

  // ---- Upload handlers ----
  // V2-PHOTO-F1 Session 2: 3-step engine moved into <PhotoUpload> + useUploadPhoto.
  // We retain only the surface-level state: error gating before the picker fires
  // (project_id required) and post-success cleanup (form reset + list reload).
  function handleUploadComplete() {
    setShowUpload(false)
    setUploadForm({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
    setUploadErr(null)
    loadPhotos()
  }

  function handleUploadError(msg) {
    setUploadErr(msg || 'Upload failed.')
  }

  // Build the linkage object the photo component forwards into POST /api/photos.
  // Empty strings become null so the Lambda treats them as "unset" rather than ""
  // (which would fail FK validation for non-uuid columns).
  const photoLinkage = {
    project_id:  uploadForm.project_id || null,
    location_id: uploadForm.location_id || null,
    plant_id:    uploadForm.plant_id    || null,
  }
  const photoCaption = uploadForm.caption.trim() || null
  // V4-PHOTOLOCFIND-001: one-of target gate, matching the photos_must_have_parent CHECK and the
  // handleTag predicate below. Project is no longer singularly required — a space alone is a valid
  // home (the meta-photo case). plant_id is in the predicate for completeness though this form only
  // offers plants after a project is picked.
  const targetMissing = !uploadForm.project_id && !uploadForm.location_id && !uploadForm.plant_id

  // ---- Modal / tag handlers ----
  function openModal(photo) {
    setModal(photo)
    setTagForm({
      project_id:  photo.project_id  ?? '',
      location_id: photo.location_id ?? '',
      plant_id:    photo.plant_id    ?? '',
    })
    setTagErr(null)
  }

  async function handleTag(e) {
    e.preventDefault()
    const newProject  = tagForm.project_id  || null
    const newLocation = tagForm.location_id || null
    const newPlant    = tagForm.plant_id    || null
    if (!newProject && !newLocation && !modal.event_id) {
      setTagErr('A standalone photo needs at least a project or location.')
      return
    }

    setTagging(true)
    setTagErr(null)

    try {
      await apiFetch('/api/photos/' + modal.id, {
        method: 'PUT',
        body: JSON.stringify({
          project_id:  newProject,
          location_id: newLocation,
          plant_id:    newPlant,
          caption:     modal.caption ?? null,
          tags:        modal.tags    ?? null,
        }),
      })

      // V4-IMGCACHE-001 D-1: a re-link moves the photo between location/project/plant buckets, so every
      // cached photo list (?location_id=, ?attachedTo=, the wall) may be stale. PhotoLibrary itself is
      // NOT cached (its grid is a bare <img>, per BUG-PHOTOBLANK-001), but the routed surfaces are.
      invalidatePhotoLists('/api/photos')

      const updatedProjectName = projects.find(p => p.id === newProject)?.name ?? null

      setPhotos(ps => ps.map(p =>
        p.id === modal.id
          ? { ...p, project_id: newProject, location_id: newLocation, plant_id: newPlant, project_name: updatedProjectName }
          : p
      ))
      setModal(null)
      setTagging(false)
    } catch (err) {
      setTagging(false)
      setTagErr(err.message)
    }
  }

  // ---- V4-FBSHARE-001 select-mode + share handlers ----
  function enterSelectMode() { setSelectMode(true); setShowUpload(false) }
  function exitSelectMode() { setSelectMode(false); setSelected(new Set()) }
  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function openShare(photoList) { setSharePhotos(photoList); setShareOpen(true) }
  const selectedPhotos = photos.filter(p => selected.has(p.id))
  // Dormant-until-configured: the FB share UI only appears once VITE_API_FACEBOOK_SHARE is wired
  // (set at go-live, after the lambda is deployed). Keeps a half-feature out of prod on any promote.
  const fbShareEnabled = !!import.meta.env.VITE_API_FACEBOOK_SHARE

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '28px 16px 60px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
              <Link to="/dashboard" style={{ color: P.green, textDecoration: 'none' }}>Dashboard</Link>
              {' › Photos'}
            </div>
            <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
              Photos
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {photos.length > 0 && fbShareEnabled && (
              <button
                onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
                style={{
                  backgroundColor: selectMode ? P.light : P.white,
                  color: selectMode ? P.white : P.green,
                  border: `1px solid ${selectMode ? P.light : P.green}`, borderRadius: 8,
                  padding: '10px 16px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            )}
            <button
              onClick={() => { setShowUpload(s => !s); setUploadErr(null) }}
              style={{
                backgroundColor: showUpload ? P.light : P.green,
                color: P.white, border: 'none', borderRadius: 8,
                padding: '10px 16px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {showUpload ? 'Cancel' : '+ Upload'}
            </button>
          </div>
        </div>

        {/* ── Upload form ── */}
        {showUpload && (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: 10, padding: 18, marginBottom: 20,
          }}>
            <h2 style={{ margin: '0 0 14px', fontSize: '0.95rem', fontWeight: 700, color: P.mid }}>
              Upload standalone photo
            </h2>
            {uploadErr && <ErrBanner msg={uploadErr} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="photo-library-upload-form">

              {/* V4-PROJHIDE-001: upload project chooser hidden when projects aren't user-facing. Flag
                  OFF renders it exactly as before. (project_id stays '' when hidden — see report note re:
                  the plant picker below, which is project-scoped.) */}
              {!PROJECTS_HIDDEN && (
              <div>
                <label style={fieldLabelStyle}>Project  ·  or pick a space below</label>
                <select
                  value={uploadForm.project_id}
                  onChange={e => setUploadForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— Select project —</option>
                  <ProjectOptions projects={projects} />
                </select>
              </div>
              )}

              {plantsForUpload.length > 0 && (
                <div>
                  <label style={fieldLabelStyle} htmlFor="pl-upload-plant">Plant  ·  optional</label>
                  {/* V4-PLANTPICKER-001: shared picker. emptyMeaning='project-level' — blank here is
                      a DELIBERATE project-level attach, not an unset field (spec §6.5 tri-state). */}
                  <PlantingSelect
                    id="pl-upload-plant"
                    plants={plantsForUpload}
                    value={uploadForm.plant_id}
                    onChange={id => setUploadForm(f => PROJECTS_HIDDEN
                      ? { ...f, plant_id: id, project_id: id ? (plantsForUpload.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id }
                      : { ...f, plant_id: id })}
                    emptyMeaning={PROJECTS_HIDDEN ? 'none' : 'project-level'}
                  />
                </div>
              )}

              <div>
                <label style={fieldLabelStyle}>{PROJECTS_HIDDEN ? 'Space  ·  optional' : 'Space  ·  or pick a project above'}</label>
                <select
                  value={uploadForm.location_id}
                  onChange={e => setUploadForm(f => ({ ...f, location_id: e.target.value }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
                </select>
              </div>

              <div>
                <label style={fieldLabelStyle}>Caption  ·  optional</label>
                <input
                  value={uploadForm.caption}
                  onChange={e => setUploadForm(f => ({ ...f, caption: e.target.value }))}
                  placeholder="What are you seeing?"
                  style={inputStyle}
                />
              </div>

              {/* V4-PUBHIDE-001: is_public toggle removed. */}

              {targetMissing && (
                <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                  A standalone photo needs at least a project or space.
                </p>
              )}

              <PhotoUpload
                keyPrefix="standalone"
                linkage={photoLinkage}
                caption={photoCaption}
                is_public={uploadForm.is_public}
                errorMode="surface"
                mode="both"
                onUploadComplete={handleUploadComplete}
                onUploadError={handleUploadError}
                disabled={targetMissing}
                inputId="photolibrary-upload-input"
              />
            </div>
          </div>
        )}

        {/* ── Filters ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { mode: 'all',        label: 'All' },
            { mode: 'standalone', label: 'No event' },
            { mode: 'untagged',   label: 'Untagged' },
          ].map(({ mode, label }) => {
            const active = filterMode === mode && !filterProject && !filterLocation
            return (
              <button
                key={mode}
                onClick={() => { setFilterMode(mode); setFilterProject(''); setFilterLocation('') }}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: '0.82rem', fontWeight: 600,
                  cursor: 'pointer',
                  border: `1px solid ${active ? P.green : P.border}`,
                  backgroundColor: active ? P.greenPale : P.white,
                  color: active ? P.green : P.mid,
                }}
              >
                {label}
              </button>
            )
          })}
          {/* V4-PROJHIDE-001: project filter hidden when projects aren't user-facing (mode chips +
              space filter remain; filterProject stays '' so no project filter applies). Flag OFF is
              byte-identical. */}
          {!PROJECTS_HIDDEN && (
          <select
            value={filterProject}
            onChange={e => { setFilterProject(e.target.value); setFilterLocation(''); setFilterMode('all') }}
            style={{
              ...selectStyle,
              fontSize: '0.82rem', padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterProject ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterProject ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by project…</option>
            <ProjectOptions projects={projects} />
          </select>
          )}
          {/* V4-PHOTOLOCFIND-001: space chip — server-side subtree filter (a parent space shows its
              descendants' photos). Mutually exclusive with the project filter, like the mode chips. */}
          <select
            value={filterLocation}
            onChange={e => { setFilterLocation(e.target.value); setFilterProject(''); setFilterMode('all') }}
            style={{
              ...selectStyle,
              fontSize: '0.82rem', padding: '6px 30px 6px 10px',
              maxWidth: 200, flexShrink: 1,
              border: filterLocation ? `1px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: filterLocation ? P.greenPale : P.white,
            }}
          >
            <option value="">Filter by space…</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
          </select>
        </div>

        {/* ── Grid ── */}
        {loading ? (
          <p style={{ color: P.light, fontSize: '0.9rem' }}>Loading…</p>
        ) : error ? (
          <AsyncRegion
            error={photoLoadErrorMessage(error, 'the gallery')}
            errorTitle="Couldn’t load your photos"
            onRetry={loadPhotos}
          />
        ) : photos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
            <p style={{ margin: 0, fontSize: '0.9rem' }}>No photos yet.</p>
            <p style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>Upload your first one above.</p>
          </div>
        ) : (
          // V3-PHOTODBG-001 (4/4): the grid render is wrapped in an ErrorBoundary so a render-time
          // fault in any PhotoCard (malformed photo shape, bad view_url) degrades to a dismissable
          // retry card instead of white-screening the whole Photos page. Mirrors the tag-modal net.
          <ErrorBoundary
            scope="photo-grid"
            fallback={(err, retry) => <PhotoGridErrorFallback retry={() => { retry(); loadPhotos() }} />}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {photos.slice(0, shown).map(photo => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  selectMode={selectMode}
                  selected={selected.has(photo.id)}
                  onClick={() => (selectMode ? toggleSelect(photo.id) : openModal(photo))}
                />
              ))}
            </div>
            {shown < photos.length && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <button type="button" onClick={() => setShown(s => s + PAGE)}
                  style={{ background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: 8,
                           padding: '11px 20px', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer', minHeight: 44 }}>
                  Show more ({photos.length - shown} left)
                </button>
              </div>
            )}
          </ErrorBoundary>
        )}
      </div>

      {/* ── Modal ── */}
      {/* V1.2a-3 Increment A (I1/I4): the tag modal is wrapped in an ErrorBoundary so a
          render-time fault (bad photo shape, malformed linkage) degrades to a dismissable
          card instead of white-screening the whole Photo Library. The 405-string bug
          itself (I1) is fixed in the photos Lambda PUT route; this is the defensive net. */}
      {modal && (
        <ErrorBoundary
          scope="photo-tag-modal"
          fallback={(err, retry) => (
            <PhotoModalErrorFallback error={err} retry={retry} onClose={() => setModal(null)} />
          )}
        >
          <PhotoModal
            photo={modal}
            tagForm={tagForm}
            setTagForm={setTagForm}
            plantsForModal={plantsForModal}
            onSave={handleTag}
            onClose={() => setModal(null)}
            tagging={tagging}
            tagErr={tagErr}
            projects={projects}
            locations={locations}
            onShare={fbShareEnabled ? (() => { setModal(null); openShare([modal]) }) : undefined}
          />
        </ErrorBoundary>
      )}

      {/* V4-FBSHARE-001 — selection action bar (only in select-mode) */}
      {selectMode && selected.size > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150, background: P.white, borderTop: `1px solid ${P.border}`, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: '0 -2px 10px rgba(0,0,0,0.08)' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: P.mid }}>{selected.size} selected</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {selected.size > 10 && <span style={{ fontSize: '0.72rem', color: P.terra }}>Max 10</span>}
            <button type="button" onClick={exitSelectMode} style={{ background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button type="button" onClick={() => openShare(selectedPhotos)} disabled={selected.size > 10}
              style={{ background: selected.size > 10 ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: '0.86rem', fontWeight: 700, cursor: selected.size > 10 ? 'default' : 'pointer' }}>
              Post to Facebook
            </button>
          </div>
        </div>
      )}

      <FacebookShareSheet
        open={shareOpen}
        photos={sharePhotos}
        onClose={() => setShareOpen(false)}
        onPosted={() => exitSelectMode()}
      />
    </div>
  )
}

// ---- Photo card ----
// Uses photo.view_url (signed S3 URL from Lambda) and photo.project_name (inline JOIN)
function PhotoCard({ photo, onClick, selectMode = false, selected = false }) {
  // V4-PROJHIDE-001: drop the project caption strip when projects aren't user-facing (null → the
  // {project && (...)} strip below renders nothing). Flag OFF keeps photo.project_name.
  const project = PROJECTS_HIDDEN ? null : photo.project_name

  return (
    <button
      onClick={onClick}
      aria-pressed={selectMode ? selected : undefined}
      style={{
        background: 'none',
        border: selected ? `2px solid ${P.green}` : `1px solid ${P.border}`,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '100%', backgroundColor: '#e8e2da' }}>
        {(photo.thumb_url || photo.view_url) && (
          <img
            // BUG-PHOTOBLANK-001: the GRID takes the ~200KB thumbnail, never the 4080x3072
            // original (30 originals = ~90MB and the tab sat blank for minutes). thumb_url is a
            // HINT — a photo uploaded before its thumb exists presigns to a missing object, so
            // onError swaps to the full image once, guarded so a failing view_url can't loop.
            src={photo.thumb_url || photo.view_url}
            alt={photo.caption ?? 'Garden photo'}
            // NO loading="lazy": measured 0 of 120 images ever requested on this grid (see the
            // windowing note above). The parent bounds how many cards exist instead, so every
            // rendered card SHOULD load — deferring that decision to the browser is what broke.
            decoding="async"
            onError={(e) => {
              if (photo.view_url && e.currentTarget.src !== photo.view_url) {
                e.currentTarget.src = photo.view_url;
              }
            }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {selectMode && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: 6, left: 6, width: 22, height: 22, borderRadius: '50%',
            border: `2px solid ${P.white}`, backgroundColor: selected ? P.green : 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: P.white, fontSize: '0.75rem', fontWeight: 700,
          }}>{selected ? '✓' : ''}</span>
        )}
        {!photo.event_id && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            backgroundColor: 'rgba(0,0,0,0.5)', color: '#fff',
            fontSize: '0.6rem', fontWeight: 700, borderRadius: 4, padding: '2px 5px',
          }}>
            standalone
          </span>
        )}
      </div>
      {project && (
        <div style={{ padding: '5px 7px', backgroundColor: P.white }}>
          <div style={{ fontSize: '0.7rem', color: P.mid, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project}
          </div>
        </div>
      )}
    </button>
  )
}

// ---- Photo modal ----
// Uses photo.view_url for display
function PhotoModal({ photo, tagForm, setTagForm, plantsForModal, onSave, onClose, tagging, tagErr, projects, locations, onShare }) {
  const hasEvent = !!photo.event_id

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        boxSizing: 'border-box',
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px',
      }}
    >
      <div style={{
        backgroundColor: P.white, borderRadius: 12,
        maxWidth: 480, width: '100%', maxHeight: '90dvh', overflow: 'hidden',
      }}>

        <div style={{ position: 'relative' }}>
          {photo.view_url && (
            <PhotoImg
              photoId={photo.id}
              initialUrl={photo.view_url} alt={photo.caption ?? 'Photo'}
              style={{ width: '100%', borderRadius: '12px 12px 0 0', display: 'block', maxHeight: 300, objectFit: 'cover' }}
            />
          )}
          <button
            onClick={onClose}
            style={{
              position: 'absolute', top: 10, right: 10,
              background: 'rgba(0,0,0,0.55)', color: '#fff',
              border: 'none', borderRadius: '50%', width: 30, height: 30,
              cursor: 'pointer', fontSize: '0.9rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        <div style={{ padding: '16px 20px 20px' }}>
          {photo.caption && (
            <p style={{ margin: '0 0 12px', fontSize: '0.88rem', color: P.mid }}>{photo.caption}</p>
          )}

          {onShare && (
            <button type="button" onClick={onShare}
              style={{ width: '100%', marginBottom: 14, background: P.white, color: P.green, border: `1px solid ${P.green}`, borderRadius: 8, padding: '11px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer' }}>
              Share to Facebook
            </button>
          )}

          {hasEvent ? (
            <div style={{ backgroundColor: P.cream, borderRadius: 8, padding: '10px 12px' }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                Attached to an event — tags are managed via the event log.
              </p>
            </div>
          ) : (
            <form onSubmit={onSave} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: '0 0 4px', fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                Tags
              </p>
              {tagErr && <ErrBanner msg={tagErr} />}

              {/* V4-PROJHIDE-001: reassign project chooser hidden when projects aren't user-facing. Flag
                  OFF renders it exactly as before. (project_id stays '' when hidden — the plant picker
                  below is project-scoped; see report note.) */}
              {!PROJECTS_HIDDEN && (
              <div>
                <label style={fieldLabelStyle}>Project</label>
                <select
                  value={tagForm.project_id}
                  onChange={e => setTagForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  <ProjectOptions projects={projects} />
                </select>
              </div>
              )}

              {plantsForModal.length > 0 && (
                <div>
                  <label style={fieldLabelStyle} htmlFor="pl-modal-plant">Plant  ·  optional</label>
                  {/* V4-PLANTPICKER-001: shared picker. NOTE the create-vs-edit contract split (spec
                      §6.5 trap): the upload form is target-gated, this modal is NOT — clearing here
                      must stay possible (un-tagging a photo is legitimate). */}
                  <PlantingSelect
                    id="pl-modal-plant"
                    plants={plantsForModal}
                    value={tagForm.plant_id}
                    onChange={id => setTagForm(f => PROJECTS_HIDDEN
                      ? { ...f, plant_id: id, project_id: id ? (plantsForModal.find(p => p.id === id)?.project_id ?? f.project_id) : f.project_id }
                      : { ...f, plant_id: id })}
                    emptyMeaning="project-level"
                  />
                </div>
              )}

              <div>
                <label style={fieldLabelStyle}>Location</label>
                <select
                  value={tagForm.location_id}
                  onChange={e => setTagForm(f => ({ ...f, location_id: e.target.value }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
                </select>
              </div>

              <button type="submit" disabled={tagging} style={{ ...primaryBtn(tagging), alignSelf: 'flex-start' }}>
                {tagging ? 'Saving…' : 'Save tags'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function ErrBanner({ msg }) {
  return (
    <div style={{
      backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
      borderRadius: 8, padding: '10px 14px', marginBottom: 8,
      fontSize: '0.82rem', color: '#7a2a10',
    }}>
      {msg}
    </div>
  )
}

// ErrorBoundary fallback for the photo-tag modal. Modal-shaped so a render fault
// still reads as "the modal broke" rather than dumping the user back to the grid
// with no explanation. Friendly copy only — never the raw error string.
// ErrorBoundary fallback for the photo GRID (V3-PHOTODBG-001 4/4). A render fault in the grid
// degrades to a contained retry card matching the load-error styling — never a white screen.
function PhotoGridErrorFallback({ retry }) {
  return (
    <AsyncRegion
      error="Something went wrong rendering the gallery. Your photos are safe — please retry."
      errorTitle="Couldn’t display your photos"
      onRetry={retry}
    />
  )
}

function PhotoModalErrorFallback({ retry, onClose }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, boxSizing: 'border-box',
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px',
      }}
    >
      <div style={{
        backgroundColor: P.white, borderRadius: 12, maxWidth: 420, width: '100%',
        padding: '24px 22px', textAlign: 'center',
      }}>
        <div style={{ fontSize: '2rem', marginBottom: 10 }}>⚠️</div>
        <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>
          This photo couldn’t open
        </p>
        <p style={{ margin: '0 0 18px', color: P.mid, fontSize: '0.85rem' }}>
          Something went wrong loading the tag editor. Your photo is safe — try again, or close and reopen it.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button type="button" onClick={retry} style={primaryBtn(false)}>Try again</button>
          <button type="button" onClick={onClose} style={{
            backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`,
            borderRadius: 8, padding: '11px 24px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}

const fieldLabelStyle = {
  display: 'block', fontSize: '0.77rem', fontWeight: 700,
  color: P.mid, marginBottom: 5, letterSpacing: '0.4px', textTransform: 'uppercase',
}

const inputStyle = {
  width: '100%', padding: '10px 12px',
  border: `1px solid ${P.border}`,
  borderRadius: 7, fontSize: '0.9rem',
  backgroundColor: '#fff', boxSizing: 'border-box', fontFamily: 'inherit',
}

const selectStyle = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 36, cursor: 'pointer',
}

// dropZoneStyle / clearBtnStyle removed in V2-PHOTO-F1 S2: <PhotoUpload> owns
// the trigger affordance and preview lifecycle now.

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: '#fff', border: 'none', borderRadius: 8,
  padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
