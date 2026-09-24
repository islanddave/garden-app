import React, { useState, useEffect, useId, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useInventory } from '../hooks/useInventory.js'
import { useApiFetch } from '../lib/api.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { P, statusLabel } from '../lib/constants.js'
import { useToast } from '../context/ToastContext.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import { INVENTORY_CATEGORIES as CATEGORIES, INVENTORY_UNITS as UNITS, INVENTORY_CONDITIONS as CONDITIONS, INVENTORY_STATUSES as STATUSES } from '../lib/inventoryEnums.js'
import { EnumSelect, Field, Input, Select, Textarea, Button, PlantingSelect, SourcePicker } from '../components/forms'
import Spinner from '../components/forms/Spinner.jsx'
import SeedStageHistory from '../components/seed/SeedStageHistory.jsx'
import SupplierChip from '../components/seed/SupplierChip.jsx'
import { lotPhoto } from '../components/seed/lotPhoto.js'
import PhotoView from '../components/photo/PhotoView.jsx'
import Lightbox from '../components/Lightbox.jsx'
import Icon from '../components/Icon.jsx'
import { useSources } from '../hooks/useSources.js'
import { TIER } from '../lib/photoModel.js'
import { supplierColors } from '../lib/supplierPalette.js'
import { seedFacts } from '../components/seed/seedFacts.js'
import { kindAllowsParentPlant } from '../components/seed/seedLots.js'
// V4-SEEDORIGIN-001 — the SAME eight values preservation_log uses, deliberately. This registry is
// one of the four synchronised homes of that vocabulary (the others: lambda/preservation/
// provenance.js, the per-Lambda copy in lambda/inventory-items/source-kinds.js, and the DB CHECK
// chk_inventory_source_kind). preservationProvenance.test.js pins this list against the JS
// canonical; the migration's post_vocabulary_exact gate pins the DB against it.
import { PUTUP_SOURCE_OPTIONS } from '../lib/dropdownRegistry.js'
import { formatQtyExact, formatDate } from '../lib/format.js'
import { seedsHref, seedsReturnFromHistory } from '../lib/seedsRoutes.js'
import { readDraft } from '../lib/draftStash.js'
import { T } from '../components/forms/formStyles.js'
import SowSheet, { sowPacketFromItem } from '../components/seed/SowSheet.jsx'
import { isInProcess } from '../lib/sowEngine.js'

// V5-SEEDSTAB-001 — seed left the Inventory list, so a seed row's exits go to Seeds › My seeds.
const SEEDS_MINE = seedsHref('mine')

// V5-SEEDSTAB-001 slice 2a — this page's Sow sheet stash. Its OWN key, never Sow now's 'sow-now': a
// shared key would let a sow interrupted here reopen itself on Seeds › Sow now, and the other way round.
// One key for every packet page, holding the packet's id; a page restores only its own packet's sheet.
const SOW_DRAFT_KEY = 'sow-packet'

