// V5-SEEDSTAB-001 — the Seeds shell: which view a door lands on, how the view lives in the URL, and
// what the shell owns (the seed rows, the ferment line, Save seed, the stale band).
//
// A REAL data router, not a stubbed one, because the behaviours under test ARE history behaviours:
// whether the default view was written with REPLACE before any body mounted, whether a switch
// replaces, whether one Back leaves the page. A MemoryRouter test that could not see the history
// action would pass whichever way those went.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy, saveSheetProps } = vi.hoisted(() => ({ fetchSpy: vi.fn(), saveSheetProps: { current: null } }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: (v) => !!v && typeof v === 'object' && v[Symbol.for('garden-app.fromCache')] === true,
}))
// The sheet is its own suite's subject; here only the CONTRACT the shell hands it matters — no
// planting (so the F1 notice keys on the picked variety) and an onSaved that confirms in place.
vi.mock('../components/planting/SaveSeedSheet.jsx', () => ({
  default: (props) => { saveSheetProps.current = props; return <div data-testid="save-seed-sheet-stub" /> },
  SeedCountBasis: () => null,
}))

import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import Seeds, { defaultSeedsView } from '../pages/Seeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { writeDraft, clearDraft } from '../lib/draftStash.js'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

const lot = (over = {}) => ({
  id: 'lot-x', name: 'Brandywine — saved 2026', variety_name: 'Brandywine', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1, variety_id: 'v-b',
  crop_slug: 'tomato', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null,
  source_id: null, stage_entered_at: null, seed_count: null, seed_weight_g: null, created_at: '2026-07-01T12:00:00Z',
  ...over,
})
const FERMENTING = lot({ id: 'lot-ferm', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', seed_stage: 'fermenting', seed_process: 'wet', stage_entered_at: daysAgo(1) })
const DRYING = lot({ id: 'lot-dry', name: 'Gong Bao — saved 2026', variety_name: 'Gong Bao', crop_slug: 'pepper', seed_stage: 'drying', stage_entered_at: daysAgo(3) })
const STORED = lot({ id: 'lot-stored', seed_stage: 'stored', stage_entered_at: daysAgo(20) })
const BOUGHT = lot({ id: 'pkt-1', name: 'Sungold', variety_name: 'Sungold', quantity_on_hand: 2 })

let seedRows
let seedResponse   // optional override: a function returning the promise for the seed list
let candidates     // sow-candidates items
let candidatesResponse   // optional override: a function returning the promise for sow-candidates

beforeEach(() => {
  fetchSpy.mockReset()
  saveSheetProps.current = null
  seedRows = [BOUGHT]
  seedResponse = null
  candidates = []
  candidatesResponse = null
  clearDraft('sow-now')
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/inventory-items?category=seeds')) return seedResponse ? seedResponse() : Promise.resolve(seedRows)
    if (p.startsWith('/api/inventory-items/sow-candidates')) return candidatesResponse ? candidatesResponse() : Promise.resolve({ items: candidates })
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

// `beforeRender(router)` runs before the first render — the one place a router.subscribe can go and be
// sure it runs ahead of the RouterProvider's own subscription (which re-renders the page).
function mount(entries = ['/seeds'], initialIndex = entries.length - 1, { beforeRender } = {}) {
  const router = createMemoryRouter(
    [
      { path: '/seeds', element: <ToastProvider><Seeds /></ToastProvider> },
      { path: '/today', element: <div data-testid="today" /> },
      { path: '/inventory/add', element: <div data-testid="add-form" /> },
      { path: '/inventory/:id', element: <div data-testid="detail" /> },
    ],
    { initialEntries: entries, initialIndex },
  )
  beforeRender?.(router)
  render(<RouterProvider router={router} />)
  return router
}
const search = (router) => router.state.location.search
const seedGets = () => fetchSpy.mock.calls.filter(([p, o]) => String(p).startsWith('/api/inventory-items?category=seeds') && !o?.method).length
const VIEW_BODY = '[data-testid="my-seeds-view"],[data-testid="saved-seeds-view"],[data-testid="sow-now-view"]'

describe('defaultSeedsView — the rule a bare /seeds lands by (§4.2)', () => {
  it('is Saved seeds while any lot is fermenting OR drying, else My seeds; never Sow now', () => {
    expect(defaultSeedsView([FERMENTING, BOUGHT])).toBe('saved')
    expect(defaultSeedsView([DRYING, STORED])).toBe('saved')
    expect(defaultSeedsView([STORED, BOUGHT])).toBe('mine')
    expect(defaultSeedsView([])).toBe('mine')
    // Not loaded yet: no answer. Failed: My seeds, which shows the error with Retry.
    expect(defaultSeedsView(null, null)).toBe(null)
    expect(defaultSeedsView(null, 'boom')).toBe('mine')
    for (const rows of [[], [FERMENTING], [DRYING], [STORED], [BOUGHT]]) expect(defaultSeedsView(rows)).not.toBe('sow')
  })
})

describe('Seeds — the default view is settled once, in the URL, before a body mounts', () => {
  const cases = [
    ['no seed at all', [], 'mine', 'my-seeds-view'],
    ['one lot fermenting', [FERMENTING, BOUGHT], 'saved', 'saved-seeds-view'],
    ['only drying and stored', [DRYING, STORED], 'saved', 'saved-seeds-view'],
    ['stored and bought only', [STORED, BOUGHT], 'mine', 'my-seeds-view'],
  ]
  for (const [name, rows, view, body] of cases) {
    it(`${name} → ?view=${view}, written with REPLACE`, async () => {
      seedRows = rows
      const router = mount()
      await waitFor(() => expect(search(router)).toBe(`?view=${view}`))
      expect(router.state.historyAction).toBe('REPLACE')
      await waitFor(() => expect(screen.getByTestId(body)).toBeTruthy())
    })
  }

  it('a failed load lands on My seeds with the error and a Retry', async () => {
    seedResponse = () => Promise.reject(new Error('network down'))
    const router = mount()
    await waitFor(() => expect(search(router)).toBe('?view=mine'))
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('a failure with an EMPTY message lands there too — never an endless spinner with no Retry', async () => {
    // api.js builds its Error from the body's `error`, falling back to `HTTP <status>` only on null: a
    // non-JSON error body with an empty statusText (HTTP/2 has none) or `{"error":""}` gives Error('').
    // An empty-string error is falsy, so the default rule read it as "still loading" and bare /seeds
    // never settled; the store has to turn it into a message.
    seedResponse = () => Promise.reject(new Error(''))
    const router = mount()
    await waitFor(() => expect(search(router)).toBe('?view=mine'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy())
    expect(screen.getByText('Could not load your seed inventory.')).toBeTruthy()
  })

  it('Sow now: a candidates failure with an EMPTY message says it failed — never "No seed packets yet"', async () => {
    // Same Error('') as above, on Sow now's own fetch (lane T4): `??` kept the '' and the page rendered
    // its empty state, so a failed load read as "you have no seed".
    candidatesResponse = () => Promise.reject(new Error(''))
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Failed to load sow candidates'))
    expect(screen.queryByText('No seed packets yet')).toBeNull()
  })

  it('mounts NO view body while the rows are still loading (the URL is written first)', async () => {
    let release
    seedResponse = () => new Promise((r) => { release = r })
    const router = mount()
    await waitFor(() => expect(screen.getByTestId('seeds-view-switch')).toBeTruthy())
    expect(screen.queryByTestId('my-seeds-view')).toBeNull()
    expect(screen.queryByTestId('saved-seeds-view')).toBeNull()
    expect(screen.queryByTestId('sow-now-view')).toBeNull()
    expect(search(router)).toBe('')
    await act(async () => { release([FERMENTING]) })
    await waitFor(() => expect(search(router)).toBe('?view=saved'))
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
  })

  // The case above watches the loading window, where a page that rendered the body from the computed
  // default at once and wrote the URL in an effect afterwards ALSO mounts nothing — so it cannot tell
  // the two apart. The difference only exists at the moment the replace lands: the router's own
  // subscription records, for every state it publishes, whether a view body was already in the DOM.
  for (const [name, rows, view, body] of [
    ['one lot fermenting', [FERMENTING], 'saved', 'saved-seeds-view'],
    ['bought packets only', [BOUGHT], 'mine', 'my-seeds-view'],
  ]) {
    it(`${name}: ?view=${view} is in the URL before any view body is in the DOM`, async () => {
      seedRows = rows
      const log = []
      mount(['/today', '/seeds'], 1, {
        beforeRender: (r) => r.subscribe((state) => log.push({
          action: state.historyAction,
          search: state.location.search,
          bodyInDom: !!document.querySelector(VIEW_BODY),
        })),
      })
      await waitFor(() => expect(screen.getByTestId(body)).toBeTruthy())
      const settled = log.find((e) => e.search.startsWith('?view='))
      expect(settled, 'the router never published a ?view= state').toBeTruthy()
      expect(settled).toEqual({ action: 'REPLACE', search: `?view=${view}`, bodyInDom: false })
    })
  }

  it('a door that names a view wins over the ferment rule, and nothing rewrites it', async () => {
    seedRows = [FERMENTING]
    const router = mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    expect(search(router)).toBe('?view=mine')
    expect(router.state.historyAction).toBe('POP')   // the initial entry, never replaced
  })

  it('an unknown or mis-cased view falls through to the default rule', async () => {
    seedRows = [FERMENTING]
    const router = mount(['/seeds?view=Saved'])
    await waitFor(() => expect(search(router)).toBe('?view=saved'))
    cleanup()
    seedRows = []
    const r2 = mount(['/seeds?view=garbage'])
    await waitFor(() => expect(search(r2)).toBe('?view=mine'))
  })
})

describe('Seeds — a bare /seeds while the page is already mounted', () => {
  it('More → Seeds from inside Seeds settles the view again instead of loading forever', async () => {
    seedRows = [BOUGHT]
    // Arrive the way the More row does — a BARE /seeds, which the page settles once — then move on.
    const router = mount(['/seeds'])
    await waitFor(() => expect(search(router)).toBe('?view=mine'))
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Sow now' })) })
    await waitFor(() => expect(screen.getByTestId('sow-now-view')).toBeTruthy())
    // More → Seeds again: the row's href is the bare path, and the page stays mounted across it.
    await act(async () => { router.navigate('/seeds') })
    await waitFor(() => expect(search(router)).toBe('?view=mine'))
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
  })
})

describe('Seeds — switching views', () => {
  it('writes ?view with REPLACE, so after three switches one Back leaves the page', async () => {
    seedRows = [BOUGHT]
    const router = mount(['/today', '/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    const radio = (label) => screen.getByRole('radio', { name: label })
    await act(async () => { fireEvent.click(radio('Saved seeds')) })
    expect(search(router)).toBe('?view=saved')
    expect(router.state.historyAction).toBe('REPLACE')
    await act(async () => { fireEvent.click(radio('Sow now')) })
    await act(async () => { fireEvent.click(radio('My seeds')) })
    expect(search(router)).toBe('?view=mine')
    await act(async () => { router.navigate(-1) })
    expect(router.state.location.pathname).toBe('/today')
  })

  it('shares ONE fetch of the seed rows across view switches', async () => {
    seedRows = [BOUGHT, STORED]
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Saved seeds' })) })
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    expect(seedGets()).toBe(1)
  })

  it('Sow now never waits on the seed rows', async () => {
    seedResponse = () => new Promise(() => {})   // never settles
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByText('No seed packets yet')).toBeTruthy())
  })
})

describe('Seeds — header actions (fixed slot per view)', () => {
  it('My seeds: + Add seeds opens the seed-mode add form returning to My seeds, and Save seed opens the sheet with NO planting', async () => {
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    expect(screen.getByTestId('seeds-add').getAttribute('href'))
      .toBe('/inventory/add?type=consumable&category=seeds&return=%2Fseeds%3Fview%3Dmine')
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    expect(saveSheetProps.current).toBeTruthy()
    expect(saveSheetProps.current.planting).toBeUndefined()
    expect(typeof saveSheetProps.current.onSaved).toBe('function')
  })

  it('a save confirms IN PLACE: the rows reload, the view does not change, and the new lot is outlined', async () => {
    seedRows = [BOUGHT]
    const router = mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    const NEW = lot({ id: 'lot-new', name: 'Cherokee Purple — saved 2026', variety_name: 'Cherokee Purple' })
    seedRows = [BOUGHT, NEW]
    await act(async () => { saveSheetProps.current.onClose(); saveSheetProps.current.onSaved(NEW, { stageWritten: null }) })
    await waitFor(() => expect(seedGets()).toBe(2))
    expect(search(router)).toBe('?view=mine')
    await waitFor(() => {
      const row = document.querySelector('[data-lot-id="lot-new"]')
      expect(row?.getAttribute('data-outlined')).toBe('true')
    })
  })

  it('Saved seeds carries + Save seed in the slot; Sow now carries none', async () => {
    const router = mount(['/seeds?view=saved'])
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    expect(screen.getByTestId('seeds-save-seed').textContent).toContain('Save seed')
    // The standalone full-width button is gone when embedded.
    expect(screen.queryByTestId('save-seed-open')).toBeNull()
    await act(async () => { router.navigate('/seeds?view=sow', { replace: true }) })
    await waitFor(() => expect(screen.getByTestId('sow-now-view')).toBeTruthy())
    expect(screen.getByTestId('seeds-actions').children.length).toBe(0)
  })
})

// §12 "N adds, then one Back leaves Seeds" holds only if the DOOR that pushes a page off Seeds attaches
// the Seeds URL it came from: the add form and the detail page leave with navigate(-1) when they see it
// (InventoryAdd.seedMode.test.jsx pins that half, with the state injected by hand). Without it every add
// stacks another copy of Seeds under the form. These pin the sending half, one door per case.
describe('Seeds — every door that pushes a page off Seeds carries the way back', () => {
  const landed = (router) => ({
    action: router.state.historyAction,
    path: router.state.location.pathname,
    state: router.state.location.state,
  })

  it('My seeds header: + Add seeds', async () => {
    const router = mount(['/today', '/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-add')) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/add', state: { seedsReturn: '/seeds?view=mine' } })
  })

  it('My seeds row: Open details → (after expanding the row)', async () => {
    seedRows = [BOUGHT]
    const router = mount(['/today', '/seeds?view=mine'])
    await waitFor(() => expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeTruthy())
    await act(async () => { fireEvent.click(document.querySelector('[data-lot-id="pkt-1"] button[aria-expanded]')) })
    await act(async () => { fireEvent.click(screen.getByTestId('my-seed-details')) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/pkt-1', state: { seedsReturn: '/seeds?view=mine' } })
  })

  it('My seeds empty state: + Add seeds', async () => {
    seedRows = []
    const router = mount(['/today', '/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-empty')).toBeTruthy())
    // The empty card's own link, not the header's (both read "+ Add seeds").
    await act(async () => { fireEvent.click(within(screen.getByTestId('my-seeds-empty')).getByRole('link', { name: '+ Add seeds' })) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/add', state: { seedsReturn: '/seeds?view=mine' } })
  })

  it('Sow now card: a packet link (Add sow details) returns to Sow now', async () => {
    candidates = [{ inventory_item_id: 'pkt-1', item_name: 'Sungold', variety_name: 'Sungold', variety_id: 'v-b' }]
    const router = mount(['/today', '/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add sow details for Sungold' })).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add sow details for Sungold' })) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/pkt-1', state: { seedsReturn: '/seeds?view=sow' } })
  })

  it('Sow now empty state: Add seeds returns to Sow now', async () => {
    candidates = []
    const router = mount(['/today', '/seeds?view=sow'])
    await waitFor(() => expect(screen.getByText('No seed packets yet')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Add seeds' })) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/add', state: { seedsReturn: '/seeds?view=sow' } })
  })

  it('Saved seeds empty state: Add the packet → returns to Saved seeds', async () => {
    seedRows = [BOUGHT]   // nothing tracked
    const router = mount(['/today', '/seeds?view=saved'])
    await waitFor(() => expect(screen.getByTestId('empty-add-packet')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('empty-add-packet')) })
    expect(landed(router)).toEqual({ action: 'PUSH', path: '/inventory/add', state: { seedsReturn: '/seeds?view=saved' } })
  })
})

describe('Seeds — the ferment line (§4.5)', () => {
  it('is absent when no ferment is due', async () => {
    seedRows = [FERMENTING]  // day 1
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    expect(screen.queryByTestId('seeds-ferment-line')).toBeNull()
  })

  it('names one overdue ferment on EVERY view and taps through to its card in Saved seeds', async () => {
    const OVERDUE = { ...FERMENTING, stage_entered_at: daysAgo(5) }
    seedRows = [OVERDUE, BOUGHT]
    const router = mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByTestId('seeds-ferment-line')).toBeTruthy())
    const line = screen.getByTestId('seeds-ferment-line')
    expect(line.textContent).toContain('Big Boy ferment — day 5, overdue')
    expect(line.getAttribute('data-level')).toBe('alarm')
    await act(async () => { fireEvent.click(line) })
    expect(search(router)).toBe('?view=saved')
    await waitFor(() => {
      const card = document.querySelector('[data-lot-id="lot-ferm"]')
      expect(card?.getAttribute('data-outlined')).toBe('true')
    })
  })

  it('counts two due ferments instead of naming one', async () => {
    seedRows = [
      { ...FERMENTING, stage_entered_at: daysAgo(4) },
      { ...FERMENTING, id: 'lot-ferm-2', variety_name: 'Brandywine', stage_entered_at: daysAgo(6) },
    ]
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('seeds-ferment-line').textContent).toContain('2 ferments need checking'))
  })
})

describe('Seeds — offline rows are marked stale (§5.1)', () => {
  it('shows the stale band with Retry on My seeds and Saved seeds, not on Sow now', async () => {
    const cached = [BOUGHT]
    cached[Symbol.for('garden-app.fromCache')] = true
    seedResponse = () => Promise.resolve(cached)
    const router = mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getByTestId('seeds-stale')).toBeTruthy())
    expect(screen.getByTestId('seeds-stale').textContent).toContain('Offline')
    expect(within(screen.getByTestId('seeds-stale')).getByRole('button', { name: 'Retry' })).toBeTruthy()
    // Saved seeds reads the same rows, so it carries the same band — and its Retry refetches them.
    await act(async () => { router.navigate('/seeds?view=saved', { replace: true }) })
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    expect(screen.getByTestId('seeds-stale').textContent).toContain('Offline')
    expect(seedGets()).toBe(1)
    await act(async () => { fireEvent.click(within(screen.getByTestId('seeds-stale')).getByRole('button', { name: 'Retry' })) })
    await waitFor(() => expect(seedGets()).toBe(2))
    await act(async () => { router.navigate('/seeds?view=sow', { replace: true }) })
    await waitFor(() => expect(screen.getByTestId('sow-now-view')).toBeTruthy())
    expect(screen.queryByTestId('seeds-stale')).toBeNull()
  })

  it('a REFRESH that fails after the rows landed keeps the rows and says so', async () => {
    seedRows = [BOUGHT]
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(screen.getAllByTestId('my-seed-row').length).toBe(1))
    seedResponse = () => Promise.reject(new Error('flaky'))
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    await act(async () => { saveSheetProps.current.onSaved({ id: 'x' }, { stageWritten: null }) })
    await waitFor(() => expect(screen.getByTestId('seeds-stale').textContent).toContain('Couldn’t refresh'))
    expect(screen.getAllByTestId('my-seed-row').length).toBe(1)
  })
})

