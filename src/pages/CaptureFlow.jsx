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
import React, { useState, useEffect, useRef, useId } from 'react'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
import { SAVE_TO_DEVICE_HIDDEN } from '../lib/featureFlags.js'
import { useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { EVENT_TYPE_META, creatableEventTypes } from '../lib/eventTypes.js'
import { PLANTING_REQUIRED_ENABLED } from '../lib/featureFlags.js'
import { INVENTORY_TYPES, INVENTORY_CATEGORIES, INVENTORY_UNITS } from '../lib/inventoryEnums.js'
import { P } from '../lib/constants.js'
import Field from '../components/forms/Field.jsx'
import Input from '../components/forms/Input.jsx'
import Select from '../components/forms/Select.jsx'
import PlantingSelect, { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import Button from '../components/forms/Button.jsx'
// Direct import, NOT via the forms barrel: formsPrimitivesFreeze.test.js pins the barrel's export
// set exactly, and buttonChrome is shared chrome rather than a frozen primitive. Same idiom, same
// reason, as ToastContext.jsx's toastStackBottom import.
import { buttonChrome } from '../components/forms/formStyles.js'
// V4-PLANTFORMUNIFY-001 (BD-014) ⊇ V4-SNAPVARIETY-001 (BD-015): Snap was the LAST add/edit-planting
// surface still hand-rolling its own fields (a bare name Input + a read-only <Select> over
// pre-fetched varieties). Every other create path — Garden add/edit and the Sow sheet via
// PlantingEditor, ProjectDetail's "+ Add planting" — already renders this same PlantForm. Adopting
// it here is what closes BOTH rows: PlantForm hosts VarietyPicker (PlantForm.jsx:94), and
// VarietyPicker owns the two-legged create (crop type -> variety, VarietyPicker.jsx submitNewCropType),
// which is precisely the capability BD-015 says is missing — Dave could not capture "Hydrangeas"
// because no hydrangea crop type existed and Snap could only pick from what was already there.
// PlantForm is ALREADY in the frozen barrel set (FROZEN.md / formsPrimitivesFreeze.test.js), so this
// adoption needs no freeze change; that freeze is a reason to use it, not to route around it.
import { PlantForm } from '../components/forms/index.js'
// V4-CROPLISTORDER-001 (BD-010): crop-rank ledger write on the event save below.
import { recordCropLog } from '../lib/cropLogLedger.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'

// V4-DIRTYGUARDSWEEP-001 — draft-stash route key (siblings: 'logone', 'logmany').
const DRAFT_KEY = 'snap'

// V4-PICKERGATE-001 — the two event destinations offer only what they can actually POST.
//
// Neither carries a capture panel: both submit branches build a flat body with no `harvest` key and
// no `metadata` key (see submit()), so harvest / failed / given_away were guaranteed 400s here.
// Snap is the fast path — photo first, three fields, save — and a required-field panel is exactly
// what it is not; the surface that owns those types is Log Event, which has them.
const EVENT_DEST_TYPES = creatableEventTypes({
  // The event destination always has a planting: submit() throws 'Pick a planting' without one.
  capturePanels: false, plantScoped: true,
})

// The location destination POSTs plant_id: null BY CONSTRUCTION — the place is the subject, and the
// submit branch says so in its own comment. So every type in the D2 predication partition
// (PLANTING_REQUIRED_TYPES) is unloggable here: there is no planting for the event to predicate on.
//
// Gated on PLANTING_REQUIRED_ENABLED like every other requiresPlanting() call site
// (EventNew.handleSubmit, ProjectDetail.handleLogEvent). That flag is the rollback lever for the
// whole D2 rule, and a consequence of the rule that does not roll back with it is a lever that only
// half works. Flag OFF leaves the capture-panel arm, which is unconditional because the SERVER
// enforces those three regardless of any client flag.
const LOCATION_DEST_TYPES = creatableEventTypes({
  capturePanels: false, plantScoped: !PLANTING_REQUIRED_ENABLED,
})

// V4-SNAPDEST-001 (BD0806-08) — 'location' is the destination this row was actually missing. Snap
// could only ever aim a photo at a PLANTING or an inventory item, so anything about the place itself
// — a bed edge washing out, a trellis leaning, a new fence line — had no home and got logged against
// whichever planting happened to be nearby, which is a lie about what the photo shows.
//
// ORDER IS PART OF THE ROW. 'location' sits directly after 'planting'/'event' because it is the same
// KIND of act (log something that happened), and 'inventory' stays LAST — the row asks for "Add
// Inventory to the bottom" and it is the only destination that creates a supply record rather than a
// garden observation. Appending 'location' after it would have quietly undone that.
const MODES = [
  { id: 'planting',  label: 'New planting',      hint: 'Create a planting, this photo becomes its picture' },
  { id: 'event',     label: 'Log on a planting', hint: 'Attach this photo to an event (Watered, Harvested…)' },
  { id: 'location',  label: 'Log on a location', hint: 'Attach this photo to a bed, area or structure — no planting needed' },
  { id: 'replace',   label: 'Update a photo',    hint: 'Set this as an existing planting’s photo' },
  { id: 'inventory', label: 'Add inventory',     hint: 'Create a supply/equipment item with this photo' },
]
// V4-SNAPTOAST-001 (BD-008 + BD0806-09) — "go to the thing I just saved", per destination.
//
// THE ROW'S PREMISE IS INVERTED, and the fix is scoped to the half that survived checking. The row
// says Snap "lacks Log Event's post-save toaster options". Log Event's toaster (ToastContext
// showUndo -> UndoToast) offers exactly two controls — Undo and ×-dismiss — on a 5s timer, and NO
// navigation link at all; its overlay sibling PostSaveFeedback offers Undo plus two static text
// lines and pins "the strip's zero-link count" as an invariant (PostSaveFeedback.jsx:144). Snap's
// done card already offered Undo + Save & Next + Done, i.e. MORE actions than the toaster, so
// "parity with Log Event" would mean DELETING Snap's Save & Next. Not built.
//
// What did survive: Dave's 0813 ruling on the row — Snap must offer a link to the newly-CREATED
// planting after add. That is real and was missing, and it is missing from Log Event too: "View
// planting" shipped as V4-VIEWPLANT-001, then V4-HARVFEEDBACK-001 S5b dropped it (spec §4.2) and
// flagged the drop as a real regression FOR DAVE. So this is the ruling being honoured on Snap
// first, not a Snap-only ornament — the copy is V4-VIEWPLANT-001's phrase verbatim so the two
// surfaces converge rather than diverge when Log Event gets its link back.
//
// NO SECOND TOASTER. Snap keeps its own persistent done card and does NOT adopt ToastContext.
// V4-LOGCONF-001 earned the finding that the global toast is "a 5s race the user always loses"
// (PostSaveFeedback.jsx:24); firing one here would both re-run that race and put two confirmations
// of one save on screen at once — the divergent-second-surface defect this row exists to close.
//
// PER-DESTINATION TARGETS — "go to the planting" is meaningless for three of the five, so each
// destination links the record the photo is actually ABOUT:
//   planting  -> /plantings/:id   "View planting"  (Dave's ruling, literal)
//   event     -> /plantings/:id   "View planting"  (the planting logged TO; the event hangs off it)
//   location  -> /locations/:id   "View location"  (no planting exists — the place IS the subject)
//   replace   -> /plantings/:id   "View planting"  (confirming a featured-photo swap is precisely
//                                                   the case where you want to go look)
//   inventory -> /inventory/:id   "View item"
// One link per destination, never two. 'event' could also link /events/:eventId, but a second exit
// in the same row costs a decision on every capture and the planting is the durable end of the pair.
const todayStr = () => todayLocalISO()

// Mirrors PlantingEditor's EMPTY_FORM key-for-key EXCEPT project_id, which Snap deliberately does
// not carry: PlantingEditor seeds `project_id: projects[0]?.id`, Snap has always POSTed
// `project_id: null` and V3-CAPTURE-001's test pins that. Adopting the shared form must not quietly
// start assigning every field capture to whichever project happens to sort first.
// `status: 'seedling'` reproduces the value Snap hardcoded into its POST before this change, so the
// default capture is byte-identical on the wire; it is now visible and changeable instead of implied.
const SNAP_PLANT_FORM = {
  name: '', variety: null, quantity: '1', notes: '', status: 'seedling',
  sown_at: '', sown_at_approx: false, qty_initial: '',
  source_type: '', source_ref: '', source_generation: '', lineage_note: '',
  parent_plant_id: '', container_type: '', container_size: '', location_id: '',
}
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
  // V4-SNAPTOAST-001 adds `link` — { to, label, name } | null. `name` is the direct object for the
  // accessible name only; `label` is what renders.
  const [result, setResult] = useState(null)     // { kind, id, label, link, undo }
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
  const [locations, setLocations] = useState([])
  // mode forms
  // One controlled object, the shape PlantForm's contract documents. The old two-scalar state
  // (pName + a bare variety-id string) is gone: `variety` is now the variety ROW, because the
  // /api/plants dual-write needs both halves (`variety_id` canonical + `variety` flat text) and the
  // id alone cannot produce the text — sending only the id is the one real trap recon flagged here.
  const [plantForm, setPlantForm] = useState(SNAP_PLANT_FORM)
  const [evPlant, setEvPlant] = useState('')
  const [evType, setEvType]   = useState('watering')
  const [evDate, setEvDate]   = useState(todayStr())
  // V4-SNAPDEST-001: own state, deliberately NOT shared with the event destination's. Reusing
  // evType/evDate would make a half-filled planting log leak into the location log and back on every
  // Back tap, and the two destinations do not even offer the same event vocabulary.
  const [locPlace, setLocPlace] = useState('')
  const [locType, setLocType]   = useState('observation')
  const [locDate, setLocDate]   = useState(todayStr())
  const [rpPlant, setRpPlant] = useState('')
  const [invName, setInvName] = useState('')
  const [invType, setInvType] = useState('consumable')
  const [invCat, setInvCat]   = useState('other')
  const [invQty, setInvQty]   = useState('1')
  const [invUnit, setInvUnit] = useState('each')

  useEffect(() => {
    let off = false
    // The eager /api/varieties GET that fed the old <Select> is DELETED, not merely unused:
    // VarietyPicker owns its own list through useVarieties and searches server-side, so keeping the
    // prefetch would issue a request on every Snap mount for a list only one of four destinations
    // ever reads. Locations replace it and are cheaper in kind — they gate whether PlantForm renders
    // its Location field at all (PlantForm.jsx:183), and they are fetched exactly as PlantingEditor
    // fetches them so the two surfaces offer the same set.
    Promise.all([fetch('/api/plants'), fetch('/api/locations/with-path').catch(() => [])])
      .then(([pl, locs]) => {
        if (off) return
        setPlantings(Array.isArray(pl) ? pl : [])
        setLocations(Array.isArray(locs) ? locs.filter(l => l.is_active) : [])
      })
      .catch(() => {})
    return () => { off = true }
  }, [fetch])

  // V4-DIRTYGUARDSWEEP-001 — restore an interrupted capture's FIELDS ONLY, one-shot on mount.
  // `step` and `file` are deliberately NOT restored, and that is the whole design of this stash: a
  // File is not serialisable, so a draft that put the user back on step 'form' would hand them a
  // filled-in form with file === null, and Save would call attach(null) — a broken save built out of
  // a recovery feature. Landing on step 'photo' with the fields already populated is safe by
  // construction: 'form' is reachable only through onPick(), which always sets a file.
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (!draft) return
    if (draft.plantForm) setPlantForm(f => ({ ...f, ...draft.plantForm }))
    if (draft.evPlant)  setEvPlant(draft.evPlant)
    if (draft.evType)   setEvType(draft.evType)
    if (draft.evDate)   setEvDate(draft.evDate)
    if (draft.locPlace) setLocPlace(draft.locPlace)
    if (draft.locType)  setLocType(draft.locType)
    if (draft.locDate)  setLocDate(draft.locDate)
    if (draft.rpPlant)  setRpPlant(draft.rpPlant)
    if (draft.invName)  setInvName(draft.invName)
    if (draft.invType)  setInvType(draft.invType)
    if (draft.invCat)   setInvCat(draft.invCat)
    if (draft.invQty)   setInvQty(draft.invQty)
    if (draft.invUnit)  setInvUnit(draft.invUnit)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // STASH predicate — BROAD: any divergence from the seeds, picks included. Compared key-by-key
  // against SNAP_PLANT_FORM rather than tested for truthiness, because six of these fields are
  // seeded non-empty (quantity '1', status 'seedling', evType 'watering', locType 'observation',
  // invType 'consumable', invCat 'other', invQty '1', invUnit 'each') and both dates are seeded to
  // today. `!==` without a `?? ''` fallback is deliberate: `variety` seeds to null, and coercing it
  // would report every pristine mount as touched.
  const today = todayStr()
  const plantFormTouched = Object.keys(SNAP_PLANT_FORM).some(k => plantForm[k] !== SNAP_PLANT_FORM[k])
  const hasDraftContent = (
    plantFormTouched ||
    !!(evPlant || locPlace || rpPlant || invName) ||
    evType !== 'watering' || locType !== 'observation' || evDate !== today || locDate !== today ||
    invType !== 'consumable' || invCat !== 'other' || invQty !== '1' || invUnit !== 'each'
  )

  // step 'done' is excluded from the WRITE, not just from the guard. save() clears the draft, but
  // it does not reset the fields (only Save & Next does), so without this the very next effect pass
  // would re-write everything that was just saved — EventNew.jsx:849-855's stale-draft rewrite,
  // rebuilt on a different page.
  useEffect(() => {
    if (!hasDraftContent || step === 'done') return
    writeDraft(DRAFT_KEY, {
      plantForm, evPlant, evType, evDate, locPlace, locType, locDate, rpPlant,
      invName, invType, invCat, invQty, invUnit,
    })
  }, [hasDraftContent, step, plantForm, evPlant, evType, evDate, locPlace, locType, locDate, rpPlant,
      invName, invType, invCat, invQty, invUnit])

  // GUARD predicate — SEPARATE from the stash and deliberately ONE term, which is both necessary
  // and sufficient here. A staged File is the only state on this page the stash cannot carry, and it
  // is also the *gate* on every other piece: step 'form' — the only step with an editable field — is
  // reachable only via onPick(), so `file` being set is implied by any typed content. Adding the
  // typed fields would not widen the cover by a single real case, and WOULD make the page report
  // dirty on a merely-opened mount right after the restore above refills them, holding a
  // service-worker update for content the stash is already holding safely.
  // The step !== 'done' term is the post-save release: after a successful save `file` is still set
  // (only resetForNext clears it), and a save that has landed is nothing left to protect.
  const hasUnsavedInput = step !== 'done' && !!file

  useReportOverlayDirty(hasUnsavedInput)

  // /snap is not an overlayable route today, so the hook above is a strict no-op and the reload gate
  // below is what actually protects this page. Per-instance key + BOOLEAN dep for the reasons
  // EventNew.jsx:933-941 records.
  const reloadGateKey = `capture-flow:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  function onPick(e) {
    const f = e.target.files?.[0]
    // Required BECAUSE the input is now permanently mounted (BUG-SNAPRETAKE-001). It used to live
    // inside the `step === 'photo'` block, so leaving and re-entering that step remounted a fresh
    // input with an empty value; keeping it mounted removed that implicit reset, and <input
    // type=file> fires NO change event when you pick the identical file again. Without this line the
    // retake fix trades one silent dead tap for a narrower one — retake, choose the same photo,
    // nothing happens — and "Next" after a save would stall on re-picking the same file, which is a
    // true regression against the remounting version. Same idiom, same reason, as
    // PhotoLibrary.jsx:248 / AddSeeds.jsx:183 / PhotoUpload.jsx / QuickActions.jsx.
    e.target.value = ''   // re-picking the same file must refire onChange
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
    setPlantForm(SNAP_PLANT_FORM); setEvPlant(''); setEvType('watering'); setEvDate(todayStr())
    setRpPlant(''); setInvName(''); setInvType('consumable'); setInvCat('other'); setInvQty('1'); setInvUnit('each')
    // PRE-EXISTING, surfaced by V4-SNAPTOAST-001: `undone` was never cleared here, so undoing a save
    // and then tapping Save & Next carried the flag into the NEXT capture — its done card opened
    // already struck through as "Undone" with Undo withdrawn, describing a save that had in fact
    // succeeded. The new link is withdrawn on the same flag, so leaving this would have made the
    // ruling's affordance vanish from every capture after the first undo. One line, same block.
    setUndone(false)
    clearDraft(DRAFT_KEY)   // fields are back at their seeds — nothing left to resume
    setStep('photo')
  }

  async function attach(linkage, keyPrefix, parentId) {
    const r = await uploader.upload(file, { keyPrefix, parentId, linkage, is_public: true })
    if (r?.error) throw new Error(r.error)
    return r.photo
  }

  // PlantForm renders a real <form>, so its submit arrives as an event and must be prevented or the
  // page reloads mid-capture. The other three destinations still drive save() from a plain button.
  function submitPlanting(e) {
    e?.preventDefault?.()
    if (saving) return
    save()
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      if (mode === 'planting') {
        const f = plantForm
        // Kept even though PlantForm marks Name `required`: jsdom does not run constraint validation
        // for a dispatched click, and a whitespace-only name passes the browser check anyway.
        if (!f.name.trim()) throw new Error('Give the planting a name')
        const qty = parseInt(f.quantity, 10)
        // Payload builder lifted key-for-key from PlantingEditor.handleAdd (the surface that owns the
        // /api/plants wire contract) so Snap stops being a second, thinner contract for the same
        // route. Two deliberate divergences: project_id stays null (see SNAP_PLANT_FORM), and there
        // is no source_inventory_item_id — Snap has no packet deep-link.
        // The '' -> null coercions are not cosmetic: source_type '' 400s, and status/notes '' would
        // otherwise be written as empty strings rather than absent.
        const plant = await fetch('/api/plants', { method: 'POST', body: JSON.stringify({
          project_id: null,
          name:       f.name.trim(),
          // `variety_id` is the canonical FK and is the ONLY one of these two that lands.
          //
          // `variety` (flat text) is sent for wire-shape parity with every other create path
          // (PlantingEditor, ProjectDetail) — but it is DISCARDED server-side: `garden_node` has no
          // `variety` column and the POST handler never reads `body.variety`. This was previously
          // commented here as a "DUAL-WRITE … both are real columns", which was false; corrected
          // 2026-08-14 after review. Lossless today because `variety_id` writes correctly, so
          // dropping the key is safe whenever the other two call sites drop it too — keeping the
          // three identical is the only reason it is still here.
          variety:    f.variety?.name ?? null,
          variety_id: f.variety?.id ?? null,
          quantity:   isNaN(qty) || qty < 1 ? 1 : qty,
          notes:      f.notes.trim() || null,
          status:     f.status || null,
          sown_at:           f.sown_at || null,
          sown_at_approx:    !!f.sown_at_approx,
          qty_initial:       f.qty_initial.trim() ? parseInt(f.qty_initial, 10) : null,
          source_type:       f.source_type || null,
          source_ref:        f.source_ref.trim() || null,
          source_generation: f.source_generation.trim() || null,
          lineage_note:      f.lineage_note.trim() || null,
          parent_plant_id:   f.parent_plant_id || null,
          container_type:    f.container_type || null,
          container_size:    (f.container_size ?? '').trim() || null,
          location_id:       f.location_id || null,
        }) })
        await attach({ plant_id: plant.id }, 'plants', plant.id)
        // V4-SNAPTOAST-001: the `to` id is RESPONSE-sourced (plant.id, the saved row's truth), never
        // staged client state — the same sourcing rule V4-VIEWPLANT-001 set for the link it built.
        // The name falls back to the typed name only for the LABEL, which is display-only.
        setResult({ kind: 'planting', id: plant.id, label: `Planting “${plant.name ?? f.name.trim()}” created`,
          link: { to: `/plantings/${plant.id}`, label: 'View planting', name: plant.name ?? f.name.trim() },
          undo: () => fetch('/api/plants/' + plant.id + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: true }) }) })
      } else if (mode === 'event') {
        const pl = plantings.find(p => p.id === evPlant)
        if (!pl) throw new Error('Pick a planting')
        const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify({
          project_id: pl.project_id ?? null, plant_id: pl.id, event_type: evType, event_date: evDate, is_public: true,
        }) })
        // V4-CROPLISTORDER-001 (BD-010): the event row exists — mark the crop's log day for
        // picker chip ranking (falsy/unresolvable slug is a silent no-op inside the ledger).
        recordCropLog(pl.variety_ref?.crop_type_slug, evDate)
        const eventId = res?.eventId ?? res?.id
        await attach({ event_id: eventId, plant_id: pl.id }, 'events', eventId)
        // V4-SNAPTOAST-001: the planting, not the event — this is the destination the row's title
        // names ("go to the planting I just logged to"). pl.id is the picked row's own id, which the
        // POST echoed back as plant_id, so it is response-consistent rather than merely staged.
        setResult({ kind: 'event', id: eventId, label: `${EVENT_TYPE_META[evType]?.label ?? evType} logged on ${pl.name}`,
          link: { to: `/plantings/${pl.id}`, label: 'View planting', name: pl.name },
          undo: () => fetch('/api/events/' + eventId, { method: 'DELETE' }) })
      } else if (mode === 'location') {
        // No plant_id and no project_id, deliberately. The events Lambda requires only event_type and
        // ownership-validates location_id (lambda/events/index.js), so a place-scoped event is a
        // supported shape, not a hole — the same plant_id-NULL family the integrity check already
        // classifies as "a shipped intentional path" rather than an orphan.
        //
        // recordCropLog is NOT called here, unlike the planting branch: it ranks crop chips by recent
        // logging, and a location event has no crop to rank. Feeding it a blank slug would be a
        // silent no-op today and a wrong ranking the moment that ledger learns to accept one.
        if (!locPlace) throw new Error('Pick a location')
        const place = locations.find(l => l.id === locPlace)
        const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify({
          project_id: null, plant_id: null, location_id: locPlace,
          event_type: locType, event_date: locDate, is_public: true,
        }) })
        const eventId = res?.eventId ?? res?.id
        // location_id rides the linkage too: the event is the photo's parent for the CHECK, but the
        // place is what the photo is OF, and the photo surfaces filter on location_id directly.
        await attach({ event_id: eventId, location_id: locPlace }, 'events', eventId)
        // V4-SNAPTOAST-001: "View planting" is not merely wrong here, it is unbuildable — this event
        // carries plant_id null by design. The place is the subject, so the link is the place.
        setResult({ kind: 'event', id: eventId,
          label: `${EVENT_TYPE_META[locType]?.label ?? locType} logged on ${place?.full_path ?? 'location'}`,
          link: { to: `/locations/${locPlace}`, label: 'View location', name: place?.full_path ?? 'location' },
          undo: () => fetch('/api/events/' + eventId, { method: 'DELETE' }) })
      } else if (mode === 'replace') {
        const pl = plantings.find(p => p.id === rpPlant)
        if (!pl) throw new Error('Pick a planting')
        const prior = pl.featured_photo_id ?? null
        const photo = await attach({ plant_id: pl.id }, 'plants', pl.id)
        await fetch('/api/plants/' + pl.id, { method: 'PUT', body: JSON.stringify({ featured_photo_id: photo.id }) })
        setResult({ kind: 'replace', id: pl.id, label: `Photo updated on ${pl.name}`,
          link: { to: `/plantings/${pl.id}`, label: 'View planting', name: pl.name },
          undo: () => fetch('/api/plants/' + pl.id, { method: 'PUT', body: JSON.stringify({ featured_photo_id: prior }) }) })
      } else if (mode === 'inventory') {
        if (!invName.trim()) throw new Error('Give the item a name')
        const body = { name: invName.trim(), type: invType, category: invCat }
        if (invType === 'consumable') { body.quantity_on_hand = Number(invQty) || 0; body.unit = invUnit }
        else { body.quantity = Number(invQty) || 0 }
        const item = await fetch('/api/inventory-items', { method: 'POST', body: JSON.stringify(body) })
        await attach({ inventory_item_id: item.id }, 'inventory', item.id)
        setResult({ kind: 'inventory', id: item.id, label: `Inventory “${item.name ?? invName.trim()}” added`,
          link: { to: `/inventory/${item.id}`, label: 'View item', name: item.name ?? invName.trim() },
          undo: () => fetch('/api/inventory-items/' + item.id, { method: 'DELETE' }) })
      }
      clearDraft(DRAFT_KEY)   // the record exists — the working draft is spent
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
        <div style={{ position: 'relative', marginBottom: 14 }}>
          {/* The preview is a 280px hero while the photo is still being judged (steps 'photo'/'mode'
              — accept it, or tap Retake, which is overlaid on it). Once a destination is chosen the
              photo is settled and the preview's job drops to confirmation, so it becomes a 120px
              band. That is not decoration: the shared PlantForm is taller than the two hand-rolled
              fields it replaces, and on the 390x660 Chrome-Android reference viewport a 280px hero
              plus the full form pushes Save off the bottom. Reclaiming 160px is what keeps
              type-a-name-and-Save a no-scroll action, which is the entire reason Snap exists.
              Same treatment for the 'done' step's result card, for the same reason. */}
          <img src={preview} alt="capture preview" style={{ width: '100%', maxHeight: step === 'photo' || step === 'mode' ? 280 : 120, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
          {/* V4-SNAPDEST-001 (BD0806-08) — the accept/redo decision belongs WITH the photo.
              This control used to render last in the step-'mode' grid, below all four destination
              cards. Measured in the mobile harness at 360x660 (a realistic Chrome Android
              innerHeight once the toolbar is counted): it sat at y=634-682, i.e. 22px BELOW the
              fold. Rejecting a shot you had already decided against required scrolling past four
              choices about what to do with it.
              OVERLAID on the preview rather than stacked under it, deliberately. A stacked row was
              measured first and works — retake moves to y=304 — but it costs 56px of vertical, and
              that pushed "Add inventory" (the last card, and the subject of this same ledger row)
              from y=608 to y=705, i.e. off-screen. Buying adjacency for the photo by demoting a
              destination card is not a trade this row wants. The overlay costs zero layout height,
              so the destination list ends up HIGHER than it was at base.
              Solid P.white fill, not a translucent scrim: the chip sits over arbitrary photo
              content and contrast has to hold against a bright sky as well as dark soil.
              Adjacency, not a new step — onPick() still auto-advances to 'mode', so choosing a
              destination IS accepting the photo. The step guard reproduces the old visibility
              exactly ('mode' only): retake is wrong in 'form' (Back exists) and in 'done'
              (already uploaded).
              Label and picker semantics are UNCHANGED on purpose: BUG-SNAPRETAKE-001's regression
              test pins both the exact string and `capture` staying null (library, not forced
              camera). This is a move, not a rewrite. */}
          {step === 'mode' && (
            <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
              <Button data-testid="cap-retake" variant="secondary" onClick={() => openPicker(false)}
                style={{ backgroundColor: P.white, fontSize: '0.85rem' }}>Retake / choose photo</Button>
            </div>
          )}
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

      {/* V4-SNAPCAPTURE-001 (BD0806-06) — "Take photo" is DEMOTED, not removed. Dave's report was
          that in-app capture "does not appear to save to the device gallery"; the finding is that
          it CANNOT — a PWA has no gallery write, only the share sheet (V4-SNAPDEST-001 hid the
          "Save to device" affordance app-wide for the same reason). So a 50/50 pair of equal
          dashed buttons was actively steering him toward the arm that silently loses the photo
          everywhere except this app. Choose is now the single primary action — Snap is one tap
          into the picker — and Take stays reachable underneath with the reason stated, because
          for a photo he does NOT want in his camera roll it is still the faster path.
          NOT auto-opening the picker on mount: the file input needs transient activation, and the
          navigation gesture that got here is already spent, so Android Chrome would block it and
          the step would render as a dead end. */}
      {step === 'photo' && (
        <div style={{ ...card, textAlign: 'center' }}>
          <p style={{ color: P.mid, marginTop: 0 }}>Choose a photo to begin.</p>
          {/* flex is explicitly cleared, not merely overridden: pickBtn carries flex:1 for the
              50/50 row that no longer exists, and a stray flex:1 on a lone block child is the kind
              of leftover that only surfaces when someone later re-wraps this in a flex parent. */}
          <button data-testid="cap-choose" type="button" onClick={() => openPicker(false)}
            style={{ ...pickBtn, flex: 'none', width: '100%', borderStyle: 'solid', borderColor: P.green, backgroundColor: P.green, color: P.white }}>
            <span style={{ fontSize: '1.3rem' }}>🖼️</span><span>Choose photo</span>
          </button>
          <button data-testid="cap-take" type="button" onClick={() => openPicker(true)}
            style={{ marginTop: 10, background: 'none', border: 'none', color: P.mid, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
            Take photo instead
          </button>
          <p style={{ color: P.light, fontSize: '0.75rem', marginTop: 6, marginBottom: 0 }}>
            Photos taken here aren’t saved to your camera roll.
          </p>
        </div>
      )}

      {step === 'mode' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {/* The affirmative half of the ask ("Use Photo") is this caption, not a button. The
              picker already auto-advances into this step, so a confirm control would be a second
              tap that decides nothing — it would gate the flow on re-accepting a photo the user
              just took. Naming the cards as the acceptance keeps one tap and still reads as a
              decision about the photo. */}
          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: P.mid }}>Use this photo for…</div>
          {MODES.map(m => (
            <button key={m.id} data-testid={`mode-${m.id}`} onClick={() => { setMode(m.id); setStep('form') }}
              style={{ ...card, textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700, color: P.green }}>{m.label}</div>
              <div style={{ fontSize: '0.82rem', color: P.light, marginTop: 2 }}>{m.hint}</div>
            </button>
          ))}
        </div>
      )}

      {/* V4-PLANTFORMUNIFY-001 — the planting destination is now the SHARED form, so it owns its own
          <form> element and its own submit/Back row and cannot share the generic card below.
          FAST-CAPTURE GUARANTEE, deliberate and load-bearing: every field PlantForm adds over the old
          two is either prefilled (quantity 1, status seedling) or marked optional, and the twelve
          provenance fields stay inside the collapsed <details> — detailsDefaultOpen is left at its
          false default here, unlike PlantingEditor which opens it for desk work. So the taps to
          capture are UNCHANGED from before this row: type a name, hit Save. Nothing new is required
          and nothing new is prompted for. */}
      {step === 'form' && mode === 'planting' && (
        <div style={card}>
          <Note>No project needed — you’ll group it with tags in the V4 update.</Note>
          <PlantForm
            value={plantForm}
            onChange={patch => setPlantForm(f => ({ ...f, ...patch }))}
            onSubmit={submitPlanting}
            submitting={saving}
            submittingLabel="Saving…"
            submitLabel="Save"
            error={err}
            locations={locations}
            plantingOptions={plantings.map(p => ({ id: p.id, name: p.name }))}
            /* project_id is injected as null by the payload builder, exactly as PlantingEditor
               injects projects[0] under PROJECTS_HIDDEN — no visible project step either way. */
            showProjectSelect={false}
            idPrefix="cap-plant"
            /* Back, not Cancel: PlantForm's built-in onCancel renders the word "Cancel", which on a
               capture flow reads as discarding the photo. This step's escape goes back to the
               destination list with the photo intact, so it keeps Snap's own label and lands in the
               shared button row via extraActions. */
            extraActions={
              <Button data-testid="cap-back" variant="secondary" disabled={saving}
                onClick={() => { setStep('mode'); setErr(null) }}>Back</Button>
            }
          />
        </div>
      )}

      {step === 'form' && mode !== 'planting' && (
        <div style={card}>
          <div style={fieldStack}>
            {mode === 'event' && (
              <>
                <Field label="Planting">
                  {/* V4-PLANTPICKER-001: shared searchable picker (unscoped list is garden-sized) */}
                  {/* V4-CROPFILTER-001: crop chips — the unscoped garden-sized list is exactly
                      where scanning stops working (§1b enabled sites). */}
                  <PlantingSelect data-testid="cap-evplant" plants={plantings} value={evPlant} cropChips={CROP_CHIPS_AUTO}
                    onChange={id => setEvPlant(id)} labelFormat="bare" placeholder="— pick a planting —" />
                </Field>
                <Field label="Event">
                  <Select value={evType} onChange={e => setEvType(e.target.value)}>
                    {EVENT_DEST_TYPES.map(t => <option key={t} value={t}>{EVENT_TYPE_META[t]?.label ?? t}</option>)}
                  </Select>
                </Field>
                <Field label="Date">
                  <Input type="date" value={evDate} onChange={e => setEvDate(e.target.value)} />
                </Field>
              </>
            )}
            {/* V4-SNAPDEST-001. Mirrors the event destination's three fields in the same order, so
                the two "log something" destinations are muscle-memory identical — only the first
                field differs (a place instead of a planting). */}
            {mode === 'location' && (
              <>
                <Field label="Location">
                  <Select data-testid="cap-locplace" value={locPlace} onChange={e => setLocPlace(e.target.value)}>
                    <option value="">— pick a location —</option>
                    {locations.map(l => (
                      <option key={l.id} value={l.id}>{l.full_path ?? l.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Event">
                  <Select data-testid="cap-loctype" value={locType} onChange={e => setLocType(e.target.value)}>
                    {LOCATION_DEST_TYPES.map(t => <option key={t} value={t}>{EVENT_TYPE_META[t]?.label ?? t}</option>)}
                  </Select>
                </Field>
                <Field label="Date">
                  <Input type="date" value={locDate} onChange={e => setLocDate(e.target.value)} />
                </Field>
                {locations.length === 0 && (
                  <Note>No locations yet — add one in Garden first, then this photo can log against it.</Note>
                )}
              </>
            )}
            {mode === 'replace' && (
              <>
                <Field label="Planting to update">
                  {/* V4-PLANTPICKER-001: shared searchable picker (unscoped list is garden-sized) */}
                  <PlantingSelect data-testid="cap-rpplant" plants={plantings} value={rpPlant} cropChips={CROP_CHIPS_AUTO}
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
          {/* V4-SNAPTOAST-001: the link sits in the EXIT row beside Done, not in row 1 beside Undo.
              Row 1 is the utility zone — it reverses a write and must be reliably noticed
              (PostSaveFeedback §1); "View planting" is the opposite kind of act, it LEAVES. Grouping
              it with Done keeps the two exits together and leaves Undo undiluted. Save & Next holds
              first/primary position unchanged: rapid field capture is the entire reason Snap exists,
              and the link must not outrank it.
              flexWrap because three controls (one of them "Save & Next — snap another") do not fit a
              390px Chrome-Android card on one line; wrapping puts Save & Next on its own row and the
              two exits together on the next, which is the reading order that was wanted anyway. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button data-testid="cap-next" variant="primary" onClick={resetForNext}>Save &amp; Next — snap another</Button>
            {/* WITHDRAWN once undone, uniformly across destinations — the same posture Undo itself
                takes above. For 'planting' the undo ARCHIVES the row and for 'inventory' it deletes
                it, so the target is genuinely gone; for 'event'/'replace' the planting survives and a
                live link would be defensible. It is still withdrawn: a control that occupies the same
                slot and is sometimes a dead end is worse than one that consistently disappears when
                the save is retracted.
                Accessible name = visible label + direct object (WCAG 2.5.3, PostSaveFeedback §5) —
                "View planting" alone is indistinguishable between two captures in one session. */}
            {result.link && !undone && (
              <Link
                data-testid="cap-view"
                to={result.link.to}
                aria-label={`${result.link.label} — ${result.link.name}`}
                style={{ ...buttonChrome('secondary'), display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
              >
                {result.link.label}
              </Link>
            )}
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
