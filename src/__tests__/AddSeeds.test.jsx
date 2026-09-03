/**
 * src/__tests__/AddSeeds.test.jsx
 * V4-SEEDINV-001 — /inventory/add-seeds bulk seed intake tests.
 *
 * Covers: chooser renders 3 options (One item navigates), paste flow extract
 * POST wire shape, 501 extractor-not-configured banner, and a review-row save
 * (variety create THEN inventory POST — order + exact payload assertions,
 * including the auto-match skip of variety creation).
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
import { packetToVarietyCols } from '../lib/parseSowProfile.js'

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

function routeFetch({
  varieties = [],
  extract = { packets: [PACKET] },
  extractError = null,
  createdVariety = { id: 'var-new', name: 'Shirley Single Blend' },
  inventoryResponse = { id: 'item-new' },
} = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
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

  it('One item navigates to the single-item add form', async () => {
    routeFetch()
    await renderAddSeeds()
    fireEvent.click(screen.getByRole('radio', { name: 'One item' }))
    expect(navigateSpy).toHaveBeenCalledWith('/inventory/add')
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

    // Variety wire body = packetToVarietyCols(packet), verbatim.
    expect(JSON.parse(calls[varietyIdx][1].body)).toEqual(packetToVarietyCols(PACKET))

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
    expect(screen.getByText(
      (_t, el) => el?.textContent === `Leave blank to create “${packetToVarietyCols(PACKET).name}” as a new variety on save.`
    )).toBeDefined()
  })
})
