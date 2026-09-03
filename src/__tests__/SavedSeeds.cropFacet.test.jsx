// V5-SEEDSAVEDFILTER-001 — the crop facet on the untracked-packet picker.
//
// WHAT THIS EXISTS TO PROVE, and why the fixture is shaped the way it is. A filter test that mounts
// only-tomato rows and asserts "filtering by tomato shows the tomato rows" is green by construction:
// it passes against a predicate that is always true, against one that ignores its argument, and
// against one that filters on entirely the wrong field. Every assertion below therefore carries a
// NEGATIVE — a row that must disappear — and at least one of those negatives shares a property with
// the row that stays, so that a predicate keying on the wrong column cannot satisfy it.
//
// THE MEASUREMENT BEHIND THE FEATURE, so a later reader can tell whether it still holds. On prod
// 2026-09-03: 263 seed rows, 260 untracked, crop_type_slug populated on 263/263 across 62 distinct
// crops, with pepper 95 + tomato 40 = 51% and 30 slugs holding exactly one row. AND: 232 of those
// 263 rows already contain their own crop word somewhere in the text the search box matches. So the
// facet's real work is the ~31 that do not — which is why `hidden-by-name` below carries a crop word
// nowhere in its name, variety_name or source, and is reachable ONLY by the chip.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const packet = (over = {}) => ({
  id: 'inv-x', name: 'Packet', variety_name: 'Packet', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1,
  variety_id: 'v-x', seed_stage: null, seed_process: null, source_plant_id: null,
  source: null, purchase_date: null, stage_entered_at: null, crop_slug: 'tomato',
  ...over,
})

// THE FACET ONLY RENDERS OVER A LIST LONG ENOUGH TO NEED IT — the gate is
// `untracked.length > MAX_CANDIDATES` (25), snapshot when the sheet opens. So padding past 25 is not
// fixture inflation, it is the precondition.
//
// THE PADDING'S SHAPE IS LOad-BEARING AND WAS GOT WRONG FIRST TIME. The pinned chips are DERIVED —
// the two crops with the most packets — so a flat block of 24 identical-crop padding silently made
// THAT crop the top of the collection and pushed pepper into the collapsed `More ▾` tray, where
// getByText could not see it. The fixture therefore mirrors the real distribution instead: two
// dominant crops and a tail of singletons (prod: pepper 95, tomato 40, then 60 crops of ≤7, with 30
// holding exactly one). A test whose fixture does not share the shape of the data cannot exercise a
// control whose behaviour is derived from that shape.
const PAD = [
  ...Array.from({ length: 12 }, (_, n) =>
    packet({ id: `pad-p-${n}`, name: `Chile ${n}`, variety_name: `Chile ${n}`, crop_slug: 'pepper' })),
  ...Array.from({ length: 6 }, (_, n) =>
    packet({ id: `pad-t-${n}`, name: `Slicer ${n}`, variety_name: `Slicer ${n}`, crop_slug: 'tomato' })),
  // The tail. A third crop, so that "everything that is not tomato is pepper" cannot accidentally
  // satisfy an assertion, and so the negatives below have something unrelated to catch.
  // FIVE, not eight, and the number is load-bearing: with eight, lettuce TIED tomato at 8 apiece and
  // the deterministic alphabetical tiebreak put `lettuce` in the second pinned slot, so the Tomato
  // chip was sitting in the collapsed tray where getByText could not reach it. The tail must stay
  // strictly smaller than both dominant crops or this fixture stops exercising what it claims to.
  ...Array.from({ length: 5 }, (_, n) =>
    packet({ id: `pad-l-${n}`, name: `Leaf ${n}`, variety_name: `Leaf ${n}`, crop_slug: 'lettuce' })),
]

