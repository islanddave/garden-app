// A saved seed's page surfaces its count — and edits the seed, not the jar.
//
// Dave, 2026-09-25, verbatim: "on a saved seed's detail page, it never surfaces the count. It seems to
// default to showing 1 packet which is not correct ever." Before this change /inventory/:id read none
// of seed_count / seed_count_estimated / seed_weight_g, and its only amount was the container pair,
// Qty on hand / Unit — 1 packet on every saved lot, because the Save-seed sheet makes one jar
// (quantity_on_hand 1) and puts the count in the measure columns.
//
// Pinned here: the packet card's "Seed count" fact (and the stated absence, "Not counted yet"); the
// saved lot's form — Seed count with the shared counted/estimated switch, Weight (g), "All used up"
// mapping quantity_on_hand 1 <-> 0, and the Qty/Unit pair kept for a lot holding any other amount; and
// the save — PUT /seed-measure only on a change, keyed by presence, the pair together, never through
// the main PUT, and a measure failure after a good main save reported as exactly that.
// The real useInventory merge is pinned in InventoryDetail.measureWire.test.jsx.
//
// No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy, paramsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  paramsRef: { current: { id: 'inv-lot-1' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => paramsRef.current,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="favorite-toggle" /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => <input id={props.inputId} type="file" data-testid="photo-upload-input" hidden />,
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { SEED_BASIS_LABEL } from '../components/planting/SaveSeedSheet.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { P } from '../lib/constants.js'

// A lot saved off one of Dave's plants and put away, as GET /:id returns it: numerics as strings
// ('1.000'), the count as an integer, the cultivar facts the card also shows.
const SAVED = {
  id: 'inv-lot-1', name: 'Thai Dragon — saved 2026', type: 'consumable', category: 'seeds', status: 'active',
  quantity_on_hand: '1.000', unit: 'packet', reorder_threshold: null, reorder_quantity: null,
  unit_cost: null, quantity_purchased: null, purchase_date: null, location_text: 'Seed tin',
  brand: null, model: null, condition: null, notes: null, source: null, source_url: null,
  source_id: null, acquired_from_source_id: null, year_harvested: 2026,
  variety_id: 'var-thai', variety_name: 'Thai Dragon', crop_slug: 'pepper',
  seed_stage: 'stored', seed_process: 'fresh', source_plant_id: 'pl-thai', source_kind: null,
  seed_count: 175, seed_count_estimated: false, seed_weight_g: null,
  featured_photo_id: null, hero_photo_id: null, featured_photo_view_url: null,
  scoville_min: 50000, scoville_max: 100000, scoville_source: null, origin_country: 'Thailand',
  origin_region: null, species: 'Capsicum annuum', breeding_system: 'open_pollinated',
  days_to_maturity_min: 90, days_to_maturity_max: 90, dtm_basis: null, variety_source_url: null,
  germination: null, sown_from: [],
}
const UNCOUNTED = { ...SAVED, seed_count: null, seed_count_estimated: null, seed_weight_g: null }
// A BOUGHT packet: no parent, no origin kind, no stage.
const BOUGHT = {
  ...SAVED, id: 'inv-pkt-1', name: 'Sungold F1 tomato seeds', variety_id: 'var-sungold', variety_name: 'Sungold F1',
  crop_slug: 'tomato', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null,
  year_harvested: null, scoville_min: null, scoville_max: null, origin_country: null, species: 'Solanum lycopersicum',
  breeding_system: 'f1', days_to_maturity_min: 57, days_to_maturity_max: 65,
  seed_count: null, seed_count_estimated: null, seed_weight_g: null,
}
// Prod's one saved lot holding another amount: "Green Flesh Honeydew seed seed 2026", 272 'each'
// beside a seed_count of 247. Nothing on it may become uneditable.
const OUTLIER = {
  ...SAVED, id: 'inv-gfh', name: 'Green Flesh Honeydew seed seed 2026', variety_id: 'var-gfh', variety_name: 'Green Flesh',
  crop_slug: 'melon', quantity_on_hand: '272.000', unit: 'each', seed_count: 247, seed_count_estimated: false,
  scoville_min: null, scoville_max: null, origin_country: null, species: null, breeding_system: null,
  days_to_maturity_min: null, days_to_maturity_max: null,
}

