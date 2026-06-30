// V3-CAPTURE-001 — Photo-first universal create. Snap a photo, then turn it into:
//   • a new planting (project-less OK; V4 tagging will group it later)
//   • a logged event on an existing planting
//   • a replacement featured photo on an existing planting
//   • a new inventory item
// Save & Next keeps the camera primed for rapid field capture; each save shows an
// inline (non-toast) Undo on the just-created row before the next snap.
import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { EVENT_TYPES, EVENT_TYPE_META } from '../lib/eventTypes.js'
import { INVENTORY_TYPES, INVENTORY_CATEGORIES, INVENTORY_UNITS } from '../lib/inventoryEnums.js'
import { P } from '../lib/constants.js'

const MODES = [
  { id: 'planting',  label: 'New planting',     hint: 'Create a planting, this photo becomes its picture' },
  { id: 'event',     label: 'Log on a planting', hint: 'Attach this photo to an event (Watered, Harvested…)' },
  { id: 'replace',   label: 'Update a photo',    hint: 'Set this as an existing planting’s photo' },
  { id: 'inventory', label: 'Add inventory',     hint: 'Create a supply/equipment item with this photo' },
]
const todayStr = () => new Date().toISOString().slice(0, 10)
const card = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 16 }
const field = { width: '100%', padding: '9px 10px', borderRadius: 6, border: `1px solid ${P.border}`, fontSize: '0.9rem', boxSizing: 'border-box' }
const primaryBtn = (d) => ({ backgroundColor: d ? P.light : P.green, color: P.white, border: 'none', borderRadius: 6, padding: '11px 20px', fontSize: '0.92rem', fontWeight: 600, cursor: d ? 'not-allowed' : 'pointer' })
const ghostBtn = { backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 6, padding: '10px 18px', fontSize: '0.9rem', cursor: 'pointer' }
const pickBtn = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', border: `2px dashed ${P.border}`, borderRadius: 8, cursor: 'pointer', backgroundColor: P.white, color: P.mid, fontSize: '0.88rem', fontWeight: 600 }