const NAMED_TOMATO = packet({
  id: 'named-tomato', name: 'Tomato — Brandywine', variety_name: 'Tomato — Brandywine',
  crop_slug: 'tomato',
})
// The row the whole feature is for: a tomato packet whose text says "tomato" NOWHERE. Typing
// "tomato" cannot reach it; the chip must.
// ITS NAME MUST BE UNIQUE IN THE FIXTURE, and that is not fussiness — the first version called it
// 'Brandywine', which is a SUBSTRING of NAMED_TOMATO's 'Tomato — Brandywine'. The assertion
// `shows('Brandywine')` was then satisfied by the OTHER row, so a predicate keyed on row text
// instead of on crop_slug passed all seven tests. Caught by mutation, not by review.
const HIDDEN_TOMATO = packet({
  id: 'hidden-by-name', name: 'Cherokee Purple', variety_name: 'Cherokee Purple', crop_slug: 'tomato',
})
// The critical negative: a PEPPER that shares the word "Brandywine" with NAMED_TOMATO, so a
// predicate keyed on row text rather than on crop_slug keeps it under a tomato filter and reds.
// Its own needle ('Brandywine Pepper') is unique, so the negative cannot be satisfied by a sibling —
// the same trap that made this file's first version pass against the wrong implementation.
const PEPPER_SHARING_A_NAME = packet({
  id: 'pepper-brandywine', name: 'Brandywine Pepper', variety_name: 'Brandywine Pepper',
  crop_slug: 'pepper',
})

const ALL = [NAMED_TOMATO, HIDDEN_TOMATO, PEPPER_SHARING_A_NAME, ...PAD]

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/varieties/crop-types')) {
      return Promise.resolve([
        { slug: 'tomato', display_name: 'Tomato' },
        { slug: 'pepper', display_name: 'Pepper' },
        { slug: 'lettuce', display_name: 'Lettuce' },
      ])
    }
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

const click = async (testId) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)) })
}
const clickText = async (label) => {
  await act(async () => { fireEvent.click(screen.getByText(label)) })
}
const openPicker = async () => { await click('track-a-lot') }
const rowText = () =>
  screen.queryAllByTestId('track-candidate').map((b) => b.textContent)
const shows = (needle) => rowText().some((t) => t.includes(needle))

beforeEach(() => { fetchSpy.mockReset() })