// The server's measure, per row id, so PUT /seed-measure behaves as the route does: keys by presence,
// RETURNING the three columns with the weight as the driver's numeric STRING.
let rows
let measureFails
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: {} })
  rows = {}
  measureFails = false
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    const measure = /^\/api\/inventory-items\/([^/?]+)\/seed-measure$/.exec(p)
    if (measure && opts?.method === 'PUT') {
      if (measureFails) return Promise.reject(new Error('503 Service Unavailable'))
      const body = JSON.parse(opts.body)
      const row = rows[measure[1]]
      for (const k of ['seed_count', 'seed_count_estimated', 'seed_weight_g']) {
        if (Object.prototype.hasOwnProperty.call(body, k)) row[k] = body[k]
      }
      return Promise.resolve({
        id: row.id, seed_count: row.seed_count, seed_count_estimated: row.seed_count_estimated,
        seed_weight_g: row.seed_weight_g == null ? null : Number(row.seed_weight_g).toFixed(3),
      })
    }
    const item = /^\/api\/inventory-items\/([^/?]+)$/.exec(p)
    if (item && !opts) return rows[item[1]] ? Promise.resolve({ ...rows[item[1]] }) : Promise.reject(Object.assign(new Error('nf'), { status: 404 }))
    return Promise.resolve([])
  })
  clearReloadBlocks()
})

