// V4-PUTUPLINK-001 — the read end of the spine on the planting-detail page.
// Covers: the plant_id-scoped fetch, group flattening (storage label rides down onto each row),
// the never-sum rule (L5), the use-soon row, and the empty state's door — which is the only action this
// read-only section offers (Put-Up R2a, lane K: a button that opens the door on this page, seeded with the
// planting; it used to be a deep-link to the Log form with the planting as prefill).
//
// Put-Up UX pass R1 (lane D, F21 / D13). The section is A LIST AND ONLY A LIST: the headline that counted
// containers, listed units and totalled put-ups is gone, and with it the "N use soon" pill. Each row says
// what the Pantry says about the same jar — its place, how many are left (on EVERY row still there), and
// the discard-date sentence of putup/jarWords.js, tinted when it is soon or past. The tests below that
// pinned the headline now pin its absence and the row's own words; every other assertion is as it was.
// New behaviour (the Pantry's words in full, the tint, the 48 px links) is in PutUpFromPlanting.rows.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// The thumb resolves its image one layer down and renders nothing while that is pending, which would
// hide the alt text this file asserts. A stand-in that renders the alt it is given, only for a photo.
vi.mock('../components/PutUpPhotoThumb.jsx', () => ({
  default: ({ photoId, alt }) => (photoId ? <img alt={alt} data-testid="putup-thumb" /> : null),
}))
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import { doorWhatOf } from '../components/planting/plantingKitchen.js'

const PLANTING = {
  id: 'pl-w2',
  name: 'Dark Green Zucchini',
  variety_id: 'var-dgz',
  variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' },
}

// Two storage groups, deliberately in INCOMPATIBLE units — the headline must list them, never add.
const GROUPED = {
  group_by: 'storage',
  groups: [
    {
      group_key: 'loc-1', label: 'Chest Freezer 1', total_packages: 4, units: ['bags'], use_soon_count: 1,
      records: [
        { id: 'r1', plant_id: 'pl-w2', quantity_value: 6, quantity_unit: 'lbs', package_count: 4,
          remaining_count: 3, method: 'blanch_freeze', preserved_at: '2026-07-10',
          use_by_target: '2027-07-10', use_by_status: 'use_soon' },
      ],
    },
    {
      group_key: 'loc-2', label: 'Pantry', total_packages: 3, units: ['jars'], use_soon_count: 0,
      records: [
        { id: 'r2', plant_id: 'pl-w2', quantity_value: 3, quantity_unit: 'jars', package_count: 3,
          remaining_count: 3, method: 'can_water_bath', preserved_at: '2026-07-18',
          use_by_target: null, use_by_status: null },
      ],
    },
  ],
}

// The clock the date sentence is read against (a year is said only when it is not this one).
const NOW = new Date(2026, 9, 1, 12, 0, 0)
function renderSection(fetchImpl) {
  const fetchMock = vi.fn(fetchImpl)
  const utils = render(
    <MemoryRouter><PutUpFromPlanting planting={PLANTING} fetch={fetchMock} now={NOW} /></MemoryRouter>
  )
  return { ...utils, fetchMock }
}
const rowsLoaded = () => screen.findAllByTestId('putup-from-planting-row')
const details = () => screen.getAllByTestId('putup-from-planting-detail').map(e => e.textContent)

