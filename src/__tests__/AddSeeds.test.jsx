/**
 * src/__tests__/AddSeeds.test.jsx
 * V4-SEEDINV-001 — /inventory/add-seeds bulk seed intake tests.
 *
 * Covers: chooser renders 3 options (One item navigates), paste flow extract
 * POST wire shape, 501 extractor-not-configured banner, and a review-row save
 * (variety create THEN inventory POST — order + exact payload assertions,
 * including the auto-match skip of variety creation), and the crop-type gate
 * on the live crop_types catalog (BUG-ADDSEEDSVALIDSLUGS-001).
 *
 * House conventions: vi.mock react-router-dom stubs + vi.mock ../lib/api.js
 * hoisted fetchSpy routed by URL + ToastProvider wrap + act/findByText. The
 * REAL useVarieties hook runs against the routed fetchSpy (integration value).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

// BUG-SEEDEXTRACTOR-001: SEED_BULK_EXTRACT_ENABLED shipped FALSE on 2026-09-03, hiding the two bulk
// intake tiles because they have never worked in prod (no ANTHROPIC_API_KEY). This suite predates
// that and its assertions describe the flag-ON world — the photo/paste wire, the 501/413/502 banners,
// the review table. Pinned TRUE so every one of them keeps covering what it was written to cover
// rather than being deleted or weakened to match a hidden UI. Nothing behind the tiles was removed,
// so all of this is still live code the moment the key is provisioned.
// The flag-OFF world is covered by AddSeeds.extractGate.test.jsx.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  SEED_BULK_EXTRACT_ENABLED: true,
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))

import AddSeeds from '../pages/AddSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { CROP_TYPE_SLUGS } from '../lib/parseSowProfile.js'

// Dataset-schema packet (extract-seeds returns packets[] in this shape).
const PACKET = {
  inv_type: 'consumable',
  inv_category: 'seeds',
  inv_unit: 'packet',
  name: 'Shirley Single Blend Corn Poppy Seeds',
  crop: 'Poppy, Corn',
  variety: 'Shirley Single Blend',
  quantity_on_hand: 1,
  vendor: 'Botanical Interests',
  source: 'Botanical Interests online order',
  source_url: null,
  purchase_date: '2026-06-09',
  price_usd: 1.35,
  sku: '1174',
  metadata: { seeds_per_packet: '1', organic: false, heirloom: false, item_category: 'flower' },
  crop_type_slug_guess: null,
  sow_profile: {
    life_cycle: 'annual',
    season: 'cool',
    sun: 'full sun',
    start_method: 'direct sow',
    start_indoor_weeks_before_lastfrost: null,
    direct_sow_timing: 'as soon as soil can be worked',
    sow_depth_in: '0.125',
    seed_spacing_in: '6',
    row_spacing_in: '12',
    days_to_germ: '10-15',
    days_to_maturity: '80-90',
    zone_notes: 'Sow early — cool-season bloomer.',
    packet_notes: 'Needs light to germinate.',
  },
  origin: 'BI-order-2026-06-09',
}

// BUG-ADDSEEDSVALIDSLUGS-001 fixtures. One guess per side of the gate:
//   carrot     — a LIVE crop type that the frozen CROP_TYPE_SLUGS list lacks (one of 85 such, prod
//                2026-09-23). Saved untyped before the fix: the defect.
//   tomato     — in BOTH lists. Must stay typed on every path, including a failed catalog fetch.
//   moonflower — in NEITHER. Must stay untyped, or the "gate" is a pass-through for LLM guesses.
//   bread      — live, but a non-plant food class. Must stay untyped: the page reads garden scope.
// sow_profile null keeps each wire body to the crop-type question. Each body is found by EXACT
// variety name (bodyFor), and the five variety names are distinct, so no lookup lands on the wrong row.
const CARROT_PACKET = {
  ...PACKET,
  name: 'Danvers 126 Carrot Seeds', crop: 'Carrot', variety: 'Danvers 126', sku: '0071',
  crop_type_slug_guess: 'carrot', sow_profile: null,
}
const TOMATO_PACKET = {
  ...PACKET,
  name: 'Sungold Tomato Seeds', crop: 'Tomato', variety: 'Sungold', sku: '0485',
  crop_type_slug_guess: 'tomato', sow_profile: null,
}
const MOONFLOWER_PACKET = {
  ...PACKET,
  name: 'Giant White Moonflower Seeds', crop: 'Moonflower', variety: 'Giant White', sku: '0912',
  crop_type_slug_guess: 'moonflower', sow_profile: null,
}
// No wheat crop type exists, so the guess settles for the nearest valid neighbour (the L-286 shape)
// and lands on a food class that the catalog response really does carry.
const WHEAT_PACKET = {
  ...PACKET,
  name: 'Red Fife Wheat Seeds', crop: 'Wheat', variety: 'Red Fife', sku: '1203',
  crop_type_slug_guess: 'bread', sow_profile: null,
}

// GET /api/varieties/crop-types rows, shape and values copied from prod crop_types 2026-09-23. The
// endpoint returns the non-plant food classes too (useCropTypes filters them out by scope), so one rides along.
const LIVE_CROP_TYPES = [
  { slug: 'carrot', display_name: 'Carrot', default_lifecycle: 'biennial', category: 'vegetable', sort_order: 0, dtm_basis: 'from-sow', search_aliases: null },
  { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0, dtm_basis: 'from-transplant', search_aliases: null },
  { slug: 'bread', display_name: 'Bread', default_lifecycle: null, category: 'non_plant_food', sort_order: 900, dtm_basis: null, search_aliases: null },
]

// `cropTypes` is the GET /api/varieties/crop-types response: an array, or a function returning the
// promise (a rejection, or one the test resolves by hand). Routed BEFORE the generic /api/varieties
// GET, which would otherwise answer it with the varieties list.
function routeFetch({
  varieties = [],
  cropTypes = LIVE_CROP_TYPES,
  extract = { packets: [PACKET] },
  extractError = null,
  createdVariety = { id: 'var-new', name: 'Shirley Single Blend' },
  inventoryResponse = { id: 'item-new' },
} = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/varieties/crop-types' && !opts.method) {
      return typeof cropTypes === 'function' ? cropTypes() : Promise.resolve(cropTypes)
    }
    if (url === '/api/inventory-items/extract-seeds' && opts.method === 'POST') {
      return extractError ? Promise.reject(extractError) : Promise.resolve(extract)
    }
    if (url.startsWith('/api/varieties') && opts.method === 'POST') {
      return Promise.resolve(createdVariety)
    }
    if (url.startsWith('/api/varieties')) {
      return Promise.resolve(varieties)
    }
    if (url === '/api/inventory-items' && opts.method === 'POST') {
      return Promise.resolve(inventoryResponse)
    }
    return Promise.resolve({})
  })
}

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  e.body = { error: message }
  return e
}

async function renderAddSeeds() {
  await act(async () => {
    render(<ToastProvider><AddSeeds /></ToastProvider>)
  })
}

async function runPasteExtract(text = 'Order #123: Shirley Single Blend Corn Poppy Seeds x1 $1.35') {
  fireEvent.click(screen.getByRole('radio', { name: 'Paste an order' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Extract packets' }))
  })
  return text
}

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
  // V4-DIRTYGUARDSWEEP-001 — AddSeeds now stashes its intake to sessionStorage, which is
  // per-realm and therefore shared by every test in this file. Without this, the first test to
  // extract packets leaves a draft that the next mount restores, the chooser never renders, and
  // the failure reads as a missing radio rather than as leaked state.
  try { sessionStorage.clear() } catch { /* jsdom build without Storage — draftStash no-ops too */ }
})