async function renderPage(row) {
  rows[row.id] = { ...row }
  paramsRef.current = { id: row.id }
  let out
  await act(async () => { out = render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  return out
}

const factRows = () => Array.from(screen.getByTestId('packet-facts').querySelectorAll('[data-testid="packet-fact"]'))
  .map(n => [n.children[0].textContent, n.children[1].textContent])
const countField = () => screen.queryByTestId('inv-seed-count')
const weightField = () => screen.queryByTestId('inv-seed-weight')
const basis = () => screen.getByRole('switch', { name: SEED_BASIS_LABEL })
const usedUp = () => screen.queryByRole('checkbox', { name: 'All used up' })
const labelTexts = () => Array.from(document.querySelectorAll('label')).map(l => l.textContent.trim())
const type = (el, value) => fireEvent.change(el, { target: { value } })
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')) }) }
const measurePuts = (id = paramsRef.current.id) => fetchSpy.mock.calls
  .filter(([p, o]) => String(p) === `/api/inventory-items/${id}/seed-measure` && o?.method === 'PUT')
  .map(([, o]) => JSON.parse(o.body))
const itemGets = (id = paramsRef.current.id) => fetchSpy.mock.calls
  .filter(([p, o]) => String(p) === `/api/inventory-items/${id}` && !o).length
const MEASURE_KEYS = ['seed_count', 'seed_count_estimated', 'seed_weight_g']
// The main PUT's body as the page handed it to useInventory: never a measure key, on any save.
const mainPutBodies = () => updateItemSpy.mock.calls.map(([, changes]) => changes)
const expectNoMeasureOnMainPut = () => {
  expect(mainPutBodies().length, 'no main save happened').toBeGreaterThan(0)
  for (const body of mainPutBodies()) {
    for (const k of MEASURE_KEYS) expect(Object.prototype.hasOwnProperty.call(body, k), `main PUT carried ${k}`).toBe(false)
  }
}

describe('the packet card — the seed count is the first fact', () => {
  it('a counted saved lot leads with "Seed count · 175 seeds", above the cultivar facts', async () => {
    await renderPage(SAVED)
    expect(factRows()[0]).toEqual(['Seed count', '175 seeds'])
    expect(factRows()[1][0]).toBe('Heat')
    // Nothing on the card says packet: the jar is not the amount.
    expect(screen.getByTestId('packet-facts').textContent).not.toMatch(/packet/i)
  })

  it('an estimated count reads "approx.", and a weighed one carries its grams', async () => {
    const { unmount } = await renderPage({ ...SAVED, seed_count: 40, seed_count_estimated: true })
    expect(factRows()[0]).toEqual(['Seed count', 'approx. 40 seeds'])
    unmount()
    await renderPage({ ...SAVED, seed_weight_g: '3.200' })
    expect(factRows()[0]).toEqual(['Seed count', '175 seeds · 3.2 g'])
  })

  it('a saved lot nobody has measured SAYS so — "Not counted yet"', async () => {
    await renderPage(UNCOUNTED)
    expect(factRows()[0]).toEqual(['Seed count', 'Not counted yet'])
  })

  it('a bought packet with a count shows it first; with nothing measured it grows no fact at all', async () => {
    const { unmount } = await renderPage({ ...BOUGHT, seed_count: 185, seed_count_estimated: true })
    expect(factRows()[0]).toEqual(['Seed count', 'approx. 185 seeds'])
    unmount()
    await renderPage(BOUGHT)
    // The anchor: the card rendered its other facts, so the absence below is about the count alone.
    expect(factRows()[0][0]).toBe('Species')
    expect(factRows().map(([label]) => label)).not.toContain('Seed count')
    expect(screen.getByTestId('packet-facts').textContent).not.toMatch(/Not counted yet/)
  })

  it('is read LIVE: an origin chosen on the page makes a bought packet a saved lot at once', async () => {
    await renderPage(BOUGHT)
    expect(factRows().map(([label]) => label)).not.toContain('Seed count')
    expect(countField()).toBeNull()
    await act(async () => { fireEvent.change(screen.getByLabelText('Where this seed came from'), { target: { value: 'own_garden' } }) })
    expect(factRows()[0]).toEqual(['Seed count', 'Not counted yet'])
    expect(countField()).toBeTruthy()
    expect(usedUp()).toBeTruthy()
  })
})

describe('the form — a saved lot edits its seed, not the jar', () => {
  it('Seed count (with the shared switch), Weight (g) and All used up replace Qty on hand / Unit', async () => {
    await renderPage({ ...SAVED, seed_weight_g: '3.200' })
    expect(countField().value).toBe('175')
    // TEXT with a numeric keypad, never type="number" — see 'a typo never erases a count' below.
    // (Asserted `number` / step 1 until the review's BLOCKING-1; changed on purpose.)
    expect(countField().getAttribute('type')).toBe('text')
    expect(countField().getAttribute('inputmode')).toBe('numeric')
    expect(document.querySelector('label[for="inv-seed-count"]').textContent).toMatch(/^Seed count/)
    expect(basis().getAttribute('aria-checked')).toBe('false')
    expect(weightField().value).toBe('3.2')
    expect(document.querySelector('label[for="inv-seed-weight"]').textContent).toMatch(/^Weight \(g\)/)
    expect(usedUp().getAttribute('aria-checked')).toBe('false')
    expect(document.getElementById(usedUp().getAttribute('aria-describedby')).textContent)
      .toBe('A used-up lot moves to Sowed previously.')
    // The container pair is gone for this lot — the "1 packet" Dave reported.
    const labels = labelTexts()
    expect(labels.some(t => t.startsWith('Qty on hand'))).toBe(false)
    expect(labels).not.toContain('Unit')
    expect(screen.queryByDisplayValue('packet')).toBeNull()
  })

  it('the switch opens on the lot\'s own answer — an estimated count stays estimated', async () => {
    await renderPage({ ...SAVED, seed_count: 7000, seed_count_estimated: true })
    expect(basis().getAttribute('aria-checked')).toBe('true')
  })

  it('an uncounted lot opens blank, never 0', async () => {
    await renderPage(UNCOUNTED)
    expect(countField().value).toBe('')
    expect(weightField().value).toBe('')
  })

  it('a bought packet keeps Qty on hand and Unit, and grows none of the seed fields', async () => {
    await renderPage(BOUGHT)
    expect(screen.getByLabelText('Qty on hand').value).toBe('1')
    expect(labelTexts()).toContain('Unit')
    expect(countField()).toBeNull()
    expect(weightField()).toBeNull()
    expect(usedUp()).toBeNull()
    expect(screen.queryByRole('switch', { name: SEED_BASIS_LABEL })).toBeNull()
  })

  it('the 272-each lot keeps its Qty on hand and Unit beside the seed fields — nothing is lost', async () => {
    await renderPage(OUTLIER)
    expect(screen.getByLabelText('Qty on hand').value).toBe('272')
    const unit = Array.from(document.querySelectorAll('select')).find(s => s.value === 'each')
    expect(unit, 'the Unit select no longer holds "each"').toBeTruthy()
    expect(countField().value).toBe('247')
    expect(usedUp()).toBeNull()
    expect(factRows()[0]).toEqual(['Seed count', '247 seeds'])

    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    const [, changes] = updateItemSpy.mock.calls[0]
    expect(changes.quantity_on_hand).toBe(272)
    expect(changes.unit).toBe('each')
    expect(measurePuts()).toEqual([])
  })
})

describe('"All used up" — quantity_on_hand 1 <-> 0 through the main PUT', () => {
  it('ticked, a lot of 1 saves as 0 with its unit untouched', async () => {
    await renderPage(SAVED)
    await act(async () => { fireEvent.click(usedUp()) })
    expect(usedUp().getAttribute('aria-checked')).toBe('true')
    await save()
    const [, changes] = updateItemSpy.mock.calls[0]
    expect(changes.quantity_on_hand).toBe(0)
    expect(changes.unit).toBe('packet')
    expect(measurePuts()).toEqual([])
    expectNoMeasureOnMainPut()
  })

  it('a used-up lot (0) opens ticked, and unticked saves as 1', async () => {
    await renderPage({ ...SAVED, quantity_on_hand: '0.000' })
    expect(usedUp().getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(usedUp()) })
    await save()
    const [, changes] = updateItemSpy.mock.calls[0]
    expect(changes.quantity_on_hand).toBe(1)
    expect(changes.unit).toBe('packet')
  })

  it('ticking and unticking is no change at all — the guard releases', async () => {
    await renderPage(SAVED)
    await act(async () => { fireEvent.click(usedUp()) })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await act(async () => { fireEvent.click(usedUp()) })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })
})

describe('the save — PUT /seed-measure only on a change, keyed by presence', () => {
  it('a save that touched no measure sends NO measure request', async () => {
    await renderPage(SAVED)
    type(screen.getByLabelText('Name'), 'Thai Dragon — saved 2026 (tin 2)')
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(mainPutBodies()[0].name).toBe('Thai Dragon — saved 2026 (tin 2)')
    expect(measurePuts()).toEqual([])
  })

  it('a re-count sends the count WITH its basis — the pair — and never through the main PUT', async () => {
    await renderPage(SAVED)
    type(countField(), '180')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 180, seed_count_estimated: false }])
    expectNoMeasureOnMainPut()
  })

  it('flipping only the switch on a counted lot restates the pair with the new answer', async () => {
    await renderPage(SAVED)
    await act(async () => { fireEvent.click(basis()) })
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 175, seed_count_estimated: true }])
  })

  it('a first count carries the switch\'s answer', async () => {
    await renderPage(UNCOUNTED)
    type(countField(), '40')
    await act(async () => { fireEvent.click(basis()) })
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 40, seed_count_estimated: true }])
  })

  it('clearing the count clears its basis in the same body — both null, never a half-pair', async () => {
    await renderPage(SAVED)
    type(countField(), '')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: null, seed_count_estimated: null }])
    await waitFor(() => expect(factRows()[0]).toEqual(['Seed count', 'Not counted yet']))
  })

  it('the switch alone on a lot with no count sends nothing — it says nothing about any number', async () => {
    await renderPage(UNCOUNTED)
    await act(async () => { fireEvent.click(basis()) })
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(measurePuts()).toEqual([])
  })

  it('a weight alone sends the weight alone, in grams — a bare number or "mg"', async () => {
    const { unmount } = await renderPage(UNCOUNTED)
    type(weightField(), '2.5')
    await save()
    expect(measurePuts()).toEqual([{ seed_weight_g: 2.5 }])
    unmount()
    fetchSpy.mockClear(); updateItemSpy.mockClear()
    await renderPage(UNCOUNTED)
    type(weightField(), '250 mg')
    await save()
    expect(measurePuts()).toEqual([{ seed_weight_g: 0.25 }])
  })

  it('a weight compared by VALUE: "3.20" on a lot of 3.2 g is no change; a cleared weight sends null', async () => {
    const { unmount } = await renderPage({ ...SAVED, seed_weight_g: '3.200' })
    type(weightField(), '3.20')
    await save()
    expect(measurePuts()).toEqual([])
    unmount()
    fetchSpy.mockClear(); updateItemSpy.mockClear()
    await renderPage({ ...SAVED, seed_weight_g: '3.200' })
    type(weightField(), '')
    await save()
    expect(measurePuts()).toEqual([{ seed_weight_g: null }])
  })

  it('count and weight changed together travel in ONE request', async () => {
    await renderPage(SAVED)
    type(countField(), '160')
    type(weightField(), '3')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 160, seed_count_estimated: false, seed_weight_g: 3 }])
  })

  it('goes AFTER the main save has landed, never beside it', async () => {
    let land
    updateItemSpy.mockImplementation(() => new Promise((res) => { land = res }))
    await renderPage(SAVED)
    type(countField(), '180')
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(measurePuts()).toEqual([])
    await act(async () => { land({ item: {} }) })
    await waitFor(() => expect(measurePuts()).toHaveLength(1))
  })

  it('the card shows the STORED measure at once — no reload, no second read', async () => {
    await renderPage(SAVED)
    expect(itemGets()).toBe(1)
    type(countField(), '180')
    // Answered by the route as the numeric STRING '0.050', and read back through formatSeedWeight.
    type(weightField(), '50 mg')
    await save()
    await waitFor(() => expect(factRows()[0]).toEqual(['Seed count', '180 seeds · 50 mg']))
    expect(itemGets()).toBe(1)
    expect(screen.getByText('✓ Saved')).toBeTruthy()
    expect(isReloadBlocked()).toBe(false)
  })
})

