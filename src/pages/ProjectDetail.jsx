import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, PROJECT_STATUSES, EVENT_TYPES, APP_URL } from '../lib/constants.js'
import { EVENT_TYPE_META } from '../lib/eventTypes.js'
import { getStatusColors } from '../lib/status.js'
import { formatQty } from '../lib/format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { loadSortOrder, saveSortOrder, applyNameSort } from '../lib/projectTree.js'
import SortToggle from '../components/SortToggle.jsx'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'
import { PlantForm, Field, Input, Select, Textarea, Button, ErrorBanner } from '../components/forms'


function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function emptyEventForm() {
  return {
    event_type:    'observation',
    event_date:    todayLocal(),
    title:         '',
    notes:         '',
    private_notes: '',
    quantity:      '',
    is_public:     true,
  }
}

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function generateSlug(name, startDate) {
  const year = startDate
    ? new Date(startDate + 'T00:00:00').getFullYear()
    : new Date().getFullYear()
  return `${slugify(name)}-${year}`
}

// I7 fix (2026-05-18, V1.2a-3 Increment C / PR-C2): STATUS_COLORS replaced by
// shared getStatusColors() from src/lib/status.js (single source of truth across
// Dashboard / ProjectList / ProjectDetail).

export default function ProjectDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const { fetch, getToken } = useApiFetch()
  // M1 telemetry (Inc 0) — reach_planting. Fire-and-forget.
  const ux = useUxFlow(FLOWS.REACH_PLANTING)
  const reachedRef = useRef(false)

  const [project,      setProject]      = useState(null)
  // Fires once when the project (and its plantings) load. Proxy signal: ProjectDetail is
  // the surface where plantings are viewed (no dedicated planting route yet). Precise
  // taps-from-app-open is a cross-route refinement (deferred per tap-fidelity note).
  useEffect(() => {
    if (project && !reachedRef.current) {
      reachedRef.current = true
      ux.step(0, 'reached', { project_id: project.id })
    }
  }, [project])  // eslint-disable-line react-hooks/exhaustive-deps
  const [locPath,      setLocPath]      = useState(null)
  const [locations,    setLocations]    = useState([])
  const [allProjects,  setAllProjects]  = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [editing,      setEditing]      = useState(false)
  const [form,         setForm]         = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [saveErr,      setSaveErr]      = useState(null)

  const [events,        setEvents]        = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [showLogForm,   setShowLogForm]   = useState(false)
  const [eventForm,     setEventForm]     = useState(emptyEventForm())
  const [loggingEvent,  setLoggingEvent]  = useState(false)
  const [logErr,        setLogErr]        = useState(null)
  const [deletingId,    setDeletingId]    = useState(null)
  const logFormRef = useRef(null)

  // V2-PHOTO-F1 Session 2: staged photo for inline mini-event-logger. Mirrors
  // EventNew's pattern — file selected first, uploaded after event POST so the
  // S3 key resolves under events/{eventId}/.
  const [miniPhotoFile,    setMiniPhotoFile]    = useState(null)
  const [miniPhotoPreview, setMiniPhotoPreview] = useState(null)
  const miniPhotoUploader = useUploadPhoto({ errorMode: 'swallow' })

  const [plants,        setPlants]        = useState([])
  const [plantsLoading, setPlantsLoading] = useState(true)
  // V3-ORDER-001: persisted sort order for this project's plantings. DEFAULT = recency.
  const [sortOrder,     setSortOrder]     = useState(() => loadSortOrder())
  const onSortChange = useCallback((order) => { setSortOrder(order); saveSortOrder(order) }, [])
  const [showAddPlant,  setShowAddPlant]  = useState(false)
  // V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #4): plantForm shape extended with
  // optional lifecycle/source/lineage fields. All NULL-tolerant server-side.
  // sown_at_approx toggles whether sown_at is treated as an exact date.
  const [plantForm,     setPlantForm]     = useState({
    name: '', variety: null, quantity: '1', notes: '', status: '',
    sown_at: '', sown_at_approx: false,
    qty_initial: '',
    source_type: '', source_ref: '', source_generation: '',
    lineage_note: '',
  })
  const [addingPlant,   setAddingPlant]   = useState(false)
  const [plantErr,      setPlantErr]      = useState(null)

  const [deleting,        setDeleting]        = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [childProjects,    setChildProjects]    = useState([])

  // Load project + events + locations + all projects in parallel
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEventsLoading(true)
    Promise.all([
      fetch('/api/projects/' + id),
      fetch('/api/events?project_id=' + id),
      fetch('/api/locations/with-path'),
      fetch('/api/projects'),
    ]).then(([proj, eventsData, locs, projects]) => {
      if (cancelled) return
      if (!proj) { setError('Project not found.'); setLoading(false); setEventsLoading(false); return }
      setProject(proj)
      setLocPath(proj.location_path ?? null)
      setLocations((locs ?? []).filter(l => l.is_active))
      // Exclude current project from re-parent picker
      setAllProjects((projects ?? []).filter(p => p.id !== id && p.name))
      setEvents(eventsData ?? [])
      setLoading(false)
      setEventsLoading(false)
    }).catch(err => {
      if (cancelled) return
      setError(err.message || 'Failed to load project.')
      setLoading(false)
      setEventsLoading(false)
    })
    return () => { cancelled = true }
  }, [id, fetch])

  // Load plants separately
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setPlantsLoading(true)
    fetch('/api/plants?project_id=' + id)
      .then(data => {
        if (cancelled) return
        setPlants(data ?? [])
        setPlantsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPlantsLoading(false)
      })
    return () => { cancelled = true }
  }, [id, fetch])

  async function refreshEvents() {
    const data = await fetch('/api/events?project_id=' + id)
    setEvents(data ?? [])
  }

  async function handleAddPlant(e) {
    e.preventDefault()
    setAddingPlant(true)
    setPlantErr(null)
    const qty = parseInt(plantForm.quantity, 10)
    const qtyInitialRaw = parseInt(plantForm.qty_initial, 10)
    // qty_initial defaults to quantity if blank/invalid (per V102 §5.1 #4 + B.2).
    const qtyInitial = isNaN(qtyInitialRaw) || qtyInitialRaw < 1
      ? (isNaN(qty) || qty < 1 ? 1 : qty)
      : qtyInitialRaw
    try {
      const data = await fetch('/api/plants', {
        method: 'POST',
        body: JSON.stringify({
          project_id: id,
          name:       plantForm.name.trim(),
          variety:    plantForm.variety?.name ?? null, // BUG-02/03: dual-write legacy name + canonical id
          variety_id: plantForm.variety?.id ?? null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      plantForm.notes.trim()   || null,
          status:     plantForm.status || null, // E1: project-create gains status; '' -> null == prior server default
          // V1.2a-4 S1: lifecycle/source/lineage extension. All optional.
          sown_at:           plantForm.sown_at         || null,
          sown_at_approx:    !!plantForm.sown_at_approx,
          qty_initial:       qtyInitial,
          source_type:       plantForm.source_type    || null,
          source_ref:        plantForm.source_ref.trim()        || null,
          source_generation: plantForm.source_generation.trim() || null,
          lineage_note:      plantForm.lineage_note.trim()      || null,
        }),
      })
      setPlants(p => [...p, data])
      setPlantForm({
        name: '', variety: null, quantity: '1', notes: '', status: '',
        sown_at: '', sown_at_approx: false,
        qty_initial: '',
        source_type: '', source_ref: '', source_generation: '',
        lineage_note: '',
      })
      setShowAddPlant(false)
    } catch (err) {
      setPlantErr(err.message)
    }
    setAddingPlant(false)
  }

  async function handleLogEvent(e) {
    e.preventDefault()
    setLoggingEvent(true)
    setLogErr(null)
    try {
      const created = await fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          project_id:    id,
          event_type:    eventForm.event_type,
          event_date:    eventForm.event_date,
          title:         eventForm.title.trim()         || null,
          notes:         eventForm.notes.trim()         || null,
          private_notes: eventForm.private_notes.trim() || null,
          quantity:      eventForm.quantity.trim()       || null,
          is_public:     eventForm.is_public,
          has_photo:     !!miniPhotoFile,
        }),
      })

      // V2-PHOTO-F1 S2: upload staged photo (if any) — non-fatal via 'swallow'.
      const newEventId = created?.id
      if (miniPhotoFile && newEventId) {
        await miniPhotoUploader.upload(miniPhotoFile, {
          keyPrefix: 'events',
          parentId:  newEventId,
          linkage:   { project_id: id, event_id: newEventId },
          is_public: eventForm.is_public,
        })
      }

      // MVP-Critter — critters are awarded SERVER-SIDE by the events Lambda hook
      // (Phase B++ refactor 2026-05-30). No client call needed; if a plant picker is added
      // to this form later, the server-side hook auto-handles it.

      setEventForm(emptyEventForm())
      clearMiniPhoto()
      setShowLogForm(false)
      await refreshEvents()
    } catch (err) {
      setLogErr(err.message)
    }
    setLoggingEvent(false)
  }

  function handleMiniPhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setMiniPhotoFile(file)
    if (miniPhotoPreview) URL.revokeObjectURL(miniPhotoPreview)
    setMiniPhotoPreview(URL.createObjectURL(file))
  }

  function clearMiniPhoto() {
    setMiniPhotoFile(null)
    if (miniPhotoPreview) URL.revokeObjectURL(miniPhotoPreview)
    setMiniPhotoPreview(null)
  }

  async function handleDeleteEvent(evId) {
    if (!window.confirm('Delete this event?')) return
    setDeletingId(evId)
    try {
      await fetch('/api/events/' + evId, { method: 'DELETE' })
      await refreshEvents()
    } catch (e) {
      console.error('delete event failed', e)
    }
    setDeletingId(null)
  }

  function startEdit() {
    setForm({
      name:              project.name,
      slug:              project.slug,
      description:       project.description ?? '',
      status:            project.status,
      start_date:        project.start_date  ?? '',
      is_public:         project.is_public,
      location_id:       project.location_id ?? '',
      parent_project_id: project.parent_project_id ?? '',
    })
    setSaveErr(null)
    setEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveErr(null)
    try {
      const updated = await fetch('/api/projects/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name:              form.name.trim(),
          slug:              form.slug.trim(),
          description:       form.description.trim() || null,
          status:            form.status,
          start_date:        form.start_date         || null,
          is_public:         form.is_public,
          location_id:       form.location_id        || null,
          parent_project_id: form.parent_project_id  || null,
        }),
      })
      const loc = locations.find(l => l.id === (form.location_id || null))
      setLocPath(loc?.full_path ?? null)
      setProject(updated)
      setEditing(false)
    } catch (err) {
      const msg = err.message ?? ''
      setSaveErr(
        msg.includes('23505') || msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate')
          ? `Slug "${form.slug}" is already taken.`
          : msg.includes('cannot be its own parent')
          ? 'A project cannot be its own parent.'
          : msg || 'Failed to save.'
      )
    }
    setSaving(false)
  }

  async function handleDeleteClick() {
    // Check for child projects before allowing delete
    try {
      const children = await fetch('/api/projects?parent_id=' + id)
      setChildProjects(children ?? [])
    } catch {
      setChildProjects([])
    }
    setDeleteDialogOpen(true)
  }

  async function confirmDelete(archive) {
    setDeleting(true)
    setDeleteDialogOpen(false)
    try {
      if (archive) {
        // V3-ARCHIVE-001 (Decision 2): real archive — sets archived_at (hides from active lists).
        // status is an orthogonal lifecycle label, left untouched. by-id detail still opens, so
        // we stay on the page and surface an Archived badge + Unarchive affordance below.
        const res = await fetch('/api/projects/' + id + '/archive', {
          method: 'PATCH',
          body: JSON.stringify({ archived: true }),
        })
        setProject(p => ({ ...p, archived_at: res?.archived_at ?? new Date().toISOString() }))
        setDeleting(false)
      } else {
        await fetch('/api/projects/' + id, { method: 'DELETE' })
        navigate('/projects')
      }
    } catch (err) {
      console.error('delete/archive failed', err)
      setDeleting(false)
    }
  }

  async function handleUnarchive() {
    setDeleting(true)
    try {
      const res = await fetch('/api/projects/' + id + '/archive', {
        method: 'PATCH',
        body: JSON.stringify({ archived: false }),
      })
      setProject(p => ({ ...p, archived_at: res?.archived_at ?? null }))
    } catch (err) {
      console.error('unarchive failed', err)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>
  if (!project) return null

  const sc = getStatusColors(project.status)

  return (
    <Shell>
      <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: project.name, href: null }]} />

      {/* Parent breadcrumb — shown when project has a parent */}
      {project.parent_project_id && project.parent_project_name && (
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 12 }}>
          Part of:{' '}
          <Link
            to={`/projects/${project.parent_project_id}`}
            style={{ color: P.green, textDecoration: 'none', fontWeight: 600 }}
          >
            {project.parent_project_name}
          </Link>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.4rem', fontWeight: 700 }}>
            {project.name}
          </h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* V1.2a-3 Increment A (I3-affordance): projects were the one favoritable
                entity type with no star control anywhere. */}
            <FavoriteToggle entityType="project" entityId={project.id} />
            <span style={{
              backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
              fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
            }}>
              {project.status}
            </span>
            {project.archived_at && (
              <span style={{
                backgroundColor: P.greenPale, color: P.green, border: `1px solid ${P.greenLight}`,
                fontSize: '0.75rem', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              }}>
                Archived
              </span>
            )}
            {!project.is_public && (
              <span style={{ fontSize: '0.75rem', color: P.light, backgroundColor: '#eee', borderRadius: 12, padding: '3px 10px' }}>
                private
              </span>
            )}
            {project.is_public && (
              <a href={`${APP_URL}/garden/${project.slug}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.75rem', color: P.green, textDecoration: 'none' }}>
                🌐 View public page ↗
              </a>
            )}
          </div>
          {!eventsLoading && events.length > 0 && (
            <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 6 }}>
              Last: {EVENT_TYPE_META[events[0].event_type]?.emoji ?? '📝'} {events[0].event_type.replace(/_/g, ' ')} · {daysAgo(events[0].event_date)}
            </div>
          )}
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            {project.archived_at && (
              <button onClick={handleUnarchive} disabled={deleting} style={outlineBtn}>
                {deleting ? 'Working…' : 'Unarchive'}
              </button>
            )}
            <button onClick={startEdit} style={outlineBtn}>Edit</button>
            <button
              onClick={handleDeleteClick}
              disabled={deleting}
              style={{ ...outlineBtn, color: P.terra, borderColor: P.alertBorder }}
            >
              {deleting ? 'Working…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteDialogOpen && (
        <DeleteDialog
          childProjects={childProjects}
          onArchive={() => confirmDelete(true)}
          onDelete={() => confirmDelete(false)}
          onCancel={() => setDeleteDialogOpen(false)}
        />
      )}

      {editing ? (
        <form onSubmit={handleSave} style={cardStyle}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>Edit project</h2>
          <ErrorBanner>{saveErr}</ErrorBanner>

          <Field label="Name *" style={{ marginBottom: 14 }}>
            <Input required value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: generateSlug(e.target.value, f.start_date) }))} />
          </Field>

          {/* BUG-08 (2.1.1): Slug input hidden from the edit form — humans don't need it now.
              Slug is still auto-generated from name/start_date (generateSlug calls below) and
              saved silently via handleSave (form.slug). Only the UI control is removed. */}

          {/* BUG-02 (variety-ref model): Variety/Species removed from the project-edit form.
              Taxonomy lives on PLANTINGS (variety_id, set via VarietyPicker in Add-Plant), not on
              plant_projects (which has no variety_id and no species column — species was silently
              dropped, variety text never displayed). Removed rather than wired to avoid duplicating
              variety attachment at two levels. Existing project.variety text is preserved (PUT no
              longer sends it, so COALESCE keeps it) but is no longer user-editable here. */}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Start date" style={{ marginBottom: 14 }}>
              <Input type="date" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value, slug: generateSlug(f.name, e.target.value) }))} />
            </Field>
            <Field label="Status" style={{ marginBottom: 14 }}>
              <Select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {[...PROJECT_STATUSES].sort((a, b) => a.localeCompare(b)).map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Location" style={{ marginBottom: 14 }}>
            <Select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}>
              <option value="">— None —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </Select>
          </Field>

          {/* ── Re-parent picker ── */}
          <Field label="Nest under another project?" style={{ marginBottom: 14 }} help="Optional — leave blank for a top-level project.">
            <Select
              value={form.parent_project_id}
              onChange={e => setForm(f => ({ ...f, parent_project_id: e.target.value }))}
            >
              <option value="">None — top-level project</option>
              {allProjects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Description" style={{ marginBottom: 14 }}>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3} />
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <input id="edit_public" type="checkbox" checked={form.is_public}
              onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer' }} />
            <label htmlFor="edit_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>Public</label>
          </div>

          <div style={{ display: 'flex', gap: 12, paddingTop: 16, borderTop: `1px solid ${P.border}` }}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
              Save changes
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div style={cardStyle}>
          <Fields project={project} locPath={locPath} />
        </div>
      )}

      {/* ---- Plants ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Plantings
            {plants.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>({plants.length})</span>
            )}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {plants.length > 1 && <SortToggle order={sortOrder} onChange={onSortChange} label="Sort plantings" />}
            <button onClick={() => { setShowAddPlant(v => !v); setPlantErr(null) }}
              style={showAddPlant ? ghostBtn : outlineBtn}>
              {showAddPlant ? 'Cancel' : '+ Add planting'}
            </button>
          </div>
        </div>

        {showAddPlant && (
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <PlantForm
              value={plantForm}
              onChange={patch => setPlantForm(f => ({ ...f, ...patch }))}
              onSubmit={handleAddPlant}
              submitting={addingPlant}
              error={plantErr}
              submitLabel="Add planting"
              submittingLabel="Adding…"
              onCancel={() => { setShowAddPlant(false); setPlantErr(null) }}
              idPrefix="add-plant"
            />
          </div>
        )}

        {plantsLoading ? (
          <div style={{ padding: '16px 0', color: P.light, fontSize: '0.875rem' }}>Loading…</div>
        ) : plants.length === 0 ? (
          <div style={{ padding: '24px 20px', textAlign: 'center', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.light, fontSize: '0.875rem' }}>
            No plantings yet — add individuals or groups above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* V3-ORDER-001: same shared comparator/order as Garden + /plants so a planting
                sits in the identical position across every surface. Default recency. */}
            {applyNameSort(plants, sortOrder).map(plant => (
              /* V3-NAV-001 (PR2): the name/photo region is a dedicated nav target to the
                 PlantingDetail page; the photo-upload control is a SIBLING (never nested in
                 the link) to avoid invalid <button>-inside-<a> and the ADHD two-target mis-tap. */
              <div key={plant.id} style={{
                backgroundColor: P.white, border: `1px solid ${P.border}`,
                borderRadius: 8, padding: '8px 12px', minHeight: 44,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              }}>
                {/* Dedicated name/photo nav region → PlantingDetail. Whole region is one tap
                    target (≥44px via card minHeight + padding); controls below are siblings. */}
                <Link
                  to={`/projects/${id}/plantings/${plant.id}`}
                  aria-label={`Open ${plant.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                           textDecoration: 'none', color: 'inherit', minHeight: 44 }}
                >
                  {/* V1.2a-3 Increment A (I2a-display): the plant's featured photo.
                      Read-back surface for the photo→plant linkage that already worked. */}
                  {plant.featured_photo_view_url
                    ? <img
                        src={plant.featured_photo_view_url}
                        alt=""
                        loading="lazy"
                        style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover',
                                 flexShrink: 0, border: `1px solid ${P.border}` }}
                      />
                    : <span aria-hidden="true" style={{ width: 40, height: 40, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.1rem', backgroundColor: P.greenPale, borderRadius: 8 }}>🌱</span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>
                      {plant.name}
                      {plant.quantity > 1 && (
                        <span style={{ marginLeft: 8, fontSize: '0.78rem', color: P.mid,
                          backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 7px' }}>
                          ×{formatQty(plant.quantity)}
                        </span>
                      )}
                    </div>
                    {plant.variety_ref?.name && (
                      <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>{plant.variety_ref.name}</div>
                    )}
                  </div>
                </Link>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {/* Multi-channel status (WCAG 1.4.1): icon + label, never color alone. */}
                  {plant.status && <PlantStatusBadge status={plant.status} />}
                  {/* V2-PHOTO-F1 S2: per-plant upload trigger on each card. */}
                  <PhotoUpload
                    keyPrefix="plants"
                    parentId={plant.id}
                    linkage={{ plant_id: plant.id, project_id: id }}
                    errorMode="surface"
                    mode="both"
                    takeLabel="📷"
                    chooseLabel="🖼️"
                    showPreview={false}
                    inputId={`plant-photo-${plant.id}`}
                    buttonStyle={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 44, height: 44, padding: 0,
                      background: 'transparent', color: P.mid,
                      border: `1px solid ${P.border}`, borderRadius: '50%',
                      cursor: 'pointer', fontSize: '0.95rem', userSelect: 'none',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Project photos (V2-PHOTO-F1 Session 2) ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Project photos
          </h2>
        </div>
        <div style={{ ...cardStyle }}>
          <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: P.mid }}>
            Add photos directly to this project — they will appear in the Photo Library tagged with this project.
          </p>
          <PhotoUpload
            keyPrefix="projects"
            parentId={id}
            linkage={{ project_id: id }}
            errorMode="surface"
            mode="both"
            inputId={`project-photo-${id}`}
          />
        </div>
      </div>

      {/* ---- Event Log ---- */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.dark }}>
            Event log
            {events.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.82rem', color: P.light }}>
                ({events.length})
              </span>
            )}
          </h2>
          <button
            onClick={() => {
              setShowLogForm(v => !v)
              setLogErr(null)
              if (!showLogForm) setTimeout(() => logFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
            }}
            style={showLogForm ? ghostBtn : primaryBtn(false)}
          >
            {showLogForm ? 'Cancel' : '+ Log event'}
          </button>
        </div>

        {showLogForm && (
          <form ref={logFormRef} onSubmit={handleLogEvent} style={{ ...cardStyle, marginBottom: 20 }}>
            {logErr && <ErrBanner msg={logErr} />}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <FormRow label="Event type *">
                <select
                  value={eventForm.event_type}
                  onChange={e => setEventForm(f => ({ ...f, event_type: e.target.value }))}
                  style={inputStyle}
                >
                  {[...EVENT_TYPES].sort((a, b) => a.localeCompare(b)).map(t => (
                    <option key={t} value={t}>
                      {(EVENT_TYPE_META[t]?.emoji ?? '📝') + ' ' + t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </FormRow>

              <FormRow label="Date *">
                <input
                  type="date"
                  required
                  value={eventForm.event_date}
                  onChange={e => setEventForm(f => ({ ...f, event_date: e.target.value }))}
                  style={inputStyle}
                />
              </FormRow>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
              <FormRow label="Title (optional)">
                <input
                  value={eventForm.title}
                  onChange={e => setEventForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. First true leaves visible"
                  style={inputStyle}
                />
              </FormRow>
              <FormRow label="Quantity (optional)">
                <input
                  value={eventForm.quantity}
                  onChange={e => setEventForm(f => ({ ...f, quantity: e.target.value }))}
                  placeholder="e.g. 6 plants"
                  style={inputStyle}
                />
              </FormRow>
            </div>

            <FormRow label="Notes (public)">
              <textarea
                value={eventForm.notes}
                onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Visible on public page…"
                style={{ ...inputStyle, height: 64, resize: 'vertical' }}
              />
            </FormRow>

            <FormRow label="Private notes (never public)">
              <textarea
                value={eventForm.private_notes}
                onChange={e => setEventForm(f => ({ ...f, private_notes: e.target.value }))}
                placeholder="Dosage, stress signs, anything you don't want to share…"
                style={{ ...inputStyle, height: 52, resize: 'vertical', borderColor: P.warnBorder, backgroundColor: P.warn }}
              />
            </FormRow>

            {/* V2-PHOTO-F1 S2: inline photo capture for the mini-logger.
                Uses staged-file pattern (file picked here, uploaded after event POST). */}
            <FormRow label="Photo · optional">
              {miniPhotoPreview ? (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={miniPhotoPreview} alt="Preview"
                    style={{ maxWidth: '100%', maxHeight: 180, borderRadius: 8, display: 'block', border: `1px solid ${P.border}` }}
                  />
                  <button type="button" onClick={clearMiniPhoto}
                    aria-label="Remove staged photo"
                    style={{
                      position: 'absolute', top: 6, right: 6,
                      background: 'rgba(0,0,0,0.55)', color: P.white,
                      border: 'none', borderRadius: '50%',
                      width: 26, height: 26, cursor: 'pointer', fontSize: '0.8rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>✕</button>
                </div>
              ) : (
                <label
                  data-testid="mini-photo-label"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                    padding: '14px 12px', border: `2px dashed ${P.border}`, borderRadius: 8,
                    cursor: 'pointer', backgroundColor: P.cream, color: P.mid, fontSize: '0.85rem',
                  }}>
                  <span style={{ fontSize: '1.2rem' }}>📷</span>
                  <span>Tap to take or choose a photo</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleMiniPhotoChange}
                    style={{ display: 'none' }}
                    data-testid="mini-photo-input"
                  />
                </label>
              )}
            </FormRow>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <input
                id="ev_public"
                type="checkbox"
                checked={eventForm.is_public}
                onChange={e => setEventForm(f => ({ ...f, is_public: e.target.checked }))}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <label htmlFor="ev_public" style={{ fontSize: '0.88rem', color: P.mid, cursor: 'pointer' }}>
                Show on public page
              </label>
            </div>

            <div style={{ display: 'flex', gap: 12, paddingTop: 14, borderTop: `1px solid ${P.border}` }}>
              <button type="submit" disabled={loggingEvent} style={primaryBtn(loggingEvent)}>
                {loggingEvent ? 'Saving…' : 'Save event'}
              </button>
              <button type="button" onClick={() => { setShowLogForm(false); setLogErr(null) }} style={ghostBtn}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {eventsLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: P.light, fontSize: '0.875rem' }}>Loading…</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8, color: P.light, fontSize: '0.875rem' }}>
            No events yet — log the first one above.
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 18, top: 0, bottom: 0, width: 2, backgroundColor: P.border }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {events.map((ev, i) => (
                <EventRow
                  key={ev.id}
                  event={ev}
                  projectId={id}
                  isLast={i === events.length - 1}
                  deleting={deletingId === ev.id}
                  onDelete={() => handleDeleteEvent(ev.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Shell>
  )
}

function DeleteDialog({ childProjects, onArchive, onDelete, onCancel }) {
  const hasChildren = childProjects.length > 0
  const top3 = childProjects.slice(0, 3)
  const extra = childProjects.length - 3

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: P.white, borderRadius: 12, padding: 28,
        maxWidth: 440, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
          {hasChildren ? 'This project has sub-projects' : 'Delete project?'}
        </h2>

        {hasChildren && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: '0.88rem', color: P.mid }}>
              {childProjects.length} sub-project{childProjects.length !== 1 ? 's' : ''} will become top-level projects if you delete this one:
            </p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
              {top3.map(c => (
                <li key={c.id} style={{ fontSize: '0.85rem', color: P.dark, marginBottom: 3 }}>{c.name}</li>
              ))}
              {extra > 0 && (
                <li style={{ fontSize: '0.85rem', color: P.light }}>…and {extra} more</li>
              )}
            </ul>
          </div>
        )}

        {!hasChildren && (
          <p style={{ margin: '0 0 20px', fontSize: '0.88rem', color: P.mid }}>
            This will permanently remove the project. This action cannot be undone.
          </p>
        )}

        <p style={{ margin: '0 0 20px', fontSize: '0.83rem', color: P.light }}>
          Recommended: archive instead to keep the record without cluttering your active list.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={onArchive} style={{
            backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 6,
            padding: '10px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', textAlign: 'center',
          }}>
            Archive instead (recommended)
          </button>
          <button onClick={onDelete} style={{
            backgroundColor: 'transparent', color: P.terra,
            border: `1px solid ${P.alertBorder}`, borderRadius: 6,
            padding: '9px 20px', fontSize: '0.88rem', cursor: 'pointer',
          }}>
            Delete permanently
          </button>
          <button onClick={onCancel} style={ghostBtn}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Fields({ project: p, locPath }) {
  const rows = [
    ['Variety',     p.variety_ref?.name],
    ['Species',     p.variety_ref?.species],
    ['Start date',  p.start_date ? new Date(p.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null],
    ['Location',    locPath ? `📍 ${locPath}` : null],
    // BUG-08 (2.1.1): Slug line hidden from detail display (humans don't need it; still populated in DB).
    ['Description', p.description],
  ].filter(([, v]) => v)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: P.light, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
          <div style={{ fontSize: '0.9rem', color: P.dark }}>{value}</div>
        </div>
      ))}
      {rows.length === 0 && <p style={{ color: P.light, margin: 0 }}>No additional details.</p>}
    </div>
  )
}

function EventRow({ event: ev, projectId, isLast, deleting, onDelete }) {
  const icon = EVENT_TYPE_META[ev.event_type]?.emoji ?? '📝'
  const d = new Date(ev.event_date)
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <Link to={`/projects/${projectId}/events/${ev.id}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 18 }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        backgroundColor: P.white, border: `2px solid ${P.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1rem', flexShrink: 0, position: 'relative', zIndex: 1,
      }}>
        {icon}
      </div>

      <div style={{
        flex: 1, backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: isLast ? 0 : 2,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>
                {ev.title || ev.event_type.replace(/_/g, ' ')}
              </span>
              {ev.title && (
                <span style={{ fontSize: '0.75rem', color: P.light, fontStyle: 'italic' }}>
                  {ev.event_type.replace(/_/g, ' ')}
                </span>
              )}
              {ev.quantity && (
                <span style={{
                  fontSize: '0.73rem', color: P.mid,
                  backgroundColor: P.greenPale, borderRadius: 10, padding: '1px 7px',
                }}>
                  {ev.quantity}
                </span>
              )}
              {!ev.is_public && (
                <span style={{
                  fontSize: '0.7rem', color: P.light,
                  backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px',
                }}>
                  private
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', color: P.light, marginBottom: ev.notes || ev.private_notes ? 6 : 0 }}>
              {dateStr}
            </div>
            {ev.notes && (
              <p style={{ margin: '0 0 4px', color: P.mid, fontSize: '0.83rem', lineHeight: 1.5 }}>
                {ev.notes}
              </p>
            )}
            {ev.private_notes && (
              <p style={{
                margin: 0, color: P.mid, fontSize: '0.8rem', lineHeight: 1.5,
                backgroundColor: P.warn, borderRadius: 4, padding: '4px 8px',
                borderLeft: `3px solid ${P.warnBorder}`,
              }}>
                🔒 {ev.private_notes}
              </p>
            )}
          </div>
          <button
            onClick={(e) => { e.preventDefault(); onDelete() }}
            disabled={deleting}
            title="Delete event"
            style={{
              background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer',
              color: P.light, fontSize: '1rem', padding: '2px 4px', lineHeight: 1, flexShrink: 0,
            }}
          >
            {deleting ? '…' : '×'}
          </button>
        </div>
      </div>
    </Link>
  )
}

function daysAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }
function ErrBanner({ msg }) {
  return <div style={{ backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: '0.875rem', color: '#7a2a10' }}>{msg}</div>
}
function FormRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: P.mid, marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

const inputStyle = { width: '100%', padding: '8px 11px', border: `1px solid ${P.border}`, borderRadius: 6, fontSize: '0.88rem', backgroundColor: P.white, boxSizing: 'border-box' }
const cardStyle  = { backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 28 }
const primaryBtn = (disabled) => ({ backgroundColor: disabled ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' })
const ghostBtn   = { backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 6, padding: '9px 20px', fontSize: '0.88rem', cursor: 'pointer' }
const outlineBtn = { backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.greenLight}`, borderRadius: 6, padding: '7px 18px', fontSize: '0.85rem', cursor: 'pointer' }