// Inventory enums centralized in src/lib/inventoryEnums.js (live prod CHECK sets);
// the former local duplicates here were removed (Lane D dedup).

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InventoryDetail() {
  const { id }       = useParams()
  const navigate     = useNavigate()
  // V5-SEEDSTAB-001 — set when a Seeds view pushed this page; Cancel then goes BACK to that view
  // (same filters, same scroll) instead of pushing a fresh copy of it.
  const [pushedFromSeeds] = useState(seedsReturnFromHistory)
  const { updateItem, deleteItem } = useInventory()
  const { fetch } = useApiFetch()
  const { show } = useToast()

  const [item,         setItem]         = useState(null)
  const [form,         setForm]         = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [loadErr,      setLoadErr]      = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [errors,       setErrors]       = useState({})
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,     setDeleting]     = useState(false)
  // V4-DIRTYGUARDSWEEP-001 — the last form snapshot that is known to be ON THE SERVER. Kept
  // separately from `item` because handleSave deliberately does NOT re-set `item` (the breadcrumb
  // and heading keep showing the loaded name until a reload), so diffing against `item` would leave
  // this page reporting dirty forever after a SUCCESSFUL save — the same post-save pin EventNew
  // hit. Re-baselining here is additive. V5-SEEDCARDS-001: the packet card is its one reader — it
  // shows the supplier and packet link AS SAVED, which is exactly what this holds and `item` does not.
  const [baseline,     setBaseline]     = useState(null)

  // ── V4-SEEDLINK-001 — seed-lot provenance ("Saved from") ───────────────────
  // Its OWN state and its OWN write, deliberately outside form/baseline/buildChanges, for two
  // independent reasons:
  //   1. It saves the instant it is chosen, so it is never unsaved input. Folding it into `form`
  //      would make the dirty guard hold a service-worker update for a value already on the server.
  //   2. The wide PUT assigns every column it names unconditionally (`= ${body.x ?? null}`), so a
  //      provenance link routed through buildChanges() would be NULLED by every later edit that did
  //      not happen to round-trip it. PATCH /:id/source-plant exists precisely to dodge that.
  const [sourcePlantId,   setSourcePlantId]   = useState('')
  const [sourcePlantBusy, setSourcePlantBusy] = useState(false)
  const [sourcePlantErr,  setSourcePlantErr]  = useState(null)
  // BUG-PLANTFETCHSILENT-001 contract: the picker self-fetches, and a failed load must read as a
  // failure rather than as "you have no plantings" — an unfillable field that looks legitimately
  // empty. The host owns the copy; PutUp's PlantingField is the precedent.
  const [sourcePlantLoadFailed, setSourcePlantLoadFailed] = useState(false)
  // The parent's NAME, when this page happens to know it. PlantingSelect hands the chosen row to
  // onChange(id, planting) but exposes nothing for a value it merely resolved on load, so this is
  // populated by a selection made in this session and is null for a link loaded with the item. The
  // chain below degrades to a bare link in that case rather than fetching a second time — see the
  // prop note in SeedStageHistory.
  const [sourcePlantName, setSourcePlantName] = useState(null)

  // ── V4-SEEDORIGIN-001 — where this lot came from when it came from no planting of ours ────
  // Own state and own write, for the same reason "Saved from" has them: this writes on selection
  // through a dedicated sub-route, so it has no business in a form whose Save button implies
  // unsaved state, and it must never travel through the wide PUT.
  const [sourceKind,     setSourceKind]     = useState('')
  const [sourceKindBusy, setSourceKindBusy] = useState(false)
  const [sourceKindErr,  setSourceKindErr]  = useState(null)

  // ── V5-SEEDSTAB-001 slice 2a — "Sow this" opens THE Sow sheet on this packet ───────────────────
  // The packet the sheet is open on (null = closed), and — once a sow from this page lands — the
  // planting it made, so the page can say so and offer the way to it for the rest of the visit.
  const [sowPacket, setSowPacket] = useState(null)
  const [sown,      setSown]      = useState(null)

  // ── V5-SEEDCARDS-001 — the packet card's supplier, by name ─────────────────────────────────
  // The registry is what turns `source_id` into a name (and the name into the supplier's colours).
  // Enabled only once the item has loaded AS A SEED: that is the same commit the form's SourcePicker
  // mounts in, so this joins its request inside useSources' dedupe window instead of issuing a
  // second GET — and a tool or an amendment never asks at all.
  const { sources } = useSources({ enabled: item?.category === 'seeds' })

  // ── Load item ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    setLoading(true)
    setLoadErr(null)
    fetch('/api/inventory-items/' + id)
      .then(data => {
        if (!mounted) return
        setItem(data)
        setForm(itemToForm(data))
        setBaseline(itemToForm(data))
        // '' not null: PlantingSelect's `value` is a string and '' is its cleared state.
        setSourcePlantId(data.source_plant_id ?? '')
        setSourceKind(data.source_kind ?? '')
        setLoading(false)
      })
      .catch(err => {
        if (!mounted) return
        setLoadErr(err?.status === 404
          ? 'Item not found — it may have been removed.'
          : (err?.message ?? 'Failed to load item.'))
        setLoading(false)
      })
    return () => { mounted = false }
  }, [id, fetch])

  // ── Helpers ────────────────────────────────────────────────────────────────
  // BUG-INVQTYROUNDTRIP-001 — every quantity below is formatQtyExact, NEVER formatQty. These five are
  // not renders: buildChanges() reads each one back through parseNum (parseFloat) and PUTs it, so a
  // rounding formatter here makes merely OPENING an item and saving any other field rewrite the
  // stored value. quantity_on_hand / reorder_threshold / reorder_quantity / quantity_purchased are
  // numeric(10,3) on prod and five live rows were fractional when this was found; `quantity` is
  // integer, and it is switched with them anyway because "which of these is safe to round" is not a
  // fact a future edit should have to re-derive per field.
  function itemToForm(i) {
    return {
      name:               i.name              ?? '',
      type:               i.type              ?? 'consumable',
      category:           i.category          ?? '',
      status:             i.status            ?? 'active',
      quantity_on_hand:   formatQtyExact(i.quantity_on_hand),
      quantity:           formatQtyExact(i.quantity),
      unit:               i.unit              ?? '',
      reorder_threshold:  formatQtyExact(i.reorder_threshold),
      reorder_quantity:   formatQtyExact(i.reorder_quantity),
      condition:          i.condition         ?? '',
      unit_cost:          i.unit_cost         != null ? Number(i.unit_cost).toFixed(2)         : '',
      quantity_purchased: formatQtyExact(i.quantity_purchased),
      purchase_date:      i.purchase_date     ?? '',
      source:             i.source            ?? '',
      source_url:         i.source_url        ?? '',
      // V4-SOURCEREG-001 — GET /:id is `SELECT i.*`, so both FK columns arrive on the row. '' not
      // null, so the picker's empty contract and the baseline diff both read them as plain blanks.
      source_id:              i.source_id              ?? '',
      acquired_from_source_id:i.acquired_from_source_id?? '',
      brand:              i.brand             ?? '',
      model:              i.model             ?? '',
      location_text:      i.location_text     ?? '',
      notes:              i.notes             ?? '',
      // BUG-SEEDYEARNOOP-001 — GET /:id is `SELECT i.*`, so the column arrives on the row and has
      // done all along; nothing has ever rendered it. '' not null, for the same reason the two
      // source FKs above use '': the baseline diff reads it as a plain blank.
      year_harvested:     i.year_harvested != null ? String(i.year_harvested) : '',
    }
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    if (errors[field]) setErrors(e => ({ ...e, [field]: null }))
  }

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name     = 'Name is required.'
    if (!form.category)    e.category = 'Choose a category.'
    if (form.type === 'consumable' && form.quantity_on_hand === '' && form.quantity_on_hand !== 0)
      e.quantity_on_hand = 'Enter a quantity (0 is fine).'
    if (form.type === 'durable' && form.quantity === '')
      e.quantity = 'Enter quantity.'
    // CHECK chk_inventory_source_distinct — a row may not name the same source twice. The Lambda
    // rejects it too (inventory-items/index.js:193), but its message names the two columns; caught
    // here it costs no round trip and reads like the form.
    if (form.source_id && form.source_id === form.acquired_from_source_id)
      e.acquired_from_source_id = `Same as the ${form.category === 'seeds' ? 'supplier' : 'origin'} — leave this blank when they match.`
    // BUG-SEEDYEARNOOP-001 — reject an unparseable year rather than letting it become a silent
    // clear. parseNum returns null for both '' and NaN, so without this a typo ("19 86") would read
    // as "the user emptied the field" and NULL a curated value on save, with a 200 and no message.
    // Blank stays a legitimate clear; only non-blank-and-not-a-year is an error.
    if (form.year_harvested.trim() !== '' && !/^\d{4}$/.test(form.year_harvested.trim()))
      e.year_harvested = 'Enter a four-digit year, or leave it blank.'
    return e
  }

  function buildChanges() {
    const base = {
      name:          form.name.trim(),
      // BUG-INVSEEDPUT400-001. `type` is NOT NULL on prod, but that is the smaller half: the wide
      // PUT reads body.type into isConsumable/isDurable and those two gate SIX further SET-list
      // expressions (unit, quantity_on_hand, reorder_threshold, reorder_quantity, quantity,
      // condition). Omitting it does not merely fail the NOT NULL — it NULLS all six, which then
      // trips consumable_requires_unit / consumable_requires_quantity_on_hand. The handler is
      // body-only by design (validateUpdate's own comment says so), so the complete payload is the
      // client's contract to keep. Masked in practice by updateItem's {...listRow, ...changes}
      // merge, which is why this survived to ship: it only bites when the list has not loaded.
      type:          form.type,
      category:      form.category,
      status:        form.status,
      notes:         form.notes.trim()         || null,
      source:        form.source.trim()        || null,
      source_url:    form.source_url.trim()    || null,
      // V4-SOURCEREG-001. Both keys are sent ALWAYS, and that is the contract rather than a habit:
      // the wide PUT reads these two by hasOwnProperty into a `CASE WHEN <present> … ELSE <col> END`
      // (inventory-items/index.js:943-952), so PRESENCE means "use this value" and an omitted key
      // means "leave the column alone". This form renders both controls, so it owns both values and
      // an explicit null is a real clear.
      source_id:               form.source_id               || null,
      acquired_from_source_id: form.acquired_from_source_id || null,
      purchase_date: form.purchase_date        || null,
      unit_cost:     parseNum(form.unit_cost),
      location_text: form.location_text.trim() || null,
      quantity_purchased: parseNum(form.quantity_purchased),
      // BUG-SEEDYEARNOOP-001 — sent ONLY for seeds, and for seeds sent ALWAYS. Same presence
      // contract as the two source FKs above: the wide PUT reads this key by hasOwnProperty into a
      // CASE WHEN <present> … ELSE <col> END, so an omitted key leaves the column alone and a
      // present one is authoritative. Omitting it for non-seed rows is therefore not a shortcut —
      // it is what stops a hammer's edit form from having an opinion about a harvest year.
      // For seeds, sending it unconditionally also seals the deep-link hole from the client side:
      // the column can no longer be absent from a body this form produces.
      ...(form.category === 'seeds'
        ? { year_harvested: form.year_harvested.trim() === '' ? null : Number(form.year_harvested) }
        : {}),
    }
    if (form.type === 'consumable') {
      return {
        ...base,
        quantity_on_hand:  parseNum(form.quantity_on_hand) ?? 0,
        unit:              form.unit || null,
        reorder_threshold: parseNum(form.reorder_threshold),
        reorder_quantity:  parseNum(form.reorder_quantity),
        // null out durable-only
        quantity:  null,
        condition: null,
        brand:     null,
        model:     null,
      }
    }
    // durable
    return {
      ...base,
      quantity:  parseInt(form.quantity) || 1,
      condition: form.condition || null,
      brand:     form.brand.trim()  || null,
      model:     form.model.trim()  || null,
      // null out consumable-only
      quantity_on_hand:  null,
      unit:              null,
      reorder_threshold: null,
      reorder_quantity:  null,
    }
  }

  function parseNum(val) {
    if (val === '' || val == null) return null
    const n = parseFloat(val)
    return isNaN(n) ? null : n
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave(e) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }

    // Snapshotted BEFORE the await, and it is the same render's `form` that buildChanges() reads.
    // Anything typed while the PUT is in flight is therefore still unsaved once it lands, and the
    // guard correctly stays held.
    const sent = form
    setSaving(true)
    const { error } = await updateItem(id, buildChanges())
    setSaving(false)

    if (error) {
      setErrors({ _form: error })
    } else {
      setBaseline(sent)
      // Operational confirmation via the GLOBAL toast layer (auto-dismisses).
      show({ message: '✓ Saved' })
    }
  }

  // ── Save the parent plant (V4-SEEDLINK-001) ────────────────────────────────
  // Writes on selection rather than behind the page's Save button: this is one field with one
  // meaning, and a picker that looks chosen while the value sits unsent is the silent-failure shape
  // BUG-SILENTFAILSWEEP-001 catalogued. Optimistic, then reverted on failure — showing a parent the
  // server does not have is worse than showing none.
  // V4-SEEDORIGIN-001. Same optimistic-with-revert shape as saveSourcePlant below, and the same
  // explicit-null contract: the route reads `source_kind` by PRESENCE, so omitting the key is a 400
  // and sending null is the clear. "Not recorded" is the honest state of every packet that predates
  // this column, and it has to stay reachable rather than being a value you can never get back to.
  async function saveSourceKind(next) {
    const prev = sourceKind
    if (next === prev) return
    setSourceKind(next)
    setSourceKindBusy(true)
    setSourceKindErr(null)
    try {
      await fetch(`/api/inventory-items/${id}/source-kind`, {
        method: 'PATCH',
        body: JSON.stringify({ source_kind: next || null }),
      })
      show({ message: '✓ Saved' })
    } catch (e) {
      setSourceKind(prev)
      setSourceKindErr(e?.message ?? 'Could not save that.')
    } finally {
      setSourceKindBusy(false)
    }
  }

  async function saveSourcePlant(nextId, planting) {
    const prev = sourcePlantId
    const prevName = sourcePlantName
    if (nextId === prev) return
    setSourcePlantId(nextId)
    // V4-SEEDHISTORY-001 — the picker hands the whole row along with the id, so the chain below can
    // name the parent without a second request. Reverted with the id below, not left behind: an id
    // that rolled back while its label did not is a chain that names the wrong plant.
    setSourcePlantName(planting?.name ?? planting?.variety_ref?.name ?? null)
    setSourcePlantBusy(true)
    setSourcePlantErr(null)
    try {
      await fetch(`/api/inventory-items/${id}/source-plant`, {
        method: 'PATCH',
        // Explicit null, never an omitted key: the route reads this by PRESENCE, so omitting it is
        // a 400 and sending null is the clear. That asymmetry is what makes "I don't know which
        // plant" a recordable answer instead of an unreachable one.
        body: JSON.stringify({ source_plant_id: nextId || null }),
      })
      show({ message: '✓ Saved' })
    } catch (e) {
      setSourcePlantId(prev)
      setSourcePlantName(prevName)
      setSourcePlantErr(e?.message ?? 'Could not save that.')
    } finally {
      setSourcePlantBusy(false)
    }
  }

  // ── V5-SEEDCARDS-001 — after an upload, ask the server what the packet box should show ──────
  // The photos Lambda features a lot's FIRST photo and GET /:id derives the hero from that, so the
  // upload's own response cannot say whether the box changed; a re-read can. Only the photo fields
  // are adopted (adoptPacketPhoto): nothing else on `item` moves because a photo landed. A failed
  // re-read is left silent on purpose — the upload itself succeeded and PhotoUpload's preview already
  // shows it; the box simply catches up on the next load.
  function refetchPacketPhoto() {
    fetch('/api/inventory-items/' + id)
      .then(data => setItem(prev => adoptPacketPhoto(prev, data)))
      .catch(() => {})
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true)
    const { error } = await deleteItem(id)
    setDeleting(false)
    if (error) {
      setErrors({ _form: error })
      setConfirmDelete(false)
    } else if (item?.category === 'seeds') {
      // V5-SEEDSTAB-001 — Back never reopens the lot just removed. Pushed by a Seeds view: go BACK to
      // it (Seeds remounts and refetches, so the row is gone). A replace there left two identical
      // Seeds entries in a row, and the next Back was a press that did nothing (pre-promote review).
      // Any other arrival has nothing under it to go back to: REPLACE onto My seeds.
      if (pushedFromSeeds) navigate(-1)
      else navigate(SEEDS_MINE, { replace: true })
    } else {
      navigate('/inventory')
    }
  }

  // ── Dirty guard (V4-DIRTYGUARDSWEEP-001) ───────────────────────────────────
  // This whole page IS one edit form, seeded field-for-field from the loaded item, so the honest
  // predicate is differs-from-the-row and NOT truthiness: every box arrives populated, and a
  // truthiness guard would hold a service-worker update from the moment the item finished loading
  // — for a user who only came to look at it. Same reading as Locations' inline edit form.
  //
  // Compared over the baseline's own keys, which are exactly itemToForm's: `set()` only ever merges
  // into that shape, so a key that appears on one side and not the other would be a bug in
  // itemToForm rather than a case to tolerate here.
  //
  // Nothing else on this page carries unsaved state. PhotoUpload posts the file the instant it is
  // chosen (there is no staged-file step, unlike EventNew's), `confirmDelete` is a transient
  // confirmation, and the V4-SEEDLINK-001 "Saved
  // from" picker PATCHes on selection — so its value is on the server before this could observe it.
  // The Sow sheet (V5-SEEDSTAB-001 slice 2a, replacing the Plant-from-packet navigation) guards
  // itself — it takes its own reload hold and writes its own stash while open — and joins only the
  // overlay report below, which is one value per page.
  // The seed-processing card holds nothing at all since V5-SEEDSTAGEONEPLACE-001 moved its stage
  // control (and the count prompt that hung off it) to /seeds/saved: what is left is a read-only
  // history panel.
  //
  // Declared above the loading/error early returns because hooks cannot live below them. `form` and
  // `baseline` are both null until the load resolves, which reads as clean — correct, there is
  // nothing typed yet.
  const hasUnsavedInput = !!(
    form && baseline && Object.keys(baseline).some(k => form[k] !== baseline[k])
  )

  // Forward-compat, like SowNow's: /inventory/:id is not an overlayable route, so no provider listens
  // today. The open Sow sheet is folded in HERE rather than reported by the sheet itself, because the
  // channel keeps one value per page and a second reporter would overwrite this form's.
  useReportOverlayDirty(hasUnsavedInput || !!sowPacket)

  // V5-SEEDSTAB-001 slice 2a — reopen a Sow sheet an ABNORMAL exit interrupted (SW reload, hard
  // refresh) on THIS packet. Validated against the live row, the rule SowNow applies against its
  // buckets: the stash names a packet id, and only that packet's page — still sowable — reopens it. Once
  // per packet id, so a later re-read of the row (the packet photo's) can never reopen a sheet the user
  // has since closed. A deliberate close cleared the stash (SowSheet), so this never resurrects one.
  const restoredSowRef = useRef(null)
  useEffect(() => {
    if (!item || restoredSowRef.current === item.id) return
    restoredSowRef.current = item.id
    if (!canSowFrom(item)) return
    if (readDraft(SOW_DRAFT_KEY)?.inventoryItemId !== item.id) return
    setSowPacket(sowPacketFromItem(item))
  }, [item])

  // The reload-gate half. Key is per-instance for the reason EventNew.jsx:985 gives — reloadGate
  // holds a Set, so a shared literal key would let one instance's unmount release another's hold.
  // The cleanup release is required, not defensive: a navigated-away dirty form that kept its hold
  // would wedge updates forever and rebuild BUG-STALECLIENT-001.
  const reloadGateKey = `inventory-detail:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <Shell><Spinner block /></Shell>
  if (loadErr) return <Shell><ErrMsg msg={loadErr} /></Shell>
  if (!item)   return <Shell><ErrMsg msg="Item not found." /></Shell>

  const isConsumable = form.type === 'consumable'
  const visibleCats  = CATEGORIES.filter(c => c.types.includes(form.type))
    .slice().sort((a, b) => a.label.localeCompare(b.label))
  // V5-SEEDCARDS-001 — the seed wording on the form follows the form's own category, like the seed
  // harvest year below does.
  const isSeedForm = form.category === 'seeds'
  // BUG-SAVEDSEEDPARENTONPRODUCE-001 — whether "Saved from" may offer a plant, per the CHECK that
  // refuses a parent to a lot whose origin names a farm stand, a gift or a shop. The LIVE select value,
  // so a change of origin shows or hides the picker in the same render as the change itself.
  const parentAllowed = kindAllowsParentPlant(sourceKind)
  // The supplier as last SAVED, named from the registry. Null while the registry loads, for a lot
  // with no supplier, and for an id the registry no longer lists — the card then draws no stripe.
  const savedSourceId = baseline?.source_id || null
  const supplierName = savedSourceId
    ? (sources.find(s => String(s.id) === String(savedSourceId))?.name ?? null)
    : null

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>

        {/* Breadcrumb — V5-SEEDSTAB-001: a seed row belongs to Seeds, which the Inventory list no
            longer shows. */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          {item.category === 'seeds'
            ? <Link to={SEEDS_MINE} style={{ color: P.green, textDecoration: 'none' }}>Seeds</Link>
            : <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>}
          {' › '}{item.name}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, flex: 1 }}>
            {item.name}
          </h1>
          <FavoriteToggle entityType="inventory_item" entityId={id} />
        </div>

        {/* ── V5-SEEDCARDS-001 — the packet card: the seed's picture, big, and its facts ──────────
            Dave, 2026-09-19: the seed-packet image "also a bigger version of it on the seed's detail
            page", with the details filled in. SEEDS ONLY; it also takes over the Photo card below
            (one upload control on this page, inside this card). */}
        {item.category === 'seeds' && (
          <PacketCard
            item={item}
            supplierName={supplierName}
            packetUrl={baseline?.source_url}
            onUploadComplete={refetchPacketPhoto}
          />
        )}

        {/* ── V5-SEEDSTAB-001 slice 2a (§6) — Sow this ─────────────────────────────────────────
            Replaces VARIETY-REF S4b's "Plant from this packet", which navigated to
            /garden?source_inventory_item_id=…&variety_id=… — Garden's generic add form, with other
            defaults (no status, no sow date, no source type) and an emoji for an icon. This opens
            THE Sow sheet Sow now opens, on this packet, so a sow from here and a sow from there send
            the same POST. Same visibility rule as before: seed rows with stock on hand. The page's
            LIVE provenance rides along (a parent picked in "Saved from" a moment ago counts), since
            it decides whether the planting records saved seed or a bought packet. */}
        {item.category === 'seeds' && (canSowFrom(item) || sown || item.variety_id) && (
          <div data-testid="sow-actions" style={sowActions}>
            {canSowFrom(item) && (
              <SowThisCTA
                item={item}
                onClick={() => setSowPacket(sowPacketFromItem({
                  ...item,
                  source_plant_id: sourcePlantId || null,
                  source_kind: sourceKind || null,
                }))}
              />
            )}
            {/* What that sow made, for the rest of the visit, with the way to it — a line on the
                page, not a toast (the sheet's own "Planted!" toast is the transient half).
                Operational, so it is the same quiet green Sow now's "Sown ✓" chip is. */}
            {sown && (
              <div data-testid="sow-this-sown" role="status" style={sownLine}>
                <span style={{ fontWeight: 700 }}>Sown ✓</span>
                {sown.plantingId && (
                  <Link to={`/plantings/${sown.plantingId}`} data-testid="sow-this-see-planting" style={sownLink}>
                    See the planting
                  </Link>
                )}
              </div>
            )}
            {/* V5-SEEDSTAB-001 slice 2a (§6) — Edit sow details. A packet's sow profile (timing,
                depth, spacing, days to germinate) belongs to its CULTIVAR, and the variety editor is
                the only editor of those fields; this page could only read them. A plain push: the
                editor leaves with navigate(-1) on save and cancel, which lands back here, and it says
                for itself when the viewer cannot edit this cultivar. Every seed row carries a variety
                (chk_inventory_seed_requires_variety); the guard only keeps a row that somehow does
                not from linking to /varieties/undefined/edit. */}
            {item.variety_id && (
              <Link to={`/varieties/${item.variety_id}/edit`} data-testid="edit-sow-details" style={editSowDetailsLink}>
                Edit sow details →
              </Link>
            )}
          </div>
        )}
        {canSowFrom(item) && (
          <SowSheet
            packet={sowPacket}
            draftKey={SOW_DRAFT_KEY}
            onSown={(_packet, planting) => setSown({ plantingId: planting?.id ?? null })}
            onClose={() => setSowPacket(null)}
          />
        )}

        {/* ── V5-SEEDSTAB-001 slice 3 (§9) — the plantings sown from this packet ────────────────────
            GET /:id's sown_from: every live planting whose source_inventory_item_id is this packet,
            archived ones already filtered out by the route (Archive-Hiding Rule), newest sowing first.
            One 44px link each, to the planting. Rendered only when there is one — a packet nobody has
            sown from shows nothing, not an empty heading. Directly under Sow this, whose "Sown ✓" line
            covers a sow made on this visit (the list is the page as loaded), and above the
            germination record of those same sowings. */}
        {item.category === 'seeds' && Array.isArray(item.sown_from) && item.sown_from.length > 0 && (
          <div data-testid="packet-sown-from" style={sownFromCard}>
            <div style={sownFromHeading}>Sown from this packet</div>
            {item.sown_from.map(p => (
              <Link key={p.id} to={`/plantings/${p.id}`} data-testid="sown-from-link" style={sownFromLink}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, overflowWrap: 'anywhere' }}>{p.name}</span>
                  <span style={{ display: 'block', fontSize: T.type.xs2, color: P.mid }}>
                    {[p.sown_at ? `Sown ${formatDate(p.sown_at)}` : '', p.status ? statusLabel(p.status) : '']
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span aria-hidden="true" style={{ flexShrink: 0, fontSize: '1.1rem' }}>›</span>
              </Link>
            ))}
          </div>
        )}

        {/* ── V4-SEEDGERMRATE-001 (BD-057) — this packet's germination record ─────────────────────
            Dave wanted the rate held per PACKET rather than per variety or crop, "because packets
            of the same variety differ by age, vendor, and lot" — so this panel is the whole point
            of the feature, and everything else exists to fill it.

            Combined AND per-sowing, which is his Q2 answer verbatim ("combine them, keep the
            history"). The combined number alone would hide the thing worth knowing: 80% in March
            and 45% in July from the same packet is a packet going over, and a single averaged 62%
            says nothing at all. So the rows stay.

            Rendered only when there is something to say. A packet nobody has counted from shows
            nothing rather than an empty scaffold or a 0% that reads as total failure. */}
        {item.germination && item.germination.sowings?.length > 0 && (
          <div data-testid="packet-germination" style={{
            marginBottom: 20, padding: '14px 16px',
            backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
          }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: P.mid, marginBottom: 10,
                          letterSpacing: '0.3px', textTransform: 'uppercase' }}>
              Germination
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span data-testid="packet-germ-rate" style={{ fontSize: '1.6rem', fontWeight: 700, color: P.green }}>
                {item.germination.rate}%
              </span>
              {/* The raw counts sit beside the percentage permanently, never behind a tap: 7 of 10
                  and 70 of 100 are the same number and not the same evidence, and the decision this
                  panel informs — re-sow from this packet or bin it — turns on which one it is. */}
              <span style={{ fontSize: '0.85rem', color: P.light }}>
                {item.germination.seeds_germinated} of {item.germination.seeds_sown} seeds
                {item.germination.sowings.length > 1 ? ` · ${item.germination.sowings.length} sowings` : ''}
              </span>
            </div>
            {item.germination.sowings.length > 1 && (
              <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
                {item.germination.sowings.map(s => {
                  const up = Number(s.seeds_germinated ?? 0)
                  const n = Number(s.seeds_sown ?? 0)
                  return (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: P.mid }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.sown_at ? String(s.sown_at).slice(0, 10) : 'undated'} — {s.name}
                      </span>
                      <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                        {n > 0 ? `${Math.round((up / n) * 1000) / 10}%` : '—'} ({up}/{n})
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── V4-SEEDLINK-001 — "Saved from": which PLANT did this lot come from? ────────────────
            plants.source_inventory_item_id already answers the reverse ("sown FROM this packet");
            nothing answered this direction, and the only thing the app previously offered was the
            /seeds/saved empty state telling Dave to log a `seed_saved` event — a dead end with 0
            events ever logged and no side effect of any kind.

            SEEDS ONLY, gated like the packet card above. It never appears on
            tools, media or containers.

            THIS PAGE IS THE PLACEMENT THAT MATTERS. /seeds/saved only lists lots that carry a
            seed_stage, and its "Track a lot" picker hard-codes `fermenting` — so attaching a parent
            there would mean writing a false stage into seed_lot_stage_log for a dry-processed lot.
            Every lot is reachable HERE, tracked or not.

            OUTSIDE the <form> deliberately: it writes on selection, so it has no business in a
            surface whose Save button implies unsaved state.

            BUG-SAVEDSEEDPARENTONPRODUCE-001 — the picker is SHOWN ONLY WHILE THE LOT MAY HAVE A
            PARENT: the mirror of the rule below that hides the origin select while a parent is set,
            and the same constraint read from its other side. A lot whose origin says a farm stand, a
            gift or a shop is refused a parent by chk_inventory_seed_source_plant, so a pick here could
            only fail. kindAllowsParentPlant is that CHECK, asked of the LIVE select, so choosing "My
            garden" or "Not recorded" below brings the picker straight back. */}
        {item.category === 'seeds' && (
          <div data-testid="seed-source-plant" style={{ ...card, marginBottom: 20 }}>
            <div style={groupLabel}>Saved from</div>
            {parentAllowed && (
              <>
                <PlantingSelect
                  id="inv-source-plant"
                  value={sourcePlantId}
                  // The second argument is the chosen ROW — the picker passes it so call sites never
                  // need their own id→row lookup, and the chain panel below uses it for the name.
                  onChange={(pid, planting) => saveSourcePlant(pid || '', planting)}
                  // The lot's own cultivar pins the list exactly — every seed row carries a variety_id
                  // (chk_inventory_seed_requires_variety), so this collapses ~239 plantings to the one
                  // to three of that cultivar.
                  varietyId={item.variety_id}
                  // Succession disambiguation: three plantings of one cultivar are indistinguishable by
                  // name, and this is the case the multi-planting minority is made of.
                  labelFormat="wave"
                  // "Not recorded", not "you must choose" — the honest empty state for a bought packet
                  // and for a saved one whose parent Dave no longer remembers.
                  emptyMeaning="none"
                  // An already-set parent stays listed and selected even if it later falls out of scope.
                  retainOutOfScopeValue
                  required={false}
                  onLoadError={() => setSourcePlantLoadFailed(true)}
                  aria-label="Saved from which plant"
                  data-testid="source-plant-select"
                />
                <p data-testid="source-plant-help" style={{
                  margin: 0, color: sourcePlantErr ? P.terra : P.light,
                  fontSize: '0.78rem', lineHeight: 1.5,
                }}>
                  {sourcePlantErr
                    ? sourcePlantErr
                    : sourcePlantLoadFailed
                      ? "Couldn't load your plantings — the rest of this page still saves normally."
                      : sourcePlantBusy
                        ? 'Saving…'
                        : 'The plant this seed was saved from. Leave it empty for bought seed.'}
                </p>
              </>
            )}

            {/* ── V4-SEEDORIGIN-001 — the OTHER half of provenance ────────────────────────────
                "Saved from" answers which of MY plants. This answers where the seed came from when
                it came from none of them: a store-bought pepper scraped for its seed, a gift
                packet, a u-pick fruit. Dave's founding case for it is a Carolina Reaper bought to
                eat. Before this the only place to record that was the item's NAME — a real prod row
                reads "Money Plant (self-saved, variety unrecorded)".

                SHOWN ONLY WHEN NO PARENT PLANT IS SET, and that is the DB constraint made visible
                rather than a layout preference. chk_inventory_seed_source_plant is
                `source_kind IS NULL OR source_kind = 'own_garden' OR source_plant_id IS NULL`, so a
                lot cannot claim it came from a shop AND from one of our plants. With a parent set,
                the origin is answered — it is this garden — so offering a contradicting dropdown
                would be offering a choice the database will refuse.

                Plain Select, NOT EnumSelect, for the reason dropdownRegistry.js records: EnumSelect
                defaults to sort=true and would alphabetize the list, burying the frequency ordering
                the vocabulary is built on ("My garden" first). Same call PutUp.jsx makes.

                BUG-SAVEDSEEDPARENTONPRODUCE-001 — alone in the card when the picker above is hidden,
                so it drops the "Or" and the extra gap, and its help names the way back to a plant. */}
            {!sourcePlantId && (
              <div style={{ marginTop: parentAllowed ? 14 : 0 }} data-testid="seed-source-kind">
                <Field label={parentAllowed ? 'Or where did it come from?' : 'Where did it come from?'} htmlFor="inv-source-kind" optional>
                  <Select
                    id="inv-source-kind"
                    value={sourceKind}
                    onChange={e => saveSourceKind(e.target.value)}
                    disabled={sourceKindBusy}
                    aria-label="Where this seed came from"
                    data-testid="source-kind-select"
                  >
                    {/* "Not recorded" is a first-class answer, not a prompt to choose: it is the
                        honest state of all 260 existing packets and must stay reachable. */}
                    <option value="">Not recorded</option>
                    {PUTUP_SOURCE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </Field>
                <p data-testid="source-kind-help" style={{
                  margin: '6px 0 0', color: sourceKindErr ? P.terra : P.mid,
                  fontSize: '0.78rem', lineHeight: 1.5,
                }}>
                  {sourceKindErr
                    ? sourceKindErr
                    : sourceKindBusy
                      ? 'Saving…'
                      : parentAllowed
                        ? 'For seed you saved from something you did not grow — a shop-bought pepper, a gift, a u-pick.'
                        : 'For seed you saved from something you did not grow — a shop-bought pepper, a gift, a u-pick. From one of your own plants instead? Choose “My garden” to pick which one.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── V4-SEEDHISTORY-001 — this lot's processing chain ────────────────────────────────
            GET /api/inventory-items/:id/seed-stage shipped with the write path and had ZERO
            consumers — the log was written and never read anywhere. A two-week ferment→dry→store
            commitment showed the user nothing back for it, which is the reinforcement loop this
            closes.

            READ-ONLY SINCE V5-SEEDSTAGEONEPLACE-001. This card used to carry a stage <select> that
            moved the pointer WITHOUT appending a log row, plus the count prompt that hung off its
            `stored` transition. Both are gone: a lot's stage is now changed in exactly one place,
            /seeds/saved, where every change writes a seed_lot_stage_log row and can be dated to the
            day the lot actually entered the stage. Two writers, one of which could not log, is what
            made the pointer and the history diverge on 3 of 3 live lots — the divergence notice
            below still fires because the wide PUT and the create INSERT can both still set
            `seed_stage` server-side, and neither appends.

            SEEDS ONLY, gated exactly like the two cards above. A hori-hori has no processing chain
            and must not grow an empty one. */}
        {item.category === 'seeds' && (
          <div data-testid="seed-stage-panel" style={{ ...card, marginBottom: 20 }}>
            <div style={groupLabel}>Seed processing</div>
            {/* The moved capability, named where it used to live. Deleting the control without
                saying where it went would leave a user who has spotted a wrong stage with nothing
                to do about it — and seed_lot_stage_log has no DELETE, so "leave it" is permanent.
                44px box for the reason SavedSeeds.jsx gives about `set-source-plant`: this is a
                card action, not a link inside a sentence. */}
            <Link
              to={seedsHref('saved', { lot: item.id })}
              data-testid="seed-stage-change-link"
              style={{
                display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start',
                minHeight: 44, paddingRight: 8, color: P.green, fontSize: '0.82rem',
              }}
            >
              Change stage in Saved seeds →
            </Link>
            <SeedStageHistory
              itemId={item.id}
              currentStage={item.seed_stage ?? null}
              sourcePlantId={sourcePlantId}
              sourcePlantName={sourcePlantName}
            />
          </div>
        )}

        {/* V2-PHOTO-F1 Session 2: inventory item photo upload.
            Belongs just below the S4b CTA per Session 2 spec (Sow this since V5-SEEDSTAB-001 slice 2a).
            Useful for capturing seed-packet photos, durable-tool photos, etc.
            V5-SEEDCARDS-001: not for seeds — their upload lives in the packet card above, so the
            page never carries two. Every other category renders this card exactly as before. */}
        {item.category !== 'seeds' && (
          <div style={{
            marginBottom: 20, padding: '14px 16px',
            backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
          }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: P.mid, marginBottom: 10,
                          letterSpacing: '0.3px', textTransform: 'uppercase' }}>
              Photo
            </div>
            <PhotoUpload
              keyPrefix="inventory"
              parentId={item.id}
              linkage={{ inventory_item_id: item.id }}
              errorMode="surface"
              inputId={`inventory-photo-${item.id}`}
            />
          </div>
        )}

        {errors._form && (
          <div style={{
            backgroundColor: P.alert, border: `1px solid ${P.alertBorder}`,
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            fontSize: '0.875rem', color: P.bannerInk,
          }}>
            {errors._form}
          </div>
        )}

        <form onSubmit={handleSave} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Core fields ── */}
          <div style={card}>
            <div style={groupLabel}>Item details</div>

            <Field label="Name" error={errors.name}>
              <Input
                value={form.name}
                onChange={e => set('name', e.target.value)}
                error={!!errors.name}
              />
            </Field>

            <Field label="Category" error={errors.category}>
              <EnumSelect
                value={form.category}
                onChange={e => set('category', e.target.value)}
                error={errors.category}
                enumValues={visibleCats}
                placeholder="— Select —"
              />
            </Field>

            <Field label="Status">
              <EnumSelect
                value={form.status}
                onChange={e => set('status', e.target.value)}
                enumValues={STATUSES}
              />
            </Field>

            {/* Consumable quantity */}
            {isConsumable && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {/* BUG-INVQTYROUNDTRIP-001 — step="any" on all four numeric(10,3) boxes (here,
                    both reorder_* below, and Qty purchased), and it is not cosmetic. type="number"
                    defaults to step=1, so a box holding 4.4 reports validity.stepMismatch and the
                    form is INVALID: this <form> carries noValidate, which is the ONLY reason a
                    fractional save still submits. Measured, not assumed — PlantForm's quantity input
                    has the same implicit step and NO noValidate, and there a fractional prefill makes
                    the whole planting form unsubmittable (see PlantingEditor.formFromPlant). Declaring
                    the step the column actually has removes the dependence on that one attribute.
                    The durable Quantity box below keeps step="1": inventory_items.quantity is an
                    integer column. */}
                {/* V5-SEEDCARDS-001 — for a packet this is now the ONE place its quantity is
                    written, so the rule that used to sit beside the My seeds stepper sits here. */}
                <Field label="Qty on hand" error={errors.quantity_on_hand}
                  help={isSeedForm ? 'Set to 0 when the packet is used up — it moves to Sowed previously.' : undefined}>
                  <Input
                    type="number" min="0" step="any"
                    value={form.quantity_on_hand}
                    onChange={e => set('quantity_on_hand', e.target.value)}
                    error={!!errors.quantity_on_hand}
                  />
                </Field>
                <Field label="Unit">
                  <EnumSelect
                    value={form.unit}
                    onChange={e => set('unit', e.target.value)}
                    enumValues={UNITS}
                    placeholder="— Unit —"
                  />
                </Field>
              </div>
            )}

            {/* Durable quantity */}
            {!isConsumable && (
              <Field label="Quantity" error={errors.quantity}>
                <Input
                  type="number" min="1" step="1"
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  error={!!errors.quantity}
                />
              </Field>
            )}
          </div>

          {/* ── Optional details ── */}
          <div style={card}>
            <div style={groupLabel}>Details</div>

            {isConsumable && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Reorder when below">
                  <Input
                    type="number" min="0" step="any"
                    value={form.reorder_threshold}
                    onChange={e => set('reorder_threshold', e.target.value)}
                  />
                </Field>
                <Field label="Reorder quantity">
                  <Input
                    type="number" min="0" step="any"
                    value={form.reorder_quantity}
                    onChange={e => set('reorder_quantity', e.target.value)}
                  />
                </Field>
              </div>
            )}

            {!isConsumable && (
              <>
                <Field label="Condition">
                  <EnumSelect
                    value={form.condition}
                    onChange={e => set('condition', e.target.value)}
                    enumValues={CONDITIONS}
                    placeholder="— Optional —"
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Brand">
                    <Input
                      value={form.brand}
                      onChange={e => set('brand', e.target.value)}
                    />
                  </Field>
                  <Field label="Model">
                    <Input
                      value={form.model}
                      onChange={e => set('model', e.target.value)}
                    />
                  </Field>
                </div>
              </>
            )}

            <Field label="Location">
              <Input
                value={form.location_text}
                onChange={e => set('location_text', e.target.value)}
                placeholder="e.g. Stable rack, shelf 2"
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Unit cost ($)">
                <Input
                  type="number" min="0" step="0.01"
                  value={form.unit_cost}
                  onChange={e => set('unit_cost', e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Qty purchased">
                <Input
                  type="number" min="0" step="1"
                  value={form.quantity_purchased}
                  onChange={e => set('quantity_purchased', e.target.value)}
                />
              </Field>
            </div>

            {/* ── V4-SOURCEREG-001 — the EDIT half of the same three fields as /inventory/add ─────
                Both halves or neither: the add form alone would leave every existing item stranded
                on free text, which is where the 73 spellings of 35 places came from. `source` stays
                and is relabelled to the order/lot reference it actually holds — 567 rows carry text
                with no other column in this design and it was deliberately never overwritten.
                V5-SEEDCARDS-001: a seed's is "Supplier" — the packet card beside it now shows a
                "Country of origin", and two different "Origin"s on one page is a labelling defect.
                Same column, same picker, same testid; every other category keeps "Origin". */}
            <Field label={isSeedForm ? 'Supplier' : 'Origin'}
              help={isSeedForm ? 'Who sold, packed or gave it.' : 'Who grew, bred, packed or gave it.'}>
              <SourcePicker
                label={isSeedForm ? 'Supplier' : 'Origin'}
                value={form.source_id}
                onChange={(sid) => {
                  // Clearing the origin clears the venue with it — acquired_from means "the shop
                  // WHEN IT DIFFERS from the grower" and is meaningless alone. The distinct-error
                  // is about the PAIR, so it can be resolved from this end too; `set()` would only
                  // clear its own key's.
                  if (sid) setForm(f => ({ ...f, source_id: sid }))
                  else setForm(f => ({ ...f, source_id: '', acquired_from_source_id: '' }))
                  setErrors(e => (e.acquired_from_source_id ? { ...e, acquired_from_source_id: null } : e))
                }}
                placeholder="Search sources…"
                data-testid="inv-detail-origin"
              />
            </Field>

            {/* Only once an origin exists — before that the question is "different from what?". */}
            {form.source_id !== '' && (
              <Field label="Acquired from" error={errors.acquired_from_source_id}
                help={`The shop or venue, only if it differs from the ${isSeedForm ? 'supplier' : 'origin'}.`}>
                <SourcePicker
                  label="Acquired from"
                  value={form.acquired_from_source_id}
                  onChange={(sid) => set('acquired_from_source_id', sid)}
                  placeholder="Search sources…"
                  data-testid="inv-detail-acquired-from"
                />
              </Field>
            )}

            <Field label="Order / lot reference"
              help="Order number, lot code, discount, date — anything with no field of its own.">
              <Input
                value={form.source}
                onChange={e => set('source', e.target.value)}
                placeholder="e.g. order no. 350019, item 233"
              />
            </Field>

            {/* V5-SEEDCARDS-001 — Dave's words for it on a seed ("url of the packet"); the packet
                card's "Packet page" link reads this field. */}
            <Field label={isSeedForm ? 'Packet page (URL)' : 'Source URL'}>
              <Input
                type="url"
                value={form.source_url}
                onChange={e => set('source_url', e.target.value)}
                placeholder="https://…"
              />
            </Field>

            <Field label="Purchase date">
              <Input
                type="date"
                value={form.purchase_date}
                onChange={e => set('purchase_date', e.target.value)}
              />
            </Field>

            {/* BUG-SEEDYEARNOOP-001 — the first surface in the app that renders year_harvested.
                The column has been in prod since 2026-07-13 and reaches the browser on every
                inventory read (all three GETs are SELECT i.*), but nothing has ever displayed it,
                which is how it stayed inert long enough for a writer to ship against it and no-op
                unnoticed.
                It matters because germination decays with age: how old a lot is decides whether it
                is worth sowing, and only 4 of 316 seed rows record it. All four are here rather
                than on SavedSeeds because every one of them has a NULL seed_stage, and that page
                lists tracked lots — /inventory/:id is the only surface that reaches an untracked
                lot, which SavedSeeds' own comment states.
                Seeds only: a harvest year on a trowel is noise, and buildChanges omits the key
                entirely for non-seed rows so the column is left alone rather than written null. */}
            {form.category === 'seeds' && (
              <Field label="Seed harvest year" error={errors.year_harvested}
                help="The year this seed was grown, not the year it was bought.">
                <Input
                  type="text"
                  inputMode="numeric"
                  data-testid="inv-year-harvested"
                  placeholder="e.g. 2025"
                  value={form.year_harvested}
                  onChange={e => set('year_harvested', e.target.value)}
                />
              </Field>
            )}

            <Field label="Notes">
              <Textarea
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
              />
            </Field>
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…">
                Save changes
              </Button>
              {item.category === 'seeds' ? (
                // V5-SEEDSTAB-001 — Back to the Seeds view that opened this page, else to My seeds.
                <button
                  type="button"
                  data-testid="inventory-detail-cancel"
                  onClick={() => (pushedFromSeeds ? navigate(-1) : navigate(SEEDS_MINE))}
                  style={{ color: P.mid, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.88rem', fontFamily: 'inherit', minHeight: 44 }}
                >
                  Cancel
                </button>
              ) : (
                <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
                  Cancel
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: P.light, fontSize: '0.82rem', textDecoration: 'underline', padding: 0,
              }}
            >
              Remove item
            </button>
          </div>
        </form>

        {/* Delete confirmation */}
        {confirmDelete && (
          <div style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 500, padding: 20,
          }}>
            <div style={{
              backgroundColor: P.white, borderRadius: 12,
              padding: '28px 24px', maxWidth: 380, width: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}>
              <h2 style={{ margin: '0 0 10px', fontSize: '1.1rem', color: P.dark }}>Remove item?</h2>
              <p style={{ margin: '0 0 24px', fontSize: '0.88rem', color: P.mid }}>
                "{item.name}" will be hidden from your inventory. This can't be undone from the app.
              </p>
              <div style={{ display: 'flex', gap: 12 }}>
                <Button
                  variant="danger"
                  loading={deleting}
                  loadingLabel="Removing…"
                  onClick={handleDelete}
                >
                  Remove
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

// ── V5-SEEDSTAGEONEPLACE-001 — the wide-PUT strip lists used to live here ────────────────────────
// PUT_DERIVED_KEYS / PUT_PRESENCE_GUARDED_KEYS / putPayloadFrom() were removed with the stage
// control and count prompt that were this page's only wide-PUT writers. This page now reaches the
// wide PUT solely through useInventory.updateItem(buildChanges()), which emits the edit form's own
// projection and names no derived or presence-guarded key.
//
// The contract they documented is NOT gone — /seeds/saved still round-trips a whole row into that
// PUT for the count, and LIST_ROW_PUT_STRIP in src/pages/SavedSeeds.jsx carries the same per-key
// reasoning. Its guard is now anchored on the handler's own hasOwnProperty guards rather than on a
// second hand-maintained copy here; see SavedSeeds.storedCount.test.jsx.

// ── Shared primitives ─────────────────────────────────────────────────────────
// Who gets "Sow this": seed rows with stock on hand — the rule the Plant-from-packet CTA it replaced
// shipped with (VARIETY-REF S4b) — and NOT a lot still fermenting or drying. Sow now withholds those
// (wet seed in a jar is not sowable), and this is the same sheet, so the two doors answer alike; the
// page's "Change stage in Saved seeds" link is the way on for such a lot. `isInProcess` is the engine's
// own predicate, not a copy. `?? 0`: an untracked (null) quantity shows no CTA.
function canSowFrom(item) {
  return item?.category === 'seeds' && Number(item.quantity_on_hand ?? 0) > 0 && !isInProcess(item)
}

// V5-SEEDSTAB-001 slice 2a — the S4b card-button, re-pointed at the Sow sheet: same footprint (full
// width, 56px, the 44px floor with room to spare at 360px), the colour registry sprout instead of the
// 🌱 emoji (the same glyph BottomNav's "Sow from seed" and the packet box use). The accessible name
// starts with the visible words ("Sow this"), so a voice command naming the button still reaches it.
function SowThisCTA({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Sow this: ${item.name}`}
      data-testid="sow-this"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '14px 16px',
        backgroundColor: P.greenPale,
        border: `2px solid ${P.green}`,
        borderRadius: T.radiusCard,
        cursor: 'pointer',
        minHeight: 56,
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <Icon name="lifecycle.sprout" size={24} decorative style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 700, color: P.green, fontSize: T.type.md }}>
          Sow this
        </span>
        <span style={{ display: 'block', fontSize: '0.78rem', color: P.mid, marginTop: 2 }}>
          Starts a planting from this packet, sown today.
        </span>
      </span>
      <span aria-hidden="true" style={{ color: P.green, fontSize: '1.1rem' }}>›</span>
    </button>
  )
}

