/**
 * src/__tests__/PhotoLibrary.filterParity.test.jsx
 * V5-PHOTOFILTERPARITY-001 (BD0901-01) — the Photos page brought up to the Garden page's
 * filter/sort grammar. Dave, verbatim: "app photos page needs the robust filter options found
 * elsewhere, especially Garden page."
 *
 * FOUR THINGS ARE UNDER TEST, and they are four because that is the measured gap, not a wish list:
 *   1. a CROP facet (Garden's lead group-by, "Type", which this page had no equivalent of at all)
 *   2. filters that COMPOSE instead of clobbering each other (Garden's caretaker lens ANDs with its
 *      group-by; here a mode chip used to silently wipe the zone)
 *   3. a SORT control (the grid had none — it was whatever order the wire arrived in)
 *   4. an active-filter BREADCRUMB with per-pill removal and one-tap clear, plus a filtered empty
 *      state told apart from the first-run one (Garden's lens cue / Harvests' "Clear filters")
 *
 * WHY THE FIXTURE LOOKS LIKE THIS. A crop filter mounted over all-tomato photos is green against a
 * predicate that always returns true, one that ignores its argument, and one keyed on the wrong
 * column. So every narrowing assertion below carries a NEGATIVE, and the negatives share
 * `project_id` with the survivors — project being the only OTHER groupable field a photo row carries
 * — so a predicate reading the wrong column reds in both directions.
 *
 * AND ON THE MEANING OF A CROP CHIP: photos carry `plant_id`, never a subject. "Tomato" means "filed
 * under a tomato planting" — what the gardener was doing that day, not what the lens was pointed at.
 * `EVENT_ONLY` below is the photo that has no planting at all, and it must vanish under any chip;
 * that exclusion is a property of the feature, which is why it is asserted rather than tolerated.
 *
 * No jest-dom (L-182).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

// The join side. `pl-basil` is deliberately the only basil, so Basil lands in FilterChipRow's
// collapsed `More ▾` tray while Tomato and Pepper are pinned — the pinned set is DERIVED (top two by
// count), so the fixture has to have a shape for it to derive from.
const PICKER_PLANTS = [
  { id: 'pl-t1', name: 'Sungold', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'pl-t2', name: 'Brandywine', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'pl-p1', name: 'Gong Bao', variety_ref: { crop_type_slug: 'pepper' } },
  { id: 'pl-p2', name: 'Jimmy Nardello', variety_ref: { crop_type_slug: 'pepper' } },
  { id: 'pl-b1', name: 'Genovese', variety_ref: { crop_type_slug: 'basil' } },
]

const CROP_TYPES = [
  { slug: 'tomato', display_name: 'Tomato' },
  { slug: 'pepper', display_name: 'Pepper' },
  { slug: 'basil', display_name: 'Basil' },
]

// created_at is scrambled relative to the array order on purpose: the server returns DESC, so a
// fixture that arrived pre-sorted would let a no-op client sort pass the 'Newest' case.
const photo = (id, caption, over = {}) => ({
  id, caption, view_url: `https://x/${id}.jpg`,
  event_id: null, project_id: null, location_id: null, plant_id: null, inventory_item_id: null,
  created_at: '2026-09-01T12:00:00Z', ...over,
})

// TOM_A carries an event_id — it is the row that separates the crop filter from the mode filter in
// the composition test below (right crop, wrong mode).
const TOM_A = photo('tom-a', 'tomato A', { plant_id: 'pl-t1', project_id: 'proj-1', event_id: 'ev-9', created_at: '2026-09-01T10:00:00Z' })
const TOM_B = photo('tom-b', 'tomato B', { plant_id: 'pl-t2', project_id: 'proj-2', created_at: '2026-09-03T10:00:00Z' })
const TOM_C = photo('tom-c', 'tomato C', { plant_id: 'pl-t1', project_id: 'proj-2', created_at: '2026-09-02T10:00:00Z' })
// Shares proj-1 with TOM_A: a predicate keyed on project instead of crop keeps this under a tomato
// filter and reds.
const PEP_A = photo('pep-a', 'pepper A', { plant_id: 'pl-p1', project_id: 'proj-1', created_at: '2026-08-30T10:00:00Z' })
const PEP_B = photo('pep-b', 'pepper B', { plant_id: 'pl-p2', project_id: 'proj-3', created_at: '2026-08-31T10:00:00Z' })
const BAS_A = photo('bas-a', 'basil A', { plant_id: 'pl-b1', project_id: 'proj-3', created_at: '2026-08-29T10:00:00Z' })
// No planting of any kind, and it shares proj-1 with the tomato that survives.
const EVENT_ONLY = photo('ev-only', 'event only', { event_id: 'ev-1', project_id: 'proj-1', created_at: '2026-09-04T10:00:00Z' })

const ALL = [TOM_C, EVENT_ONLY, PEP_A, TOM_A, BAS_A, TOM_B, PEP_B]

const LOCATIONS = [{ id: 'loc-1', full_path: 'Pasture › Bed A', is_active: true }]

function wireApi(photos) {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p === '/api/projects') return Promise.resolve([])
    if (p === '/api/locations/with-path') return Promise.resolve(LOCATIONS)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve(CROP_TYPES)
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PICKER_PLANTS)
    if (p.startsWith('/api/plants')) return Promise.resolve([])
    if (p.startsWith('/api/photos')) return Promise.resolve(photos)
    return Promise.resolve([])
  })
}

const mount = async (photos = ALL) => {
  wireApi(photos)
  await act(async () => { render(<PhotoLibrary />) })
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
}

// The grid's cards each hold one <img alt={caption}>. Reading them IN ORDER is what makes the sort
// assertions real — a set comparison would pass against a sort that does nothing.
const grid = () => screen.queryAllByTestId('pl-photo-card')
  .map((card) => card.querySelector('img')?.getAttribute('alt') ?? '')
const shows = (alt) => grid().includes(alt)
const clickText = async (label) => { await act(async () => { fireEvent.click(screen.getByText(label)) }) }
const clickTestId = async (id) => { await act(async () => { fireEvent.click(screen.getByTestId(id)) }) }

beforeEach(() => {
  fetchSpy.mockReset()
  localStorage.clear()
  sessionStorage.clear()
})

describe('V5-PHOTOFILTERPARITY-001 — the crop facet', () => {
  it('renders once two crops can discriminate, with the top two pinned', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    // Pins are DERIVED (count-descending), not a literal pair: tomato 3 and pepper 2 lead, basil 1
    // sits in the collapsed More tray. Asserting basil's ABSENCE from the collapsed row is what
    // proves the pinning is doing something rather than the row simply listing everything.
    expect(screen.queryByText('Tomato')).toBeTruthy()
    expect(screen.queryByText('Pepper')).toBeTruthy()
    expect(screen.queryByText('Basil'), 'the third crop belongs behind More ▾').toBeNull()
    expect(screen.queryByText('More ▾')).toBeTruthy()
  })

  it('is absent when it could not change the answer', async () => {
    // One crop across every photo: a chip row here can only ever be furniture. Both directions are
    // needed — "always renders" and "never renders" each satisfy one of these two alone.
    await mount([TOM_B, TOM_C])
    await waitFor(() => expect(grid().length).toBe(2))
    expect(screen.queryByTestId('pl-crop-filter')).toBeNull()
  })

  it('is absent — and costs no request — when no photo names a planting at all', async () => {
    await mount([EVENT_ONLY])
    await waitFor(() => expect(grid().length).toBe(1))
    expect(screen.queryByTestId('pl-crop-filter')).toBeNull()
    // The join and the vocabulary are both gated on a photo actually having a plant_id. A page of
    // event photos must not pay 101KB for a list it cannot use.
    const paths = fetchSpy.mock.calls.map(([u]) => String(u))
    expect(paths.some((u) => u.startsWith('/api/plants?view=picker')),
      'the picker projection must not be fetched with nothing to join').toBe(false)
    expect(paths.some((u) => u.startsWith('/api/varieties/crop-types'))).toBe(false)
  })

  it('narrows to the chosen crop across projects, and drops the same-project other crop', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    // INSTRUMENT, before any filter claim: without it every negative below is satisfied by a grid
    // that rendered nothing.
    expect(grid().length, 'the grid rendered nothing — the assertions below prove nothing').toBe(7)
    expect(shows('pepper A'), 'the row we later exclude must be here first').toBe(true)

    await clickText('Tomato')

    expect(shows('tomato A')).toBe(true)
    expect(shows('tomato B'), 'a tomato in another project must survive').toBe(true)
    expect(shows('tomato C')).toBe(true)
    expect(shows('pepper A'), 'a pepper sharing tomato A\'s project must not survive').toBe(false)
    expect(shows('basil A'), 'an unrelated crop must not survive').toBe(false)
    expect(shows('event only'), 'a photo with no planting cannot match a crop chip').toBe(false)
  })

  it('is multi-select OR, not a mode switch', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickText('Pepper')

    expect(shows('tomato B')).toBe(true)
    expect(shows('pepper A')).toBe(true)
    expect(shows('basil A'), 'OR across chips is still a narrowing — basil stays out').toBe(false)
  })
})

describe('V5-PHOTOFILTERPARITY-001 — filters compose', () => {
  it('a crop chip and a mode chip narrow TOGETHER, each still doing its own job', async () => {
    // The parity change. Before this row, tapping a mode chip called setFilterProject('') +
    // selectLocationFilter(''), and either select reset the mode to All — so the second tap always
    // undid the first, silently. Garden's caretaker lens has ANDed with its group-by since
    // V4-ASSIGNLENS-001.
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    expect(grid().length, 'instrument: the crop filter alone leaves three tomatoes').toBe(3)

    await clickTestId('pl-filter-standalone')   // "No event"

    // BOTH predicates are separately observable, which is what makes this more than a smoke test:
    expect(shows('tomato B'), 'right crop AND no event — must survive both').toBe(true)
    expect(shows('tomato C')).toBe(true)
    expect(shows('tomato A'), 'right crop, WRONG mode (it has an event) — the mode still applies')
      .toBe(false)
    expect(shows('pepper B'), 'right mode, WRONG crop — the crop chip still applies').toBe(false)
  })
})

describe('V5-PHOTOFILTERPARITY-001 — sort', () => {
  it('orders the grid newest-first by default and flips on demand', async () => {
    await mount()
    await waitFor(() => expect(grid().length).toBe(7))
    const newest = ['event only', 'tomato B', 'tomato C', 'tomato A', 'pepper B', 'pepper A', 'basil A']
    // The fixture is handed to the page in a scrambled order, so this is a claim about the CLIENT
    // sorting rather than about the wire's order surviving.
    expect(grid()).toEqual(newest)

    await clickText('Oldest')
    expect(grid(), 'Oldest must be the exact reverse, not merely a different order')
      .toEqual([...newest].reverse())

    await clickText('Newest')
    expect(grid()).toEqual(newest)
  })

  it('does not offer to reorder a grid with nothing to reorder', async () => {
    await mount([TOM_B])
    await waitFor(() => expect(grid().length).toBe(1))
    expect(screen.queryByTestId('pl-sort'), 'a one-photo grid has no order to choose').toBeNull()
  })
})

describe('V5-PHOTOFILTERPARITY-001 — the active-filter breadcrumb', () => {
  it('does not render over an unfiltered page', async () => {
    await mount()
    await waitFor(() => expect(grid().length).toBe(7))
    expect(screen.queryByTestId('tag-filter-bar')).toBeNull()
    expect(screen.queryByTestId('pl-filter-cue')).toBeNull()
  })

  it('names every active narrowing and says how much is on screen', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickTestId('pl-filter-standalone')

    const bar = screen.getByTestId('tag-filter-bar')
    expect(bar.textContent).toContain('Tomato')
    expect(bar.textContent).toContain('No event')
    expect(screen.getByTestId('pl-filter-cue').textContent).toBe('2 photos shown')
  })

  it('removing ONE pill lifts only that narrowing', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickTestId('pl-filter-standalone')
    expect(shows('pepper B'), 'instrument: the pepper is excluded before the pill is removed').toBe(false)

    await act(async () => { fireEvent.click(screen.getByLabelText('Remove Tomato')) })

    // The crop narrowing is gone (the pepper is back)…
    expect(shows('pepper B'), 'removing the crop pill must restore the other crops').toBe(true)
    // …and the mode narrowing is NOT — a per-pill remove that quietly cleared everything would pass
    // the assertion above and be wrong.
    expect(shows('tomato A'), 'the event-attached photo must still be excluded by "No event"').toBe(false)
    expect(screen.getByTestId('tag-filter-bar').textContent).toContain('No event')
  })

  it('"Clear all" lifts every axis, and is worded apart from the chip row\'s own narrower Clear', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickTestId('pl-filter-standalone')
    expect(grid().length).toBe(2)
    // TWO clears are on screen with different blast radii — FilterChipRow's (crop chips only) and
    // the bar's (every axis). They must not read identically, or the user is guessing. `getByText`
    // throwing on a duplicate is what caught this in the first place.
    expect(screen.getAllByText('Clear'), 'the row-local Clear must remain, and remain singular')
      .toHaveLength(1)

    await clickText('Clear all')

    await waitFor(() => expect(grid().length).toBe(7))
    expect(screen.queryByTestId('tag-filter-bar')).toBeNull()
  })

  it('the chip row\'s own Clear drops the crops and leaves the mode alone', async () => {
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickTestId('pl-filter-standalone')

    await clickText('Clear')

    expect(shows('pepper B'), 'the crop narrowing is gone').toBe(true)
    expect(shows('tomato A'), 'the mode narrowing is NOT — this Clear is the narrow one').toBe(false)
  })
})

describe('V5-PHOTOFILTERPARITY-001 — the two emptinesses', () => {
  it('tells "nothing matches these filters" apart from "you have no photos"', async () => {
    // "No photos yet / upload your first one" answers "how do I start", which is the wrong question
    // for someone holding a filtered library — it reads as data loss. Harvests draws exactly this
    // line, and the crop chips make the filtered branch newly reachable with a full library behind it.
    await mount()
    await waitFor(() => expect(screen.queryByTestId('pl-crop-filter')).toBeTruthy())
    await clickText('Tomato')
    await clickTestId('pl-filter-untagged')   // every planting photo IS attached — nothing survives

    expect(grid().length).toBe(0)
    expect(screen.queryByTestId('pl-empty-filtered')).toBeTruthy()
    expect(screen.queryByTestId('pl-empty-first-run'), 'a filtered-to-nothing library is not a new one')
      .toBeNull()

    // And the escape hatch in that state actually works — a dead-end empty state is the failure.
    await clickText('Clear filters')
    await waitFor(() => expect(grid().length).toBe(7))
  })

  it('still shows the first-run copy when the library is genuinely empty', async () => {
    await mount([])
    await waitFor(() => expect(screen.queryByTestId('pl-empty-first-run')).toBeTruthy())
    expect(screen.queryByTestId('pl-empty-filtered')).toBeNull()
  })
})
