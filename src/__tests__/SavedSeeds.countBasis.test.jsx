// V5-SEEDESTTOGGLE-001 — recording WHETHER A SEED COUNT WAS COUNTED OR ESTIMATED, from both doors.
//
// THE DEFECT THIS PINS. `inventory_items.seed_count_estimated` shipped with V5-SEEDQTY-001 and
// SavedSeeds' seedCountLabel has rendered `approx. 200 seeds` off it since V5-SEEDCOUNTCARD-001 —
// but both client writers hardcoded `false`, so a vendor packet reading "approx. 200 seeds" was
// recorded as a number Dave had counted out himself and the `approx.` branch was unreachable from
// inside the app. The column exists because, in V5-SEEDQTY-001's own words, "a vendor's 'approx. 200
// seeds' and a hand-counted 185 are different facts"; until this change the app could only ever
// assert one of them.
//
// ONE FILE FOR TWO SURFACES, deliberately, and it is the reason this is not two files. The whole
// design constraint is that the create sheet (src/components/planting/SaveSeedSheet.jsx) and the
// advance sheet (src/pages/SavedSeeds.jsx) say the SAME words and send the SAME pair — a split file
// can prove each surface self-consistent while they drift apart. The identical-wording assertions
// below read one exported constant through both renders, so a surface that re-spells the label fails
// here rather than shipping.
//
// WHAT IS NOT ASSERTED, said out loud. There is no CLEARING path to test: neither writer can send
// `seed_count: null`. seedMeasurePayload omits the key entirely on a blank field and submitStage is
// gated on `count.value != null`, so "clear the count" is not a reachable state from either sheet —
// it is reachable only through the route directly, whose own half-pair refusal
// (lambda/inventory-items/index.js) is covered by the integration tests that landed with it in
// edc12b2. What IS asserted here is the invariant that makes a half-pair unreachable from the
// client: the two keys are never present without each other, in any body either surface emits.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchSpy, navigateSpy, toastSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../context/ToastContext.jsx', async (orig) => {
  const actual = await orig()
  return { ...actual, useOptionalToast: () => ({ show: toastSpy }) }
})
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: vi.fn(), takePendingCapture: vi.fn() }))
// The real picker fetches /api/varieties on mount, which would put a read into a call list several
// assertions here read by path. Stubbed for the same reason the sibling seedMeasure file stubs it.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="variety-picker-value">{value?.id ?? 'none'}</span>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import SaveSeedSheet, { SEED_BASIS_LABEL, seedMeasurePayload } from '../components/planting/SaveSeedSheet.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// A stored-bound drying lot as the list endpoint returns it, trimmed to the columns these
// assertions read. `seed_count_estimated: false` is the shape every existing prod row holds.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: '1.000', unit: 'packet', tags: [], metadata: null,
  seed_count: 185, seed_weight_g: null, seed_count_estimated: false,
  variety_id: 'v-melon', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z', crop_slug: 'melon',
  year_harvested: 2026, updated_at: '2026-08-30T12:00:00Z',
}
// The row this feature exists for: a bought packet whose count came off the back of it. Unreachable
// from inside the app before this change.
const ESTIMATED = { ...LOT, seed_count: 7000, seed_count_estimated: true }

const PL = {
  id: 'pl1', project_id: 'proj1', name: 'Brandywine #2', status: 'fruiting',
  variety_id: 'v-brandywine',
  variety_ref: { id: 'v-brandywine', name: 'Brandywine', crop_type_slug: 'tomato' },
}

const mountPage = async (items = [LOT]) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  // A real MemoryRouter rather than the sibling files' react-router-dom stub: this file renders the
  // create sheet too, which needs useNavigate, and one router serves both.
  await act(async () => {
    render(<MemoryRouter><ToastProvider><SavedSeeds /></ToastProvider></MemoryRouter>)
  })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

const mountSheet = async () => {
  fetchSpy.mockImplementation(() => Promise.resolve({ id: 'inv-9' }))
  await act(async () => {
    render(<MemoryRouter><SaveSeedSheet planting={PL} onClose={vi.fn()} /></MemoryRouter>)
  })
}

const click = async (testId) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)) })
}
// By ROLE and by NAME, never by testid, and that is the assertion rather than a convenience: it
// proves the control is announced as a binary setting called exactly SEED_BASIS_LABEL. A surface
// that re-spelled the words, or dropped the switch role, stops being findable here.
const basis = () => screen.getByRole('switch', { name: SEED_BASIS_LABEL })
const toggleBasis = async () => { await act(async () => { fireEvent.click(basis()) }) }

