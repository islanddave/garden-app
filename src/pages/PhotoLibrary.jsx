import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase, getPhotoUrl } from '../lib/supabase.js'
import { P, PHOTO_BUCKET } from '../lib/constants.js'

// ---- Photo Library — D1 + D2 ----
// Browse all photos, upload standalone photos (event_id = null),
// tag / un-tag photos against projects, locations, and plants.

export default function PhotoLibrary() {
  const { user } = useAuth()

  const [photos,        setPhotos]        = useState([])
  const [loading,       setLoading]       = useState(true)
  const [projects,      setProjects]      = useState([])
  const [locations,     setLocations]     = useState([])

  // Filter state
  const [filterProject, setFilterProject] = useState('')
  const [filterMode,    setFilterMode]    = useState('all') // 'all' | 'standalone' | 'untagged'

  // Upload state
  const [showUpload,     setShowUpload]     = useState(false)
  const [uploadFile,     setUploadFile]     = useState(null)
  const [uploadPreview,  setUploadPreview]  = useState(null)
  const [uploadForm,     setUploadForm]     = useState({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
  const [plantsForUpload, setPlantsForUpload] = useState([])
  const [uploading,      setUploading]      = useState(false)
  const [uploadErr,      setUploadErr]      = useState(null)

  // Modal / tag state
  const [modal,          setModal]          = useState(null)
  const [tagForm,        setTagForm]        = useState({ project_id: '', location_id: '', plant_id: '' })
  const [plantsForModal, setPlantsForModal] = useState([])
  const [tagging,        setTagging]        = useState(false)
  const [tagErr,         setTagErr]         = useState(null)

  // ---- Initial data load ----
  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('plant_projects').select('id, name').order('name'),
      supabase.from('locations_with_path').select('id, full_path, is_active').order('full_path'),
    ]).then(([{ data: proj }, { data: locs }]) => {
      setProjects(proj ?? [])
      setLocations((locs ?? []).filter(l => l.is_active))
    })
  }, [user])

  // ---- Load plants when upload project changes ----
  useEffect(() => {
    if (!uploadForm.project_id) { setPlantsForUpload([]); return }
    supabase
      .from('plants')
      .select('id, name, variety, quantity')
      .eq('project_id', uploadForm.project_id)
      .is('deleted_at', null)
      .order('created_at')
      .then(({ data }) => setPlantsForUpload(data ?? []))
  }, [uploadForm.project_id])

  // ---- Load plants when modal project changes ----
  useEffect(() => {
    if (!tagForm.project_id) { setPlantsForModal([]); return }
    supabase
      .from('plants')
      .select('id, name, variety, quantity')
      .eq('project_id', tagForm.project_id)
      .is('deleted_at', null)
      .order('created_at')
      .then(({ data }) => setPlantsForModal(data ?? []))
  }, [tagForm.project_id])

  // ---- Photos query ----
  const loadPhotos = useCallback(async () => {
    if (!user) return
    setLoading(true)
    let q = supabase
      .from('photos')
      .select('id, project_id, event_id, location_id, plant_id, storage_path, caption, is_public, created_at, plant_projects(name), plants(name, variety, quantity)')
      .eq('uploaded_by', user.id)
      .order('created_at', { ascending: false })
      .limit(120)

    if (filterProject)               q = q.eq('project_id', filterProject)
    if (filterMode === 'standalone')  q = q.is('event_id', null)
    if (filterMode === 'untagged') {
      q = q.is('event_id', null)
      q = q.is('project_id', null)
    }

    const { data } = await q
    setPhotos(data ?? [])
    setLoading(false)
  }, [user, filterProject, filterMode])

  useEffect(() => { loadPhotos() }, [loadPhotos])

  // ---- Upload handlers ----
  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadFile(file)
    setUploadPreview(URL.createObjectURL(file))
    setUploadErr(null)
  }

  function clearUploadFile() {
    setUploadFile(null)
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setUploadPreview(null)
  }

  async function handleUpload(e) {
    e.preventDefault()
    if (!uploadFile) { setUploadErr('Select a photo first.'); return }
    if (!uploadForm.project_id && !uploadForm.location_id) {
      setUploadErr('Select a project or location — at least one is required.')
      return
    }

    setUploading(true)
    setUploadErr(null)

    const ext         = uploadFile.name.split('.').pop().toLowerCase()
    const photoId     = crypto.randomUUID()
    const storagePath = `standalone/${photoId}.${ext}`

    const { error: upErr } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(storagePath, uploadFile, { upsert: false })

    if (upErr) { setUploading(false); setUploadErr(upErr.message); return }

    const { error: dbErr } = await supabase.from('photos').insert({
      project_id:   uploadForm.project_id  || null,
      location_id:  uploadForm.location_id || null,
      plant_id:     uploadForm.plant_id    || null,
      event_id:     null,
      storage_path: storagePath,
      caption:      uploadForm.caption.trim() || null,
      is_public:    uploadForm.is_public,
      uploaded_by:  user.id,
    })

    if (dbErr) {
      await supabase.storage.from(PHOTO_BUCKET).remove([storagePath])
      setUploading(false)
      setUploadErr(dbErr.message)
      return
    }

    setUploading(false)
    setShowUpload(false)
    clearUploadFile()
    setUploadForm({ project_id: '', location_id: '', plant_id: '', caption: '', is_public: true })
    loadPhotos()
  }

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

    const { error } = await supabase
      .from('photos')
      .update({ project_id: newProject, location_id: newLocation, plant_id: newPlant })
      .eq('id', modal.id)

    if (error) { setTagging(false); setTagErr(error.message); return }

    const updatedProject = projects.find(p => p.id === newProject) ?? null
    const updatedPlant   = plantsForModal.find(p => p.id === newPlant) ?? null

    setPhotos(ps => ps.map(p =>
      p.id === modal.id
        ? { ...p, project_id: newProject, location_id: newLocation, plant_id: newPlant,
            plant_projects: updatedProject,
            plants: updatedPlant }
        : p
    ))
    setModal(null)
    setTagging(false)
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
            <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {uploadPreview ? (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={uploadPreview} alt="Preview"
                    style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, display: 'block', border: `1px solid ${P.border}` }}
                  />
                  <button type="button" onClick={clearUploadFile} style={clearBtnStyle}>✕</button>
                </div>
              ) : (
                <label style={dropZoneStyle}>
                  <span style={{ fontSize: '1.5rem' }}>📷</span>
                  <span>Tap to choose a photo</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
                </label>
              )}

              <div>
                <label style={fieldLabelStyle}>Project</label>
                <select
                  value={uploadForm.project_id}
                  onChange={e => setUploadForm(f => ({ ...f, project_id: e.target.value, plant_id: '' }))}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              {/* Plant selector — only when project has plants */}
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
                        {pl.name}{pl.quantity > 1 ? ` ×${pl.quantity}` : ''}{pl.variety ? ` — ${pl.variety}` : ''}
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

              <button type="submit" disabled={uploading} style={{ ...primaryBtn(uploading), alignSelf: 'flex-start' }}>
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </form>
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
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {/* ── Grid ── */}
        {loading ? (
          <p style={{ color: P.light, fontSize: '0.9rem' }}>Loading…</p>
        ) : photos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: P.light }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📷</div>
            <p style={{ margin: 0, fontSize: '0.9rem' }}>No photos yet.</p>
            <p style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>Upload your first one above.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {photos.map(photo => (
              <PhotoCard key={photo.id} photo={photo} onClick={() => openModal(photo)} />
            ))}
          </div>
        )}
      </div>

      {/* ── Modal ── */}
      {modal && (
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
      )}
    </div>
  )
}