// ── Review BLOCKING-1 (2026-09-25) — a one-key slip ERASED a stored count ─────────────────────────────
// The box was type="number". "175-", "175e", "1-", "--5", "17-5" are badInput there: the value reads ""
// (Chrome, and jsdom sanitizes the same way), no message shows, and blank is this field's CLEAR — so Save
// sent PUT /seed-measure {seed_count: null, seed_count_estimated: null} and said "✓ Saved". Reproduced in
// real Chrome by the reviewer, and by gate:seed-detail (l) against that build. As text, the typed string
// reaches parseSeedCount whole and is refused. Each case here ALSO fails against the old number box: the
// change event hands jsdom "175-", the number box keeps "", and the save goes through as a clear.
describe('a typo never erases a count (review BLOCKING-1)', () => {
  it.each(['175-', '175e', '1-', '--5', '17-5'])('"%s" is kept as typed, refused beside the field, and sends NOTHING', async (typed) => {
    await renderPage(SAVED)
    type(countField(), typed)
    expect(countField().value, 'the box discarded what was typed').toBe(typed)
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    expect(measurePuts()).toEqual([])
    const alert = document.getElementById(`${countField().id}-error`)
    expect(alert, 'no refusal beside the Seed count').toBeTruthy()
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('That is not a number.')
    // The stored count is untouched, and what was typed is still there to correct, still unsaved.
    expect(factRows()[0]).toEqual(['Seed count', '175 seeds'])
    expect(countField().value).toBe(typed)
    expect(isReloadBlocked()).toBe(true)
  })

  it.each([
    ['1e3', 'That is not a number.'],
    ['0x1A', 'That is not a number.'],
    ['+5', 'That is not a number.'],
    ['1,000', 'That is not a number.'],
    ['5.0', 'A seed count is a whole number of seeds.'],
    ['-0', 'A count cannot be negative.'],
  ])('"%s" is not a count either — digits only (Number() would have read some of these as counts)', async (typed, words) => {
    await renderPage(SAVED)
    type(countField(), typed)
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    expect(measurePuts()).toEqual([])
    expect(document.getElementById(`${countField().id}-error`).textContent).toContain(words)
  })

  it('digits with spaces round them are a count; spaces alone are blank, which CLEARS it, as designed', async () => {
    const { unmount } = await renderPage(SAVED)
    type(countField(), ' 0180 ')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 180, seed_count_estimated: false }])
    unmount()
    fetchSpy.mockClear(); updateItemSpy.mockClear()
    await renderPage(SAVED)
    type(countField(), '   ')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: null, seed_count_estimated: null }])
    await waitFor(() => expect(factRows()[0]).toEqual(['Seed count', 'Not counted yet']))
  })
})

