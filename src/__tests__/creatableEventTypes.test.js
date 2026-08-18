// V4-PICKERGATE-001 — a creation surface must not OFFER a type it cannot SUBMIT.
//
// WHY THE ORACLE IS THE REAL SERVER VALIDATOR AND NOT A LIST. The bug this lane fixes came from a
// hand-list: V4-LOSSUI-001 opened SELECTABLE_EVENT_TYPES and three surfaces inherited two types
// they cannot POST. Re-closing it with another hand-list ("drop failed and given_away here, here
// and here") rots the moment a fourth required-field type appears — which is the same failure one
// level up. So these tests import lambda/events/validators.js, the SAME validatePostBody that
// lambda/events/index.js:2471 runs on every POST, and probe EVERY member of EVENT_TYPES with each
// surface's VERBATIM request body. The required-field set is DERIVED from the server's own
// behaviour; CAPTURE_PANEL_REQUIRED_TYPES only has to agree with it.
//
// Consequence, and it is the point: adding a fourth type with a required field to the validator and
// forgetting this constant reds this file, naming the type — without anyone editing the assertions.
//
// TWO TIERS, BECAUSE THE TWO CAPABILITY ARMS HAVE DIFFERENT ENFORCERS AND MUST NOT BE CONFLATED:
//   Tier 1 — capturePanels. SERVER-enforced, unconditional: absent fields are a hard 400. Proven
//            against validatePostBody, bidirectionally.
//   Tier 2 — plantScoped. CLIENT policy (V4-PLANTREQUIRED-001's D2 predication partition),
//            feature-flagged, and NOT a server 400 for most of its members — a plant-less watering
//            is accepted by the API today. Proven against PLANTING_REQUIRED_TYPES, the canonical
//            partition, never against a copy of it.
// A single tier would have to weaken one of the two proofs to the other's strength.
import { describe, it, expect } from 'vitest'
import { validatePostBody } from '../../lambda/events/validators.js'
import {
  EVENT_TYPES,
  SELECTABLE_EVENT_TYPES,
  CAPTURE_PANEL_REQUIRED_TYPES,
  PLANTING_REQUIRED_TYPES,
  PLANTING_EXEMPT_TYPES,
  requiresCapturePanel,
  creatableEventTypes,
} from '../lib/eventTypes.js'

// Inside validatePostBody's event_date bounds (5 years back / 1 hour forward), computed rather than
// literal so this file does not expire.
const DATE = new Date().toISOString()

// ── The surfaces, as CAPABILITIES + the body they really send ────────────────────────────────────
// `body` is copied key-for-key from each surface's own submit handler. Copied rather than imported
// because the handlers are inside React components; the shapes are pinned by the per-surface render
// tests (ProjectDetail.pickerGate / CaptureFlow.pickerGate) plus the existing POST-body tests.
const SURFACES = [
  {
    name: 'EventNew (Log Event) — renders every required capture panel',
    caps: { capturePanels: true, plantScoped: true },
    // EventNew's handleSubmit attaches harvest{} / metadata{} for the types that need them; the
    // panels are what collect them (HarvestFields, PlantReductionFields).
    body: (t) => ({
      project_id: 'proj-1', plant_id: 'plant-1', event_type: t, event_date: DATE,
      ...(t === 'harvest' ? { harvest: { quantity: 3, unit: 'count' } } : {}),
      ...(t === 'failed' ? { metadata: { qty_reduced: 2, loss_reason: 'pest' } } : {}),
      ...(t === 'given_away' ? { metadata: { qty_reduced: 2, giveaway_reason: 'friend' } } : {}),
    }),
  },
  {
    name: 'ProjectDetail mini-logger — no capture panel, has a planting picker',
    caps: { capturePanels: false, plantScoped: true },
    body: (t) => ({
      project_id: 'proj-1', event_type: t, plant_id: 'plant-1', event_date: DATE,
      title: null, notes: null, private_notes: null, quantity: null,
      is_public: true, has_photo: false,
    }),
  },
  {
    name: 'CaptureFlow event destination — no capture panel, planting always present',
    caps: { capturePanels: false, plantScoped: true },
    body: (t) => ({
      project_id: 'proj-1', plant_id: 'plant-1', event_type: t, event_date: DATE, is_public: true,
    }),
  },
]

describe('V4-PICKERGATE-001 — the required-field set is derived from the server, not assumed', () => {
  // THE GENERALISATION PROOF. Probe every type with a body that has NO capture-panel output at all,
  // and let the server say which ones it refuses. That answer is the set — three today, and
  // whatever it is tomorrow.
  it('CAPTURE_PANEL_REQUIRED_TYPES === the types validatePostBody refuses without panel fields', () => {
    const derived = EVENT_TYPES.filter((t) => validatePostBody({
      project_id: 'proj-1', plant_id: 'plant-1', event_type: t, event_date: DATE,
    }) != null)
    // Sorted compare: the constant's order follows EVENT_TYPES for readability, and order is not
    // part of the claim.
    expect([...derived].sort()).toEqual([...CAPTURE_PANEL_REQUIRED_TYPES].sort())
    // Named explicitly as well, so the failure message says WHICH type moved rather than only that
    // two arrays differ. Three, not the two this lane was briefed on — `harvest` has been a
    // guaranteed 400 on the panel-less surfaces since long before the reduction types existed.
    expect([...derived].sort()).toEqual(['failed', 'given_away', 'harvest'])
  })

  it('requiresCapturePanel agrees with the constant across the whole vocabulary', () => {
    for (const t of EVENT_TYPES) {
      expect(requiresCapturePanel(t)).toBe(CAPTURE_PANEL_REQUIRED_TYPES.includes(t))
    }
  })
})