const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)
const measureBodies = () => writes()
  .filter(([p, o]) => String(p).endsWith('/seed-measure') && o.method === 'PUT')
  .map(([, o]) => JSON.parse(o.body))
const measureBody = () => {
  const bodies = measureBodies()
  expect(bodies, 'expected exactly one PUT /seed-measure').toHaveLength(1)
  return bodies[0]
}

beforeEach(() => { fetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset() })

describe('the control itself — one component, both surfaces, one set of words', () => {
  it('renders on the advance sheet with the shared label', async () => {
    await mountPage()
    await click('advance-stage')
    expect(basis().textContent).toContain(SEED_BASIS_LABEL)
  })

  it('renders on the create sheet with the SAME label', async () => {
    await mountSheet()
    expect(basis().textContent).toContain(SEED_BASIS_LABEL)
  })

  it('reports its state through aria-checked, not through colour alone', async () => {
    // The switch carries fill, border and font-weight changes too, but those are invisible to a
    // screen reader and to this suite. aria-checked is the fact.
    await mountSheet()
    expect(basis().getAttribute('aria-checked')).toBe('false')
    await toggleBasis()
    expect(basis().getAttribute('aria-checked')).toBe('true')
    await toggleBasis()
    expect(basis().getAttribute('aria-checked')).toBe('false')
  })

  it('clears the 44px tap floor by being a button, not a bare checkbox', async () => {
    // jsdom cannot measure height (that is what scripts/layout-gate/seeds-saved-clearance.mjs is
    // for), so this pins the one thing jsdom CAN see and the gate depends on: the control is a
    // <button>, which is what the gate's `button, input, select, textarea` census selects. Swap it
    // for a <div role="switch"> and it silently leaves that census — passing the gate by leaving it
    // rather than by clearing the floor.
    await mountSheet()
    expect(basis().tagName).toBe('BUTTON')
    expect(basis().getAttribute('type')).toBe('button')
  })
})

describe('the advance sheet — SET, CHANGE and the pair that must travel together', () => {
  it('DEFAULTS TO COUNTED: an untouched switch writes false, exactly as before this change', async () => {
    // The load-bearing default. `false` is what every existing row holds and what this page has
    // always sent; defaulting to `true` would silently re-interpret the meaning of counts already
    // recorded, which is a data migration wearing a UI change.
    await mountPage()
    await click('advance-stage')          // drying -> stored, count prefilled to 185
    await click('stage-save')
    expect(measureBody()).toEqual({ seed_count: 185, seed_count_estimated: false })
  })

  it('SETS the basis: switching it on writes true beside the same count', async () => {
    await mountPage()
    await click('advance-stage')
    await toggleBasis()
    await click('stage-save')
    expect(measureBody()).toEqual({ seed_count: 185, seed_count_estimated: true })
  })

  it('SEEDS FROM THE LOT: an estimated lot re-saved untouched stays estimated', async () => {
    // The regression that would hurt most and show least. Every submit carrying a count carries a
    // basis (the pairing rule), so a switch that opened `false` on an estimated lot would re-assert
    // "hand-counted" about a number Dave already said was a vendor's — the exact fabrication the
    // column exists to prevent, arriving through the door built to fix it.
    await mountPage([ESTIMATED])
    await click('advance-stage')
    expect(basis().getAttribute('aria-checked')).toBe('true')
    await click('stage-save')
    expect(measureBody()).toEqual({ seed_count: 7000, seed_count_estimated: true })
  })

  it('CHANGES it back: an estimate corrected to a hand count writes false', async () => {
    await mountPage([ESTIMATED])
    await click('advance-stage')
    await toggleBasis()
    await click('stage-save')
    expect(measureBody()).toEqual({ seed_count: 7000, seed_count_estimated: false })
  })

  it('reads NULL as not-estimated — the historical row, not a third state', async () => {
    await mountPage([{ ...LOT, seed_count: null, seed_count_estimated: null }])
    await click('advance-stage')
    expect(basis().getAttribute('aria-checked')).toBe('false')
  })

  it('NEVER SENDS HALF THE PAIR — no count, no basis, no request', async () => {
    // chk_inventory_seed_count_basis_pairing is ARMED on prod: `(seed_count IS NULL) =
    // (seed_count_estimated IS NULL)`. A switch flipped on an in-flight stage with the count left
    // blank must send nothing at all, because `{seed_count_estimated: true}` alone is a half-pair the
    // route answers with a 400 — and would be, correctly, a claim about a number nobody gave.
    await mountPage([{ ...LOT, seed_stage: 'fermenting', seed_count: null, seed_count_estimated: null }])
    await click('advance-stage')          // fermenting -> drying, count optional and blank
    await toggleBasis()
    await click('stage-save')
    expect(measureBodies(), 'a lone basis opened the measure route').toHaveLength(0)
    expect(writes().map(([p, o]) => `${o.method} ${p}`))
      .toEqual(['POST /api/inventory-items/inv-1/seed-stage'])
  })

  it('keeps the basis OFF the wide PUT, on the narrow route and nowhere else', async () => {
    // The defect V5-SEEDQTY-001 exists to prevent: the wide PUT assigns its whole SET list
    // unconditionally and useInventory.adjustQuantity resends an entire stale list row, so a measure
    // column reachable that way gets reverted by an unrelated save.
    await mountPage([{ ...LOT, year_harvested: null }])
    await click('advance-stage')
    await toggleBasis()
    await click('stage-save')
    const wide = writes().filter(([p, o]) => String(p) === '/api/inventory-items/inv-1' && o.method === 'PUT')
    expect(wide, 'the year_harvested wide PUT should still fire on this lot').toHaveLength(1)
    for (const k of ['seed_count', 'seed_count_estimated']) {
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(wide[0][1].body), k),
        `${k} in a wide-PUT body — these columns have exactly one writer`).toBe(false)
    }
    expect(measureBody().seed_count_estimated).toBe(true)
  })
})