// ── Review MINOR-1 — decisions the first pass claimed were pinned and were not ───────────────────────
describe('the container control is decided by the lot AS SAVED, never the live field (review MINOR-1)', () => {
  it('typing 1 then 0 into the 272-each lot keeps its Qty on hand box — no "All used up" until it is saved', async () => {
    await renderPage(OUTLIER)
    const qty = () => screen.queryByLabelText('Qty on hand')
    type(qty(), '1')
    expect(qty(), 'the Qty box unmounted under the thumb').toBeTruthy()
    expect(qty().value).toBe('1')
    expect(usedUp()).toBeNull()
    type(qty(), '0')
    expect(qty()).toBeTruthy()
    expect(qty().value).toBe('0')
    expect(usedUp()).toBeNull()
    // Saved at one jar, the lot now holds a yes/no's worth, and the toggle takes over.
    type(qty(), '1')
    await save()
    expect(mainPutBodies()[0].quantity_on_hand).toBe(1)
    await waitFor(() => expect(usedUp()).toBeTruthy())
    expect(screen.queryByLabelText('Qty on hand')).toBeNull()
    expect(usedUp().getAttribute('aria-checked')).toBe('false')
  })

  it('a DURABLE seeds row grows no seed fields and sends no /seed-measure', async () => {
    // Saved seed by provenance (a parent, a stage), but durable: chk_inventory_seed_count_seeds_only
    // refuses a count on it, so the form must not offer one. (No such row on prod today; 352 of 352
    // seeds rows are consumable.)
    const DURABLE = {
      ...SAVED, id: 'inv-dur-1', type: 'durable', quantity: 1, quantity_on_hand: null, unit: null,
      seed_count: null, seed_count_estimated: null, seed_weight_g: null,
    }
    await renderPage(DURABLE)
    expect(screen.getByLabelText('Quantity').value).toBe('1')
    expect(countField()).toBeNull()
    expect(weightField()).toBeNull()
    expect(usedUp()).toBeNull()
    expect(screen.queryByRole('switch', { name: SEED_BASIS_LABEL })).toBeNull()
    type(screen.getByLabelText('Name'), 'Thai Dragon — tin')
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(measurePuts()).toEqual([])
    expectNoMeasureOnMainPut()
  })
})