describe('AddSeeds — chooser', () => {
  it('renders the three intake choices', async () => {
    routeFetch()
    await renderAddSeeds()
    expect(screen.getByRole('radio', { name: 'Photo of packets' })).toBeDefined()
    expect(screen.getByRole('radio', { name: 'Paste an order' })).toBeDefined()
    expect(screen.getByRole('radio', { name: 'One item' })).toBeDefined()
    // Registry SVG glyphs, no emoji.
    expect(screen.getByRole('radio', { name: 'Photo of packets' }).querySelector('svg')).not.toBeNull()
  })

  it('One item navigates to the add form WITH seeds preselected', async () => {
    // UPDATED 2026-09-03. This previously asserted a bare `/inventory/add`, which is what the code
    // did and is not what it should have done: the route is reached only from a page titled "Add
    // seeds", so landing on an unfilled generic form asks the user to re-state what they already
    // said. Dave hit it and reported it. The destination has always read these two params
    // (InventoryAdd.jsx:39-40) and the sibling caller on /seeds/saved has always passed them, so
    // this caller was the odd one out rather than the params being new.
    //
    // The old assertion was a characterization test — it encoded the behaviour faithfully, which is
    // why it went red on the fix rather than catching the defect. Asserted as the exact string
    // rather than a substring so a future caller cannot drop one param and stay green.
    routeFetch()
    await renderAddSeeds()
    fireEvent.click(screen.getByRole('radio', { name: 'One item' }))
    expect(navigateSpy).toHaveBeenCalledWith('/inventory/add?type=consumable&category=seeds')
  })
})