export default function CaptureFlow() {
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const uploader = useUploadPhoto({ errorMode: 'surface' })

  const [step, setStep]   = useState('photo')   // photo | mode | form | done
  const [file, setFile]   = useState(null)
  const [preview, setPreview] = useState(null)
  const [mode, setMode]   = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr]     = useState(null)
  const [result, setResult] = useState(null)     // { kind, id, label, undo }
  const fileRef = useRef(null)
  // V4-SNAPPICK-001: one hidden input, capture toggled per choice so SNAP offers BOTH
  // take-photo and choose-photo (mirrors EventNew openPhotoPicker / <PhotoUpload mode="both">).
  function openPicker(useCamera) {
    const el = fileRef.current
    if (!el) return
    if (useCamera) el.setAttribute('capture', 'environment')
    else el.removeAttribute('capture')
    el.click()
  }

  const [plantings, setPlantings] = useState([])
  const [varieties, setVarieties] = useState([])
  // mode forms
  const [pName, setPName]   = useState('')
  const [pVariety, setPVariety] = useState('')
  const [evPlant, setEvPlant] = useState('')
  const [evType, setEvType]   = useState('watering')
  const [evDate, setEvDate]   = useState(todayStr())
  const [rpPlant, setRpPlant] = useState('')
  const [invName, setInvName] = useState('')
  const [invType, setInvType] = useState('consumable')
  const [invCat, setInvCat]   = useState('other')
  const [invQty, setInvQty]   = useState('1')
  const [invUnit, setInvUnit] = useState('each')

  useEffect(() => {
    let off = false
    Promise.all([fetch('/api/plants'), fetch('/api/varieties').catch(() => [])])
      .then(([pl, vr]) => { if (!off) { setPlantings(Array.isArray(pl) ? pl : []); setVarieties(Array.isArray(vr) ? vr : []) } })
      .catch(() => {})
    return () => { off = true }
  }, [fetch])

  function onPick(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(URL.createObjectURL(f))
    setErr(null)
    setStep('mode')
  }

  function resetForNext() {
    if (preview) URL.revokeObjectURL(preview)
    setFile(null); setPreview(null); setMode(null); setResult(null); setErr(null)
    setPName(''); setPVariety(''); setEvPlant(''); setEvType('watering'); setEvDate(todayStr())
    setRpPlant(''); setInvName(''); setInvType('consumable'); setInvCat('other'); setInvQty('1'); setInvUnit('each')
    setStep('photo')
  }

  async function attach(linkage, keyPrefix, parentId) {
    const r = await uploader.upload(file, { keyPrefix, parentId, linkage, is_public: false })
    if (r?.error) throw new Error(r.error)
    return r.photo
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      if (mode === 'planting') {
        if (!pName.trim()) throw new Error('Give the planting a name')
        const plant = await fetch('/api/plants', { method: 'POST', body: JSON.stringify({
          name: pName.trim(), variety_id: pVariety || null, project_id: null, quantity: 1, status: 'seedling',
        }) })
        await attach({ plant_id: plant.id }, 'plants', plant.id)
        setResult({ kind: 'planting', id: plant.id, label: `Planting “${plant.name ?? pName.trim()}” created`,
          undo: () => fetch('/api/plants/' + plant.id + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: true }) }) })
      } else if (mode === 'event') {
        const pl = plantings.find(p => p.id === evPlant)
        if (!pl) throw new Error('Pick a planting')
        const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify({
          project_id: pl.project_id ?? null, plant_id: pl.id, event_type: evType, event_date: evDate, is_public: false,
        }) })
        const eventId = res?.eventId ?? res?.id
        await attach({ event_id: eventId, plant_id: pl.id }, 'events', eventId)
        setResult({ kind: 'event', id: eventId, label: `${EVENT_TYPE_META[evType]?.label ?? evType} logged on ${pl.name}`,
          undo: () => fetch('/api/events/' + eventId, { method: 'DELETE' }) })
      } else if (mode === 'replace') {
        const pl = plantings.find(p => p.id === rpPlant)
        if (!pl) throw new Error('Pick a planting')
        const prior = pl.featured_photo_id ?? null
        const photo = await attach({ plant_id: pl.id }, 'plants', pl.id)
        await fetch('/api/plants/' + pl.id, { method: 'PUT', body: JSON.stringify({ featured_photo_id: photo.id }) })
        setResult({ kind: 'replace', id: pl.id, label: `Photo updated on ${pl.name}`,
          undo: () => fetch('/api/plants/' + pl.id, { method: 'PUT', body: JSON.stringify({ featured_photo_id: prior }) }) })
      } else if (mode === 'inventory') {
        if (!invName.trim()) throw new Error('Give the item a name')
        const body = { name: invName.trim(), type: invType, category: invCat }
        if (invType === 'consumable') { body.quantity_on_hand = Number(invQty) || 0; body.unit = invUnit }
        else { body.quantity = Number(invQty) || 0 }
        const item = await fetch('/api/inventory-items', { method: 'POST', body: JSON.stringify(body) })
        await attach({ inventory_item_id: item.id }, 'inventory', item.id)
        setResult({ kind: 'inventory', id: item.id, label: `Inventory “${item.name ?? invName.trim()}” added`,
          undo: () => fetch('/api/inventory-items/' + item.id, { method: 'DELETE' }) })
      }
      setStep('done')
    } catch (e) {
      setErr(e?.message || 'Save failed')
    }
    setSaving(false)
  }

  const [undone, setUndone] = useState(false)
  async function doUndo() {
    if (!result?.undo) return
    setSaving(true)
    try { await result.undo(); setUndone(true) } catch (e) { setErr(e?.message || 'Undo failed') }
    setSaving(false)
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>📸 Snap</h1>
        <button onClick={() => navigate(-1)} style={ghostBtn}>Close</button>
      </div>

      {preview && (
        <img src={preview} alt="capture preview" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 10, marginBottom: 14 }} />
      )}

      {step === 'photo' && (
        <div style={{ ...card, textAlign: 'center' }}>
          <p style={{ color: P.mid, marginTop: 0 }}>Take or choose a photo to begin.</p>
          <input ref={fileRef} data-testid="capture-input" type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button data-testid="cap-take" type="button" onClick={() => openPicker(true)} style={pickBtn}>
              <span style={{ fontSize: '1.3rem' }}>📷</span><span>Take photo</span>
            </button>
            <button data-testid="cap-choose" type="button" onClick={() => openPicker(false)} style={pickBtn}>
              <span style={{ fontSize: '1.3rem' }}>🖼️</span><span>Choose photo</span>
            </button>
          </div>
        </div>
      )}

      {step === 'mode' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {MODES.map(m => (
            <button key={m.id} data-testid={`mode-${m.id}`} onClick={() => { setMode(m.id); setStep('form') }}
              style={{ ...card, textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700, color: P.green }}>{m.label}</div>
              <div style={{ fontSize: '0.82rem', color: P.light, marginTop: 2 }}>{m.hint}</div>
            </button>
          ))}
          <button type="button" onClick={() => openPicker(false)} style={ghostBtn}>Retake / choose photo</button>
        </div>
      )}

      {step === 'form' && (
        <div style={card}>
          {mode === 'planting' && (
            <>
              <Label>Planting name</Label>
              <input data-testid="cap-pname" value={pName} onChange={e => setPName(e.target.value)} placeholder="e.g. Charentais melon" style={field} />
              <Label>Variety (optional)</Label>
              <select value={pVariety} onChange={e => setPVariety(e.target.value)} style={field}>
                <option value="">— none —</option>
                {varieties.map(v => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
              </select>
              <Note>No project needed — you’ll group it with tags in the V4 update.</Note>
            </>
          )}
          {mode === 'event' && (
            <>
              <Label>Planting</Label>
              <select data-testid="cap-evplant" value={evPlant} onChange={e => setEvPlant(e.target.value)} style={field}>
                <option value="">— pick a planting —</option>
                {plantings.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Label>Event</Label>
              <select value={evType} onChange={e => setEvType(e.target.value)} style={field}>
                {EVENT_TYPES.map(t => <option key={t} value={t}>{EVENT_TYPE_META[t]?.label ?? t}</option>)}
              </select>
              <Label>Date</Label>
              <input type="date" value={evDate} onChange={e => setEvDate(e.target.value)} style={field} />
            </>
          )}
          {mode === 'replace' && (
            <>
              <Label>Planting to update</Label>
              <select data-testid="cap-rpplant" value={rpPlant} onChange={e => setRpPlant(e.target.value)} style={field}>
                <option value="">— pick a planting —</option>
                {plantings.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Note>This photo becomes the planting’s featured picture.</Note>
            </>
          )}
          {mode === 'inventory' && (
            <>
              <Label>Item name</Label>
              <input data-testid="cap-invname" value={invName} onChange={e => setInvName(e.target.value)} placeholder="e.g. Pro-Mix HP" style={field} />
              <Label>Type</Label>
              <select value={invType} onChange={e => { setInvType(e.target.value); }} style={field}>
                {INVENTORY_TYPES.map(t => <option key={t.value} value={t.value}>{t.value}</option>)}
              </select>
              <Label>Category</Label>
              <select value={invCat} onChange={e => setInvCat(e.target.value)} style={field}>
                {INVENTORY_CATEGORIES.filter(c => c.types.includes(invType)).map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}><Label>Quantity</Label>
                  <input type="number" min="0" value={invQty} onChange={e => setInvQty(e.target.value)} style={field} /></div>
                {invType === 'consumable' && (
                  <div style={{ flex: 1 }}><Label>Unit</Label>
                    <select value={invUnit} onChange={e => setInvUnit(e.target.value)} style={field}>
                      {INVENTORY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select></div>
                )}
              </div>
            </>
          )}
          {err && <p style={{ color: P.terra, fontSize: '0.85rem' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => { setStep('mode'); setErr(null) }} disabled={saving} style={ghostBtn}>Back</button>
            <button data-testid="cap-save" onClick={save} disabled={saving} style={primaryBtn(saving)}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={card}>
          <div data-testid="cap-result" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontWeight: 600, color: undone ? P.light : P.green, textDecoration: undone ? 'line-through' : 'none' }}>
              {undone ? 'Undone' : result.label}
            </span>
            {!undone && <button data-testid="cap-undo" onClick={doUndo} disabled={saving} style={{ ...ghostBtn, padding: '5px 12px' }}>Undo</button>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button data-testid="cap-next" onClick={resetForNext} style={primaryBtn(false)}>Save &amp; Next — snap another</button>
            <button onClick={() => navigate('/today')} style={ghostBtn}>Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Label({ children }) {
  return <label style={{ display: 'block', fontSize: '0.78rem', color: P.mid, fontWeight: 600, margin: '12px 0 4px' }}>{children}</label>
}
function Note({ children }) {
  return <p style={{ fontSize: '0.78rem', color: P.light, marginTop: 10 }}>{children}</p>
}