describe('Seeds — the view is the URL, so it survives a trip away and back', () => {
  it('bare /seeds lands on Saved seeds for a drying lot; lot → detail → Back returns to Saved seeds even after the lot is stored', async () => {
    seedRows = [DRYING]
    const router = mount(['/today', '/seeds'])
    await waitFor(() => expect(search(router)).toBe('?view=saved'))
    await waitFor(() => expect(screen.getByText('Gong Bao')).toBeTruthy())
    // The lot's detail page is a PUSH that carries the way back.
    await act(async () => { fireEvent.click(screen.getByText('Gong Bao')) })
    expect(router.state.location.pathname).toBe('/inventory/lot-dry')
    expect(router.state.location.state).toEqual({ seedsReturn: '/seeds?view=saved' })
    // Meanwhile the lot finished drying: the default rule would now say My seeds. The URL says Saved.
    seedRows = [{ ...DRYING, seed_stage: 'stored' }]
    await act(async () => { router.navigate(-1) })
    expect(search(router)).toBe('?view=saved')
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
  })
})

// §5.2 / §4.3 / §4.6 on the Saved seeds view. Two arrivals put a lot on screen and outline it: the URL's
// `?lot=` (Planting → Save seed with a stage, and the detail page's stage link, both land here), and a
// save made from the shell's + Save seed. The second one can land under a crop chip that hides it.
describe('Seeds › Saved seeds — a lot the page is told about is brought into sight and outlined', () => {
  const outlined = (id) => document.querySelector(`[data-lot-id="${id}"]`)?.getAttribute('data-outlined')

  it('arriving at ?view=saved&lot=<id> outlines that card', async () => {
    seedRows = [DRYING, STORED]
    mount(['/today', '/seeds?view=saved&lot=lot-dry'])
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    await waitFor(() => expect(outlined('lot-dry')).toBe('true'))
    // Only that card: the other lot on the page is not.
    expect(outlined('lot-stored')).toBeNull()
  })

  it('a save whose lot a crop chip hides clears the chip, says so, and outlines the lot', async () => {
    // Two crops among the tracked lots, so the chip row renders. FERMENTING is day 1 — not urgent, so
    // the pepper chip really does hide it (an overdue ferment survives any filter by design).
    seedRows = [DRYING, FERMENTING]
    mount(['/seeds?view=saved'])
    await waitFor(() => expect(screen.getByTestId('tracked-crop-filter')).toBeTruthy())
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('tracked-crop-filter')).getByRole('button', { name: /Pepper/ }))
    })
    expect(document.querySelector('[data-lot-id="lot-ferm"]')).toBeNull()
    expect(screen.queryByTestId('saved-filter-cleared')).toBeNull()

    // + Save seed from the header, and the new lot is a tomato the chip would hide.
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    const NEW = lot({
      id: 'lot-new', name: 'Cherokee Purple — saved 2026', variety_name: 'Cherokee Purple', crop_slug: 'tomato',
      seed_stage: 'fermenting', seed_process: 'wet', stage_entered_at: daysAgo(0),
    })
    seedRows = [DRYING, FERMENTING, NEW]
    await act(async () => { saveSheetProps.current.onClose(); saveSheetProps.current.onSaved(NEW, { stageWritten: 'fermenting' }) })

    await waitFor(() => expect(screen.getByTestId('saved-filter-cleared').textContent).toBe('Showing all · Cherokee Purple'))
    await waitFor(() => expect(outlined('lot-new')).toBe('true'))
    // The chip was cleared, not the lot let through alone: the other tomato is back too.
    expect(document.querySelector('[data-lot-id="lot-ferm"]')).toBeTruthy()
  })

  // Found by lane T4 (report: _crucible_seedstab_20260918/build-20260918/lane-t4-report.md): Saved seeds'
  // useLotOutline `ready` was `items != null`, so after a save the outline (and its one scrollIntoView)
  // fired BEFORE the reload brought the new card in, and nothing scrolled to it when it landed. An
  // instant fetch cannot see this — the reload here is held open, as a phone's is.
  for (const view of ['mine', 'saved']) {
    it(`${view === 'saved' ? 'Saved seeds' : 'My seeds'} scrolls a just-saved lot into view once a SLOW reload lands (§4.6)`, async () => {
      const calls = []
      const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
      const orig = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function () { calls.push(this.getAttribute('data-lot-id')) }
      try {
        seedRows = [DRYING]
        mount([`/seeds?view=${view}`])
        await waitFor(() => expect(document.querySelector('[data-lot-id="lot-dry"]')).toBeTruthy())
        await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
        const NEW = lot({ id: 'lot-new', name: 'Cherokee Purple — saved 2026', variety_name: 'Cherokee Purple', seed_stage: 'fermenting', seed_process: 'wet', stage_entered_at: daysAgo(0) })
        let release
        seedResponse = () => new Promise((r) => { release = r })
        await act(async () => { saveSheetProps.current.onClose(); saveSheetProps.current.onSaved(NEW, { stageWritten: 'fermenting' }) })
        await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
        expect(calls).toEqual([])   // nothing to scroll to yet — and nothing scrolled to the wrong place
        await act(async () => { release([DRYING, NEW]) })
        await waitFor(() => expect(document.querySelector('[data-lot-id="lot-new"]')?.getAttribute('data-outlined')).toBe('true'))
        await waitFor(() => expect(calls).toContain('lot-new'))
      } finally {
        if (had) Element.prototype.scrollIntoView = orig; else delete Element.prototype.scrollIntoView
      }
    })
  }
})

