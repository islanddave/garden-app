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

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))

import SowNow, { SEED_STAGE_LABEL } from '../pages/SowNow.jsx'
import { IN_PROCESS_STAGES } from '../lib/sowEngine.js'
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

  // ── BUG-SOWPROSEUNREAD-001 — "Needs a sow profile" when the profile EXISTS ────────────────────
  //
  // A packet with no timing at all genuinely needs one, and MYSTERY above is that packet. The defect
  // is the other kind: prose the classifier cannot parse. The card claimed the profile was missing,
  // offered "Add sow details", and showed the gardener nothing — while the packet itself said
  // something perfectly actionable.
  //
  // FIXTURE RE-POINTED 2026-09-02 — the old one stopped being unreadable. It was Quincy ('Direct sow
  // after all frost once soil is reliably warm (optimal 75-95F; never below 55-60F). Zone 5b: late May
  // to mid-June.'), picked because a semicolon inside its parenthetical had once made splitClauses emit
  // unbalanced fragments. Widening class B to accept "after all frost" made that string classify as B,
  // so this block was rendering a candidate that no longer lands in needs_profile at all. Quincy's
  // paren-split property is NOT lost — BUG-SOWCLAUSEPARENSPLIT-001 in sowEngine.test.js owns it.
  //
  // Replacement is VERBATIM from live prod (Zebrune shallot) and picked for STABILITY under future
  // widening, not merely for being unreadable today: it is an INDOOR-START instruction, which no
  // widening of a DIRECT-sow classifier should ever turn into a direct-sow window. Mirrors the fixture
  // in sowEngine.test.js deliberately — the engine test asserts the ROUTING and this one asserts the
  // RENDER, and they should fail together rather than drift apart.
  const UNREADABLE_PROSE = 'Indoor start strongly preferred in Zone 5b to mature before Sep 26 frost'
  const UNREADABLE = {
    ...MYSTERY,
    inventory_item_id: 'inv-zebrune',
    item_name: 'Zebrune Shallot Onion Seeds',
    variety_name: 'Zebrune',
    direct_sow_timing: UNREADABLE_PROSE,
  }

  it('shows the packet’s own words when the engine could not read them', async () => {
    routeFetch({ candidates: [UNREADABLE] })
    await renderSowNow()
    await screen.findByText('Needs a sow profile')

    const prose = screen.getByTestId('sow-prose')
    expect(prose.textContent).toContain('Indoor start strongly preferred in Zone 5b')
    // Labelled as the packet talking, never as an engine verdict — the app did not derive this.
    expect(prose.textContent).toMatch(/packet says/i)
  })

  it('still offers the CTA — reading the prose is not a substitute for a real profile', async () => {
    routeFetch({ candidates: [UNREADABLE] })
    await renderSowNow()
    expect(await screen.findByLabelText('Add sow details for Zebrune')).toBeDefined()
  })

  it('a packet with NO timing shows no prose line at all', async () => {
    // MYSTERY carries direct_sow_timing: null and sow_notes: null. An empty "The packet says:" label
    // would be worse than the dead end it replaces.
    routeFetch()
    await renderSowNow()
    await screen.findByText('Needs a sow profile')
    expect(screen.queryByTestId('sow-prose')).toBeNull()
  })

  it('does NOT appear on a card the engine DID understand', async () => {
    // Everywhere else the engine parsed the timing and its own window label is the better answer;
    // echoing the raw prose beside a computed date would invite the reader to arbitrate between them.
    routeFetch({ candidates: [CUCUMBER] })
    await renderSowNow()
    await screen.findByText('Window closing')
    expect(screen.queryByTestId('sow-prose')).toBeNull()
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
    // Copy rewritten 2026-08-17 (V4-SOWOWCOPY-001): the old subtitle promised flowers, but the
    // bucket is a horizon partition and takes food crops too. Pinned verbatim because the point of
    // the change is the wording, not the presence of a subtitle.
    expect(screen.getByText(
      'Sow now, bloom or harvest next spring — nothing here pays off this season.',
    )).toBeDefined()
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

// ── V4-SEEDZEROVIEW-001 ───────────────────────────────────────────────────────
// "I want to keep zero counts in our records, viewable as 'sowed previously' so i can review, but I
// don't want a real 'reorder if...' logic in here. Won't use it, just need to know what I've had,
// how much I have now, and all the details even if zero — zero counts can be filtered out of sow now
// and other used surfaces, but a view/filter of them would be useful."
//
// The filed defect was Belstar Broccoli at quantity_on_hand = 0 being offered as sowable. These
// tests assert BOTH halves: it is off the working list, AND it is still on the page in full.
describe('SowNow — sowed previously (zero-count packets)', () => {
  const EMPTY_CUKE = { ...CUCUMBER, quantity_on_hand: '0' }

  it('THE FILED DEFECT: a zero-count packet is not offered as sowable', async () => {
    // Cucumber is the page's only window_closing packet, so the whole section goes with it — and
    // there is no Sow button anywhere for it.
    routeFetch({ candidates: [EMPTY_CUKE, LETTUCE] })
    await renderSowNow()
    await screen.findByText('Direct sow now')

    expect(screen.queryByText('Window closing')).toBeNull()
    expect(screen.queryByLabelText('Sow Spacemaster 80')).toBeNull()
    expect(screen.getByText('Sowed previously')).toBeDefined()
    // The neighbour with stock is untouched.
    expect(screen.getByLabelText('Sow Black Seeded Simpson')).toBeDefined()
  })

  it('the section is collapsed by default and expands to the full packet, with its provenance', async () => {
    routeFetch({ candidates: [EMPTY_CUKE, LETTUCE] })
    await renderSowNow()
    await screen.findByText('Sowed previously')

    // Off the working list: nothing about the packet is rendered while the disclosure is shut.
    expect(screen.queryByText('Spacemaster 80')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByText('Sowed previously')) })

    // Kept in full — name, the window it would have had, and the depth/spacing line.
    expect(screen.getByText('Spacemaster 80')).toBeDefined()
    expect(screen.getByText('Direct sow through Jul 14')).toBeDefined()
    expect(screen.getByText('Sow ½ in deep · 12 in apart')).toBeDefined()
    // Where it would have sat, so "why was this on my list?" needs no restock to answer.
    expect(screen.getByText('From: Window closing')).toBeDefined()
    // Still no Sow action, even with the section open.
    expect(screen.queryByLabelText('Sow Spacemaster 80')).toBeNull()
  })

  it('the review card routes to the packet record — "all the details even if zero"', async () => {
    routeFetch({ candidates: [EMPTY_CUKE] })
    await renderSowNow()
    await act(async () => { fireEvent.click(await screen.findByText('Sowed previously')) })

    fireEvent.click(screen.getByLabelText('View details for Spacemaster 80'))
    expect(navigateSpy).toHaveBeenCalledWith('/inventory/inv-cuke')
  })

  it('NO reorder cue anywhere on the page — Dave asked for the record, not a restock prompt', async () => {
    routeFetch({ candidates: [EMPTY_CUKE, LETTUCE] })
    await renderSowNow()
    await act(async () => { fireEvent.click(await screen.findByText('Sowed previously')) })

    expect(document.body.textContent).not.toMatch(/reorder|re-order|restock|buy more|order more|running low/i)
  })

  it('THE NULL DECISION: an untracked packet stays on the working list', async () => {
    // quantity_on_hand NULL means "not tracked", not "used up" — see isDepleted's note. Hiding an
    // uncounted packet is the wrong-late direction and forfeits a sowing silently.
    routeFetch({ candidates: [{ ...CUCUMBER, quantity_on_hand: null }] })
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.getByLabelText('Sow Spacemaster 80')).toBeDefined()
    expect(screen.queryByText('Sowed previously')).toBeNull()
  })

  it('a half-empty packet is still seed — it stays sowable', async () => {
    // Clemson Spineless 80 Okra sits at 0.5 on prod; a fraction is stock, not depletion.
    routeFetch({ candidates: [{ ...CUCUMBER, quantity_on_hand: '0.5' }] })
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.queryByText('Sowed previously')).toBeNull()
  })

  it('a zero-count packet is still archivable, and reports the review section as its home', async () => {
    routeFetch({ candidates: [{ ...EMPTY_CUKE, sow_archived_season: 2026 }] })
    await renderSowNow()
    await act(async () => { fireEvent.click(await screen.findByText('Archived for this season')) })

    expect(screen.queryByText('Sowed previously')).toBeNull()
    expect(screen.getByText('From: Sowed previously')).toBeDefined()
    expect(screen.getByLabelText('Un-archive Spacemaster 80')).toBeDefined()
  })
})

