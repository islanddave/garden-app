// V4-SAVESEEDBTN-001 — "Save seed" from a planting: the CREATE half of the seed-lot flow.
//
// WHY THIS EXISTS. Nothing in this app could create a seed lot. /seeds/saved only attaches a stage
// to an inventory row that already exists, so saving seed off a plant meant hand-building a packet
// at /inventory/add and then finding it again in a 260-row unfiltered picker — and the one door to
// the whole seed surface was the eighth row of a collapsed More sheet.
//
// The structural win of launching from a planting is that the parent is a PARAMETER, not a picker:
// source_plant_id AND variety_id both come off the record this page already loaded, so the sheet
// asks for a name and a count rather than for identity. That is also why there is no
// <PlantingSelect> here — a picker on this surface asks a question we already know the answer to.
//
// WRITE SHAPE (POST /api/inventory-items). Every key is load-bearing; see validateCreate and the
// INSERT column list in lambda/inventory-items/index.js:
//   type 'consumable' + unit 'packet' + quantity_on_hand — validateCreate requires ALL THREE
//     together (quantity_on_hand is the consumable arm's count; `quantity` is the durable one).
//   category 'seeds' — the discriminator both the CHECK and the /source-plant route key off.
//   variety_id — MANDATORY, never sent null. chk_inventory_seed_requires_variety is
//     `category <> 'seeds' OR variety_id IS NOT NULL`, and validateCreate 400s on a seeds row
//     without one before the CHECK ever sees it. Defaulted from the planting, overridable.
//   source_plant_id — the point of the whole feature. BUG-SEEDPOSTDROPSPARENT-001: this key was
//     named in NEITHER the INSERT column list nor its VALUES, so a client that sent one got 201
//     back with the provenance silently dropped. It is persisted and household-authorized now.
//
// THE STAGE IS A SECOND REQUEST, not a field on the create. The INSERT does name seed_stage, but
// writing it there sets the column WITHOUT a seed_lot_stage_log row — and /seeds/saved derives its
// entire queue from stage_entered_at (a lot with no log entry sorts LAST, duration unknown). POST
// /seed-stage writes the column and the log row in one statement, so the lot lands on that page
// with a real clock on it. It also carries its own failure: the lot exists either way, and
// reporting a landed create as failed because an optional stage did not land is the worse error.
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet } from '../forms'
import VarietyPicker from '../VarietyPicker.jsx'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'
import { P } from '../../lib/constants.js'

// MIRRORS src/pages/SavedSeeds.jsx's PROCESS_ENTRY, deliberately rather than importing it: that is
// a page, and a component reaching into a page for a constant inverts the dependency. Both copies
// are the live vocabulary of the two DB CHECKs, not UI invention —
// inventory_items_seed_process_check is `wet | dry` and inventory_items_seed_stage_check is
// `fermenting | drying | stored`. The wet/dry split is BUG-SEEDPROCFORCED-001: beans, peas, lettuce
// and every brassica are threshed from a pod that dried on the plant and never fermented, so a
// hard-coded `fermenting` entry writes a permanent false row into seed_lot_stage_log.
const PROCESS_ENTRY = {
  wet: {
    stage: 'fermenting',
    label: 'Wet — ferment first',
    sub: 'Tomato, cucumber, squash, melon: seed washed or fermented out of wet pulp',
  },
  dry: {
    stage: 'drying',
    label: 'Dry — no ferment',
    sub: 'Beans, peas, lettuce, brassicas: seed threshed from a pod dried on the plant',
  },
}

/**
 * V4-SAVESEEDBTN-001 — the lot's opening name. Pure, exported for test.
 * Variety first because that is what the seed IS; the planting's own name is the fallback for a
 * planting with no cultivar attached. The year is what separates this lot from next season's, and
 * it is the LOCAL year — a December save in Eastern would file under next year off a UTC clock.
 * Always editable: this is a starting point, not a naming scheme.
 */
export function defaultLotName(planting, today = todayLocalISO()) {
  const base = planting?.variety_ref?.name || planting?.name || ''
  const year = String(today).slice(0, 4)
  return base ? `${base} — saved ${year}` : `Saved seed ${year}`
}