// ── Review MINOR-2 — a count typed, then hidden by a live change, was baselined as saved ─────────────
describe('a count typed and then hidden is neither sent nor baselined (review MINOR-2)', () => {
  // Saved seed ONLY by its origin kind — no parent, no stage — so one select un-saves it and hides the
  // seed fields. (Every live saved lot carries a stage today; a new "Not yet" save does not.)
  const FARMSTAND = {
    ...SAVED, id: 'inv-fs-1', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: 'farm_stand',
  }
  const origin = () => screen.getByLabelText('Where this seed came from')

  it('the hidden 180 is not sent, stays unsaved (the guard holds), and is sent once the fields are back', async () => {
    await renderPage(FARMSTAND)
    type(countField(), '180')
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await act(async () => { fireEvent.change(origin(), { target: { value: '' } }) })
    expect(countField(), 'the seed fields stayed on a lot that is no longer saved seed').toBeNull()

    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(measurePuts()).toEqual([])
    expect(isReloadBlocked(), 'the unsent count was baselined as saved').toBe(true)

    await act(async () => { fireEvent.change(origin(), { target: { value: 'farm_stand' } }) })
    expect(countField().value).toBe('180')
    await save()
    expect(measurePuts()).toEqual([{ seed_count: 180, seed_count_estimated: false }])
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })
})