describe('AddSeeds — paste extract wire', () => {
  it('POSTs /api/inventory-items/extract-seeds with {mode:"text", text}', async () => {
    routeFetch()
    await renderAddSeeds()
    const text = await runPasteExtract()

    const call = fetchSpy.mock.calls.find(([url]) => url === '/api/inventory-items/extract-seeds')
    expect(call).toBeDefined()
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ mode: 'text', text })

    // Review list renders with the auto-match chip (no varieties -> New variety).
    expect(await screen.findByText('Shirley Single Blend Corn Poppy Seeds')).toBeDefined()
    expect(screen.getByText('New variety')).toBeDefined()
  })

  it('501 shows the extractor-not-configured banner', async () => {
    routeFetch({ extractError: httpError(501, 'extractor_not_configured') })
    await renderAddSeeds()
    await runPasteExtract()
    expect(await screen.findByText(
      "The photo/paste extractor isn't configured yet — you can still add packets one at a time."
    )).toBeDefined()
  })

  it('413 shows the photo-too-large banner and 502 a generic retry banner', async () => {
    routeFetch({ extractError: httpError(413, 'payload too large') })
    await renderAddSeeds()
    await runPasteExtract()
    expect(await screen.findByText(/Photo too large/)).toBeDefined()

    routeFetch({ extractError: httpError(502, 'upstream error') })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Extract packets' }))
    })
    expect(await screen.findByText(/please try again/)).toBeDefined()
  })
})