describe('PutUpFromPlanting', () => {
  it('scopes the read to THIS planting, and asks for the consumed rows too', async () => {
    // include_consumed is asserted literally because nothing on screen distinguishes its absence
    // until a jar is actually finished — and at that point the section silently loses the record.
    const { fetchMock } = renderSection(() => Promise.resolve(GROUPED))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?plant_id=pl-w2&include_consumed=1'))
  })

  it('is a list and totals nothing: no container count, no unit list, no count of put-ups — and never a sum (L5)', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    expect(await rowsLoaded()).toHaveLength(2)
    // 4 + 3 packages is 7 containers and 6 lbs + 3 jars is 9 of nothing: neither is printed, nor is any
    // headline that counts (UX pass R1: the section is a list, never a sum).
    const text = document.body.textContent
    expect(text).not.toMatch(/\bcontainers?\b/)
    expect(text).not.toMatch(/\bput-ups?\b/)
    expect(text).not.toMatch(/\b7\b/)
    expect(text).not.toMatch(/\b9\b/)
    // Each row still says its own size, in its own unit.
    expect(screen.getAllByTestId('putup-from-planting-head').map(e => e.textContent))
      .toEqual(['3 jars in all · Water-bath can', '6 lbs in all · Blanch & freeze'])
  })

  it('marks the row to use soon on its own date line, in the Pantry\'s words — no "N use soon" rollup', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    await rowsLoaded()
    const lines = screen.getAllByTestId('putup-from-planting-discard')
    expect(lines.map(l => l.textContent)).toEqual(['discard by Jul 10, 2027 · soon'])     // r1; r2 has no date and says nothing
    expect(lines[0].dataset.soon).toBe('true')
    expect(screen.queryByText(/use soon/)).toBeNull()
  })

  it('carries each group\'s storage label down onto its rows', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    await rowsLoaded()
    expect(screen.getByText(/Chest Freezer 1/)).toBeTruthy()
    expect(screen.getByText(/Pantry/)).toBeTruthy()
  })

  it('says how many are left on EVERY row still there, not only where it differs from the package count', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    await rowsLoaded()
    // r2: 3 of 3 (it used to say nothing); r1: 3 of 4.
    expect(details()).toEqual(['Pantry · 3 left · put up Jul 18, 2026', 'Chest Freezer 1 · 3 left · put up Jul 10, 2026'])
  })

  it('empty state offers the door seeded with the planting, crop and variety — a button, never a link', async () => {
    renderSection(() => Promise.resolve({ group_by: 'storage', groups: [] }))
    const button = await screen.findByRole('button', { name: /Put something up from this planting/i })
    expect([button.tagName, button.getAttribute('href'), button.getAttribute('type')]).toEqual(['BUTTON', null, 'button'])
    expect(screen.queryByRole('link')).toBeNull()
    // The planting rides into the door as its What (the door is opened in place; nothing travels in router state).
    expect(doorWhatOf(PLANTING)).toEqual({ source: 'planting', name: 'Dark Green Zucchini', plant_id: 'pl-w2', crop_type_slug: 'squash', variety_id: 'var-dgz' })
    expect(screen.getByText(/Nothing put up from this planting yet\./)).toBeTruthy()
  })

  it('degrades to a quiet message when the read fails — never blanks the page', async () => {
    renderSection(() => Promise.reject(new Error('boom')))
    // Curly apostrophes (&rsquo;) in the copy — match loosely rather than assert typography.
    expect(await screen.findByText(/Couldn.t load what.s put up/)).toBeTruthy()
  })

  it('handles a group payload with no records array', async () => {
    renderSection(() => Promise.resolve({ groups: [{ group_key: 'x', label: 'X' }] }))
    expect(await screen.findByText(/Nothing put up from this planting yet\./)).toBeTruthy()
  })
})