// The group under the packet card: Sow this, what a sow from here made, and Edit sow details. One
// bottom margin for the group, so the link reads as part of the sowing actions, not a stray line.
const sowActions = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: T.space.xs, marginBottom: T.space.lg }
const sownLine = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: T.space.sm,
  color: P.green, fontSize: T.type.sm,
}
const sownLink = { display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, color: P.green, fontWeight: 700 }
// The same shape as "Change stage in Saved seeds →" further down this page: a text link, underlined,
// on the 44px floor.
const editSowDetailsLink = {
  display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start', minHeight: T.tapMinHeight,
  paddingRight: 8, color: P.green, fontSize: T.type.sm,
}
// V5-SEEDSTAB-001 slice 3 — "Sown from this packet": the germination panel's card and heading, so the
// two records of this packet's sowings read as one family; each planting a full-width row link on the
// 44px floor (the whole row is the target, not the name).
const sownFromCard = {
  marginBottom: 20, padding: '8px 16px',
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
}
const sownFromHeading = {
  fontSize: '0.78rem', fontWeight: 700, color: P.mid, margin: '6px 0 2px',
  letterSpacing: '0.3px', textTransform: 'uppercase',
}
const sownFromLink = {
  display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.tapMinHeight,
  padding: '6px 0', color: P.green, fontSize: T.type.sm, textDecoration: 'none',
}

