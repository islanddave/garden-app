/**
 * src/__tests__/SowNow.test.jsx
 * DRG-SOWNOW-001 — /sow surface tests.
 *
 * Uses the REAL sowEngine (integration value) with a fixed today=2026-07-10:
 * fixture v_sow_candidates rows cover window_closing / direct_sow_now /
 * needs_profile / too_late. Asserts bucket headers render and the Sow Sheet
 * POSTs /api/plants with the EXACT wire body shape.
 *
 * House conventions: vi.mock react-router-dom stubs + vi.mock ../lib/api.js
 * hoisted fetchSpy routed by URL + ToastProvider wrap + act/findByText.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))

import SowNow from '../pages/SowNow.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const TODAY = '2026-07-10'

// v_sow_candidates-shaped rows (numerics as strings — neon driver serialization).
// Verified against the real engine for today=2026-07-10 (LF 05-20, FF 09-28):
//   cucumber  -> window_closing (direct close Jul 14, 4 days left)
//   lettuce   -> direct_sow_now (class C, close Aug 23)
//   mystery   -> needs_profile (no start_method, no direct_sow_timing)
//   biquinho  -> too_late (spring indoor window passed; warm = no fall pass)
const CUCUMBER = {
  inventory_item_id: 'inv-cuke', item_name: 'Spacemaster 80 Cucumber Seeds',
  variety_name: 'Spacemaster 80', variety_id: 'var-cuke',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'cucumber', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', days_to_maturity_min: '55', days_to_maturity_max: '62',
  start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: 'direct sow after last frost',
  sow_depth_in: '0.5', seed_spacing_in: '12', row_spacing_in: null,
  days_to_germ_min: '3', days_to_germ_max: '10', sow_season: 'warm', sow_notes: null,
}
const LETTUCE = {
  inventory_item_id: 'inv-lettuce', item_name: 'Black Seeded Simpson Lettuce Seeds',
  variety_name: 'Black Seeded Simpson', variety_id: 'var-lettuce',
  quantity_on_hand: '2', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'lettuce', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', days_to_maturity_min: '46', days_to_maturity_max: '50',
  start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: 'as soon as soil can be worked; succession sow every 2 weeks',
  sow_depth_in: '0.25', seed_spacing_in: '6', row_spacing_in: '12',
  days_to_germ_min: '2', days_to_germ_max: '15', sow_season: 'cool', sow_notes: null,
}
const MYSTERY = {
  inventory_item_id: 'inv-mystery', item_name: 'Mystery Pepper Seeds',
  variety_name: 'Mystery Pepper', variety_id: 'var-mystery',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: null, source: null, metadata: { needs_confirmation: true },
  crop_type_slug: 'pepper', lifecycle: null, grown_as: null,
  sun_requirements: null, days_to_maturity_min: null, days_to_maturity_max: null,
  start_method: null, start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: null, sow_depth_in: null, seed_spacing_in: null, row_spacing_in: null,
  days_to_germ_min: null, days_to_germ_max: null, sow_season: null, sow_notes: null,
}
const BIQUINHO = {
  inventory_item_id: 'inv-biquinho', item_name: 'Chile Biquinho Pepper Seeds',
  variety_name: 'Chile Biquinho', variety_id: 'var-biquinho',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'pepper', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', days_to_maturity_min: '75', days_to_maturity_max: '80',
  start_method: 'start_indoors', start_indoor_weeks_min: '8', start_indoor_weeks_max: '10',
  direct_sow_timing: null, sow_depth_in: '0.25', seed_spacing_in: '18', row_spacing_in: null,
  days_to_germ_min: '7', days_to_germ_max: '21', sow_season: 'warm', sow_notes: null,
}
const FIXTURES = [CUCUMBER, LETTUCE, MYSTERY, BIQUINHO]

function routeFetch({ candidates = FIXTURES, plantResponse = { id: 'plant-1' } } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/inventory-items/sow-candidates') {
      return Promise.resolve({ items: candidates })
    }
    if (url === '/api/plants' && opts.method === 'POST') {
      return Promise.resolve(plantResponse)
    }
    return Promise.resolve({})
  })
}

async function renderSowNow() {
  await act(async () => {
    render(<ToastProvider><SowNow todayISO={TODAY} /></ToastProvider>)
  })
}

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
})

describe('SowNow — bucket sections (real sowEngine, today=2026-07-10)', () => {
  it('renders populated bucket headers with counts, skips empty buckets', async () => {
    routeFetch()
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.getByText('Direct sow now')).toBeDefined()
    expect(screen.getByText('Needs a sow profile')).toBeDefined()
    expect(screen.getByText('Too late this year')).toBeDefined()
    // Empty buckets are collapsed away entirely.
    expect(screen.queryByText('Start indoors now')).toBeNull()
    expect(screen.queryByText('Sow inside anytime')).toBeNull()
    expect(screen.queryByText('Hold for later')).toBeNull()
  })

  it('cards show variety name, windowLabel, daysLeft badge, and depth/spacing line', async () => {
    routeFetch()
    await renderSowNow()

    await screen.findByText('Spacemaster 80')
    expect(screen.getByText('4 days left')).toBeDefined()
    expect(screen.getByText('Direct sow through Jul 14')).toBeDefined()
    // Number()-coerced depth/spacing line for lettuce (0.25 -> quarter fraction).
    expect(screen.getByText('Sow ¼ in deep · 6 in apart')).toBeDefined()
  })

  it('too_late is collapsed by default behind a disclosure', async () => {
    routeFetch()
    await renderSowNow()

    const disclosure = await screen.findByRole('button', { name: /Too late this year/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Chile Biquinho')).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Chile Biquinho')).toBeDefined()
    // No Sow button in too_late.
    expect(screen.queryByLabelText('Sow Chile Biquinho')).toBeNull()
  })

  it('needs_profile card CTA navigates to the inventory item', async () => {
    routeFetch()
    await renderSowNow()

    const cta = await screen.findByLabelText('Add sow details for Mystery Pepper')
    fireEvent.click(cta)
    expect(navigateSpy).toHaveBeenCalledWith('/inventory/inv-mystery')
  })

  it('shows the empty state when there are no candidates', async () => {
    routeFetch({ candidates: [] })
    await renderSowNow()
    expect(await screen.findByText('No seed packets yet')).toBeDefined()
  })

  it('shows an error state when the fetch fails', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'))
    await renderSowNow()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('boom')).toBeDefined()
  })
})

describe('SowNow — Sow Sheet POST wire shape', () => {
  it('POSTs /api/plants with the exact body and marks the card sown', async () => {
    routeFetch()
    await renderSowNow()

    fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))

    const sheet = screen.getByRole('dialog')
    // Mini-form defaults: name = variety_name, quantity 1, sown date today.
    expect(within(sheet).getByDisplayValue('Spacemaster 80')).toBeDefined()
    expect(within(sheet).getByDisplayValue('1')).toBeDefined()
    expect(within(sheet).getByDisplayValue(TODAY)).toBeDefined()

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Sow' }))
    })

    const call = fetchSpy.mock.calls.find(([url]) => url === '/api/plants')
    expect(call).toBeDefined()
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({
      name: 'Spacemaster 80',
      project_id: null,
      quantity: 1,
      status: 'seed',
      sown_at: '2026-07-10',
      sown_at_approx: false,
      variety: 'Spacemaster 80',
      variety_id: 'var-cuke',
      source_inventory_item_id: 'inv-cuke',
      source_type: 'seed_packet',
      notes: null,
    })

    // Card flips to the Sown text state (no emoji) and the toast fires.
    expect(await screen.findByText(/Sown/)).toBeDefined()
    expect(screen.queryByLabelText('Sow Spacemaster 80')).toBeNull()
    expect(screen.getByText('Planted!')).toBeDefined()
  })

  it('respects edited quantity and sown date in the POST body', async () => {
    routeFetch()
    await renderSowNow()

    fireEvent.click(await screen.findByLabelText('Sow Black Seeded Simpson'))
    const sheet = screen.getByRole('dialog')
    fireEvent.change(within(sheet).getByDisplayValue('1'), { target: { value: '6' } })
    fireEvent.change(within(sheet).getByDisplayValue(TODAY), { target: { value: '2026-07-08' } })

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Sow' }))
    })

    const call = fetchSpy.mock.calls.find(([url]) => url === '/api/plants')
    const body = JSON.parse(call[1].body)
    expect(body.quantity).toBe(6)
    expect(body.sown_at).toBe('2026-07-08')
    expect(body.source_inventory_item_id).toBe('inv-lettuce')
    expect(body.variety_id).toBe('var-lettuce')
  })
})
