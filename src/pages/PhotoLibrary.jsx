import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { formatQty } from '../lib/format.js'
import PhotoUpload from '../components/PhotoUpload.jsx'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import ProjectOptions from '../components/ProjectOptions.jsx'

// ---- Photo Library ----
// Browse all photos, upload standalone photos (event_id = null),
// tag / un-tag photos against projects, locations, and plants.
// Photos Lambda GET returns view_url (signed S3 URL) and project_name inline.
// Filter modes 'standalone' and 'untagged' are applied client-side.
// NOTE: project_id is required by photos Lambda POST — upload form requires it.
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

  const [filterProject, setFilterProject] = useState('')
  const [filterMode,    setFilterMode]    = useState('all')

  const [showUpload,     setShowUpload]     = useState(false)
  const [uploadForm,     setUploadForm]     = useState({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
  const [plantsForUpload, setPlantsForUpload] = useState([])
  const [uploadErr,      setUploadErr]      = useState(null)

  const [modal,          setModal]          = useState(null)
  const [tagForm,        setTagForm]        = useState({ project_id: '', location_id: '', plant_id: '' })
  const [plantsForModal, setPlantsForModal] = useState([])
  const [tagging,        setTagging]        = useState(false)
  const [tagErr,         setTagErr]         = useState(null)

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

  // ---- Load plants when upload project changes ----
  useEffect(() => {
    if (!uploadForm.project_id) { setPlantsForUpload([]); return }
    apiFetch('/api/plants?project_id=' + uploadForm.project_id)
      .then(data => setPlantsForUpload(data ?? []))
      .catch(() => setPlantsForUpload([]))
  }, [apiFetch, uploadForm.project_id])

  // ---- Load plants when modal project changes ----
  useEffect(() => {
    if (!tagForm.project_id) { setPlantsForModal([]); return }
    apiFetch('/api/plants?project_id=' + tagForm.project_id)
      .then(data => setPlantsForModal(data ?? []))
      .catch(() => setPlantsForModal([]))
  }, [apiFetch, tagForm.project_id])

  // ---- Photos query ----
  const loadPhotos = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = filterProject ? `?project_id=${filterProject}` : ''
    try {
      let data = await apiFetch('/api/photos' + qs) ?? []
      if (filterMode === 'standalone') data = data.filter(p => !p.event_id)
      if (filterMode === 'untagged')   data = data.filter(p => !p.event_id && !p.project_id)
      setPhotos(data)
    } catch (err) {
      setPhotos([])
      setError(err)   // apiFetch throws with .status on non-2xx; surface instead of masking as empty
    }
    setLoading(false)
  }, [apiFetch, filterProject, filterMode])

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
  const projectIdMissing = !uploadForm.project_id

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
          <button
            onClick={() => { setShowUpload(s => !s); setUploadErr(null) }}
            style={{
              backgroundColor: showUpload ? P.light : P.green,
              color: P.white, border: 'none', borderRadius: 8,
              padding: '10px 16px', fontSize: '0.88rem', fontWeight: 700,
              cursor: 'pointer', marginTop: 20,
            }}
          >
            {showUpload ? 'Cancel' : '+ Upload'}
          </button>
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

              <div>
                <label style={fieldLabelStyle}>Project  ·  required</label>
                <select
                  value={uploadForm.project_id}
                  onChange={e => setUploadForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— Select project —</option>
                  <ProjectOptions projects={projects} />
                </select>
              </div>

              {plantsForUpload.length > 0 && (
                <div>
                  <label style={fieldLabelStyle}>Plant  ·  optional</label>
                  <select
                    value={uploadForm.plant_id}
                    onChange={e => setUploadForm(f => ({ ...f, plant_id: e.target.value }))}
                    style={selectStyle}
                  >
                    <option value="">— All plants (project level) —</option>
                    {plantsForUpload.map(pl => (
                      <option key={pl.id} value={pl.id}>
                        {pl.name}{pl.quantity > 1 ? ` ×${formatQty(pl.quantity)}` : ''}{pl.variety_ref?.name ? ` — ${pl.variety_ref.name}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label style={fieldLabelStyle}>Location  ·  optional</label>
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="up_pub" type="checkbox"
                  checked={uploadForm.is_public}
                  onChange={e => setUploadForm(f => ({ ...f, is_public: e.target.checked }))}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <label htmlFor="up_pub" style={{ fontSize: '0.85rem', color: P.mid, cursor: 'pointer' }}>
                  Visible on public project page
                </label>
              </div>

              {projectIdMissing && (
                <p style={{ margin: 0, fontSize: '0.8rem', color: P.light }}>
                  Select a project before uploading.
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
                disabled={projectIdMissing}
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
            const active = filterMode === mode && !filterProject
            return (
              <button
                key={mode}
                onClick={() => { setFilterMode(mode); setFilterProject('') }}
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
          <select
            value={filterProject}
            onChange={e => { setFilterProject(e.target.value); setFilterMode('all') }}
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
        </div>

        {/* ── Grid ── */}
        {loading ? (
          <p style={{ color: P.light, fontSize: '0.9rem' }}>Loading…</p>
        ) : error ? (
          <div role="alert" style={{ textAlign: 'center', padding: '40px 16px', background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 10 }}>
            <div style={{ fontSize: '2.2rem', marginBottom: 10 }}>⚠️</div>
            <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 600 }}>Couldn’t load your photos</p>
            <p style={{ margin: '6px 0 14px', fontSize: '0.82rem', color: P.mid }}>
              {(error?.status == null || error.status >= 500)
                ? 'The photo service had a problem. This is usually temporary — please retry.'
                : 'Something went wrong loading the gallery.'}
            </p>
            <button type="button" onClick={loadPhotos} style={{ padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8, border: `1px solid ${P.alertBorder}`, background: P.white, color: P.dark, cursor: 'pointer' }}>Retry</button>
          </div>
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
              {photos.map(photo => (
                <PhotoCard key={photo.id} photo={photo} onClick={() => openModal(photo)} />
              ))}
            </div>
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
          />
        </ErrorBoundary>
      )}
    </div>
  )
}

// ---- Photo card ----
// Uses photo.view_url (signed S3 URL from Lambda) and photo.project_name (inline JOIN)
function PhotoCard({ photo, onClick }) {
  const project = photo.project_name

  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: `1px solid ${P.border}`,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '100%', backgroundColor: '#e8e2da' }}>
        {photo.view_url && (
          <img
            src={photo.view_url}
            alt={photo.caption ?? 'Garden photo'}
            loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
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
function PhotoModal({ photo, tagForm, setTagForm, plantsForModal, onSave, onClose, tagging, tagErr, projects, locations }) {
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
            <img
              src={photo.view_url} alt={photo.caption ?? 'Photo'}
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

              {plantsForModal.length > 0 && (
                <div>
                  <label style={fieldLabelStyle}>Plant  ·  optional</label>
                  <select
                    value={tagForm.plant_id}
                    onChange={e => setTagForm(f => ({ ...f, plant_id: e.target.value }))}
                    style={selectStyle}
                  >
                    <option value="">— All plants (project level) —</option>
                    {plantsForModal.map(pl => (
                      <option key={pl.id} value={pl.id}>
                        {pl.name}{pl.quantity > 1 ? ` ×${formatQty(pl.quantity)}` : ''}{pl.variety_ref?.name ? ` — ${pl.variety_ref.name}` : ''}
                      </option>
                    ))}
                  </select>
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
    <div role="alert" style={{ textAlign: 'center', padding: '40px 16px', background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 10 }}>
      <div style={{ fontSize: '2.2rem', marginBottom: 10 }}>⚠️</div>
      <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 600 }}>Couldn’t display your photos</p>
      <p style={{ margin: '6px 0 14px', fontSize: '0.82rem', color: P.mid }}>
        Something went wrong rendering the gallery. Your photos are safe — please retry.
      </p>
      <button type="button" onClick={retry} style={{ padding: '8px 18px', fontSize: '0.85rem', borderRadius: 8, border: `1px solid ${P.alertBorder}`, background: P.white, color: P.dark, cursor: 'pointer' }}>Retry</button>
    </div>
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