// ── V4-SEEDSAVEFLOW-001 ───────────────────────────────────────────────────────
// The filed defect, measured on a real Neon branch 2026-09-02: v_sow_candidates says nothing about
// seed_stage, so a lot at 'fermenting' — wet tomato seed in its own pulp — was offered by this page
// exactly as a finished packet is. Dave's remedy is DIVERT, NOT HIDE: the lot stays on the page,
// marked with the stage it is in, so he can see the seed exists and is coming while being unable to
// mis-sow it. Every negative below is asserted in the SAME render as its positive — a queryByText
// that runs alone passes just as well against a page that renders no markers at all.
describe('SowNow — seed still in process', () => {
  const WET_CUKE = { ...CUCUMBER, seed_stage: 'fermenting' }
  const DRYING_LETTUCE = { ...LETTUCE, seed_stage: 'drying' }
  const STORED_LETTUCE = { ...LETTUCE, seed_stage: 'stored' }
  // A saved lot off the same gated onion. Distinct id + name so it can sit in one render beside the
  // bought packet and be told apart by label.
  const WET_ONION = {
    ...FLAT_OF_ITALY,
    inventory_item_id: 'inv-flatitaly-saved',
    variety_name: 'Flat of Italy (saved)',
    seed_stage: 'fermenting',
  }

  // Scopes an assertion to ONE card's chips: the title span and every status badge are siblings
  // inside the card's badge row, so the title's parent IS that row.
  const chipsFor = (title) => screen.getByText(title).parentElement

  it('THE FILED DEFECT: a fermenting lot is not offered as sowable', async () => {
    // Cucumber is the page's only window_closing packet, so the whole section goes with it.
    routeFetch({ candidates: [WET_CUKE, LETTUCE] })
    await renderSowNow()
    await screen.findByText('Direct sow now')

    expect(screen.queryByText('Window closing')).toBeNull()
    expect(screen.queryByLabelText('Sow Spacemaster 80')).toBeNull()
    expect(screen.getByText('Still in process')).toBeDefined()
    // The bought neighbour (seed_stage absent entirely) is untouched.
    expect(screen.getByLabelText('Sow Black Seeded Simpson')).toBeDefined()
  })

  it('the marker NAMES the stage, and a stored lot in the same render gets none', async () => {
    routeFetch({ candidates: [WET_CUKE, STORED_LETTUCE] })
    await renderSowNow()
    await screen.findByText('Still in process')

    // Words, not colour: the chip says which stage and says it cannot be sown.
    expect(within(chipsFor('Spacemaster 80')).getByText('Fermenting — not ready to sow')).toBeDefined()
    // SAME RENDER, and scoped to the other card rather than to the page: the stored lot carries no
    // marker at all, and is on the working list with a live Sow action.
    expect(within(chipsFor('Black Seeded Simpson')).queryByText(/not ready to sow/)).toBeNull()
    expect(screen.getByLabelText('Sow Black Seeded Simpson')).toBeDefined()
    expect(screen.getAllByText(/not ready to sow/)).toHaveLength(1)
  })

  it('drying says Drying — the marker is the stage, not a generic "not ready"', async () => {
    // Both stages in one render, each naming itself, plus a never-staged packet with no marker.
    routeFetch({ candidates: [WET_CUKE, DRYING_LETTUCE, { ...MYSTERY, seed_stage: null }] })
    await renderSowNow()
    await screen.findByText('Still in process')

    expect(within(chipsFor('Spacemaster 80')).getByText('Fermenting — not ready to sow')).toBeDefined()
    expect(within(chipsFor('Black Seeded Simpson')).getByText('Drying — not ready to sow')).toBeDefined()
    expect(within(chipsFor('Mystery Pepper')).queryByText(/not ready to sow/)).toBeNull()
    expect(screen.getAllByText(/not ready to sow/)).toHaveLength(2)
  })

  it('every stage the engine diverts on has words on the card', () => {
    // A stage in IN_PROCESS_STAGES with no entry here would render the fallback chip instead of its
    // name — legible, but the stage would go unsaid. This is the drift guard for that.
    expect(Object.keys(SEED_STAGE_LABEL).sort()).toEqual([...IN_PROCESS_STAGES].sort())
  })

  it('the section is OPEN on arrival — "see it coming" is not a thing behind a toggle', async () => {
    routeFetch({ candidates: [WET_CUKE] })
    await renderSowNow()
    await screen.findByText('Still in process')

    // Card content with no click, unlike sowed_previously/archived/too_late.
    expect(screen.getByText('Spacemaster 80')).toBeDefined()
    expect(screen.getByText(
      'Seed you are saving that is not finished yet. It stays on the list so you can see it coming — but it cannot be sown until it is dry and stored.',
    )).toBeDefined()
    // Kept in full: the window it will return to once it is dry, and its depth/spacing line.
    expect(screen.getByText('Direct sow through Jul 14')).toBeDefined()
    expect(screen.getByText('From: Window closing')).toBeDefined()
    expect(screen.getByText('Sow ½ in deep · 12 in apart')).toBeDefined()
  })

  it('NO override on a wet lot — the gated bought packet beside it keeps its own', async () => {
    // The one place this page withholds "Sow anyway" on purpose: a gate is a judgement Dave may know
    // better than, but wet seed in a jar is a physical fact and no tap makes it sowable today.
    //
    // STILL TRUE AFTER BUG-SEEDZEROSOWABLE-001 (2026-09-02), which added ONE documented exception to
    // this rule — see the `unstartedSave` test below. This assertion is deliberately left standing
    // rather than loosened: the exception turns on a claim the app never made about an unstarted
    // lot, and it must not leak to a lot the app HAS called fermenting.
    routeFetch({ candidates: [FLAT_OF_ITALY, WET_ONION] })
    await renderSowNow()
    await screen.findByText('Still in process')

    expect(screen.getByLabelText('Sow Flat of Italy anyway')).toBeDefined()
    expect(screen.queryByLabelText('Sow Flat of Italy (saved) anyway')).toBeNull()
    expect(screen.queryByLabelText('Sow Flat of Italy (saved)')).toBeNull()
    expect(screen.getAllByLabelText(/anyway$/)).toHaveLength(1)
  })

  // BUG-SEEDZEROSOWABLE-001 — a lot saved off a plant, uncounted, process never started.
  const JUST_SAVED_ONION = {
    ...FLAT_OF_ITALY,
    inventory_item_id: 'inv-flatitaly-justsaved',
    variety_name: 'Flat of Italy (just saved)',
    quantity_on_hand: '0',
    seed_stage: null,
    source_plant_id: 'pl-onion',
  }

  it('a just-saved lot is marked "Not started yet", NOT filed as sowed previously', async () => {
    // The whole defect in one render: before this, a lot created seconds earlier appeared under
    // "Sowed previously — none of these left".
    routeFetch({ candidates: [JUST_SAVED_ONION] })
    await renderSowNow()

    expect(await screen.findByText('Still in process')).toBeDefined()
    const chip = screen.getByTestId('seed-stage-chip')
    expect(chip.textContent).toMatch(/Not started yet/)
    // NOT "not ready to sow": that is a claim about wet seed, and this lot keeps its override. The
    // page must not offer a Sow anyway button beside a chip saying the lot cannot be sown.
    expect(chip.textContent).toMatch(/no count recorded/)
    expect(chip.textContent).not.toMatch(/not ready to sow/)
    expect(screen.queryByText('Sowed previously')).toBeNull()
  })

  it('the wet lot keeps "not ready to sow" — the physical claim still gets made where it is true', async () => {
    routeFetch({ candidates: [WET_ONION] })
    await renderSowNow()
    await screen.findByText('Still in process')
    expect(screen.getByTestId('seed-stage-chip').textContent).toMatch(/Fermenting — not ready to sow/)
  })

  it('KEEPS its override, unlike the wet lot — the carve-out, asserted in one render', async () => {
    // Both lots sit in the same bucket and are told apart only by whether the app has ever asserted
    // anything about the seed's physical state. Rendered together so the two halves cannot drift:
    // a change that granted the wet lot an override, or took the unstarted one's away, reds here.
    routeFetch({ candidates: [WET_ONION, JUST_SAVED_ONION] })
    await renderSowNow()
    await screen.findByText('Still in process')

    expect(screen.getByLabelText('Sow Flat of Italy (just saved) anyway')).toBeDefined()
    expect(screen.queryByLabelText('Sow Flat of Italy (saved) anyway')).toBeNull()
    expect(screen.getAllByLabelText(/anyway$/)).toHaveLength(1)
  })

  it('a bought packet on zero still reads as sowed previously — provenance is the discriminator', async () => {
    // The row this fix must NOT catch, and the reason it needed a migration rather than a rule about
    // stage and quantity. Identical to JUST_SAVED_ONION except that nobody saved it.
    routeFetch({ candidates: [{ ...JUST_SAVED_ONION, source_plant_id: null }] })
    await renderSowNow()

    expect(await screen.findByText('Sowed previously')).toBeDefined()
    expect(screen.queryByText('Not started yet')).toBeNull()
  })

  it('THE FORWARD HALF: advancing to stored puts the lot back on the working list', async () => {
    // Reaching `stored` used to grant a lot nothing at all. Same row, one column advanced.
    routeFetch({ candidates: [{ ...CUCUMBER, seed_stage: 'stored' }] })
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.getByLabelText('Sow Spacemaster 80')).toBeDefined()
    expect(screen.queryByText('Still in process')).toBeNull()
    expect(screen.queryByText(/not ready to sow/)).toBeNull()
  })

  it('THE NULL DECISION: a never-staged packet stays on the working list, unmarked', async () => {
    // seed_stage NULL is what EVERY bought packet carries — "never tracked", not "unfinished".
    routeFetch({ candidates: [{ ...CUCUMBER, seed_stage: null }] })
    await renderSowNow()

    expect(await screen.findByText('Window closing')).toBeDefined()
    expect(screen.getByLabelText('Sow Spacemaster 80')).toBeDefined()
    expect(screen.queryByText('Still in process')).toBeNull()
    expect(screen.queryByText(/not ready to sow/)).toBeNull()
  })

  it('a wet lot is still archivable, and the marker follows it into the archive', async () => {
    routeFetch({ candidates: [{ ...WET_CUKE, sow_archived_season: 2026 }] })
    await renderSowNow()
    await act(async () => { fireEvent.click(await screen.findByText('Archived for this season')) })

    expect(screen.queryByText('Still in process')).toBeNull()
    expect(screen.getByText('From: Still in process')).toBeDefined()
    // An archived jar of wet seed is still a jar of wet seed — the chip rides on the lot, not the
    // section it happens to be sitting in.
    expect(within(chipsFor('Spacemaster 80')).getByText('Fermenting — not ready to sow')).toBeDefined()
    expect(screen.getByLabelText('Un-archive Spacemaster 80')).toBeDefined()
  })
})