// ── V5-SEEDCARDS-001 — the packet card (UX spec §7.2) ─────────────────────────────────────────────
// The row Dave tapped on My seeds, continued: the same 4px supplier stripe, the same chip, the same
// fact words. NOT a hero — no scrim, no floating Back/Share; PhotoHero stays the app's one hero shell.
//
// THE IMAGE BOX is 3:4 portrait and CONTAIN on white, so a packet's printed name is never cropped.
// FULL tier because the by-id GET signs only the original, and the viewer then opens on the same bytes.
// It is a button onto the app's Lightbox, which registers with the dismiss registry at armsBack, so
// Android Back closes the viewer and leaves the page where it was. The photo object comes from
// lotPhoto(), whose id is the PHOTO's (hero_photo_id): PhotoImg re-mints an expired URL by that id,
// and the lot's own id there would 404 into a permanent blank.
//
// WITH NO IMAGE the box is the upload trigger: it clicks the file input of the one PhotoUpload below
// it, by the `inventory-photo-<id>` id that automated bulk-attach sessions also drive — so there is
// still exactly one input, one upload path and one contract.
function PacketCard({ item, supplierName, packetUrl, onUploadComplete }) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const photo = lotPhoto(item)
  // No stripe without a supplier: a grey one would read as a disabled supplier (supplierPalette.js).
  const stripe = supplierColors(supplierName)?.primary ?? null
  // My seeds' words and order (seedFacts.js); the chip's short numbers, for a ~168 px column.
  const facts = seedFacts(item, { compact: true })
  // The lot's own packet page first. Only without one does the cultivar's reference URL stand in, and
  // then it is named for where it goes — it usually points at another seller (UX spec P6).
  const packet = linkTarget(packetUrl)
  const about = packet ? null : linkTarget(item.variety_source_url)
  const link = packet ? { ...packet, words: 'Packet page' }
    : about ? { ...about, words: 'About this variety' }
    : null
  const inputId = `inventory-photo-${item.id}`

  return (
    <>
      <div data-testid="packet-card" style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        marginBottom: 20, padding: 14,
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        // 3px of padding stands in for a missing stripe, so nothing shifts when the registry loads.
        ...(stripe ? { borderLeft: `4px solid ${stripe}` } : { paddingLeft: 17 }),
      }}>
        <div style={{ flex: '0 0 auto', width: 'clamp(120px, 33vw, 160px)' }}>
          {photo ? (
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              aria-label={`Enlarge packet photo of ${item.name}`}
              data-testid="packet-photo-open"
              style={{ ...PACKET_BOX, backgroundColor: P.white }}
            >
              <PhotoView
                photo={photo}
                tier={TIER.FULL}
                alt=""
                decoding="async"
                data-testid="packet-photo"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => document.getElementById(inputId)?.click()}
              data-testid="packet-photo-add"
              style={{
                ...PACKET_BOX, backgroundColor: P.greenPale,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <Icon name="lifecycle.sprout" size={32} decorative />
              <span style={{ fontSize: '0.75rem', color: P.mid }}>Add packet photo</span>
            </button>
          )}
          <PhotoUpload
            keyPrefix="inventory"
            parentId={item.id}
            linkage={{ inventory_item_id: item.id }}
            errorMode="surface"
            inputId={inputId}
            buttonLabel="Add photo"
            buttonStyle={ADD_PHOTO_BTN}
            onUploadComplete={onUploadComplete}
          />
        </div>

        {/* Read-only: cultivar facts, edited in the variety editor, never here. */}
        <div data-testid="packet-facts" style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
        }}>
          {supplierName && <SupplierChip name={supplierName} full />}
          {facts.map(f => (
            <div key={f.key} data-testid="packet-fact" data-fact={f.key}>
              <div style={{ fontSize: '0.72rem', color: P.mid }}>{f.label}</div>
              <div style={{
                fontSize: '0.88rem', color: P.dark, overflowWrap: 'anywhere',
                fontStyle: f.italic ? 'italic' : undefined,
              }}>
                {f.value}
              </div>
            </div>
          ))}
          {link && (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="packet-link"
              style={{
                position: 'relative', display: 'inline-flex', alignItems: 'center', minHeight: 44,
                color: P.green, fontSize: '0.82rem', fontWeight: 600,
                textDecoration: 'none', overflowWrap: 'anywhere',
              }}
            >
              {/* Named by its CONTENT — the sentence a screen reader should hear — with the glyph
                  line hidden from it. Not aria-label: the a11y gate's static layer rebuilds an <a>
                  without its href, where a name is prohibited, so the label would read as a defect. */}
              <span aria-hidden="true">{link.words} · {link.domain} ↗</span>
              <span style={SR_ONLY}>{`${link.words} on ${link.domain}, opens in browser`}</span>
            </a>
          )}
        </div>
      </div>

      {photo && (
        <Lightbox
          open={viewerOpen}
          images={[{ id: photo.id, src: photo.featured_photo_view_url, alt: `Packet photo of ${item.name}`, caption: null }]}
          index={0}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  )
}