describe('V5-SEEDSAVEDFILTER-001 — crop facet on the packet picker', () => {
  // BOTH directions, as two tests rather than one. A single test that mounted twice left two pages
  // in the DOM and `getByText('Saved seeds')` threw on the duplicate — which reads like a facet bug
  // and is not one. Either direction alone is satisfied by a control that never renders (or one that
  // always does), so both are required; they just cannot share a mount.
  it('does NOT render the facet over a list short enough to read', async () => {
    // The threshold is the truncation cap: below it every packet is already on screen, so a filter
    // would be furniture over a list you can simply scroll.
    await mount([NAMED_TOMATO, HIDDEN_TOMATO, PEPPER_SHARING_A_NAME])
    await openPicker()
    expect(screen.queryAllByTestId('track-candidate').length, 'instrument: the picker did render')
      .toBe(3)
    expect(screen.queryByTestId('candidate-crop-filter'), 'short list must not render the facet')
      .toBeNull()
  })

  it('renders the facet once the list is long enough to hide rows from you', async () => {
    await mount(ALL)
    await openPicker()
    expect(screen.queryByTestId('candidate-crop-filter'), 'long list must render the facet')
      .toBeTruthy()
  })

  it('narrows to the chosen crop — including the packet whose name never says the crop', async () => {
    await mount(ALL)
    await openPicker()

    // INSTRUMENT CHECK, before any filter claim. Without it every assertion below is satisfiable by
    // a sheet that rendered nothing at all: `[].some(...)` is false, so all three negatives would
    // "pass" against a blank screen.
    expect(rowText().length, 'picker rendered no rows — the assertions below prove nothing')
      .toBeGreaterThan(1)
    expect(shows('Brandywine Pepper'), 'unfiltered list must contain the row we later exclude')
      .toBe(true)

    await clickText('Tomato')

    expect(shows('Tomato — Brandywine')).toBe(true)
    // THE POINT OF THE FEATURE, and the assertion that discriminates a crop_slug predicate from a
    // text one: this row is a tomato whose text says "tomato" nowhere, so only the joined column can
    // keep it. The needle is unique to this row for the reason given at its definition.
    expect(shows('Cherokee Purple'), 'the tomato whose text never says tomato must survive the filter')
      .toBe(true)
    // Same discrimination on the bulk rows: a text predicate drops all six 'Slicer N' tomatoes too.
    expect(shows('Slicer 0'), 'a tomato named Slicer must survive a tomato filter').toBe(true)
    // THE NEGATIVE THAT MAKES THE TEST REAL. This row shares "Brandywine" with the row above, so a
    // predicate keyed on row text keeps it and reds here.
    expect(shows('Brandywine Pepper'), 'a pepper must not survive a tomato filter')
      .toBe(false)
    // A second negative on an unrelated crop, so a predicate that merely excludes 'pepper' also reds.
    expect(shows('Leaf 0'), 'a lettuce must not survive a tomato filter').toBe(false)
  })

  it('is multi-select OR, not a mode switch', async () => {
    // Single-select would make the two most common crops mutually exclusive — on prod, pepper and
    // tomato together are 51% of the collection, so that is the query most worth being able to ask.
    await mount(ALL)
    await openPicker()
    await clickText('Tomato')
    await clickText('Pepper')

    expect(shows('Tomato — Brandywine')).toBe(true)
    expect(shows('Brandywine Pepper')).toBe(true)
    expect(shows('Leaf 0'), 'lettuce is still excluded — OR across chips, not "show everything"')
      .toBe(false)
  })

  it('combines with the text box rather than replacing it', async () => {
    await mount(ALL)
    await openPicker()
    await clickText('Tomato')
    await act(async () => {
      fireEvent.change(screen.getByTestId('candidate-filter'), { target: { value: 'Brandywine' } })
    })
    // Both predicates applied: the pepper is excluded by the chip, the padding by the text.
    expect(shows('Tomato — Brandywine')).toBe(true)
    expect(shows('Brandywine Pepper')).toBe(false)
    expect(shows('Leaf 0')).toBe(false)
  })

  it('says WHICH emptiness it is — three branches, never `matches ""`', async () => {
    // Before the facet this branch was unreachable with an empty box, because a blank query
    // short-circuits to the full set. The chip makes it reachable, and the naive copy would render
    // the literal `No packet matches ""` — a sentence naming neither the cause nor the way out.
    await mount(ALL)
    await openPicker()
    await act(async () => {
      fireEvent.change(screen.getByTestId('candidate-filter'), { target: { value: 'zzzz' } })
    })
    expect(screen.getByTestId('candidate-no-match').textContent).toContain('No packet matches')

    // chip only, no query
    await act(async () => {
      fireEvent.change(screen.getByTestId('candidate-filter'), { target: { value: '' } })
    })
    await clickText('Pepper')
    await act(async () => {
      fireEvent.change(screen.getByTestId('candidate-filter'), { target: { value: 'zzzz' } })
    })
    const both = screen.getByTestId('candidate-no-match').textContent
    expect(both).toContain('Pepper')
    expect(both).toContain('zzzz')
    expect(both, 'the empty-query artefact must never render').not.toContain('“”')
  })

  it('forgets the chip when the sheet closes, the way it forgets the query', async () => {
    // The argument is STRONGER for a chip than for typed text: the text is visibly sitting in the
    // box when you reopen, while a selected chip is easy to scroll past — a stale narrowing that
    // hides the very packet you came back for.
    await mount(ALL)
    await openPicker()
    await clickText('Pepper')
    expect(shows('Leaf 0')).toBe(false)

    await act(async () => { fireEvent.click(screen.getByLabelText('Close')) })
    await openPicker()
    expect(shows('Leaf 0'), 'reopening must not land on a stale crop narrowing').toBe(true)
  })
})

// ── The PAGE-level crop filter (second pass) ─────────────────────────────────────────────────────
// Dave looked for a filter on the page twice and did not find it, because the first pass put it only
// inside the track-a-lot sheet. His rule: "there is no point in having to click to get to a
// search/sort/filter." These cover the inline control AND the one row it must never hide.
const lot = (over = {}) => packet({
  seed_stage: 'stored', seed_process: 'dry', stage_entered_at: daysAgo(30), ...over,
})
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

