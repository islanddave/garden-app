// V3-CAPTURE-001 — Photo-first universal create. Snap a photo, then turn it into:
//   • a new planting (project-less OK; V4 tagging will group it later)
//   • a logged event on an existing planting
//   • a replacement featured photo on an existing planting
//   • a new inventory item
// Save & Next keeps the camera primed for rapid field capture; each save shows an
// inline (non-toast) Undo on the just-created row before the next snap.
//
// V4-FORMSYS-SNAP-001 (Dave: "the choice list on Snap is out of conformity"): the form
// fields + Back/Save/Next buttons use the canonical forms/ primitives (Field/Input/Select/
// Button) instead of the old bespoke field/primaryBtn/ghostBtn/local <Label>. The photo
// take/choose picker and the mode cards are distinct affordances and keep their own styling.
import React, { useState, useEffect, useRef } from 'react'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import { SAVE_TO_DEVICE_HIDDEN } from '../lib/featureFlags.js'
import { useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { EVENT_TYPES, EVENT_TYPE_META } from '../lib/eventTypes.js'
import { INVENTORY_TYPES, INVENTORY_CATEGORIES, INVENTORY_UNITS } from '../lib/inventoryEnums.js'
import { P } from '../lib/constants.js'
import Field from '../components/forms/Field.jsx'
import Input from '../components/forms/Input.jsx'
import Select from '../components/forms/Select.jsx'
import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import Button from '../components/forms/Button.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'

const MODES = [
  { id: 'planting',  label: 'New planting',     hint: 'Create a planting, this photo becomes its picture' },
  { id: 'event',     label: 'Log on a planting', hint: 'Attach this photo to an event (Watered, Harvested…)' },
  { id: 'replace',   label: 'Update a photo',    hint: 'Set this as an existing planting’s photo' },
  { id: 'inventory', label: 'Add inventory',     hint: 'Create a supply/equipment item with this photo' },
]
const todayStr = () => todayLocalISO()
const card = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 16 }
const fieldStack = { display: 'flex', flexDirection: 'column', gap: 12 }
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
    const r = await uploader.upload(file, { keyPrefix, parentId, linkage, is_public: true })
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
          project_id: pl.project_id ?? null, plant_id: pl.id, event_type: evType, event_date: evDate, is_public: true,
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
      {/* BUG-SNAPRETAKE-001 — this input is mounted for EVERY step, deliberately, and must stay
          that way. It used to live inside the `step === 'photo'` block, but the "Retake / choose
          photo" control sits in `step === 'mode'`, i.e. it is only reachable AFTER onPick() has
          advanced the step and unmounted the input. openPicker() then read a null fileRef and hit
          its `if (!el) return`, so the tap produced no picker, no camera, no clear and no error —
          the button was dead in exactly the state it exists to serve.
          The early return is correct defensively; the bug was the ref being legitimately null.
          Keeping the input outside the step conditionals is what makes it never null. */}
      <input ref={fileRef} data-testid="capture-input" type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />

      {preview && (
        <div style={{ marginBottom: 14 }}>
          <img src={preview} alt="capture preview" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
          {file && !SAVE_TO_DEVICE_HIDDEN && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
              <button type="button" onClick={() => saveFileToDevice(file)} aria-label="Save photo to device"
                style={{ border: `1px solid ${P.border}`, borderRadius: 8, padding: '5px 12px', background: P.white, color: P.mid, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                Save to device
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'photo' && (
        <div style={{ ...card, textAlign: 'center' }}>
          <p style={{ color: P.mid, marginTop: 0 }}>Take or choose a photo to begin.</p>
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
          <Button variant="secondary" onClick={() => openPicker(false)}>Retake / choose photo</Button>
        </div>
      )}

      {step === 'form' && (
        <div style={card}>
          <div style={fieldStack}>
            {mode === 'planting' && (
              <>
                <Field label="Planting name">
                  <Input data-testid="cap-pname" value={pName} onChange={e => setPName(e.target.value)} placeholder="e.g. Charentais melon" />
                </Field>
                <Field label="Variety" optional>
                  <Select value={pVariety} onChange={e => setPVariety(e.target.value)}>
                    <option value="">— none —</option>
                    {varieties.map(v => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
                  </Select>
                </Field>
                <Note>No project needed — you’ll group it with tags in the V4 update.</Note>
              </>
            )}
            {mode === 'event' && (
              <>
                <Field label="Planting">
                  {/* V4-PLANTPICKER-001: shared searchable picker (unscoped list is garden-sized) */}
                  <PlantingSelect data-testid="cap-evplant" plants={plantings} value={evPlant}
                    onChange={id => setEvPlant(id)} labelFormat="bare" placeholder="— pick a planting —" />
                </Field>
                <Field label="Event">
                  <Select value={evType} onChange={e => setEvType(e.target.value)}>
                    {EVENT_TYPES.map(t => <option key={t} value={t}>{EVENT_TYPE_META[t]?.label ?? t}</option>)}
                  </Select>
                </Field>
                <Field label="Date">
                  <Input type="date" value={evDate} onChange={e => setEvDate(e.target.value)} />
                </Field>
              </>
            )}
            {mode === 'replace' && (
              <>
                <Field label="Planting to update">
                  {/* V4-PLANTPICKER-001: shared searchable picker (unscoped list is garden-sized) */}
                  <PlantingSelect data-testid="cap-rpplant" plants={plantings} value={rpPlant}
                    onChange={id => setRpPlant(id)} labelFormat="bare" placeholder="— pick a planting —" />
                </Field>
                <Note>This photo becomes the planting’s featured picture.</Note>
              </>
            )}
            {mode === 'inventory' && (
              <>
                <Field label="Item name">
                  <Input data-testid="cap-invname" value={invName} onChange={e => setInvName(e.target.value)} placeholder="e.g. Pro-Mix HP" />
                </Field>
                <Field label="Type">
                  <Select value={invType} onChange={e => { setInvType(e.target.value) }}>
                    {INVENTORY_TYPES.map(t => <option key={t.value} value={t.value}>{t.value}</option>)}
                  </Select>
                </Field>
                <Field label="Category">
                  <Select value={invCat} onChange={e => setInvCat(e.target.value)}>
                    {INVENTORY_CATEGORIES.filter(c => c.types.includes(invType)).map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
                  </Select>
                </Field>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Field label="Quantity" style={{ flex: 1 }}>
                    <Input type="number" min="0" value={invQty} onChange={e => setInvQty(e.target.value)} />
                  </Field>
                  {invType === 'consumable' && (
                    <Field label="Unit" style={{ flex: 1 }}>
                      <Select value={invUnit} onChange={e => setInvUnit(e.target.value)}>
                        {INVENTORY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                      </Select>
                    </Field>
                  )}
                </div>
              </>
            )}
          </div>
          {err && <p style={{ color: P.terra, fontSize: '0.85rem' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="secondary" disabled={saving} onClick={() => { setStep('mode'); setErr(null) }}>Back</Button>
            <Button data-testid="cap-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save}>Save</Button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={card}>
          <div data-testid="cap-result" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontWeight: 600, color: undone ? P.light : P.green, textDecoration: undone ? 'line-through' : 'none' }}>
              {undone ? 'Undone' : result.label}
            </span>
            {!undone && <Button data-testid="cap-undo" variant="secondary" disabled={saving} onClick={doUndo} style={{ minHeight: 34, padding: '5px 12px' }}>Undo</Button>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button data-testid="cap-next" variant="primary" onClick={resetForNext}>Save &amp; Next — snap another</Button>
            <Button variant="secondary" onClick={() => navigate('/today')}>Done</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Note({ children }) {
  return <p style={{ fontSize: '0.78rem', color: P.light, marginTop: 10 }}>{children}</p>
}
