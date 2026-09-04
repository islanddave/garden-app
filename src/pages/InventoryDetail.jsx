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
// V4-SEEDORIGIN-001 — the SAME eight values preservation_log uses, deliberately. This registry is
// one of the four synchronised homes of that vocabulary (the others: lambda/preservation/
// provenance.js, the per-Lambda copy in lambda/inventory-items/source-kinds.js, and the DB CHECK
// chk_inventory_source_kind). preservationProvenance.test.js pins this list against the JS
// canonical; the migration's post_vocabulary_exact gate pins the DB against it.
import { PUTUP_SOURCE_OPTIONS } from '../lib/dropdownRegistry.js'
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
                the vocabulary is built on ("My garden" first). Same call PutUp.jsx makes. */}
            {!sourcePlantId && (
              <div style={{ marginTop: 14 }} data-testid="seed-source-kind">
                <Field label="Or where did it come from?" htmlFor="inv-source-kind" optional>
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
                      : 'For seed you saved from something you did not grow — a shop-bought pepper, a gift, a u-pick.'}
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
              to="/seeds/saved"
              data-testid="seed-stage-change-link"
              style={{
                display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start',
                minHeight: 44, paddingRight: 8, color: P.green, fontSize: '0.82rem',
              }}
            >
              Change this lot&apos;s stage on Saved seeds →
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