// V4-HARVESTFATE-001 — the fate reading. This section is the ONLY surface that answers "where did
// this planting's harvest go", and the endpoint's default filter drops a fully-consumed jar. Every
// case below is invisible on today's data (5 of 5 live put-ups still have stock, prod 2026-08-24)
// and becomes the normal case the first time Dave finishes one.
describe('PutUpFromPlanting — consumed put-ups are fate, not stock', () => {
  const one = (over) => ({
    group_by: 'storage',
    groups: [{
      group_key: 'loc-1', label: 'Chest Freezer 1', total_packages: 4, units: ['quarts'], use_soon_count: 0,
      records: [
        { id: 'live', plant_id: 'pl-w2', quantity_value: 2, quantity_unit: 'quarts', package_count: 2,
          remaining_count: 2, method: 'whole_freeze', preserved_at: '2026-07-20', use_by_target: null },
        { id: 'gone', plant_id: 'pl-w2', quantity_value: 1, quantity_unit: 'quarts', package_count: 2,
          remaining_count: 0, method: 'passata', preserved_at: '2026-06-01',
          use_by_target: '2026-09-01', use_by_status: 'use_soon', ...over },
      ],
    }],
  })

  it('LISTS a used-up put-up rather than dropping it — the history is the answer', async () => {
    renderSection(() => Promise.resolve(one()))
    expect(await rowsLoaded()).toHaveLength(2)
    expect(screen.getByText(/all used/)).toBeTruthy()
  })

  it('an empty jar is not stock: it says "all used", never a count left, and the row still there says its own', async () => {
    renderSection(() => Promise.resolve(one()))
    await rowsLoaded()
    // 2 in the freezer; the other row was 2 and is gone — no line adds them up, and none says "0 left".
    expect(details()).toEqual(['Chest Freezer 1 · 2 left · put up Jul 20, 2026', 'Chest Freezer 1 · all used · put up Jun 1, 2026'])
    expect(document.body.textContent).not.toMatch(/\b[04] left\b|\bcontainers?\b/)
  })

  it('lists the used row AFTER what is still there, dimmed — and counts neither', async () => {
    // 'gone' is given the LATER put-up day, so the newest-first sort alone would put it first: the order is
    // "still there, then used", whatever the dates say.
    renderSection(() => Promise.resolve(one({ preserved_at: '2026-08-15' })))
    const rows = await rowsLoaded()
    expect(rows.map(r => [r.dataset.used ?? 'still there', r.style.opacity])).toEqual([['still there', '1'], ['true', '0.62']])
    expect(details()).toEqual(['Chest Freezer 1 · 2 left · put up Jul 20, 2026', 'Chest Freezer 1 · all used · put up Aug 15, 2026'])
    expect(document.body.textContent).not.toMatch(/\bput-ups?\b|used up/)
  })

  it('never prompts "use soon" for a jar that has already been eaten', async () => {
    renderSection(() => Promise.resolve(one()))
    await rowsLoaded()
    // 'gone' carries a date and a use_soon status from the server; it is finished, so no date line at all.
    expect(screen.queryAllByTestId('putup-from-planting-discard')).toHaveLength(0)
    expect(screen.queryByText(/use soon/)).toBeNull()
    expect(screen.queryByText(/use by/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/soon|discard/)
  })

  it('a planting whose stores are all gone still shows what it produced', async () => {
    const allGone = one()
    allGone.groups[0].records = allGone.groups[0].records.filter(r => r.id === 'gone')
    renderSection(() => Promise.resolve(allGone))
    // NOT the "nothing put up yet" empty state — that would erase a real record.
    expect(await rowsLoaded()).toHaveLength(1)
    expect(screen.queryByText(/Nothing put up from this planting yet\./)).toBeNull()
    expect(screen.getByText(/all used/)).toBeTruthy()
    // …and it still offers the one action the section has.
    expect(screen.getByRole('button', { name: 'Put up more from this planting' })).toBeTruthy()
  })

  // NULL means the count was never tracked, not that the jar is gone. The endpoint's own default
  // filter reads it the same way, so a row it WOULD have returned must not be dimmed out here.
  it('treats a NULL remaining_count as still in the Pantry, not as used up', async () => {
    const untracked = one()
    untracked.groups[0].records = [{
      id: 'untracked', plant_id: 'pl-w2', quantity_value: 3, quantity_unit: 'quarts',
      package_count: 3, remaining_count: null, method: 'whole_freeze', preserved_at: '2026-07-20',
    }]
    renderSection(() => Promise.resolve(untracked))
    await rowsLoaded()
    expect(details()).toEqual(['Chest Freezer 1 · 3 left · put up Jul 20, 2026'])
    expect(screen.queryByText(/all used/)).toBeNull()
  })
})

// Put-Up release F — a jar may have NO size (the quantity pair is NULL: Put it up's "no size" rows and
// every F bottling written without one), and a quantity is the row's TOTAL (contract-F A3). This row
// used to print the pair raw: "null null" as the headline and "Photo of null put up" as the thumb's
// alt. It now says what the put-up list says, through jarWords.
// MUTATION: print `{r.quantity_value} {r.quantity_unit}` again -> the headline arms red; build the alt
// from quantity_unit again -> the alt arms red.
describe('PutUpFromPlanting — a jar with no size, and a size that is a total', () => {
  const rows = (...records) => ({ group_by: 'storage', groups: [{ group_key: 'loc-f', label: 'Fridge', records }] })
  const base = { plant_id: 'pl-w2', remaining_count: null, preserved_at: '2026-10-08', use_by_target: null }
  const heads = () => screen.getAllByTestId('putup-from-planting-head').map(e => e.textContent)

  it('a bottled jar with no size reads as its name and its container, never "null"', async () => {
    renderSection(() => Promise.resolve(rows({ ...base, id: 'b1', label: 'Megatron plain', container_label: '8 oz woozy',
      quantity_value: null, quantity_unit: null, package_count: 2, method: 'hot_sauce', photo_id: 'ph-1' })))
    await rowsLoaded()
    expect(heads()).toEqual(['Megatron plain · 8 oz woozy · Hot sauce'])
    expect(screen.getByTestId('putup-thumb').getAttribute('alt')).toBe('Photo of Megatron plain · 8 oz woozy')
    expect(document.body.textContent).not.toMatch(/null|undefined/)
  })

  it('a jar with no size, no name and no container reads as its method alone', async () => {
    renderSection(() => Promise.resolve(rows({ ...base, id: 'b2', label: null, container_label: null,
      quantity_value: null, quantity_unit: null, package_count: 1, method: 'ferment', photo_id: 'ph-2' })))
    await rowsLoaded()
    expect(heads()).toEqual(['Ferment'])
    expect(screen.getByTestId('putup-thumb').getAttribute('alt')).toBe('Photo of ferment')
    expect(document.body.textContent).not.toMatch(/null|undefined/)
  })

  // The zucchini as the driver returns it: numeric(10,2) "2.50" over three containers is 2.5 qt IN ALL.
  it('a size over several containers is said as the total, the way the column holds it', async () => {
    renderSection(() => Promise.resolve(rows({ ...base, id: 'z1', label: null, container_label: null,
      quantity_value: '2.50', quantity_unit: 'qt', package_count: 3, remaining_count: 3, method: 'whole_freeze' })))
    await rowsLoaded()
    expect(heads()).toEqual(['2.5 qt in all · Freeze'])
  })
})