describe('the create sheet — the same three cases from the other door', () => {
  it('DEFAULTS TO COUNTED on a typed count', async () => {
    await mountSheet()
    await act(async () => {
      fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '185' } })
    })
    await click('save-seed-submit')
    await waitFor(() => expect(measureBodies()).toHaveLength(1))
    expect(measureBody()).toEqual({ seed_count: 185, seed_count_estimated: false })
  })

  it('SETS the basis: a packet count off the back of the packet writes true', async () => {
    await mountSheet()
    await act(async () => {
      fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '200' } })
    })
    await toggleBasis()
    await click('save-seed-submit')
    await waitFor(() => expect(measureBodies()).toHaveLength(1))
    expect(measureBody()).toEqual({ seed_count: 200, seed_count_estimated: true })
  })

  it('NEVER SENDS HALF THE PAIR — a weight-only save with the switch on carries no basis', async () => {
    // seed_count_estimated is a statement about a COUNT. Beside a weight alone it would claim
    // something about a number that was never given, and the route would refuse it.
    await mountSheet()
    await act(async () => {
      fireEvent.change(screen.getByTestId('save-seed-weight'), { target: { value: '2.5 g' } })
    })
    await toggleBasis()
    await click('save-seed-submit')
    await waitFor(() => expect(measureBodies()).toHaveLength(1))
    expect(measureBody()).toEqual({ seed_weight_g: 2.5 })
  })
})

describe('seedMeasurePayload — the basis is a parameter now, and still rides only with a count', () => {
  it('carries the caller\'s answer through', () => {
    expect(seedMeasurePayload('185', '', true)).toEqual({ seed_count: 185, seed_count_estimated: true })
    expect(seedMeasurePayload('185', '', false)).toEqual({ seed_count: 185, seed_count_estimated: false })
  })

  it('defaults to false, so a caller that does not know about the flag writes what it always did', () => {
    expect(seedMeasurePayload('185')).toEqual({ seed_count: 185, seed_count_estimated: false })
    expect(seedMeasurePayload('185', '2.5'))
      .toEqual({ seed_count: 185, seed_count_estimated: false, seed_weight_g: 2.5 })
  })

  it('emits the two keys together or not at all, across every input shape', () => {
    // The client-side half of chk_inventory_seed_count_basis_pairing, asserted as an invariant over
    // the whole input space this function has rather than case by case: a blank count, a refused
    // count and a weight-only body must each produce a body with NEITHER key.
    const inputs = [
      ['', '', true], ['   ', '', true], [null, '', true], [undefined, '', true],
      ['abc', '', true], ['-1', '', true], ['20.5', '', true],
      ['', '2.5', true], ['', '250 mg', false],
      ['0', '', true], ['185', '2.5', true], [7000, '', true],
    ]
    for (const args of inputs) {
      const p = seedMeasurePayload(...args) ?? {}
      const has = (k) => Object.prototype.hasOwnProperty.call(p, k)
      expect(has('seed_count'), `half a pair for ${JSON.stringify(args)}`)
        .toBe(has('seed_count_estimated'))
    }
  })
})