describe('V4-PICKERGATE-001 Tier 1 — every offered type actually POSTs clean (server oracle)', () => {
  for (const { name, caps, body } of SURFACES) {
    const offered = creatableEventTypes(caps)
    const dropped = EVENT_TYPES.filter((t) => !offered.includes(t))

    // The BOTH-SIDES assertion. Checking only that dropped types 400 would pass just as well if the
    // surface offered nothing at all, which is the other way to get this wrong.
    it(`${name}: offers ${offered.length} types and every one of them validates`, () => {
      expect(offered.length).toBeGreaterThan(0)
      const rejected = offered
        .map((t) => [t, validatePostBody(body(t))])
        .filter(([, err]) => err != null)
        .map(([t, err]) => `${t}: ${err.error}`)
      expect(rejected).toEqual([])
    })

    // GUARDED AGAINST ITSELF. EventNew drops nothing, so this loop would iterate over an empty
    // array and pass while asserting literally nothing — a vacuous test that reads as coverage.
    // The panel-bearing surface is covered by the explicit "drops NOTHING" assertion below instead.
    if (dropped.length > 0) {
      it(`${name}: every one of the ${dropped.length} types it drops would have 400ed`, () => {
        expect(dropped.length).toBe(EVENT_TYPES.length - offered.length)
        for (const t of dropped) {
          const err = validatePostBody(body(t))
          expect(err, `${t} was dropped but the server accepts it from this surface`).not.toBeNull()
          expect(err.status).toBe(400)
        }
      })
    }
  }

  it('EventNew drops NOTHING — the panel-bearing surface still offers the whole vocabulary', () => {
    // Guards the direction the per-surface tests cannot: a fix that narrowed every surface would
    // satisfy all of the above and quietly undo V4-LOSSUI-001.
    expect(creatableEventTypes({ capturePanels: true, plantScoped: true })).toEqual(SELECTABLE_EVENT_TYPES)
    for (const t of ['harvest', 'failed', 'given_away']) {
      expect(creatableEventTypes({ capturePanels: true, plantScoped: true })).toContain(t)
    }
  })
})

describe('V4-PICKERGATE-001 Tier 2 — plantScoped:false drops exactly the D2 predication partition', () => {
  const locationTypes = creatableEventTypes({ capturePanels: false, plantScoped: false })

  it('offers exactly PLANTING_EXEMPT_TYPES — asserted against the canonical partition, not a copy', () => {
    // PLANTING_EXEMPT_TYPES is itself DERIVED (EVENT_TYPES − PLANTING_REQUIRED_TYPES), so this
    // cannot drift into agreement with a stale hand-list. All three capture-panel types are inside
    // PLANTING_REQUIRED_TYPES, so the two arms overlap rather than compose to a longer list.
    expect(locationTypes).toEqual(PLANTING_EXEMPT_TYPES)
    for (const t of locationTypes) expect(PLANTING_REQUIRED_TYPES.has(t)).toBe(false)
  })

  it('drops every planting-predicating type, including all three capture-panel types', () => {
    for (const t of PLANTING_REQUIRED_TYPES) expect(locationTypes).not.toContain(t)
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) expect(locationTypes).not.toContain(t)
  })

  it('the capture-panel arm survives plantScoped:true — the two arms are independent', () => {
    // If the arms were accidentally ANDed into one condition, plantScoped:true would re-admit the
    // capture types on a panel-less surface. That is the ProjectDetail/CaptureFlow-event bug again.
    const plantScoped = creatableEventTypes({ capturePanels: false, plantScoped: true })
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) expect(plantScoped).not.toContain(t)
    expect(plantScoped).toContain('watering') // planting-required, needs no panel
  })
})

describe('V4-PICKERGATE-001 — SELECTABLE_EVENT_TYPES stays the seam', () => {
  it('is still the whole vocabulary, and is what creatableEventTypes reads by default', () => {
    // V4-LOSSUI-001's one-line flip is intact; the per-surface gate did not re-narrow it.
    expect(SELECTABLE_EVENT_TYPES).toEqual(EVENT_TYPES)
    // Same order, not just the same members: proves the default source is that constant rather than
    // an independently-built list that happens to hold the same values.
    expect(creatableEventTypes({ capturePanels: true, plantScoped: true })).toEqual(SELECTABLE_EVENT_TYPES)
  })

  it('narrowing the seam narrows every creation surface at once', () => {
    // The one-line re-narrowing V4-LOSSUI-001 preserved: simulated by passing a narrowed list,
    // since the constant itself is frozen above.
    const narrowed = SELECTABLE_EVENT_TYPES.filter((t) => t !== 'watering')
    expect(creatableEventTypes({ capturePanels: true, plantScoped: true }, narrowed)).not.toContain('watering')
    expect(creatableEventTypes({ capturePanels: false, plantScoped: true }, narrowed)).not.toContain('watering')
  })

  it('defaults to the most restrictive capabilities — a caller that declares nothing gets the safe list', () => {
    expect(creatableEventTypes()).toEqual(creatableEventTypes({ capturePanels: false, plantScoped: false }))
  })
})