describe('Seeds — every view sees the others’ writes without a reload', () => {
  it('a stage moved in Saved seeds is what My seeds shows next', async () => {
    seedRows = [DRYING]
    mount(['/seeds?view=saved'])
    await waitFor(() => expect(screen.getByTestId('advance-stage')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '40' } }) })
    seedRows = [{ ...DRYING, seed_stage: 'stored', seed_count: 40 }]
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    await waitFor(() => expect(seedGets()).toBe(2))
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => expect(document.querySelector('[data-lot-id="lot-dry"]')).toBeTruthy())
    const line = document.querySelector('[data-lot-id="lot-dry"] [data-testid="my-seed-line"]').textContent
    expect(line).not.toContain('Drying')
    expect(line).toContain('40 seeds')
  })

  it('a stage advance outlines the card where it LANDS: nothing scrolls until the reload has moved it', async () => {
    // The card is already on the page in its OLD section, so an outline asked for before the reload
    // scrolled there and then watched the card jump to Stored.
    const calls = []
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function () { calls.push(this.closest('section')?.getAttribute('data-testid')) }
    try {
      seedRows = [DRYING]
      mount(['/seeds?view=saved'])
      await waitFor(() => expect(screen.getByTestId('advance-stage')).toBeTruthy())
      await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
      await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '40' } }) })
      let release
      seedResponse = () => new Promise((r) => { release = r })
      await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
      await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
      expect(calls).toEqual([])
      await act(async () => { release([{ ...DRYING, seed_stage: 'stored', seed_count: 40 }]) })
      await waitFor(() => expect(calls).toEqual(['stage-section-stored']))
    } finally {
      if (had) Element.prototype.scrollIntoView = orig; else delete Element.prototype.scrollIntoView
    }
  })

  it('an archive in Sow now shows in My seeds at once, patched in place — no second seed fetch', async () => {
    seedRows = [BOUGHT]
    candidates = [{ inventory_item_id: 'pkt-1', item_name: 'Sungold', variety_name: 'Sungold', variety_id: 'v-b' }]
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('button', { name: /Archive Sungold/ })).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Archive Sungold/ })) })
    await waitFor(() => expect(fetchSpy.mock.calls.some(([p, o]) => String(p).includes('/sow-archive') && o?.method === 'PATCH')).toBe(true))
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => {
      const line = document.querySelector('[data-lot-id="pkt-1"] [data-testid="my-seed-line"]')
      expect(line?.textContent).toContain('Archived for this season')
    })
    expect(seedGets()).toBe(1)
  })

  it('a sow on Sow now is still "Sown ✓" after a trip to My seeds and back, and does not refetch the seed rows', async () => {
    // §5.3: "Sown ✓" lives in the shell, because switching views unmounts Sow now and a confirmation
    // held there died with it — the packet sown seconds ago was offered again. And §12: a sow changes
    // no inventory row, so it must not reload the ~330-row seed list.
    seedRows = [BOUGHT]
    // start_method indoors_only is sowable inside on any date, so the card carries Sow whatever day
    // this runs (sowEngine: the indoor-only overlay → sow_inside_anytime, an actionable bucket).
    candidates = [{
      inventory_item_id: 'pkt-1', item_name: 'Sungold', variety_name: 'Sungold', variety_id: 'v-b',
      quantity_on_hand: '1', unit: 'packet', crop_type_slug: 'tomato', lifecycle: 'annual',
      start_method: 'indoors_only', sun_requirements: 'full_sun',
    }]
    const base = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) => {
      const p = String(path)
      // The Sow sheet's editor reads the packet (its name fills the required Name field) and the places.
      if (!opts?.method && p === '/api/inventory-items/pkt-1') return Promise.resolve({ id: 'pkt-1', name: 'Sungold', metadata: {} })
      if (!opts?.method && p === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Garden' }])
      if (opts?.method === 'POST' && p === '/api/plants') return Promise.resolve({ id: 'plant-1' })
      return base(path, opts)
    })
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sow Sungold' })).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sow Sungold' })) })
    const sheet = screen.getByRole('dialog', { name: /Sow Sungold/ })
    await waitFor(() => expect(within(sheet).getByDisplayValue('Sungold')).toBeTruthy())
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i })) })
    await waitFor(() => expect(fetchSpy.mock.calls.some(([p, o]) => p === '/api/plants' && o?.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.getByText('Sown ✓')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Sow now' })) })
    await waitFor(() => expect(screen.getByTestId('sow-now-view')).toBeTruthy())
    // Sow now refetched its own candidates on remount (parity) — wait for the card, then read it.
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.getByText('Sown ✓')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sow Sungold' })).toBeNull()
    expect(seedGets()).toBe(1)
  })

  it('reloading with the Sow sheet open on Seeds › Sow now brings the sheet back (draft "sow-now")', async () => {
    candidates = [{ inventory_item_id: 'pkt-1', item_name: 'Sungold', variety_name: 'Sungold', variety_id: 'v-b' }]
    writeDraft('sow-now', { inventoryItemId: 'pkt-1' })
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Sow Sungold/ })).toBeTruthy())
  })
})

