/**
 * src/__tests__/SowNow.test.jsx
 * DRG-SOWNOW-001 — /sow surface tests.
 *
 * Uses the REAL sowEngine (integration value) with a fixed today=2026-07-10:
 * fixture v_sow_candidates rows cover window_closing / direct_sow_now /
 * needs_profile / too_late. Asserts bucket headers render and that the Sow sheet
 * embeds the canonical PlantingEditor, POSTing /api/plants with a REAL project_id
 * (orphan-safe — replaces the old project_id:null mini-form; BUG-ORPHANNAV-001).
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

function routeFetch({ candidates = FIXTURES, projects = [{ id: 'proj-peppers', name: 'Peppers' }], plantResponse = { id: 'plant-1' }, sowArchiveFails = false } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/inventory-items/sow-candidates') return Promise.resolve({ items: candidates })
    if (url === '/api/projects') return Promise.resolve(projects)
    if (url === '/api/locations/with-path') return Promise.resolve([])
    // V4-SOWARCHIVE-001. MUST precede the generic /api/inventory-items/ branch below, which would
    // otherwise swallow the PATCH and return an item payload — the same route-ordering trap
    // sow-routes.test.js pins on the Lambda side.
    if (url.includes('/sow-archive')) {
      if (sowArchiveFails) return Promise.reject(new Error('network'))
      const body = JSON.parse(opts.body ?? '{}')
      return Promise.resolve({
        id: url.split('/')[3],
        sow_archived_season: body.archived === false ? null : body.season,
        sow_archived_at: body.archived === false ? null : '2026-07-10T12:00:00Z',
      })
    }
    if (url.startsWith('/api/inventory-items/')) {
      const id = url.split('/').pop()
      const c = candidates.find((x) => x.inventory_item_id === id)
      return Promise.resolve({ id, name: c?.item_name ?? 'Packet', source: c?.source ?? null, purchase_date: c?.purchase_date ?? null, brand: null, metadata: { vendor: 'Botanical Interests' } })
    }
    if (url.startsWith('/api/varieties/')) {
      const id = url.split('/').pop()
      const c = candidates.find((x) => x.variety_id === id)
      return Promise.resolve({ id, name: c?.variety_name ?? 'Variety' })
    }
    if (url === '/api/plants' && opts.method === 'POST') return Promise.resolve(plantResponse)
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

describe('SowNow — Sow sheet embeds the canonical PlantingEditor (orphan-safe)', () => {
  it('opens the pre-seeded editor and POSTs /api/plants with a REAL project_id (never null)', async () => {
    routeFetch()
    await renderSowNow()

    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80'))
    })

    const sheet = screen.getByRole('dialog')
    // The embedded editor exposes the REQUIRED project picker — the orphan fix.
    expect(within(sheet).getByLabelText(/Project/i)).toBeDefined()

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i }))
    })

    const call = fetchSpy.mock.calls.find(([url, o]) => url === '/api/plants' && o?.method === 'POST')
    expect(call).toBeDefined()
    const body = JSON.parse(call[1].body)
    expect(body.project_id).toBe('proj-peppers')   // default first project — NOT null (no orphan)
    expect(body.status).toBe('seed')
    expect(body.sown_at).toBe(TODAY)
    expect(body.source_type).toBe('seed_packet')
    expect(body.source_inventory_item_id).toBe('inv-cuke')
    expect(body.variety_id).toBe('var-cuke')
    expect(body.source_ref).toBe('Botanical Interests')             // vendor pulled from the packet
    expect(body.notes).toMatch(/Seed source: Botanical Interests/)  // haul detail pulled to notes

    // Card flips to the Sown state and the toast fires.
    expect(await screen.findByText(/Sown/)).toBeDefined()
    expect(screen.queryByLabelText('Sow Spacemaster 80')).toBeNull()
    expect(screen.getByText('Planted!')).toBeDefined()
  })

  it('lets you pick a different place; the chosen project_id is sent', async () => {
    routeFetch({ projects: [{ id: 'proj-peppers', name: 'Peppers' }, { id: 'proj-herbs', name: 'Herbs' }] })
    await renderSowNow()

    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Sow Black Seeded Simpson'))
    })
    const sheet = screen.getByRole('dialog')
    fireEvent.change(within(sheet).getByLabelText(/Project/i), { target: { value: 'proj-herbs' } })

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i }))
    })

    const call = fetchSpy.mock.calls.find(([url, o]) => url === '/api/plants' && o?.method === 'POST')
    const body = JSON.parse(call[1].body)
    expect(body.project_id).toBe('proj-herbs')
    expect(body.source_inventory_item_id).toBe('inv-lettuce')
    expect(body.status).toBe('seed')
  })
})

// ── V4-SOWNOW-PHOTOPERIOD-001 — gated alliums + the next-year section ────────────
// FLAT_OF_ITALY carries the real prod growth_habit prose; on today=2026-07-10 the gate holds it
// for next February. PURE_BIENNIAL is a pure class-H row — the only shape that reaches the new
// sow_next_year bucket (the real Hollyhock co-carries a class-B clause and stays this-season).
const FLAT_OF_ITALY = {
  inventory_item_id: 'inv-flatitaly', item_name: 'Flat of Italy Onion Seeds',
  variety_name: 'Flat of Italy', variety_id: 'var-flatitaly',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'onion', lifecycle: 'annual', grown_as: 'annual',
  sun_requirements: 'full_sun', days_to_maturity_min: '70', days_to_maturity_max: '70',
  start_method: 'both', start_indoor_weeks_min: '10', start_indoor_weeks_max: '12',
  direct_sow_timing: '4-6 weeks before last frost or as soon as soil can be worked',
  sow_depth_in: '0.25', seed_spacing_in: '4', row_spacing_in: '12',
  days_to_germ_min: '7', days_to_germ_max: '14', sow_season: 'cool', sow_notes: null,
  growth_habit: 'Intermediate-day (leaning intermediate-to-long-day) heirloom Italian cipollini; forms flattened, disk-shaped bulbs rather than tall globes. Biennial grown as a warm-season annual for bulb harvest.',
  day_length_response: null,
}
const PURE_BIENNIAL = {
  inventory_item_id: 'inv-biennial', item_name: 'Sweet William Seeds',
  variety_name: 'Sweet William', variety_id: 'var-biennial',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: null, lifecycle: 'biennial', grown_as: 'biennial',
  sun_requirements: 'full_sun', days_to_maturity_min: null, days_to_maturity_max: null,
  start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: 'sow in summer for next-year bloom',
  sow_depth_in: '0.125', seed_spacing_in: '8', row_spacing_in: null,
  days_to_germ_min: '5', days_to_germ_max: '14', sow_season: 'cool_warm', sow_notes: null,
  growth_habit: null, day_length_response: null,
}

describe('SowNow — allium gate + next-year section', () => {
  it('renders the sow_next_year section without crashing (new bucket key is seeded)', async () => {
    routeFetch({ candidates: [...FIXTURES, PURE_BIENNIAL] })
    await renderSowNow()
    expect(await screen.findByText('For next year — sow now')).toBeDefined()
  })

  // Anti-collapse requirement: the section is demoted but NEVER hidden behind a disclosure — it is
  // actionable and deadline-bearing, and a hidden window is a window that closes unseen.
  it('the next-year section is expanded on arrival, with its subtitle and a Sow action', async () => {
    routeFetch({ candidates: [PURE_BIENNIAL] })
    await renderSowNow()

    await screen.findByText('For next year — sow now')
    expect(screen.getByText('Sow these this summer; they flower next spring.')).toBeDefined()
    // Card content is present with no click — not behind a ▸ toggle.
    expect(screen.getByText('Sweet William')).toBeDefined()
    expect(screen.getByText('36 days left')).toBeDefined()
    expect(screen.getByLabelText('Sow Sweet William')).toBeDefined()
  })

  it('places the next-year section below this-season work but above too_late', async () => {
    routeFetch({ candidates: [...FIXTURES, PURE_BIENNIAL] })
    await renderSowNow()

    const nextYear = await screen.findByText('For next year — sow now')
    const directSow = screen.getByText('Direct sow now')
    const tooLate = screen.getByText('Too late this year')
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    expect(directSow.compareDocumentPosition(nextYear) & 4).toBeTruthy()
    expect(nextYear.compareDocumentPosition(tooLate) & 4).toBeTruthy()
  })

  it('a gated onion is held, explains why on the card, and keeps a Sow anyway override', async () => {
    routeFetch({ candidates: [FLAT_OF_ITALY] })
    await renderSowNow()

    await screen.findByText('Hold for later')
    expect(screen.getByText('Flat of Italy')).toBeDefined()
    // It must NOT appear in any this-season actionable section.
    expect(screen.queryByText('Direct sow now')).toBeNull()
    expect(screen.queryByText('Start indoors now')).toBeNull()
    expect(screen.queryByText('Window closing')).toBeNull()
    // Per-card "why" — the section heading cannot explain a gated hold.
    expect(screen.getByText(/Bulb onions need a spring start/)).toBeDefined()
    // Reopen badge carries the YEAR so a 7-month hold cannot read as imminent.
    expect(screen.getByText(/opens ~Feb 25, 2027/)).toBeDefined()
    // Override: an engine misclassification must never be a dead end.
    expect(screen.getByLabelText('Sow Flat of Italy anyway')).toBeDefined()
  })

  it('an ordinary (non-gated) hold shows no reason line and no override button', async () => {
    routeFetch({ candidates: [FLAT_OF_ITALY, ...FIXTURES] })
    await renderSowNow()

    await screen.findByText('Hold for later')
    // Only the gated card carries these affordances.
    expect(screen.queryAllByText(/need a spring start/)).toHaveLength(1)
    expect(screen.queryAllByLabelText(/anyway$/)).toHaveLength(1)
  })
})

// ── V4-SOWARCHIVE-001 ─────────────────────────────────────────────────────────
// "I've already sown these and I'm not going to sow more, so I don't want to see them on the list.
// They should still show up somewhere on the page, at the bottom, and I can unarchive them."
// The through-line of these tests: archived is a VIEW state, never a delete — the packet stays on
// the page, stays reversible, and never loses its identity.
describe('SowNow — archive for the season', () => {
  const patchCalls = () => fetchSpy.mock.calls.filter(([u]) => String(u).includes('/sow-archive'))

  it('offers Archive on an active card', async () => {
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    expect(screen.getByLabelText('Archive Spacemaster 80 for this season')).toBeDefined()
  })

  it('archiving PATCHes the packet with THIS season and moves it off the active list', async () => {
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Archive Spacemaster 80 for this season'))
    })

    const [url, opts] = patchCalls()[0]
    expect(url).toBe('/api/inventory-items/inv-cuke/sow-archive')
    expect(opts.method).toBe('PATCH')
    // The season is the year of todayISO — the same year the engine buckets against — NOT a fresh
    // Date(). This is what stops a 31-Dec archive being stamped into next year.
    expect(JSON.parse(opts.body)).toEqual({ archived: true, season: 2026 })

    // Gone from the active section, and that section collapsed away with it (it held only cucumber).
    expect(screen.queryByText('Window closing')).toBeNull()
    expect(screen.getByText('Archived for this season')).toBeDefined()
  })

  it('the archived section is collapsed by default and expands to reveal the packet', async () => {
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Archive Spacemaster 80 for this season'))
    })

    // Off the working list: the card is not rendered while the disclosure is shut.
    expect(screen.queryByText('Spacemaster 80')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByText('Archived for this season')) })

    // Still on the page, one tap away — and it remembers where it came from.
    expect(screen.getByText('Spacemaster 80')).toBeDefined()
    expect(screen.getByText('From: Window closing')).toBeDefined()
    expect(screen.getByLabelText('Un-archive Spacemaster 80')).toBeDefined()
  })

  it('ROUND TRIP: un-archiving clears the stamp and restores the original bucket', async () => {
    routeFetch()
    await renderSowNow()
    await screen.findByText('Spacemaster 80')
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Archive Spacemaster 80 for this season'))
    })
    await act(async () => { fireEvent.click(screen.getByText('Archived for this season')) })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Un-archive Spacemaster 80'))
    })

    // {archived:false} carries no season — the server nulls both columns.
    expect(JSON.parse(patchCalls()[1][1].body)).toEqual({ archived: false })
    // Back where it started, badge and all.
    expect(screen.getByText('Window closing')).toBeDefined()
    expect(screen.getByText('4 days left')).toBeDefined()
    expect(screen.queryByText('Archived for this season')).toBeNull()
  })

  it('a packet already archived for this season loads straight into the archived section', async () => {
    routeFetch({ candidates: [{ ...CUCUMBER, sow_archived_season: 2026 }, LETTUCE] })
    await renderSowNow()

    expect(await screen.findByText('Archived for this season')).toBeDefined()
    expect(screen.queryByText('Window closing')).toBeNull()
    // Un-archived neighbours are untouched.
    expect(screen.getByText('Direct sow now')).toBeDefined()
  })

  it('AUTO-RELEASE: last season\'s stamp does not hide anything this season', async () => {
    routeFetch({ candidates: [{ ...CUCUMBER, sow_archived_season: 2025 }] })
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.queryByText('Archived for this season')).toBeNull()
  })

  it('a failed archive puts the card BACK rather than leaving a lie on screen', async () => {
    routeFetch({ sowArchiveFails: true })
    await renderSowNow()
    await screen.findByText('Spacemaster 80')

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Archive Spacemaster 80 for this season'))
    })

    // The optimistic move is rolled back: an archived-looking card whose write failed would be a
    // packet Dave believes is put away and that reappears on his next visit.
    expect(screen.getByText('Window closing')).toBeDefined()
    expect(screen.getByText('Spacemaster 80')).toBeDefined()
    expect(screen.queryByText('Archived for this season')).toBeNull()
  })
})
