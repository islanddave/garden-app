import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'

const PLANT_STATUSES = ['seed', 'seedling', 'vegetative', 'flowering', 'fruiting', 'harvested', 'dormant', 'ended', 'failed']

function ErrBanner({ msg }) {
  return <div role="alert" style={{ padding: '10px 14px', backgroundColor: P.alert, color: P.terra, borderRadius: 8, fontSize: '0.85rem', marginBottom: 12 }}>{msg}</div>
}

export default function Plants() {
  const { fetch } = useApiFetch()
  const [plants,     setPlants]     = useState([])
  const [projects,   setProjects]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  const [form,       setForm]       = useState({ name: '', genus: '', species: '', variety: '', quantity: '1', notes: '', status: '', project_id: '' })
  const [saving,     setSaving]     = useState(false)
  const [err,        setErr]        = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [editForm,   setEditForm]   = useState(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editErr,    setEditErr]    = useState(null)
  const [deleting,   setDeleting]   = useState(null)

  useEffect(() => {
    let mounted = true
    Promise.all([
      fetch('/api/plants'),
      fetch('/api/projects'),
    ]).then(([plantsData, projData]) => {
      if (!mounted) return
      setPlants(plantsData ?? [])
      setProjects(projData ?? [])
      if (projData?.length) setForm(f => ({ ...f, project_id: projData[0].id }))
      setLoading(false)
    }).catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [fetch])

  async function handleAdd(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    const qty = parseInt(form.quantity, 10)
    try {
      const data = await fetch('/api/plants', {
        method: 'POST',
        body: JSON.stringify({
          project_id: form.project_id,
          name:       form.name.trim(),
          genus:      form.genus.trim()    || null,
          species:    form.species.trim()  || null,
          variety:    form.variety.trim()  || null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      form.notes.trim()    || null,
          status:     form.status          || null,
        }),
      })
      // POST returns raw row without project_name JOIN — merge client-side
      const proj = projects.find(p => p.id === form.project_id)
      setPlants(p => [{ ...data, project_name: data.project_name ?? proj?.name }, ...p])
      setForm(f => ({ ...f, name: '', genus: '', species: '', variety: '', quantity: '1', notes: '', status: '' }))
      setShowAdd(false)
    } catch (error) {
      setErr(error.message)
    } finally {
      setSaving(false)
    }
  }

  function startEdit(plant) {
    setExpandedId(plant.id)
    setEditForm({ name: plant.name, genus: plant.genus ?? '', species: plant.species ?? '', variety: plant.variety ?? '', quantity: String(plant.quantity ?? 1), notes: plant.notes ?? '', status: plant.status ?? '' })
    setEditErr(null)
  }

  function closeEdit() { setExpandedId(null); setEditForm(null) }

  async function handleEdit(e, id) {
    e.preventDefault()
    setEditSaving(true); setEditErr(null)
    const qty = parseInt(editForm.quantity, 10)
    try {
      const data = await fetch('/api/plants/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name:     editForm.name.trim(),
          genus:    editForm.genus.trim()    || null,
          species:  editForm.species.trim()  || null,
          variety:  editForm.variety.trim()  || null,
          quantity: isNaN(qty) || qty < 1 ? 1 : qty,
          notes:    editForm.notes.trim()    || null,
          status:   editForm.status          || null,
        }),
      })
      // PUT returns raw row without project_name — preserve existing
      setPlants(p => p.map(pl => pl.id === id ? { ...data, project_name: data.project_name ?? pl.project_name } : pl))
      closeEdit()
    } catch (error) {
      setEditErr(error.message)
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDelete(id) {
    setDeleting(id)
    try {
      await fetch('/api/plants/' + id, { method: 'DELETE' })
      setPlants(p => p.filter(pl => pl.id !== id))
    } catch {
      // non-fatal
    } finally {
      setDeleting(null); closeEdit()
    }
  }

  const bdr  = `1px solid ${P.border}`
  const card = { backgroundColor: P.white, border: bdr, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }
  const inp  = { width: '100%', padding: '9px 12px', border: bdr, borderRadius: 8, fontSize: '0.92rem', backgroundColor: P.white, boxSizing: 'border-box', color: P.dark }
  const pBtn = dis => ({ padding: '10px 20px', backgroundColor: dis ? P.greenLight : P.green, color: '#fff', border: 'none', borderRadius: 8, fontSize: '0.9rem', fontWeight: 600, cursor: dis ? 'not-allowed' : 'pointer' })
  const gBtn = { padding: '9px 16px', backgroundColor: 'transparent', color: P.mid, border: bdr, borderRadius: 8, fontSize: '0.9rem', cursor: 'pointer' }
  const lbl  = { fontSize: '0.8rem', color: P.mid, display: 'block', marginBottom: 4 }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: P.dark }}>🌿 Plants</h1>
        <button onClick={() => { setShowAdd(v => !v); setErr(null) }}
          style={showAdd ? gBtn : { ...pBtn(false), fontSize: '0.85rem', padding: '8px 14px' }}>
          {showAdd ? 'Cancel' : '+ New Plant'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} style={{ ...card, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, color: P.green }}>Add plant</div>
          {err && <ErrBanner msg={err} />}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="plant-name" style={lbl}>Name *</label>
              <input id="plant-name" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Tomato" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-genus" style={lbl}>Genus</label>
              <input id="plant-genus" value={form.genus} onChange={e => setForm(f => ({ ...f, genus: e.target.value }))} placeholder="e.g. Solanum" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-species" style={lbl}>Species</label>
              <input id="plant-species" value={form.species} onChange={e => setForm(f => ({ ...f, species: e.target.value }))} placeholder="e.g. lycopersicum" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-variety" style={lbl}>Variety</label>
              <input id="plant-variety" value={form.variety} onChange={e => setForm(f => ({ ...f, variety: e.target.value }))} placeholder="e.g. Sun Gold" style={inp} />
            </div>
            <div>
              <label htmlFor="plant-quantity" style={lbl}>Quantity</label>
              <input id="plant-quantity" type="number" min="1" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} style={inp} />
            </div>
            <div>
              <label htmlFor="plant-status" style={lbl}>Status</label>
              <select id="plant-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>
                <option value="">— none —</option>
                {PLANT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="plant-project" style={lbl}>Project *</label>
              <select id="plant-project" required value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={inp}>
                {projects.length === 0 && <option value="">No projects yet</option>}
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="plant-notes" style={lbl}>Notes</label>
              <input id="plant-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" style={inp} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" disabled={saving} style={pBtn(saving)}>{saving ? 'Adding…' : 'Add plant'}</button>
            <button type="button" onClick={() => setShowAdd(false)} style={gBtn}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <p style={{ color: P.light, textAlign: 'center', marginTop: 40 }}>Loading…</p>
      ) : plants.length === 0 ? (
        <p style={{ color: P.light, textAlign: 'center', marginTop: 40 }}>No plants yet — add one above.</p>
      ) : plants.map(plant => (
        <div key={plant.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: P.dark }}>🌿 {plant.name}</span>
                {plant.quantity > 1 && <span style={{ fontSize: '0.78rem', color: P.green, fontWeight: 600 }}>×{plant.quantity}</span>}
                {plant.status && <span style={{ fontSize: '0.72rem', backgroundColor: P.greenPale, color: P.green, padding: '2px 8px', borderRadius: 20 }}>{plant.status}</span>}
                <FavoriteToggle entityType="plant" entityId={plant.id} />
              </div>
              {(plant.genus || plant.species) && (
                <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2, fontStyle: 'italic' }}>
                  {[plant.genus, plant.species].filter(Boolean).join(' ')}
                </div>
              )}
              {plant.variety && <div style={{ fontSize: '0.8rem', color: P.light, marginTop: 2 }}>{plant.variety}</div>}
              <div style={{ fontSize: '0.75rem', marginTop: 4 }}>
                <Link to={`/projects/${plant.project_id}`} style={{ color: P.green, textDecoration: 'none' }}>
                  {plant.project_name ?? 'Project'}
                </Link>
              </div>
            </div>
            <button onClick={() => expandedId === plant.id ? closeEdit() : startEdit(plant)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.light, fontSize: '0.82rem', padding: '4px 8px', whiteSpace: 'nowrap' }}>
              {expandedId === plant.id ? 'Close' : 'Edit'}
            </button>
          </div>

          {expandedId === plant.id && editForm && (
            <form onSubmit={e => handleEdit(e, plant.id)} style={{ marginTop: 14, paddingTop: 14, borderTop: bdr }}>
              {editErr && <ErrBanner msg={editErr} />}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-name" style={lbl}>Name *</label>
                  <input id="plant-edit-name" required value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-genus" style={lbl}>Genus</label>
                  <input id="plant-edit-genus" value={editForm.genus} onChange={e => setEditForm(f => ({ ...f, genus: e.target.value }))} placeholder="e.g. Solanum" style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-species" style={lbl}>Species</label>
                  <input id="plant-edit-species" value={editForm.species} onChange={e => setEditForm(f => ({ ...f, species: e.target.value }))} placeholder="e.g. lycopersicum" style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-variety" style={lbl}>Variety</label>
                  <input id="plant-edit-variety" value={editForm.variety} onChange={e => setEditForm(f => ({ ...f, variety: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label htmlFor="plant-edit-qty" style={lbl}>Qty</label>
                  <input id="plant-edit-qty" type="number" min="1" value={editForm.quantity} onChange={e => setEditForm(f => ({ ...f, quantity: e.target.value }))} style={inp} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-status" style={lbl}>Status</label>
                  <select id="plant-edit-status" value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} style={inp}>
                    <option value="">— none —</option>
                    {PLANT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="plant-edit-notes" style={lbl}>Notes</label>
                  <input id="plant-edit-notes" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} style={inp} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button type="submit" disabled={editSaving} style={pBtn(editSaving)}>{editSaving ? 'Saving…' : 'Save'}</button>
                <button type="button" onClick={closeEdit} style={gBtn}>Cancel</button>
                <button type="button" disabled={deleting === plant.id} onClick={() => handleDelete(plant.id)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: P.terra, fontSize: '0.82rem', cursor: 'pointer' }}>
                  {deleting === plant.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </form>
          )}
        </div>
      ))}
    </div>
  )
}