const PACKET_BOX = {
  position: 'relative', display: 'block', width: '100%', aspectRatio: '3 / 4',
  padding: 0, margin: 0, overflow: 'hidden', cursor: 'pointer', fontFamily: 'inherit',
  border: `1px solid ${P.border}`, borderRadius: 10,
}
// LiveRegion.jsx's visually-hidden recipe.
const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}
// A text button, full column width so its target is the column and not the word.
const ADD_PHOTO_BTN = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '100%', minHeight: 44, padding: '0 4px',
  background: 'none', border: 'none', color: P.green,
  fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
}

// A stored URL as a link: http(s) only — these are free-text columns, and one holding `javascript:`
// must never become an href — labelled by the host it actually opens, minus a leading "www.".
function linkTarget(raw) {
  const href = typeof raw === 'string' ? raw.trim() : ''
  if (!href) return null
  let u
  try { u = new URL(href) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return { href, domain: u.hostname.replace(/^www\./i, '') }
}

// What an after-upload re-read may change on the loaded item: the photo fields, nothing else. A
// response with no URL never blanks a box that has one (a presign that failed on the re-read is not
// news about the packet), and an unchanged hero keeps the URL already rendering — a re-signed URL for
// the same photo would make the box download the full original again for nothing.
const PACKET_PHOTO_KEYS = ['featured_photo_id', 'hero_photo_id', 'featured_photo_view_url']
function adoptPacketPhoto(prev, next) {
  if (!prev || !next?.featured_photo_view_url) return prev
  if (prev.featured_photo_view_url && prev.hero_photo_id === next.hero_photo_id) return prev
  const out = { ...prev }
  for (const k of PACKET_PHOTO_KEYS) out[k] = next[k] ?? null
  return out
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px' }}>{children}</div>
    </div>
  )
}
function ErrMsg({ msg }) {
  return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div>
}

const card = {
  backgroundColor: P.white, border: `1px solid ${P.border}`,
  borderRadius: 10, padding: '20px 18px',
  display: 'flex', flexDirection: 'column', gap: 16,
}
const groupLabel = {
  fontSize: '0.7rem', fontWeight: 700, color: P.greenLight,
  letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 4,
}