describe('AddSeeds — review-row save', () => {
  it('NEW row: creates the variety (packetToVarietyCols body) THEN posts the inventory item', async () => {
    routeFetch()
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('New variety')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save all/ }))
    })

    const calls = fetchSpy.mock.calls
    const varietyIdx = calls.findIndex(([url, opts]) => url === '/api/varieties' && opts?.method === 'POST')
    const invIdx = calls.findIndex(([url, opts]) => url === '/api/inventory-items' && opts?.method === 'POST')
    expect(varietyIdx).toBeGreaterThan(-1)
    expect(invIdx).toBeGreaterThan(-1)
    // Variety create strictly precedes the inventory insert.
    expect(varietyIdx).toBeLessThan(invIdx)

    // Variety wire body, stated LITERALLY. This used to be `toEqual(packetToVarietyCols(PACKET))` —
    // the helper under test computing its own expectation, called the same way the page called it,
    // so it agreed with the page whatever either did (BUG-ADDSEEDSVALIDSLUGS-001: it stayed green
    // while every live-only crop type was being dropped). PACKET's guess is null, so no
    // crop_type_slug key; the crop-type gate itself is pinned in the describe block below.
    expect(JSON.parse(calls[varietyIdx][1].body)).toEqual({
      name: 'Shirley Single Blend',
      species: null,
      lifecycle: 'annual',
      grown_as: null,
      days_to_maturity_min: 80,
      days_to_maturity_max: 90,
      sun_requirements: 'full_sun',
      start_method: 'direct_sow',
      start_indoor_weeks_min: null,
      start_indoor_weeks_max: null,
      direct_sow_timing: 'as soon as soil can be worked',
      sow_depth_in: 0.125,
      seed_spacing_in: 6,
      row_spacing_in: 12,
      days_to_germ_min: 10,
      days_to_germ_max: 15,
      sow_season: 'cool',
      sow_notes: 'Sow early — cool-season bloomer.\n\nNeeds light to germinate.',
    })

    // Inventory wire body mirrors InventoryAdd.buildPayload (consumable seeds) +
    // packet metadata. NO created_by / user_id from the client.
    expect(JSON.parse(calls[invIdx][1].body)).toEqual({
      name: 'Shirley Single Blend Corn Poppy Seeds',
      type: 'consumable',
      category: 'seeds',
      notes: null,
      source: 'Botanical Interests online order',
      source_url: null,
      purchase_date: '2026-06-09',
      unit_cost: 1.35,
      location_text: null,
      status: 'active',
      quantity_on_hand: 1,
      unit: 'packet',
      reorder_threshold: null,
      reorder_quantity: null,
      quantity_purchased: null,
      variety_id: 'var-new',
      metadata: {
        seeds_per_packet: '1',
        organic: false,
        heirloom: false,
        item_category: 'flower',
        sku: '1174',
        vendor: 'Botanical Interests',
        origin: 'BI-order-2026-06-09',
      },
    })

    // Row flips to the saved chip + completion toast.
    expect(await screen.findByText('Saved ✓')).toBeDefined()
    expect(screen.getByText('Saved 1 packet')).toBeDefined()
  })

  it('auto-matched row skips variety creation and uses the matched id', async () => {
    routeFetch({
      varieties: [{ id: 'var-existing', name: 'shirley single blend', species: null }],
    })
    await renderAddSeeds()
    await runPasteExtract()

    // Exact case-insensitive match chip.
    expect(await screen.findByText('Matches: shirley single blend')).toBeDefined()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save all/ }))
    })

    const calls = fetchSpy.mock.calls
    expect(calls.some(([url, opts]) => url === '/api/varieties' && opts?.method === 'POST')).toBe(false)
    const invCall = calls.find(([url, opts]) => url === '/api/inventory-items' && opts?.method === 'POST')
    expect(invCall).toBeDefined()
    expect(JSON.parse(invCall[1].body).variety_id).toBe('var-existing')
  })

  it('409 variety conflict auto-uses existing.id for the inventory insert', async () => {
    routeFetch()
    const conflict = httpError(409, 'duplicate variety')
    conflict.body = { error: 'duplicate variety', existing: { id: 'var-409', name: 'Shirley Single Blend' } }
    fetchSpy.mockImplementation((url, opts = {}) => {
      if (url === '/api/inventory-items/extract-seeds' && opts.method === 'POST') return Promise.resolve({ packets: [PACKET] })
      if (url.startsWith('/api/varieties') && opts.method === 'POST') return Promise.reject(conflict)
      if (url.startsWith('/api/varieties')) return Promise.resolve([])
      if (url === '/api/inventory-items' && opts.method === 'POST') return Promise.resolve({ id: 'item-new' })
      return Promise.resolve({})
    })
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('New variety')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save all/ }))
    })

    const invCall = fetchSpy.mock.calls.find(([url, opts]) => url === '/api/inventory-items' && opts?.method === 'POST')
    expect(invCall).toBeDefined()
    expect(JSON.parse(invCall[1].body).variety_id).toBe('var-409')
  })
})

// BUG-ADDSEEDSVALIDSLUGS-001 — Save all must type each new variety against the LIVE crop_types
// catalog, not the frozen CROP_TYPE_SLUGS list in parseSowProfile.js (73 slugs vs 158 live garden
// types in prod on 2026-09-23). Every expected slug below is a literal.
function varietyPostBodies() {
  return fetchSpy.mock.calls
    .filter(([url, opts]) => url === '/api/varieties' && opts?.method === 'POST')
    .map(([, opts]) => JSON.parse(opts.body))
}

function bodyFor(varietyName) {
  const matches = varietyPostBodies().filter((b) => b.name === varietyName)
  expect(matches, `exactly one variety POST named "${varietyName}"`).toHaveLength(1)
  return matches[0]
}

async function clickSaveAll() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Save all/ }))
  })
}