describe('V5-SEEDSAVEDFILTER-001 — the crop filter on the page itself', () => {
  const TOM_A = lot({ id: 'l-tom-a', name: '1884', variety_name: '1884', crop_slug: 'tomato' })
  const TOM_B = lot({ id: 'l-tom-b', name: 'Ukrainian Purple', variety_name: 'Ukrainian Purple', crop_slug: 'tomato' })
  const MELON = lot({ id: 'l-melon', name: 'Sugar Baby', variety_name: 'Sugar Baby', crop_slug: 'watermelon' })
  // Dave's real prod shape on 2026-09-03: tomato x2 + watermelon x1, all stored.
  const LOTS = [TOM_A, TOM_B, MELON]

  const cardText = () =>
    screen.queryAllByTestId('seed-lot-card').map((c) => c.textContent)
  const cardShows = (n) => cardText().some((t) => t.includes(n))

  it('renders INLINE, with no tap to reach it', async () => {
    await mount(LOTS)
    // The control is present on first paint — not after opening a sheet, which is the whole point.
    expect(screen.queryByTestId('tracked-crop-filter'), 'filter must be on the page, not behind a tap')
      .toBeTruthy()
    expect(cardText().length, 'instrument: the lots rendered').toBe(3)
  })

  it('is absent when it could not change the answer', async () => {
    // One crop across every lot: a chip row here can only ever be furniture.
    await mount([TOM_A, TOM_B])
    expect(cardText().length, 'instrument: the lots rendered').toBe(2)
    expect(screen.queryByTestId('tracked-crop-filter')).toBeNull()
  })

  it('narrows the lots, and the negative is a lot of a different crop', async () => {
    await mount(LOTS)
    expect(cardShows('Sugar Baby'), 'instrument: the row we exclude is there first').toBe(true)
    await clickText('Tomato')
    expect(cardShows('1884')).toBe(true)
    expect(cardShows('Ukrainian Purple')).toBe(true)
    expect(cardShows('Sugar Baby'), 'a watermelon must not survive a tomato filter').toBe(false)
  })

  it('NEVER hides an overdue ferment, and says why it is still there', async () => {
    // THE SAFETY TEST. fermentUrgency alarms at 5 days and this page carries the only overdue-ferment
    // warning in the app — past that point the seed sprouts in the jar and the lot is finished. A
    // filter that hides it is doing exactly what was asked and costing a lot.
    const ALARM = lot({
      id: 'l-alarm', name: 'Gong Bao', variety_name: 'Gong Bao', crop_slug: 'pepper',
      seed_stage: 'fermenting', seed_process: 'wet', stage_entered_at: daysAgo(7),
    })
    await mount([...LOTS, ALARM])
    expect(cardShows('Gong Bao'), 'instrument: the alarming lot rendered').toBe(true)

    await clickText('Tomato')
    expect(cardShows('Sugar Baby'), 'the ordinary non-match is gone').toBe(false)
    expect(cardShows('Gong Bao'), 'an alarming ferment must survive its own exclusion').toBe(true)
    expect(screen.getByTestId('tracked-urgent-kept').textContent)
      .toContain('outside this filter')
  })

  it('tells "no lots match" apart from "you have no lots"', async () => {
    await mount(LOTS)
    await clickText('Watermelon')
    expect(cardShows('Sugar Baby')).toBe(true)
    expect(cardShows('1884')).toBe(false)
    // And the teaching empty state must NOT appear — it answers "how do I start", which is the wrong
    // question for someone who has three lots and a filter on.
    expect(screen.queryByTestId('saved-seeds-empty')).toBeNull()
  })
})

// ── V5-SEEDYEARHARVESTED-001 — the harvest year a lot already knows ──────────────────────────────
import { yearHarvestedPatch } from '../pages/SavedSeeds.jsx'

describe('V5-SEEDYEARHARVESTED-001 — year_harvested on the move to stored', () => {
  it('records the year from the entered date, not from the clock', () => {
    // Backdating a lot to last autumn is supported on this sheet. Reading `now` would file a lot
    // stored in January under the wrong season, which is precisely the mistake the column exists to
    // let you avoid.
    expect(yearHarvestedPatch({ year_harvested: null }, 'stored', '2025-10-04'))
      .toEqual({ year_harvested: 2025 })
  })

  it('NEVER overwrites a year that is already there', () => {
    // THE LANDMINE. Four prod rows carry a curated year, one of them Jen's 1986 Edelweiss from
    // Austria, and this patch travels through the WIDE PUT where every key present is assigned
    // unconditionally. Returning {} is the only way to say "leave it alone" — a null or the current
    // year would both destroy it.
    expect(yearHarvestedPatch({ year_harvested: 1986 }, 'stored', '2026-09-03')).toEqual({})
  })

  it('writes nothing on the in-flight stages', () => {
    // A lot still fermenting has no harvest year yet — it may not finish this year at all.
    expect(yearHarvestedPatch({ year_harvested: null }, 'fermenting', '2026-09-03')).toEqual({})
    expect(yearHarvestedPatch({ year_harvested: null }, 'drying', '2026-09-03')).toEqual({})
  })

  it('writes nothing rather than a wrong number when the date is unusable', () => {
    for (const bad of ['', null, undefined, 'not-a-date', '0042-01-01']) {
      expect(yearHarvestedPatch({ year_harvested: null }, 'stored', bad)).toEqual({})
    }
  })
})