// ── Review MINOR-3 — "A used-up lot moves to Sowed previously." was said where it is false ────────────
describe('the used-up sentence is said only where it is true (review MINOR-3)', () => {
  const SENTENCE = 'A used-up lot moves to Sowed previously.'
  const described = () => {
    const id = usedUp().getAttribute('aria-describedby')
    return id ? document.getElementById(id)?.textContent ?? null : null
  }

  it('a stored lot files under Sowed previously when used up: said, and the toggle is described by it', async () => {
    await renderPage(SAVED)
    expect(described()).toBe(SENTENCE)
  })

  it.each(['drying', 'fermenting'])('a %s lot stays under its stage: the toggle is offered, the sentence is not', async (stage) => {
    await renderPage({ ...SAVED, seed_stage: stage })
    expect(usedUp()).toBeTruthy()
    expect(usedUp().getAttribute('aria-describedby')).toBeNull()
    expect(document.body.textContent).not.toContain(SENTENCE)
  })

  it('a lot off one of my plants, never started, stays "Not started": nothing said', async () => {
    await renderPage({ ...SAVED, seed_stage: null, seed_process: null })
    expect(usedUp()).toBeTruthy()
    expect(document.body.textContent).not.toContain(SENTENCE)
  })

  it('a farm-stand lot never staged DOES file under Sowed previously: said', async () => {
    await renderPage({ ...SAVED, seed_stage: null, seed_process: null, source_plant_id: null, source_kind: 'farm_stand' })
    expect(described()).toBe(SENTENCE)
  })
})

describe('the save — refusals and failures', () => {
  it.each([
    ['20.5', 'A seed count is a whole number of seeds.'],
    ['-3', 'A count cannot be negative.'],
  ])('a count of %s is refused before ANY request, beside the field', async (value, words) => {
    await renderPage(SAVED)
    type(countField(), value)
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    expect(measurePuts()).toEqual([])
    const alert = document.getElementById(`${countField().id}-error`)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain(words)
  })

  it('a weight that is not a weight is refused before ANY request', async () => {
    await renderPage(SAVED)
    type(weightField(), 'a pinch')
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    expect(measurePuts()).toEqual([])
    expect(document.getElementById(`${weightField().id}-error`).textContent)
      .toContain('That is not a weight — type a number of grams, or add "mg".')
  })

  it('a main save that fails sends NO measure, and says why in the form', async () => {
    updateItemSpy.mockResolvedValue({ error: 'Server said no' })
    await renderPage(SAVED)
    type(countField(), '180')
    await save()
    expect(screen.getByText('Server said no')).toBeTruthy()
    expect(measurePuts()).toEqual([])
    expect(isReloadBlocked()).toBe(true)
  })

  it('a measure that fails AFTER a good main save: the save stands, the toast names what missed, and the count stays unsaved', async () => {
    await renderPage(SAVED)
    type(screen.getByLabelText('Name'), 'Thai Dragon — tin 2')
    type(countField(), '180')
    measureFails = true
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(measurePuts()).toHaveLength(1)
    // The toast, in the error tone — and no "whole save failed" banner.
    const toast = await screen.findByText("Saved — couldn't record the count")
    const probe = document.createElement('div')
    probe.style.backgroundColor = P.terra
    expect(toast.closest('[role="status"]').style.backgroundColor).toBe(probe.style.backgroundColor)
    expect(screen.queryByText('✓ Saved')).toBeNull()
    // The card still reads what the server holds.
    expect(factRows()[0]).toEqual(['Seed count', '175 seeds'])
    // The name landed (baselined); the count did not (still unsaved input, the guard holds).
    expect(isReloadBlocked()).toBe(true)
    type(countField(), '175')
    await waitFor(() => expect(isReloadBlocked()).toBe(false))

    // …and the next Save sends it again.
    measureFails = false
    type(countField(), '180')
    await save()
    expect(measurePuts()).toHaveLength(2)
    await waitFor(() => expect(factRows()[0]).toEqual(['Seed count', '180 seeds']))
  })

  it('names the weight, or both, when that is what was entered', async () => {
    measureFails = true
    const { unmount } = await renderPage(SAVED)
    type(weightField(), '2')
    await save()
    expect(await screen.findByText("Saved — couldn't record the weight")).toBeTruthy()
    unmount()
    await renderPage(SAVED)
    type(countField(), '9')
    type(weightField(), '2')
    await save()
    expect(await screen.findByText("Saved — couldn't record the count and weight")).toBeTruthy()
  })
})