/** The planting's own cultivar, in the shape VarietyPicker's `value` wants. Null when it has none. */
function plantingVariety(planting) {
  const ref = planting?.variety_ref
  if (ref?.id) return ref
  // A record can carry variety_id without the joined ref (narrow projections do). The id is what
  // the write needs, so keep it and let the picker fill the name in if the user opens it.
  if (planting?.variety_id) return { id: planting.variety_id, name: '' }
  return null
}

export default function SaveSeedSheet({ planting, onClose }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const navigate = useNavigate()

  const seeded = plantingVariety(planting)
  const [name, setName] = useState(() => defaultLotName(planting))
  const [variety, setVariety] = useState(seeded)
  // Open by default ONLY when there is nothing to show. The picker's hook fetches /api/varieties on
  // mount, so keeping it collapsed on the common path (the planting knows its cultivar) keeps the
  // whole happy path to zero reads.
  const [pickerOpen, setPickerOpen] = useState(!seeded)
  const [packets, setPackets] = useState('1')
  const [seedProcess, setSeedProcess] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const varietyId = variety?.id ?? null
  const qty = Number(packets)
  const qtyOk = packets.trim() !== '' && Number.isFinite(qty) && qty > 0
  // The missing VARIETY is deliberately NOT in here, and that is the one interesting line in this
  // component. A disabled Save plus an in-writer guard would be two mechanisms enforcing one rule,
  // and a redundant mechanism cannot be tested: neutralise either half and the other keeps the
  // suite green, so neither is ever proven to work. One mechanism, and it is the one that can
  // SPEAK — a dead grey button is not an explanation, an inline sentence naming the missing field
  // is. Name and count stay here because a disabled control is the conventional answer for a field
  // the user can see is blank; the variety is the one that maps to a DB CHECK.
  const canSave = !!name.trim() && qtyOk && !busy

  async function save() {
    if (busy) return
    // chk_inventory_seed_requires_variety refuses `category='seeds' AND variety_id IS NULL`, and
    // validateCreate 400s on it first. Both would tell us what we already know, so nothing leaves
    // the client — the user gets the answer here instead of after a round trip.
    if (!varietyId) {
      setError('Pick the variety this seed came from — a seed lot has to name one.')
      return
    }
    if (!name.trim() || !qtyOk) return
    setBusy(true)
    setError(null)
    try {
      const lot = await fetch('/api/inventory-items', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          category: 'seeds',
          type: 'consumable',
          unit: 'packet',
          quantity_on_hand: qty,
          variety_id: varietyId,
          source_plant_id: planting.id,
        }),
      })
      let stageFailed = false
      if (seedProcess && lot?.id) {
        try {
          await fetch(`/api/inventory-items/${lot.id}/seed-stage`, {
            method: 'POST',
            // entered_at omitted on purpose: absent -> now() server-side, and this stage IS being
            // entered now. The column is a timestamptz, so there is no date-only off-by-one to
            // guard against here — unlike the backdated advance on /seeds/saved.
            body: JSON.stringify({ stage: PROCESS_ENTRY[seedProcess].stage, seed_process: seedProcess }),
          })
        } catch {
          stageFailed = true
        }
      }
      toast.show(stageFailed
        ? { message: "Seed lot saved — couldn't start tracking it", tone: 'error' }
        : { message: 'Seed lot saved', tone: 'success' })
      if (onClose) onClose()
      // The action needs an end, and the lot's own page is it: /inventory/:id is where "Saved from"
      // renders, so the user lands looking at the provenance they just created. A PLAIN navigate,
      // not useOverlayNavigate — /inventory/:id is not registered `overlayable`, so a background in
      // route state would leave the page tree on this planting and render nothing at all.
      if (lot?.id) navigate(`/inventory/${lot.id}`)
    } catch (err) {
      setError(err?.message || "Couldn't save the seed lot")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open busy={busy} onClose={onClose} title="Save seed">
      <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
        From {planting?.name || 'this planting'} — the lot remembers which plant it came off.
      </p>

      <label style={fieldLabelStyle}>
        Lot name
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)}
          data-testid="save-seed-name" style={inputStyle}
        />
      </label>

      <div style={fieldLabelStyle}>
        Variety
        {!pickerOpen && (
          <div style={varietyRowStyle}>
            <span data-testid="save-seed-variety-name" style={{ fontWeight: 400, color: P.dark }}>
              {variety?.name || "this planting's variety"}
            </span>
            <button
              type="button" data-testid="save-seed-variety-change"
              onClick={() => setPickerOpen(true)} style={linkBtnStyle}
            >
              Change
            </button>
          </div>
        )}
      </div>
      {pickerOpen && (
        <div data-testid="save-seed-variety-picker" style={{ marginBottom: 14 }}>
          <VarietyPicker
            id="save-seed-variety" value={variety} onChange={setVariety} required
          />
          {!varietyId && (
            // Named, not silent: a planting with no cultivar is the ONE case this flow cannot
            // default its way out of, and the user needs to know why Save is off.
            <p data-testid="save-seed-no-variety" style={hintStyle}>
              This planting has no variety recorded. Pick the variety this seed came from — a seed
              lot has to name one.
            </p>
          )}
        </div>
      )}

      <label style={fieldLabelStyle}>
        Packets
        <input
          type="number" inputMode="numeric" min="1" step="1" value={packets}
          onChange={(e) => setPackets(e.target.value)}
          data-testid="save-seed-packets" style={inputStyle}
        />
      </label>

      {/* Optional, and DEFAULTED OFF. Choosing a process writes a permanent seed_lot_stage_log row,
          so the sheet must not pick one on the user's behalf — that is BUG-SEEDPROCFORCED-001 in a
          new place. "Not yet" leaves the lot un-staged, exactly as /inventory/add would. */}
      <div style={fieldLabelStyle} id="save-seed-process-label">Start tracking it?</div>
      <div role="group" aria-labelledby="save-seed-process-label" style={{ marginBottom: 14 }}>
        {[['none', 'Not yet — just save the lot', 'It sits in Inventory until you start the process'],
          ...Object.entries(PROCESS_ENTRY).map(([k, m]) => [k, m.label, m.sub])].map(([key, label, sub]) => {
          const selected = key === 'none' ? seedProcess === null : seedProcess === key
          return (
            <button
              key={key} type="button" data-testid={`save-seed-process-${key}`}
              aria-pressed={selected}
              onClick={() => setSeedProcess(key === 'none' ? null : key)}
              style={processRowStyle(selected)}
            >
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 2 }}>
                {sub}
              </span>
              {key !== 'none' && (
                <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 4 }}>
                  Starts in {PROCESS_ENTRY[key].stage}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <p role="alert" data-testid="save-seed-error" style={errorStyle}>{error}</p>
      )}

      <button
        type="button" onClick={save} disabled={!canSave}
        data-testid="save-seed-submit" style={primaryBtnStyle(!canSave)}
      >
        {busy ? 'Saving…' : 'Save seed'}
      </button>
    </Sheet>
  )
}

const fieldLabelStyle = {
  display: 'block', marginBottom: 14, fontSize: '0.82rem', fontWeight: 600, color: P.mid,
}
const inputStyle = {
  display: 'block', width: '100%', minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const varietyRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, backgroundColor: P.white, fontSize: '1rem',
}
const linkBtnStyle = {
  background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
  fontSize: '0.82rem', fontWeight: 600, color: P.green, textDecoration: 'underline',
}
const processRowStyle = (selected) => ({
  display: 'block', width: '100%', textAlign: 'left', minHeight: 64, padding: 12,
  marginBottom: 10, borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${selected ? P.green : P.border}`,
  backgroundColor: selected ? P.greenPale : P.white, color: P.dark,
})
const hintStyle = { margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.5 }
const errorStyle = {
  margin: '0 0 12px', padding: '8px 10px', borderRadius: 8,
  border: `1px solid ${P.alertBorder}`, backgroundColor: P.alert,
  color: P.dark, fontSize: '0.82rem',
}
const primaryBtnStyle = (disabled) => ({
  width: '100%', minHeight: 48, borderRadius: 10, border: 'none',
  backgroundColor: P.green, color: P.white, fontWeight: 700, fontSize: '0.95rem',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
})