// Pre-promote regression pass #2 (build-20260918/prepromote-regression-2.md, IMPORTANT A-D): the shell's
// last highlight used to be re-applied long after the write it confirmed — every time a view's `ready`
// rose again, every time a view remounted, and when a stage move's reload landed after the user had
// left Saved seeds. An outline is an answer to one write: it happens once, where the user is.
describe('Seeds — an outline happens once, for the write it confirms', () => {
  const PKT2 = lot({ id: 'pkt-2', name: 'Jalapeno', variety_name: 'Jalapeno', crop_slug: 'pepper', quantity_on_hand: 3 })
  const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
  let calls, restoreScroll
  beforeEach(() => {
    calls = []
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function () { calls.push(this.getAttribute('data-lot-id')) }
    restoreScroll = () => { if (had) Element.prototype.scrollIntoView = orig; else delete Element.prototype.scrollIntoView }
  })
  afterEach(() => restoreScroll())

  it('Saved seeds: a crop chip that hides and then shows the lot again does not scroll back to it', async () => {
    seedRows = [DRYING, FERMENTING]
    mount(['/seeds?view=saved&lot=lot-dry'])
    await waitFor(() => expect(calls).toEqual(['lot-dry']))
    await wait(2100)   // the outline has run its course
    const tomato = within(screen.getByTestId('tracked-crop-filter')).getAllByRole('button').find((b) => /tomato/i.test(b.textContent))
    await act(async () => { fireEvent.click(tomato) })
    expect(document.querySelector('[data-lot-id="lot-dry"]')).toBeNull()
    await act(async () => { fireEvent.click(tomato) })
    await waitFor(() => expect(document.querySelector('[data-lot-id="lot-dry"]')).toBeTruthy())
    await wait(100)
    expect(calls).toEqual(['lot-dry'])
    expect(document.querySelector('[data-lot-id="lot-dry"]').getAttribute('data-outlined')).toBeNull()
  })

  it('My seeds: clearing a search that had hidden the row does not scroll back to it', async () => {
    seedRows = [BOUGHT, PKT2]
    mount(['/seeds?view=mine&lot=pkt-1'])
    await waitFor(() => expect(calls).toEqual(['pkt-1']))
    await wait(2100)
    const box = screen.getByTestId('my-seeds-search')
    await act(async () => { fireEvent.change(box, { target: { value: 'Jalap' } }) })
    expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeNull()
    await act(async () => { fireEvent.change(box, { target: { value: '' } }) })
    await wait(100)
    expect(calls).toEqual(['pkt-1'])
  })

  it('a stage move whose reload lands after the user switched to My seeds leaves their search alone', async () => {
    seedRows = [DRYING, BOUGHT]
    mount(['/seeds?view=saved'])
    await waitFor(() => expect(screen.getByTestId('advance-stage')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '40' } }) })
    let release
    seedResponse = () => new Promise((r) => { release = r })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
    await wait(30)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => expect(screen.getByTestId('my-seeds-search')).toBeTruthy())
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'Sungold' } }) })
    await act(async () => { release([{ ...DRYING, seed_stage: 'stored', seed_count: 40 }, BOUGHT]) })
    await wait(100)
    expect(screen.getByTestId('my-seeds-search').value).toBe('Sungold')
    expect(screen.queryByTestId('my-seeds-notice')).toBeNull()
    expect(calls).toEqual([])
  })

  it('switching away and back keeps the filters the user chose after an outline', async () => {
    seedRows = [BOUGHT, PKT2]
    mount(['/seeds?view=mine'])
    await waitFor(() => expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('seeds-save-seed')) })
    await act(async () => { saveSheetProps.current.onClose(); saveSheetProps.current.onSaved({ id: 'pkt-1' }, {}) })
    await waitFor(() => expect(calls).toEqual(['pkt-1']))
    await wait(2200)
    const pepper = () => within(screen.getByTestId('my-seeds-crop-filter')).getAllByRole('button').find((b) => /pepper/i.test(b.textContent))
    await act(async () => { fireEvent.click(pepper()) })
    expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Saved seeds' })) })
    await waitFor(() => expect(screen.getByTestId('saved-seeds-view')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    await wait(100)
    expect(pepper().getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('my-seeds-notice')).toBeNull()
    expect(document.querySelector('[data-lot-id="pkt-1"]')).toBeNull()
    expect(calls).toEqual(['pkt-1'])
  })
})