describe('AddSeeds — crop type is gated on the LIVE catalog (BUG-ADDSEEDSVALIDSLUGS-001)', () => {
  it('fixture precondition: carrot is live-only, tomato is in both lists, moonflower in neither', () => {
    // If the frozen list ever gains 'carrot', the live-catalog case below can no longer tell the
    // live gate from the frozen one and would pass on the pre-fix code. Pick another live-only slug.
    expect(CROP_TYPE_SLUGS).not.toContain('carrot')
    expect(CROP_TYPE_SLUGS).toContain('tomato')
    expect(CROP_TYPE_SLUGS).not.toContain('moonflower')
    expect(LIVE_CROP_TYPES.map((c) => c.slug)).toEqual(['carrot', 'tomato', 'bread'])
  })

  it('a crop type that exists only in the live catalog is saved WITH that type', async () => {
    routeFetch({ extract: { packets: [CARROT_PACKET, TOMATO_PACKET, MOONFLOWER_PACKET] } })
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('Danvers 126 Carrot Seeds')
    await clickSaveAll()
    await screen.findByText('Saved 3 packets')

    expect(bodyFor('Danvers 126').crop_type_slug).toBe('carrot')          // the defect: was dropped
    expect(bodyFor('Sungold').crop_type_slug).toBe('tomato')               // still typed
    expect(bodyFor('Giant White')).not.toHaveProperty('crop_type_slug')    // still gated, not a pass-through
  })

  it('a non-plant food class in the catalog never types a seed variety (garden scope)', async () => {
    routeFetch({ extract: { packets: [WHEAT_PACKET, CARROT_PACKET] } })
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('Red Fife Wheat Seeds')
    await clickSaveAll()
    await screen.findByText('Saved 2 packets')

    // Carrot is the control: typed, so the live list WAS in force when bread was refused.
    expect(bodyFor('Danvers 126').crop_type_slug).toBe('carrot')
    expect(bodyFor('Red Fife')).not.toHaveProperty('crop_type_slug')
  })

  it.each([
    ['the catalog fetch fails (500)', () => Promise.reject(httpError(500, 'internal error'))],
    ['the catalog comes back empty', () => Promise.resolve([])],
  ])('%s: falls back to the frozen list, so a known type is never dropped', async (_label, cropTypes) => {
    // useCropTypes answers [] in both cases. Handing that [] to packetToVarietyCols as validSlugs
    // would reject EVERY guess ([] is truthy and [].includes(x) is false) and untype every packet,
    // which is worse than the bug. The fallback is exactly the pre-fix behaviour.
    routeFetch({ cropTypes, extract: { packets: [TOMATO_PACKET, CARROT_PACKET] } })
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('Sungold Tomato Seeds')
    await clickSaveAll()
    await screen.findByText('Saved 2 packets')

    expect(bodyFor('Sungold').crop_type_slug).toBe('tomato')
    // No live list, so nothing admits carrot: it saves untyped, as it did before the fix.
    expect(bodyFor('Danvers 126')).not.toHaveProperty('crop_type_slug')
  })

  it('Save all is held while the catalog loads, then saves with the live type', async () => {
    let resolveCropTypes
    const pending = new Promise((resolve) => { resolveCropTypes = resolve })
    routeFetch({ cropTypes: () => pending, extract: { packets: [CARROT_PACKET] } })
    await renderAddSeeds()
    await runPasteExtract()
    await screen.findByText('Danvers 126 Carrot Seeds')

    // Rows can exist before the catalog does (a restored draft renders them on mount). A save in
    // that window would type against the frozen list and drop carrot, so the button is held.
    expect(screen.getByRole('button', { name: /Save all/ }).disabled).toBe(true)
    await clickSaveAll()
    expect(varietyPostBodies()).toEqual([])

    await act(async () => { resolveCropTypes(LIVE_CROP_TYPES) })
    expect(screen.getByRole('button', { name: /Save all/ }).disabled).toBe(false)
    await clickSaveAll()
    await screen.findByText('Saved 1 packet')
    expect(bodyFor('Danvers 126').crop_type_slug).toBe('carrot')
  })
})

// BUG-FIELDCHILDDROP-001 — the row-edit sheet's variety hint was a second child of its <Field>
// and Field dropped every element child after the first, so this sentence has never reached a
// screen. Nothing caught it because nothing rendered the sheet: every test above stops at the
// review list. The static sweep in fieldChildren.test.jsx pins the shape; this pins the text.
describe('AddSeeds — row-edit sheet', () => {
  it('shows the create-a-new-variety hint under the variety picker', async () => {
    routeFetch()
    await renderAddSeeds()
    await runPasteExtract()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Shirley Single Blend Corn Poppy Seeds' }))
    })

    // The name is interpolated from the packet, so assert the whole sentence, not just the prefix —
    // a hint that rendered with an empty name would be a different bug wearing this one's clothes.
    // The name is a literal, not computed by the helper the page calls (BUG-ADDSEEDSVALIDSLUGS-001).
    expect(screen.getByText(
      (_t, el) => el?.textContent === 'Leave blank to create “Shirley Single Blend” as a new variety on save.'
    )).toBeDefined()
  })
})