// ---- Photo card ----
function PhotoCard({ photo, onClick }) {
  const url     = getPhotoUrl(photo.storage_path)
  const project = photo.plant_projects?.name
  const plant   = photo.plants?.name

  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: `1px solid ${P.border}`,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '100%', backgroundColor: '#e8e2da' }}>
        {url && (
          <img
            src={url}
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
      {(project || plant) && (
        <div style={{ padding: '5px 7px', backgroundColor: P.white }}>
          {project && (
            <div style={{ fontSize: '0.7rem', color: P.mid, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {project}
            </div>
          )}
          {plant && (
            <div style={{ fontSize: '0.65rem', color: P.light, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              🌱 {plant}
            </div>
          )}
        </div>
      )}
    </button>
  )
}

// ---- Photo modal ----
function PhotoModal({ photo, tagForm, setTagForm, plantsForModal, onSave, onClose, tagging, tagErr, projects, locations }) {
  const url      = getPhotoUrl(photo.storage_path)
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

        {/* Image */}
        <div style={{ position: 'relative' }}>
          {url && (
            <img
              src={url} alt={photo.caption ?? 'Photo'}
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

        {/* Details */}
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
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              {/* Plant selector — only when project is selected and has plants */}
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
                        {pl.name}{pl.quantity > 1 ? ` ×${pl.quantity}` : ''}{pl.variety ? ` — ${pl.variety}` : ''}
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

// ---- Shared UI ----
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

const dropZoneStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
  padding: '20px 16px', border: `2px dashed ${P.border}`, borderRadius: 8,
  cursor: 'pointer', backgroundColor: P.cream, color: P.mid, fontSize: '0.88rem',
}

const clearBtnStyle = {
  position: 'absolute', top: 8, right: 8,
  background: 'rgba(0,0,0,0.55)', color: '#fff',
  border: 'none', borderRadius: '50%',
  width: 28, height: 28, cursor: 'pointer', fontSize: '0.85rem',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const primaryBtn = (disabled) => ({
  backgroundColor: disabled ? P.light : P.green,
  color: '#fff', border: 'none', borderRadius: 8,
  padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
