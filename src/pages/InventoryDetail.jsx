import React, { useState, useEffect, useId } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useInventory } from '../hooks/useInventory.js'
import { useApiFetch } from '../lib/api.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { P } from '../lib/constants.js'
import { useToast } from '../context/ToastContext.jsx'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import { INVENTORY_CATEGORIES as CATEGORIES, INVENTORY_UNITS as UNITS, INVENTORY_CONDITIONS as CONDITIONS, INVENTORY_STATUSES as STATUSES } from '../lib/inventoryEnums.js'
import { EnumSelect, Field, Input, Select, Textarea, Button, PlantingSelect } from '../components/forms'
import Spinner from '../components/forms/Spinner.jsx'
import SeedStageHistory from '../components/seed/SeedStageHistory.jsx'
import { SEED_STAGE_OPTIONS } from '../components/seed/seedStages.js'
import { formatQty } from '../lib/format.js'

// Inventory enums centralized in src/lib/inventoryEnums.js (live prod CHECK sets);
// the former local duplicates here were removed (Lane D dedup).

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InventoryDetail() {
  const { id }       = useParams()
  const navigate     = useNavigate()
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
  // hit. Re-baselining here is additive: nothing rendered reads it.
  const [baseline,     setBaseline]     = useState(null)
  // V4-SEEDHISTORY-001 — the last row this page KNOWS is on the server, kept whole rather than as a
  // form snapshot. Distinct from BOTH of the above: `form`/`baseline` are the edit-form projection
  // (itemToForm drops every column the form does not render), and `item` is the LOAD-TIME row that
  // handleSave deliberately does not refresh, so it goes stale the moment a save lands. Neither is
  // safe to round-trip into a wide PUT. Written on load and on every successful write from this
  // page; read only by saveSeedStage, which needs a complete, current row for the reason spelled
  // out there. Nothing rendered reads it.
  const [serverRow,    setServerRow]    = useState(null)

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

  // ── V4-SEEDHISTORY-001 — the lot's CURRENT processing stage ────────────────
  // Its own state and its own write for the same two reasons "Saved from" has its own, plus a third
  // that is specific to this column: routing it through buildChanges() would put it in the wide
  // PUT's payload, and the wide PUT is where seed_stage's explicit-presence guard exists precisely
  // so that form does NOT carry it (lambda/inventory-items/index.js:714-730 — a bare assignment
  // there would null the stage on every unrelated edit).
  const [seedStage,     setSeedStage]     = useState('')
  const [seedStageBusy, setSeedStageBusy] = useState(false)
  const [seedStageErr,  setSeedStageErr]  = useState(null)

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
        setServerRow(data)
        // '' not null: PlantingSelect's `value` is a string and '' is its cleared state.
        setSourcePlantId(data.source_plant_id ?? '')
        // Same '' convention, same reason — Select's cleared state is the empty string.
        setSeedStage(data.seed_stage ?? '')
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
  function itemToForm(i) {
    return {
      name:               i.name              ?? '',
      type:               i.type              ?? 'consumable',
      category:           i.category          ?? '',
      status:             i.status            ?? 'active',
      quantity_on_hand:   formatQty(i.quantity_on_hand),
      quantity:           formatQty(i.quantity),
      unit:               i.unit              ?? '',
      reorder_threshold:  formatQty(i.reorder_threshold),
      reorder_quantity:   formatQty(i.reorder_quantity),
      condition:          i.condition         ?? '',
      unit_cost:          i.unit_cost         != null ? Number(i.unit_cost).toFixed(2)         : '',
      quantity_purchased: formatQty(i.quantity_purchased),
      purchase_date:      i.purchase_date     ?? '',
      source:             i.source            ?? '',
      source_url:         i.source_url        ?? '',
      brand:              i.brand             ?? '',
      model:              i.model             ?? '',
      location_text:      i.location_text     ?? '',
      notes:              i.notes             ?? '',
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
      purchase_date: form.purchase_date        || null,
      unit_cost:     parseNum(form.unit_cost),
      location_text: form.location_text.trim() || null,
      quantity_purchased: parseNum(form.quantity_purchased),
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
    const { error, item: saved } = await updateItem(id, buildChanges())
    setSaving(false)

    if (error) {
      setErrors({ _form: error })
    } else {
      setBaseline(sent)
      // V4-SEEDHISTORY-001 — re-baseline the server mirror off the row the PUT returned. `item` is
      // still deliberately left alone (the heading and breadcrumb keep showing the loaded name), so
      // without this a stage change made after a save would round-trip pre-save values and revert
      // the edit that just landed. Identity-checked for the reason saveSeedStage states: a truthy
      // body that is not this row is worse than no refresh at all.
      if (saved?.id === id) setServerRow(saved)
      // Operational confirmation via the GLOBAL toast layer (auto-dismisses).
      show({ message: '✓ Saved' })
    }
  }

  // ── Save the parent plant (V4-SEEDLINK-001) ────────────────────────────────
  // Writes on selection rather than behind the page's Save button: this is one field with one
  // meaning, and a picker that looks chosen while the value sits unsent is the silent-failure shape
  // BUG-SILENTFAILSWEEP-001 catalogued. Optimistic, then reverted on failure — showing a parent the
  // server does not have is worse than showing none.
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

  // ── Save the current seed stage (V4-SEEDHISTORY-001) ───────────────────────
  // THE REPAIR PATH, and until now it existed only in the Lambda. The wide PUT has accepted
  // `seed_stage` under a hasOwnProperty presence guard since v4-seedsaveflow-001 — including
  // `seed_stage: null` as the deliberate clear — and no UI had ever put that key in a body, so the
  // documented capability was reachable only by hand-crafting an HTTP request. It matters because
  // seed_lot_stage_log has NO delete route (lambda/inventory-items/index.js has only the GET, the
  // INSERT and two LATERAL reads): a mis-tapped stage on /seeds/saved is permanent, and moving this
  // pointer is the only way to say where the lot actually is.
  //
  // IT DOES NOT WRITE HISTORY, deliberately. POST /seed-stage appends a log row; this does not. A
  // correction that logged itself would make `stage_entered_at` the time of the correction rather
  // than the time the lot entered the stage, which is the number /seeds/saved's whole queue is
  // ordered by (BUG-SEEDELAPSEDUPDATED-001). The history panel says so when the two diverge.
  //
  // NOT buildChanges(), and NOT updateItem(). buildChanges() is the edit form's projection and does
  // not carry seed columns at all; updateItem() merges against its own list, which is empty on a
  // deep link. Both would leave the payload short, and the wide PUT assigns every column it names
  // unconditionally (`= ${body.x ?? null}`) — so a short payload is not a partial update, it is a
  // wipe. The complete current row is round-tripped instead.
  async function saveSeedStage(nextStage) {
    const prev = seedStage
    const next = nextStage || null
    // Normalised on both sides: '' and null both mean "no stage", and comparing them raw would fire
    // a pointless write every time the placeholder was re-selected on an untracked lot.
    if ((prev || null) === next) return
    setSeedStage(next ?? '')
    setSeedStageBusy(true)
    setSeedStageErr(null)
    try {
      const updated = await fetch(`/api/inventory-items/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...putPayloadFrom(serverRow ?? item), seed_stage: next }),
      })
      // Only a response that IS this row replaces the mirror. A truthy-but-wrong body — `[]`, `{}`,
      // an envelope — would otherwise poison it, and the NEXT stage write would round-trip that
      // instead of the row, which is the wipe this whole function is built to avoid. Falling back
      // to the previous mirror costs at most a stale field on a later write; accepting garbage
      // costs the row.
      if (updated?.id === id) setServerRow(updated)
      show({ message: '✓ Saved' })
    } catch (e) {
      setSeedStage(prev)
      setSeedStageErr(e?.message ?? 'Could not save that.')
    } finally {
      setSeedStageBusy(false)
    }
  }

  // ── Delete (soft) ──────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true)
    const { error } = await deleteItem(id)
    setDeleting(false)
    if (error) {
      setErrors({ _form: error })
      setConfirmDelete(false)
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
  // confirmation, the Plant-from-packet CTA is pure navigation, and the V4-SEEDLINK-001 "Saved
  // from" picker PATCHes on selection — so its value is on the server before this could observe it.
  // The V4-SEEDHISTORY-001 stage select is the same shape for the same reason: it PUTs on choice,
  // so there is never a moment where it looks set and is not saved.
  //
  // Declared above the loading/error early returns because hooks cannot live below them. `form` and
  // `baseline` are both null until the load resolves, which reads as clean — correct, there is
  // nothing typed yet.
  const hasUnsavedInput = !!(
    form && baseline && Object.keys(baseline).some(k => form[k] !== baseline[k])
  )

  useReportOverlayDirty(hasUnsavedInput)

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

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>
          {' › '}{item.name}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, flex: 1 }}>
            {item.name}
          </h1>
          <FavoriteToggle entityType="inventory_item" entityId={id} />
        </div>

        {/* Plant-from-packet CTA — VARIETY-REF S4b.
            Visible only for seed packets with stock on hand. Tap-target ≥44px (Jen iPhone-primary).
            Carries source_inventory_item_id + variety_id as query params; Garden reads them and
            opens the PlantingEditor add form pre-filled. */}
        {item.category === 'seeds' && Number(item.quantity_on_hand ?? 0) > 0 && (
          <PlantFromPacketCTA
            item={item}
            onClick={() => {
              const params = new URLSearchParams()
              params.set('source_inventory_item_id', item.id)
              if (item.variety_id) params.set('variety_id', item.variety_id)
              navigate(`/garden?${params.toString()}`)
            }}
          />
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

            SEEDS ONLY, gated exactly like the Plant-from-packet CTA above. It never appears on
            tools, media or containers.

            THIS PAGE IS THE PLACEMENT THAT MATTERS. /seeds/saved only lists lots that carry a
            seed_stage, and its "Track a lot" picker hard-codes `fermenting` — so attaching a parent
            there would mean writing a false stage into seed_lot_stage_log for a dry-processed lot.
            Every lot is reachable HERE, tracked or not.

            OUTSIDE the <form> deliberately: it writes on selection, so it has no business in a
            surface whose Save button implies unsaved state. */}
        {item.category === 'seeds' && (
          <div data-testid="seed-source-plant" style={{ ...card, marginBottom: 20 }}>
            <div style={groupLabel}>Saved from</div>
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
          </div>
        )}

        {/* ── V4-SEEDHISTORY-001 — this lot's processing chain, and the control that repairs it ────
            Two things the app has never had, in one card because they answer one question.

            THE HISTORY. GET /api/inventory-items/:id/seed-stage shipped with the write path and had
            ZERO consumers — the log was written and never read anywhere. A two-week ferment→dry→
            store commitment showed the user nothing back for it, which is the reinforcement loop
            this closes.

            THE CONTROL. The wide PUT has accepted `seed_stage` under a presence guard since
            v4-seedsaveflow-001, `null` included as the deliberate clear, and no UI ever sent that
            key — so the documented capability was reachable only by hand-crafting a request. Since
            seed_lot_stage_log has no DELETE, it is also the ONLY repair for a mis-tapped stage.

            SEEDS ONLY, gated exactly like the two cards above. A hori-hori has no processing chain
            and must not grow an empty one.

            OUTSIDE the <form>, same reasoning as "Saved from": the select writes on choice, so it
            carries no unsaved state and has no business under a Save button that implies it does. */}
        {item.category === 'seeds' && (
          <div data-testid="seed-stage-panel" style={{ ...card, marginBottom: 20 }}>
            <div style={groupLabel}>Seed processing</div>
            <Field label="Current stage" htmlFor="inv-seed-stage">
              <Select
                id="inv-seed-stage"
                value={seedStage}
                onChange={e => saveSeedStage(e.target.value)}
                options={SEED_STAGE_OPTIONS}
                // The placeholder IS the clear. Choosing it sends `seed_stage: null` — an explicit
                // key, never an omission, because the handler reads this by presence and an omitted
                // key means "leave it alone", which is the opposite instruction.
                placeholder="— Not tracked —"
                disabled={seedStageBusy}
                // Explicit, so the status line below is announced with the control. Field would
                // otherwise clone `undefined` here — its own `help` slot is unused because this
                // copy switches between three states and Field's is static.
                aria-describedby="inv-seed-stage-help"
                data-testid="seed-stage-select"
              />
            </Field>
            <p id="inv-seed-stage-help" data-testid="seed-stage-help" style={{
              margin: 0, color: seedStageErr ? P.terra : P.light,
              fontSize: '0.78rem', lineHeight: 1.5,
            }}>
              {seedStageErr
                ? seedStageErr
                : seedStageBusy
                  ? 'Saving…'
                  : 'Corrects where this lot is now. It does not add a processing entry — advance a lot from Saved seeds to record one.'}
            </p>
            <SeedStageHistory
              itemId={item.id}
              // The optimistic value, not item.seed_stage: the control reverts on failure, so this
              // tracks what the user is being shown and the two cannot disagree mid-write.
              currentStage={seedStage || null}
              sourcePlantId={sourcePlantId}
              sourcePlantName={sourcePlantName}
            />
          </div>
        )}

        {/* V2-PHOTO-F1 Session 2: inventory item photo upload.
            Belongs just below the S4b Plant-from-packet CTA per Session 2 spec.
            Useful for capturing seed-packet photos, durable-tool photos, etc. */}
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
                <Field label="Qty on hand" error={errors.quantity_on_hand}>
                  <Input
                    type="number" min="0" step="1"
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
                    type="number" min="0" step="1"
                    value={form.reorder_threshold}
                    onChange={e => set('reorder_threshold', e.target.value)}
                  />
                </Field>
                <Field label="Reorder quantity">
                  <Input
                    type="number" min="0" step="1"
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

            <Field label="Source">
              <Input
                value={form.source}
                onChange={e => set('source', e.target.value)}
                placeholder="Store or vendor name"
              />
            </Field>

            <Field label="Source URL">
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
              <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
                Cancel
              </Link>
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

// ── V4-SEEDHISTORY-001 — a complete wide-PUT body, built from a SERVER row ────────────────────────
// The wide PUT is "replace all editable fields": every column in its SET list is assigned
// unconditionally, so anything the body omits is NULLED rather than preserved
// (lambda/inventory-items/index.js:660-672 states this in its own words). A stage-only body would
// therefore not be a partial update — it would erase the name, type, category, quantities and the
// rest. The row that came back from the server is round-tripped instead, which is exactly the
// "frontend sends complete payload" contract the handler documents.
//
// A DENYLIST, not an allowlist, and the direction matters: a column added to that SET list later
// rides through here automatically, where an allowlist would silently start nulling it. Two groups,
// both small enough to state a reason for each:
//
// DERIVED — computed by the id-GET, not columns on the row. Inert in the SET list (it reads only
// the keys it names), stripped because a PUT body carrying a germination summary is noise that
// invites someone to wire it up.
const PUT_DERIVED_KEYS = ['germination', 'featured_photo_view_url', 'variety_name', 'featured_is_explicit']
// PRESENCE-GUARDED — columns the handler writes through `CASE WHEN hasOwnProperty(...)`. OMITTING
// them is the guaranteed no-op; MENTIONING them is an assignment, which is not the same thing:
//   featured_photo_id — the GET returns the DERIVED hero (INV-HERO), not the stored pointer, so
//                       echoing it back would quietly rewrite the pointer to the derived value.
//   variety_id        — validateUpdate 400s on category:'seeds' with an explicitly-null variety
//                       (BUG-INVSEEDPUT400-001), and omission sidesteps that entirely.
//   seed_process      — the lot's process is decided at the moment it enters the pipeline and has
//                       no business being re-asserted from a snapshot by a stage correction.
//   seed_stage        — stripped so the ONLY source of this key is the caller's explicit
//                       assignment. Left in, a caller that stopped setting it would echo the stale
//                       value straight back and the write would look like it worked; stripped, it
//                       is absent instead, which the handler reads as "leave the stage alone" —
//                       still wrong, but wrong in the direction that changes nothing.
const PUT_PRESENCE_GUARDED_KEYS = ['featured_photo_id', 'variety_id', 'seed_process', 'seed_stage']
function putPayloadFrom(row) {
  const out = { ...(row ?? {}) }
  for (const k of [...PUT_DERIVED_KEYS, ...PUT_PRESENCE_GUARDED_KEYS]) delete out[k]
  return out
}

// ── Shared primitives ─────────────────────────────────────────────────────────
function PlantFromPacketCTA({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Plant from ${item.name}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        marginBottom: 20,
        padding: '14px 16px',
        backgroundColor: P.greenPale,
        border: `2px solid ${P.green}`,
        borderRadius: 10,
        cursor: 'pointer',
        minHeight: 56,
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>🌱</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>
          Plant from this packet
        </span>
        <span style={{ display: 'block', fontSize: '0.78rem', color: P.mid, marginTop: 2 }}>
          Opens a new plant pre-filled with this variety.
        </span>
      </span>
      <span aria-hidden="true" style={{ color: P.green, fontSize: '1.1rem' }}>›</span>
    </button>
  )
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
