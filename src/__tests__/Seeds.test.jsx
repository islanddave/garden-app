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
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'

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

beforeEach(() => {
  fetchSpy.mockReset()
  saveSheetProps.current = null
  seedRows = [BOUGHT]
  seedResponse = null
  candidates = []
  clearDraft('sow-now')
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/inventory-items?category=seeds')) return seedResponse ? seedResponse() : Promise.resolve(seedRows)
    if (p.startsWith('/api/inventory-items/sow-candidates')) return Promise.resolve({ items: candidates })
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

function mount(entries = ['/seeds'], initialIndex = entries.length - 1) {
  const router = createMemoryRouter(
    [
      { path: '/seeds', element: <ToastProvider><Seeds /></ToastProvider> },
      { path: '/today', element: <div data-testid="today" /> },
      { path: '/inventory/add', element: <div data-testid="add-form" /> },
      { path: '/inventory/:id', element: <div data-testid="detail" /> },
    ],
    { initialEntries: entries, initialIndex },
  )
  render(<RouterProvider router={router} />)
  return router
}
const search = (router) => router.state.location.search
const seedGets = () => fetchSpy.mock.calls.filter(([p, o]) => String(p).startsWith('/api/inventory-items?category=seeds') && !o?.method).length

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
    const router = mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByTestId('sow-now-view')).toBeTruthy())
    // The More row's href is the bare path; the page stays mounted across it.
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

  it('reloading with the Sow sheet open on Seeds › Sow now brings the sheet back (draft "sow-now")', async () => {
    candidates = [{ inventory_item_id: 'pkt-1', item_name: 'Sungold', variety_name: 'Sungold', variety_id: 'v-b' }]
    writeDraft('sow-now', { inventoryItemId: 'pkt-1' })
    mount(['/seeds?view=sow'])
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Sow Sungold/ })).toBeTruthy())
  })
})
