// Put-Up UX pass R1, lane A — the page's ONE opener and its way back out (PLAN-V3 section 3 "What the page
// does"; D11), on a REAL history stack.
//
// WHY BrowserRouter AND window.history, not MemoryRouter. The rule under test is "pop when the entry names
// its sender AND the router's history index is above 0, otherwise push". A MemoryRouter writes no index to
// window.history, so under it the page can only ever push and the pop half of the rule cannot go red.
// jsdom's history is real enough: react-router writes `idx` into history.state, history.back() fires a
// real (asynchronous) popstate, and a <Sheet armsBack> pushes its real Back marker.
//
// THE OTHER LANES ARE STAND-INS HERE, each honouring the prop it was promised (PLAN-V3 section 3 "Props") and
// nothing more: the closed list (B), batch detail (B), the Recipes view (D), the Pantry list, its search
// results and the door (C). What is asserted is what THIS page does with each call — the push it makes,
// the state it carries, the label it shows and where its Back lands.
//
// MUTATIONS (run for this file; each names the test it reds):
//   M1      withFrom returns `{ from }` only                      -> "the pushed state is { background, from }"
//   M3      leaveMode as at the base (always the push)             -> "returns to the sender … and a system
//                                                                    Back after it does not return to the batch"
//   Spare 2 an opener adds its own key and clears no other         -> "From a batch, opening its recipe shows
//                                                                    the recipe"
//   (own)   openMode never replaces over a sheet's Back marker     -> "a sender that did not land first …"
// LANE A2 (the mobile seat's render review; one mutation per rule, each names the test it reds):
//   A2-1a   openMode passes `origin ?? null` (no segment named)    -> "a Going-now card → batch: the Back reads
//                                                                    as it always did, POPS …"
//   A2-1b   the segment is named even over the search's results    -> "over the search's results there is no
//                                                                    segment on screen …"
//   A2-1c   the segment is named even inside a mode                -> "inside a mode there is no segment on
//                                                                    screen either …"
//   A2-1d   a fresh page ignores the segment its entry names       -> "a recipe opened from Recipes, restored …"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182). Nothing here reads a clock.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchMock, seen } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  seen: { closed: [], detail: [], recipes: [], recipesMounts: 0, pantry: [], search: [], walk: [], door: [], sheet: [] },
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

// ── lane B: the closed list and batch detail ─────────────────────────────────────────────────────
vi.mock('../components/putup/ClosedBatchesView.jsx', () => ({
  default: (props) => {
    seen.closed.push(props)
    return (
      <div data-testid="closed-batches-view">
        <button type="button" data-testid="stub-closed-row"
          onClick={() => props.onOpenBatch('kb-closed', { label: 'Closed batches' })}>Peach butter</button>
      </div>
    )
  },
}))
vi.mock('../components/putup/BatchDetailView.jsx', () => ({
  default: (props) => {
    seen.detail.push(props)
    const b = props.batch
    return (
      <div data-testid="batch-detail-view" data-batch-id={b?.id ?? ''}>
        <button type="button" data-testid="stub-batch-recipe"
          onClick={() => props.onOpenRecipe('rc-1', { label: 'Megatron mash', kind: 'batch', id: 'kb-1' })}>From Petri Dish →</button>
        <button type="button" data-testid="stub-batch-removed" onClick={() => props.onRemoved()}>Remove this batch</button>
      </div>
    )
  },
}))

// ── lane D: the Recipes view — controlled if and only if `onOpen` is a function ──────────────────
vi.mock('../components/recipes/RecipesView.jsx', async () => {
  const { useEffect } = await import('react')
  return {
    default: function StubRecipesView(props) {
      seen.recipes.push(props)
      useEffect(() => { seen.recipesMounts += 1 }, [])
      if (typeof props.onOpen === 'function' && props.openId) {
        return (
          <div data-testid="recipe-detail" data-recipe-id={props.openId}>
            <button type="button" data-testid="stub-recipe-make"
              onClick={() => props.onBatchStarted({ id: 'kb-made', label: 'Petri Dish' }, { label: 'Petri Dish', kind: 'recipe', id: props.openId })}>Make this</button>
            <button type="button" data-testid="stub-recipe-removed" onClick={() => props.onOpen(null)}>Remove</button>
          </div>
        )
      }
      return (
        <div data-testid="recipes-view">
          <button type="button" data-testid="stub-recipes-row" onClick={() => props.onOpen('rc-1')}>Petri Dish</button>
          <button type="button" data-testid="stub-recipes-null" onClick={() => props.onOpen(null)}>a null from the list</button>
        </div>
      )
    },
  }
})

// ── lane C: the Pantry list (its real list hook kept), the search results, the walk and the door ──
vi.mock('../components/pantry/PantryView.jsx', async (importActual) => {
  const { useState } = await import('react')
  const { default: Sheet } = await import('../components/forms/Sheet.jsx')
  const { landAfterClose } = await import('../components/kitchen/sheetLanding.js')
  function StubPantryView(props) {
    seen.pantry.push(props)
    const [open, setOpen] = useState(false)
    const go = () => props.onOpenBatch('kb-1', { label: 'Pantry' })
    return (
      <div data-testid="pantry-view">
        <button type="button" data-testid="stub-pantry-batch" onClick={go}>from Megatron mash</button>
        <button type="button" data-testid="stub-pantry-empty-door" onClick={props.onPutSomethingUp}>Put something up</button>
        <button type="button" data-testid="stub-pantry-empty-door-named" onClick={() => props.onPutSomethingUp('kraut')}>Put something up: kraut</button>
        <button type="button" data-testid="stub-pantry-empty-walk" onClick={() => props.onWalkPlace()}>Walk a place</button>
        <button type="button" data-testid="stub-pantry-row" onClick={() => setOpen(true)}>Megatron reaper</button>
        <Sheet open={open} onClose={() => setOpen(false)} title="Megatron reaper" armsBack>
          <div data-testid="stub-row-sheet">
            <button type="button" data-testid="stub-sheet-landed" onClick={() => landAfterClose(() => setOpen(false), go)}>What went in →</button>
            <button type="button" data-testid="stub-sheet-unlanded" onClick={go}>What went in → (no landing)</button>
          </div>
        </Sheet>
      </div>
    )
  }
  return { ...(await importActual()), default: StubPantryView }
})
vi.mock('../components/pantry/PantrySearch.jsx', async (importActual) => ({
  ...(await importActual()),
  default: (props) => {
    seen.search.push(props)
    return (
      <div data-testid="pantry-search-results">
        <button type="button" data-testid="stub-search-batch" onClick={() => props.onOpenBatch('kb-1', { label: 'Pantry' })}>from Megatron mash</button>
        {(props.extraSearchItems ?? []).map(it => (
          <button type="button" key={it.id} data-testid={`stub-search-hit-${it.id}`} onClick={() => props.onOpenExtra(it)}>{it.name}</button>
        ))}
      </div>
    )
  },
}))
vi.mock('../components/pantry/WalkPlace.jsx', async (importActual) => ({
  ...(await importActual()),
  default: (props) => { seen.walk.push(props); return <div data-testid="walk-place" /> },
}))
vi.mock('../components/pantry/PutSomethingUpSheet.jsx', () => ({
  default: (props) => {
    seen.door.push(props)
    return (
      <div role="dialog" aria-label="Put something up" data-testid="stub-door" data-initial-name={String(props.initialName)}>
        {typeof props.onStartBatchInstead === 'function' && (
          <button type="button" data-testid="stub-door-escape" onClick={() => props.onStartBatchInstead('Megatron mash')}>
            Still going (a ferment)? Start a batch instead →
          </button>
        )}
      </div>
    )
  },
}))

import PutUp from '../pages/PutUp.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readAnyMarker } from '../lib/backNav.js'
import { withFrom } from '../components/putup/origin.js'

// The Start sheet is handed in as a stand-in (the page's own test seam): it records what it was opened with.
function StubStartSheet({ open, onClose, onStarted, initialLabel }) {
  seen.sheet.push({ open, initialLabel })
  return (
    <div role="dialog" aria-label="Start a batch" data-testid="stub-start" data-initial-label={String(initialLabel ?? '')}>
      <button type="button" data-testid="stub-start-it" onClick={() => onStarted({ id: 'kb-new', label: 'Kraut' })}>Start it</button>
      <button type="button" data-testid="stub-start-noid" onClick={() => onStarted({ label: 'no id came back' })}>Start it (no id)</button>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  )
}

const MASH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: '2026-09-20T13:00:00.000Z', start_precision: 'day', first_recorded_at: '2026-09-20T13:00:00.000Z',
  expected_days_min: null, expected_days_max: null, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null, current_stage_entered_at: '2026-09-20T13:00:00.000Z',
  input_count: '0', output_count: '0', last_ph_reading: null, last_ph_read_at: null,
}
let going
function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (method !== 'GET') return Promise.resolve(null)
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches: going })
    if (path.startsWith('/api/kitchen-batches?state=closed')) return Promise.resolve({ state: 'closed', batches: [] })
    if (/^\/api\/kitchen-batches\/[^/?]+$/.test(path)) {
      const id = path.split('/').pop()
      return Promise.resolve({ ...MASH, id, inputs: [], stages: [], outputs: [] })
    }
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [] })
    if (path === '/api/recipes') return Promise.resolve({ recipes: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    return Promise.resolve(null)
  })
}
// The one recipe the page search can find, handed in through the page's own `extraSearchItems` seam, so
// nothing in this file rests on WHEN the page reads the recipes (PutUp.laneA.header.test.jsx holds that).
const RECIPE_HITS = [{ kind: 'recipe', id: 'rc-1', name: 'Petri Dish', type_label: 'Hot sauce' }]
const gets = (p) => fetchMock.mock.calls.filter(([path, o]) => path === p && (o?.method ?? 'GET') === 'GET').length

// ── the history rig ──────────────────────────────────────────────────────────────────────────────
let pops = 0
window.addEventListener('popstate', () => { pops += 1 })
// Wait for ONE real popstate (or 2 s), then let React settle.
const settle = (from) => act(async () => {
  const deadline = Date.now() + 2000
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  await new Promise((r) => setTimeout(r, 0))
})
const systemBack = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function Probe() {
  const loc = useLocation()
  return (
    <>
      <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
      <div data-testid="probe-state">{JSON.stringify(loc.state ?? null)}</div>
    </>
  )
}
// A page on ANOTHER route that links into a batch the way the planting page will (PLAN-V3 section 3 point 4:
// router state withFrom(null, { label: <planting name> }) on its <Link>).
function PlantingStub() {
  return (
    <div data-testid="planting-page">
      <Link data-testid="planting-batch-link" to="/put-up?batch=kb-1" state={withFrom(null, { label: 'Ristra Cayenne' })}>from Megatron mash →</Link>
    </div>
  )
}

// Every test starts on a fresh pair of entries: a floor, so a Back that leaves the page is a real
// traversal, and the entry under test on top of it. `state` is the router's `usr`; `idx` the router's index
// (0 = the first app entry of the session, which is what a cold deep link and a restored PWA are).
// `under` seeds app entries BETWEEN the floor and the entry under test, oldest first, each `{ url, state?,
// idx?, key? }`: a stack as a reload finds it, which no tap in a fresh render can build. `key` is the
// router's key for an entry; two entries that share one are a sheet's Back marker and the entry it copied.
const entryKey = () => `e${pops}-${Math.random().toString(36).slice(2, 8)}`
function renderAt(url, { state = null, idx = 0, sheet = StubStartSheet, registry = false, under = [], key } = {}) {
  window.history.pushState({ __floor: 1 }, '', '/floor')
  for (const e of under) window.history.pushState({ usr: e.state ?? null, key: e.key ?? entryKey(), idx: e.idx ?? 0 }, '', e.url)
  window.history.pushState({ usr: state, key: key ?? entryKey(), idx }, '', url)
  const tree = (
    <>
      <Probe />
      <Routes>
        <Route path="/put-up" element={<PutUp StartBatchSheet={sheet} extraSearchItems={RECIPE_HITS} />} />
        <Route path="/plantings/:id" element={<PlantingStub />} />
        <Route path="/floor" element={<div data-testid="floor">the entry under the app</div>} />
      </Routes>
    </>
  )
  return render(<BrowserRouter>{registry ? <DismissRegistryProvider>{tree}</DismissRegistryProvider> : tree}</BrowserRouter>)
}
const loc = () => screen.getByTestId('probe-loc').textContent
const state = () => JSON.parse(screen.getByTestId('probe-state').textContent)
const backBtn = () => screen.getByTestId('putup-mode-back')
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const segment = () => [...screen.getByRole('radiogroup', { name: 'Put-Up view' }).querySelectorAll('[role="radio"]')]
  .find(r => r.getAttribute('aria-checked') === 'true')?.textContent
const pickSegment = (name) => fireEvent.click(screen.getByRole('radio', { name }))

beforeEach(() => {
  fetchMock.mockReset(); going = [MASH]; wire()
  for (const k of Object.keys(seen)) { if (Array.isArray(seen[k])) seen[k].length = 0; else seen[k] = 0 }
  localStorage.clear(); sessionStorage.clear()
})
afterEach(() => { cleanup() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('instrument: this file\'s history is real', () => {
  it('a popstate arrives, and the router writes its index into history.state', async () => {
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    expect(window.history.state.idx).toBe(0)
    tap('stub-pantry-batch')
    await waitFor(() => expect(loc()).toBe('/put-up?view=pantry&batch=kb-1'))
    expect(window.history.state.idx).toBe(1)
    const before = pops
    await systemBack()
    expect(pops).toBe(before + 1)
    expect(loc()).toBe('/put-up?view=pantry')
  })
})

describe('the one opener: one mode key, always a push, the state carried through withFrom', () => {
  const BG = { pathname: '/today', search: '', hash: '', key: 'bg', historyEntry: { idx: 0, doc: 'd1' } }

  // M1's page half. Each sender, opened from an overlay entry: the background must ride along, and the
  // origin must be the sender's own. A sender that names none is opened from the segment on screen, so the
  // page names that segment (lane A2); over the search's results there is no segment, and no origin.
  // ⚠ AMENDED by lane A2, in the same commit as the change: the three "(no origin)" doors that are tapped ON A
  // SEGMENT used to push `{ background }` alone; each now also carries `from: { label: <that segment> }`.
  it.each([
    ['the Going-now card (names none: the segment it was tapped on)', '/put-up', async () => { pickSegment('Going now'); tap('going-open-batch') },
      '/put-up?batch=kb-1', { background: BG, from: { label: 'Going now' } }],
    ['Going now\'s door to the closed list (names none: the segment)', '/put-up', async () => { pickSegment('Going now'); tap('going-closed-door') },
      '/put-up?state=closed', { background: BG, from: { label: 'Going now' } }],
    ['a closed row', '/put-up?state=closed', async () => tap('stub-closed-row'),
      '/put-up?batch=kb-closed', { background: BG, from: { label: 'Closed batches' } }],
    ['the Pantry list', '/put-up?view=pantry', async () => tap('stub-pantry-batch'),
      '/put-up?view=pantry&batch=kb-1', { background: BG, from: { label: 'Pantry' } }],
    ['the Pantry search results', '/put-up?view=pantry&find=mega', async () => tap('stub-search-batch'),
      '/put-up?view=pantry&batch=kb-1', { background: BG, from: { label: 'Pantry' } }],
    ['a batch\'s recipe link', '/put-up?batch=kb-1', async () => tap('stub-batch-recipe'),
      '/put-up?recipe=rc-1', { background: BG, from: { label: 'Megatron mash', kind: 'batch', id: 'kb-1' } }],
    ['a recipe\'s Make this', '/put-up?recipe=rc-1', async () => tap('stub-recipe-make'),
      '/put-up?batch=kb-made', { background: BG, from: { label: 'Petri Dish', kind: 'recipe', id: 'rc-1' } }],
    ['a row of the Recipes list (names none: the segment)', '/put-up', async () => { pickSegment('Recipes'); tap('stub-recipes-row') },
      '/put-up?recipe=rc-1', { background: BG, from: { label: 'Recipes' } }],
    ['a recipe search hit (no origin)', '/put-up?view=pantry&find=petri', async () => tap(await hit()),
      '/put-up?view=pantry&recipe=rc-1', { background: BG }],
  ])('%s: the pushed state is { background, from }', async (_name, url, act1, wantUrl, wantState) => {
    renderAt(url, { state: { background: BG } })
    await flush(); await flush()
    const depth = window.history.state.idx
    await act1()
    await waitFor(() => expect(loc()).toBe(wantUrl))
    expect(state()).toEqual(wantState)
    // A push, never a replace: the router's index moved up by one.
    expect(window.history.state.idx).toBe(depth + 1)
  })
  async function hit() { await screen.findByTestId('stub-search-hit-rc-1'); return 'stub-search-hit-rc-1' }

  // ⚠ AMENDED by lane A2 (same commit): was "…and it names no origin", `{ background }` alone.
  it('a batch just started rides the same opener: its background is kept, and its origin is the segment it was started on', async () => {
    renderAt('/put-up', { state: { background: BG } })
    await flush()
    pickSegment('Going now')
    tap('start-a-batch')
    tap('stub-start-it')
    await waitFor(() => expect(loc()).toBe('/put-up?batch=kb-new'))
    expect(state()).toEqual({ background: BG, from: { label: 'Going now' } })
  })

  it('a start that answered with no id opens nothing and pushes nothing', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Going now')
    tap('start-a-batch')
    const depth = window.history.state.idx
    tap('stub-start-noid')
    await flush()
    expect(loc()).toBe('/put-up')
    expect(window.history.state.idx).toBe(depth)
    expect(screen.queryByTestId('stub-start')).toBeNull()
  })

  // An origin is the SENDER's, never inherited: the entry a card is tapped on may itself carry one.
  it('a sender that names no origin does not hand on the last entry\'s', async () => {
    renderAt('/put-up?state=closed')
    await flush()
    tap('stub-closed-row')
    await waitFor(() => expect(state()).toEqual({ from: { label: 'Closed batches' } }))
    tap('stub-batch-recipe')
    await waitFor(() => expect(loc()).toBe('/put-up?recipe=rc-1'))
    tap('stub-recipe-removed')                                   // pops back to the batch, which still names the closed list
    await waitFor(() => expect(loc()).toBe('/put-up?batch=kb-closed'))
    expect(state()).toEqual({ from: { label: 'Closed batches' } })
  })

  // Spare 2. `batch` outranks `recipe` on a URL that carries both, so an opener that only ADDED its own
  // key would leave the batch on screen and the tap would do nothing.
  it('From a batch, opening its recipe shows the recipe', async () => {
    renderAt('/put-up?batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    tap('stub-batch-recipe')
    await waitFor(() => expect(screen.getByTestId('recipe-detail').getAttribute('data-recipe-id')).toBe('rc-1'))
    expect(loc()).toBe('/put-up?recipe=rc-1')
    expect(screen.queryByTestId('putup-batch-mode')).toBeNull()
  })

  it('…and from the closed list, opening a row shows that batch, not the list', async () => {
    renderAt('/put-up?state=closed')
    await screen.findByTestId('putup-closed-mode')
    tap('stub-closed-row')
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(loc()).toBe('/put-up?batch=kb-closed')
    expect(screen.queryByTestId('putup-closed-mode')).toBeNull()
  })

  it('every other param survives an open: the walk\'s place and the Pantry\'s view and filter', async () => {
    renderAt('/put-up?view=pantry&filter=use-soon')
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-batch')
    await waitFor(() => expect(loc()).toBe('/put-up?view=pantry&filter=use-soon&batch=kb-1'))
  })

  it('a deep link that carries more than one mode key is read batch, then recipe, then state', async () => {
    renderAt('/put-up?state=closed&recipe=rc-1&batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(screen.queryByTestId('putup-closed-mode')).toBeNull()
    cleanup()
    renderAt('/put-up?state=closed&recipe=rc-1')
    await screen.findByTestId('recipe-detail')
    expect(screen.queryByTestId('putup-closed-mode')).toBeNull()
    // The closed list is not read for a URL that will not show it.
    expect(gets('/api/kitchen-batches?state=closed')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the page\'s Back: it says where it lands, and lands there', () => {
  // One row per sender of PLAN-V3's origin table. [name, the sender's URL, the tap, the Back's exact words,
  // where the press lands: a URL and a testid that must be on screen].
  it.each([
    ['a closed row → batch', '/put-up?state=closed', 'stub-closed-row', '← Closed batches', '/put-up?state=closed', 'putup-closed-mode'],
    ['recipe detail → batch', '/put-up?recipe=rc-1', 'stub-recipe-make', '← Petri Dish (recipe)', '/put-up?recipe=rc-1', 'recipe-detail'],
    ['batch detail → its recipe', '/put-up?batch=kb-1', 'stub-batch-recipe', '← Megatron mash (batch)', '/put-up?batch=kb-1', 'putup-batch-mode'],
    ['the Pantry → batch', '/put-up?view=pantry', 'stub-pantry-batch', '← Pantry', '/put-up?view=pantry', 'pantry-view'],
    ['the search results → batch', '/put-up?view=pantry&find=mega', 'stub-search-batch', '← Pantry', '/put-up?view=pantry&find=mega', 'pantry-search-results'],
  ])('%s: the label is the sender, and the press returns to it', async (_name, url, sender, words, landUrl, landId) => {
    renderAt(url)
    await flush(); await flush()
    tap(sender)
    await waitFor(() => expect(backBtn().textContent).toBe(words))
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe(landUrl))
    expect(screen.getByTestId(landId)).toBeTruthy()
  })

  it('the planting page → batch: the label is the planting, and the press returns to that page', async () => {
    renderAt('/plantings/p1')
    tap('planting-batch-link')
    await waitFor(() => expect(backBtn().textContent).toBe('← Ristra Cayenne'))
    expect(state()).toEqual({ from: { label: 'Ristra Cayenne' } })
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe('/plantings/p1'))
    expect(screen.getByTestId('planting-page')).toBeTruthy()
  })

  // ⚠ AMENDED by lane A2 (same commit): was "…names no origin: the label is the segment…". The words, the
  // landing and the segment are asserted exactly as before; what is new is that the press is a POP.
  it('the Going-now card → batch: the label is the segment it was tapped on, and the press lands on it', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Going now')
    tap('going-open-batch')
    await waitFor(() => expect(backBtn().textContent).toBe('← Going now'))
    const depth = window.history.state.idx
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('going-now-view')).toBeTruthy())
    expect(loc()).toBe('/put-up')
    expect(segment()).toBe('Going now')
    expect(window.history.state.idx).toBe(depth - 1)
  })

  it('a recipe search hit names no origin: the label is Recipes, and the press lands on the Recipes list', async () => {
    renderAt('/put-up?view=pantry&find=petri')
    tap(await (async () => { await screen.findByTestId('stub-search-hit-rc-1'); return 'stub-search-hit-rc-1' })())
    await waitFor(() => expect(backBtn().textContent).toBe('← Recipes'))
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('recipes-view')).toBeTruthy())
    expect(loc()).toBe('/put-up?view=pantry')
    expect(segment()).toBe('Recipes')
  })

  // M3. With the base leaveMode (always a push with the mode keys removed) the Back from a batch opened off
  // the closed list lands on a SEGMENT, not on the closed list — and a system Back after it walks back INTO
  // the batch.
  it('returns to the sender — the closed list, not a segment — and a system Back after it does not return to the batch', async () => {
    renderAt('/put-up?state=closed')
    await screen.findByTestId('putup-closed-mode')
    tap('stub-closed-row')
    await screen.findByTestId('putup-batch-mode')
    const depth = window.history.state.idx
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('putup-closed-mode')).toBeTruthy())
    expect(screen.queryByTestId('going-now-view')).toBeNull()
    expect(loc()).toBe('/put-up?state=closed')
    expect(window.history.state.idx).toBe(depth - 1)          // a pop, not a second push
    await systemBack()
    expect(loc()).not.toMatch(/batch=/)
    expect(screen.queryByTestId('putup-batch-mode')).toBeNull()
    expect(screen.getByTestId('floor')).toBeTruthy()           // …it leaves, the way it came in
  })

  // A pop is not idempotent the way the push was: an unguarded second press would pop AGAIN, past the
  // sender and off the page it was meant to return to (here, onto the entry under the app).
  // MUTATION: leaveMode pops on every press (no "wait") -> the page lands on the floor and this reds.
  it('two presses before the first one lands return to the sender ONCE — never past it', async () => {
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-batch')
    await screen.findByTestId('putup-batch-mode')
    const from = pops
    const button = backBtn()
    // jsdom drops a traversal that is still queued when the next one is asked for, so two back() calls in
    // one tick show as ONE popstate here; a phone's browser does both. The count of traversals ASKED FOR
    // is what tells the guard from its absence (found at the train: the mutant survived on `pops` alone).
    const go = vi.spyOn(window.history, 'go')
    try {
      act(() => { button.click(); button.click() })
      expect(go.mock.calls).toEqual([[-1]])
    } finally { go.mockRestore() }
    await settle(from)
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })   // room for a second pop to land, if one was made
    expect(pops).toBe(from + 1)
    expect(loc()).toBe('/put-up?view=pantry')
    expect(screen.getByTestId('pantry-view')).toBeTruthy()
    expect(screen.queryByTestId('floor')).toBeNull()
  })

  it('a cold ?batch= deep link: the Back lands on Going now and does not leave the page', async () => {
    renderAt('/put-up?batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    await waitFor(() => expect(backBtn().textContent).toBe('← Going now'))   // the viewer's own batch is going
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('going-now-view')).toBeTruthy())
    expect(loc()).toBe('/put-up')
    expect(screen.queryByTestId('floor')).toBeNull()
    expect(segment()).toBe('Going now')
  })

  it('a cold ?batch= deep link with nothing going: the label and the landing are both the Pantry', async () => {
    going = []
    renderAt('/put-up?batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(backBtn().textContent).toBe('← Pantry')
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('pantry-view')).toBeTruthy())
    expect(segment()).toBe('Pantry')
  })

  // A restored PWA: history.state outlives a reload and a deploy, so the first entry of a session can
  // carry an origin with nothing of this app under it. history.back() there does nothing.
  it('at history index 0 with an origin in state, the Back falls back to the push — never a dead press, and never a lie', async () => {
    renderAt('/put-up?batch=kb-1', { state: { from: { label: 'Pantry' } }, idx: 0 })
    await screen.findByTestId('putup-batch-mode')
    await waitFor(() => expect(backBtn().textContent).toBe('← Going now'))   // where the push lands, not "Pantry"
    tap('putup-mode-back')
    await waitFor(() => expect(screen.queryByTestId('putup-batch-mode')).toBeNull())
    expect(loc()).toBe('/put-up')
    expect(screen.getByTestId('going-now-view')).toBeTruthy()
    expect(screen.queryByTestId('floor')).toBeNull()
    // The list entry it pushed carries no origin of its own.
    expect(state()).toBeNull()
  })

  it('the same restored entry, one entry up, pops: the index is the only difference', async () => {
    renderAt('/put-up?batch=kb-1', { state: { from: { label: 'Pantry' } }, idx: 1 })
    await screen.findByTestId('putup-batch-mode')
    expect(backBtn().textContent).toBe('← Pantry')
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('floor')).toBeTruthy())
  })

  it('a removed batch and a removed recipe leave by the same act as the Back', async () => {
    renderAt('/put-up?state=closed')
    await screen.findByTestId('putup-closed-mode')
    tap('stub-closed-row')
    await screen.findByTestId('putup-batch-mode')
    tap('stub-batch-removed')
    await waitFor(() => expect(loc()).toBe('/put-up?state=closed'))
    cleanup()
    renderAt('/put-up?recipe=rc-1')
    await screen.findByTestId('recipe-detail')
    tap('stub-recipe-removed')                                   // onOpen(null), with no origin: the push
    await waitFor(() => expect(screen.getByTestId('recipes-view')).toBeTruthy())
    expect(loc()).toBe('/put-up')
    expect(segment()).toBe('Recipes')
  })

  it('onOpen(null) from the LIST, where there is nothing to leave, pushes nothing', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Recipes')
    const depth = window.history.state.idx
    tap('stub-recipes-null')
    await flush()
    expect(window.history.state.idx).toBe(depth)
    expect(loc()).toBe('/put-up')
  })

  it('is ONE line that names the place: the name can shorten, the kind stays whole, 48px', async () => {
    renderAt('/put-up?recipe=rc-1')
    await screen.findByTestId('recipe-detail')
    tap('stub-recipe-make')
    await waitFor(() => expect(backBtn().textContent).toBe('← Petri Dish (recipe)'))
    const [name, kind] = backBtn().querySelectorAll('span')
    expect([name.textContent, kind.textContent]).toEqual(['← Petri Dish', ' (recipe)'])
    expect(backBtn().style.whiteSpace).toBe('nowrap')
    expect(backBtn().style.maxWidth).toBe('100%')
    expect([name.style.overflow, name.style.textOverflow, name.style.minWidth]).toEqual(['hidden', 'ellipsis', '0'])
    expect(kind.style.flexShrink).toBe('0')
    expect(backBtn().style.minHeight).toBe('48px')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// R1 follow-up, lane A2 (the mobile seat's finding: a Back that walks back INTO a mode). A door that hands
// the page no origin is opened from the segment on screen, so the page names that segment as the origin and
// the mode is left by a POP — the words on the Back are the ones it always showed.
describe('a door that names no origin is opened from the segment on screen', () => {
  // [name, the segment, the door, the mode's URL, its testid, the Back's exact words, the landing's testid]
  it.each([
    ['a Going-now card → batch', 'Going now', () => tap('going-open-batch'),
      '/put-up?batch=kb-1', 'putup-batch-mode', '← Going now', 'going-now-view'],
    ['Going now → Closed batches', 'Going now', () => tap('going-closed-door'),
      '/put-up?state=closed', 'putup-closed-mode', '← Going now', 'going-now-view'],
    ['a Recipes row → recipe', 'Recipes', () => tap('stub-recipes-row'),
      '/put-up?recipe=rc-1', 'recipe-detail', '← Recipes', 'recipes-view'],
    ['a batch just started on Going now', 'Going now', () => { tap('start-a-batch'); tap('stub-start-it') },
      '/put-up?batch=kb-new', 'putup-batch-mode', '← Going now', 'going-now-view'],
    ['a batch started through the Pantry\'s door', 'Pantry', () => { tap('putup-door'); tap('stub-door-escape'); tap('stub-start-it') },
      '/put-up?batch=kb-new', 'putup-batch-mode', '← Pantry', 'pantry-view'],
  ])('%s: the Back reads as it always did, POPS, and a system Back after it does not walk back in', async (_name, seg, open, modeUrl, modeId, words, landId) => {
    renderAt('/put-up')
    await flush()
    pickSegment(seg)
    open()
    await waitFor(() => expect(loc()).toBe(modeUrl))
    expect(screen.getByTestId(modeId)).toBeTruthy()
    expect(state()).toEqual({ from: { label: seg } })
    expect(backBtn().textContent).toBe(words)
    const depth = window.history.state.idx
    expect(depth).toBe(1)
    const go = vi.spyOn(window.history, 'go')
    try {
      tap('putup-mode-back')
      await waitFor(() => expect(loc()).toBe('/put-up'))
      expect(go.mock.calls).toEqual([[-1]])                     // ONE traversal: the press popped, it did not push
    } finally { go.mockRestore() }
    expect(window.history.state.idx).toBe(depth - 1)
    expect(screen.getByTestId(landId)).toBeTruthy()
    expect(segment()).toBe(seg)
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()            // …it leaves the page: the mode is not re-opened
    expect(screen.queryByTestId(modeId)).toBeNull()
  })

  // A search hit's under-entry is the results, not a segment (the recipe hit is held above, in the pushed-state
  // table and in "a recipe search hit names no origin"). The same holds for every door under the results.
  it('over the search\'s results there is no segment on screen: a batch started there names no origin, and its Back is the push', async () => {
    going = []                                                  // nothing going: the page holds the Pantry
    renderAt('/put-up?find=kraut')
    await screen.findByTestId('pantry-search-results')
    tap('putup-door'); tap('stub-door-escape'); tap('stub-start-it')
    await waitFor(() => expect(loc()).toBe('/put-up?batch=kb-new'))
    expect(state()).toBeNull()
    expect(backBtn().textContent).toBe('← Pantry')
    const depth = window.history.state.idx
    const go = vi.spyOn(window.history, 'go')
    try {
      tap('putup-mode-back')
      await waitFor(() => expect(screen.getByTestId('pantry-view')).toBeTruthy())
      expect(go).not.toHaveBeenCalled()
    } finally { go.mockRestore() }
    expect(loc()).toBe('/put-up')
    expect(window.history.state.idx).toBe(depth + 1)
  })

  // Inside a mode the entry under a push is that mode. The held segment is not on screen and is not where
  // the press would land, so naming it would be the Back lying.
  it('inside a mode there is no segment on screen either: a door there that names no origin gets none', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Recipes')
    tap('stub-recipes-row')
    await screen.findByTestId('recipe-detail')
    expect(state()).toEqual({ from: { label: 'Recipes' } })     // instrument: the segment WAS named one step earlier
    act(() => { seen.recipes.at(-1).onOpen('rc-2') })
    await waitFor(() => expect(loc()).toBe('/put-up?recipe=rc-2'))
    expect(state()).toBeNull()
  })

  it('Going now → a batch → its recipe, then Back twice: each press pops to its own sender, and the system Back then leaves', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Going now')
    tap('going-open-batch')
    await screen.findByTestId('putup-batch-mode')
    tap('stub-batch-recipe')
    await waitFor(() => expect(backBtn().textContent).toBe('← Megatron mash (batch)'))
    expect(window.history.state.idx).toBe(2)
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe('/put-up?batch=kb-1'))
    // The batch entry still names the segment it was opened from: a recipe opened from it took nothing away.
    expect(state()).toEqual({ from: { label: 'Going now' } })
    expect(backBtn().textContent).toBe('← Going now')
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)
    expect(screen.getByTestId('going-now-view')).toBeTruthy()
    expect(segment()).toBe('Going now')
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()
  })

  it('a removed batch and a removed recipe pop to the segment they were opened from', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Going now')
    tap('going-open-batch')
    await screen.findByTestId('putup-batch-mode')
    tap('stub-batch-removed')
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)
    expect(screen.getByTestId('going-now-view')).toBeTruthy()
    cleanup()
    renderAt('/put-up')
    await flush()
    pickSegment('Recipes')
    tap('stub-recipes-row')
    await screen.findByTestId('recipe-detail')
    tap('stub-recipe-removed')                                   // onOpen(null)
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)
    expect(screen.getByTestId('recipes-view')).toBeTruthy()
    expect(segment()).toBe('Recipes')
  })

  // history.state outlives a reload: an entry that names a segment can be the first of a session.
  it('at history index 0 an entry that names a segment still pushes, as every origin does there', async () => {
    renderAt('/put-up?recipe=rc-1', { state: { from: { label: 'Recipes' } }, idx: 0 })
    await screen.findByTestId('recipe-detail')
    expect(backBtn().textContent).toBe('← Recipes')
    const go = vi.spyOn(window.history, 'go')
    try {
      tap('putup-mode-back')
      await waitFor(() => expect(screen.getByTestId('recipes-view')).toBeTruthy())
      expect(go).not.toHaveBeenCalled()
    } finally { go.mockRestore() }
    expect(loc()).toBe('/put-up')
    expect(window.history.state.idx).toBe(1)
    expect(segment()).toBe('Recipes')
    expect(state()).toBeNull()
    expect(screen.queryByTestId('floor')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The segment is the page's own state, not part of the URL. A page that MOUNTS on a mode entry — a reload,
// a PWA restored from a discard, a return from another route — has lost it, and the list entry under the
// mode shows whatever a fresh page defaults to. With the segment named as the origin, the Back would then
// read "← Recipes" and land on the Pantry. So a page that mounts on an entry naming a segment holds it.
// The stack is seeded as the reload finds it: [the floor, the list at index 0, the mode at index 1].
describe('a page that mounts on a mode entry holds the segment its origin names', () => {
  const LIST = [{ url: '/put-up', idx: 0 }]

  it('a recipe opened from Recipes, restored: "← Recipes" lands on Recipes', async () => {
    renderAt('/put-up?recipe=rc-1', { state: { from: { label: 'Recipes' } }, idx: 1, under: LIST })
    await screen.findByTestId('recipe-detail')
    await flush()
    expect(backBtn().textContent).toBe('← Recipes')
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)                    // the pop, to the list entry under it
    expect(screen.getByTestId('recipes-view')).toBeTruthy()
    expect(segment()).toBe('Recipes')
  })

  // Nothing of the viewer's is going, so a fresh page holds the Pantry — which is not what the Back says.
  it('the closed list opened from Going now, restored with nothing going: "← Going now" lands on Going now', async () => {
    going = []
    renderAt('/put-up?state=closed', { state: { from: { label: 'Going now' } }, idx: 1, under: LIST })
    await screen.findByTestId('putup-closed-mode')
    await flush()
    expect(backBtn().textContent).toBe('← Going now')
    tap('putup-mode-back')
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(screen.getByTestId('going-now-view')).toBeTruthy()
    expect(segment()).toBe('Going now')
  })

  it('the same at index 0, where the Back pushes: the words and the landing are still that segment', async () => {
    going = []
    renderAt('/put-up?batch=kb-1', { state: { from: { label: 'Going now' } }, idx: 0 })
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(backBtn().textContent).toBe('← Going now')
    tap('putup-mode-back')
    await waitFor(() => expect(screen.getByTestId('going-now-view')).toBeTruthy())
    expect(window.history.state.idx).toBe(1)
    expect(segment()).toBe('Going now')
  })

  // Only a segment's own label, with no kind: a recipe or a batch that happens to be CALLED "Recipes" is a
  // sender like any other, and a harvest prefill still opens the form.
  it('an origin that is not a segment changes nothing about where a fresh page lands', async () => {
    going = []
    renderAt('/put-up?batch=kb-1', { state: { from: { label: 'Recipes', kind: 'recipe', id: 'rc-9' } }, idx: 0 })
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(backBtn().textContent).toBe('← Pantry')
    cleanup()
    renderAt('/put-up?batch=kb-1', { state: { from: { label: 'Ristra Cayenne' } }, idx: 0 })
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(backBtn().textContent).toBe('← Pantry')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('recipe mode is a full mode (PLAN-V3 D11)', () => {
  it('hides the search row, the header button and the segments, and shows ONE Back — the page\'s', async () => {
    renderAt('/put-up?recipe=rc-1')
    await screen.findByTestId('recipe-detail')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByTestId('putup-door')).toBeNull()
    expect(screen.queryByTestId('start-a-batch')).toBeNull()
    expect(screen.queryByTestId('putup-walk-door')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Put-Up view' })).toBeNull()
    expect(screen.getAllByTestId('putup-mode-back')).toHaveLength(1)
    // Green control: the same things ARE there once the mode is left.
    tap('putup-mode-back')
    await screen.findByTestId('recipes-view')
    expect(screen.getByRole('searchbox')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Put-Up view' })).toBeTruthy()
  })

  it('hands the Recipes view the URL\'s recipe as openId, and null on the list', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Recipes')
    await screen.findByTestId('recipes-view')
    expect(seen.recipes.at(-1).openId).toBeNull()
    expect(typeof seen.recipes.at(-1).onOpen).toBe('function')
    expect(typeof seen.recipes.at(-1).onBatchStarted).toBe('function')
    expect('onOpenBatch' in seen.recipes.at(-1)).toBe(false)
    tap('stub-recipes-row')
    await screen.findByTestId('recipe-detail')
    expect(seen.recipes.at(-1).openId).toBe('rc-1')
  })

  // ONE element for the list and the detail: a second mount would refetch two lists and reset the type
  // filter on every open and close.
  it('keeps ONE Recipes view mounted across list → recipe → Back', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Recipes')
    await screen.findByTestId('recipes-view')
    expect(seen.recipesMounts).toBe(1)
    tap('stub-recipes-row')
    await screen.findByTestId('recipe-detail')
    tap('putup-mode-back')
    await screen.findByTestId('recipes-view')
    expect(seen.recipesMounts).toBe(1)
  })

  it('a batch outranks a recipe on the URL, so the Recipes view is not mounted under a batch', async () => {
    renderAt('/put-up?batch=kb-1&recipe=rc-1')
    await screen.findByTestId('putup-batch-mode')
    expect(seen.recipesMounts).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('a sender inside an armed sheet (PLAN-V3 section 3 point 2, rule 4)', () => {
  const armed = () => !!readAnyMarker(window.history.state)

  it('one that lands first: a push, and each Back is one real step — the list, then out', async () => {
    renderAt('/put-up?view=pantry', { registry: true })
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-row')
    await waitFor(() => expect(armed()).toBe(true))
    const from = pops
    tap('stub-sheet-landed')
    await settle(from)
    await waitFor(() => expect(loc()).toBe('/put-up?view=pantry&batch=kb-1'))
    expect(armed()).toBe(false)
    expect(window.history.state.idx).toBe(1)
    await systemBack()
    expect(loc()).toBe('/put-up?view=pantry')
    expect(screen.queryByTestId('stub-row-sheet')).toBeNull()
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()
  })

  // The net. A plain push here would leave [list, list+marker, batch]: one Back press that does nothing.
  it('a sender that did not land first: the mode REPLACES the sheet\'s Back marker, so no Back press is dead', async () => {
    renderAt('/put-up?view=pantry', { registry: true })
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-row')
    await waitFor(() => expect(armed()).toBe(true))
    const length = window.history.length
    tap('stub-sheet-unlanded')
    await waitFor(() => expect(loc()).toBe('/put-up?view=pantry&batch=kb-1'))
    await flush()
    expect(armed()).toBe(false)                                 // the marker entry became the batch
    expect(window.history.length).toBe(length)                  // …and no entry was added on top of it
    expect(state()).toEqual({ from: { label: 'Pantry' } })
    await systemBack()
    expect(loc()).toBe('/put-up?view=pantry')
    expect(screen.getByTestId('pantry-view')).toBeTruthy()
    expect(screen.queryByTestId('stub-row-sheet')).toBeNull()
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()            // the second Back leaves: it was not eaten
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the callbacks the other lanes were promised (PLAN-V3 section 3, "Props")', () => {
  it('onOpenBatch reaches the closed list, the Pantry and the search results — and never the walk', async () => {
    renderAt('/put-up?state=closed')
    await screen.findByTestId('putup-closed-mode')
    expect(typeof seen.closed.at(-1).onOpenBatch).toBe('function')
    cleanup()
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    expect(typeof seen.pantry.at(-1).onOpenBatch).toBe('function')
    cleanup()
    renderAt('/put-up?view=pantry&find=mega')
    await screen.findByTestId('pantry-search-results')
    expect(typeof seen.search.at(-1).onOpenBatch).toBe('function')
    cleanup()
    renderAt('/put-up?session=putup')
    await screen.findByTestId('walk-place')
    expect(seen.walk.length).toBeGreaterThan(0)
    for (const p of seen.walk) {
      expect('onOpenBatch' in p).toBe(false)
      expect('onOpenRecipe' in p).toBe(false)
    }
  })

  it('onOpenRecipe reaches batch detail, beside the handlers it already had', async () => {
    renderAt('/put-up?batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    const p = seen.detail.at(-1)
    expect(typeof p.onOpenRecipe).toBe('function')
    expect(typeof p.onChanged).toBe('function')
    expect(typeof p.onRemoved).toBe('function')
  })

  it('the empty Pantry\'s two buttons: Put something up opens the door, Walk a place opens the walk', async () => {
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-empty-door-named')
    expect(screen.getByTestId('stub-door').getAttribute('data-initial-name')).toBe('kraut')
    cleanup()
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    // Wired straight to onClick, the callback is handed a click event: the door opens empty, never with
    // an object for a name.
    tap('stub-pantry-empty-door')
    expect(screen.getByTestId('stub-door').getAttribute('data-initial-name')).toBe('')
    cleanup()
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    tap('stub-pantry-empty-walk')
    await waitFor(() => expect(loc()).toBe('/put-up?session=putup'))
    expect(screen.getByTestId('walk-place')).toBeTruthy()
  })

  it('the door\'s escape closes the door and opens Start with the name it carried', async () => {
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    tap('putup-door')
    tap('stub-door-escape')
    expect(screen.queryByTestId('stub-door')).toBeNull()
    expect(screen.getByTestId('stub-start').getAttribute('data-initial-label')).toBe('Megatron mash')
    expect(loc()).toBe('/put-up?view=pantry')                   // one sheet handed over to another: no navigation
  })

  it('with no Start sheet there is nothing to escape to, so the door is handed no escape', async () => {
    renderAt('/put-up?view=pantry', { sheet: null })
    await screen.findByTestId('pantry-view')
    tap('putup-door')
    expect(screen.getByTestId('stub-door')).toBeTruthy()
    expect(seen.door.at(-1).onStartBatchInstead).toBeUndefined()
    expect(screen.queryByTestId('stub-door-escape')).toBeNull()
  })

  it('Start opened from its own button carries no name', async () => {
    renderAt('/put-up')
    await flush()
    pickSegment('Going now')
    tap('start-a-batch')
    expect(screen.getByTestId('stub-start').getAttribute('data-initial-label')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the Pantry list re-reads once on leaving a mode', () => {
  const READ = '/api/pantry?group=place'
  const hit = async () => { await screen.findByTestId('stub-search-hit-rc-1'); return 'stub-search-hit-rc-1' }
  // "Once" has two halves: it DOES read (the list a write in the mode may have changed), and it reads once,
  // not once per render.
  const readsExactly = async (n) => {
    await waitFor(() => expect(gets(READ)).toBe(n))
    await flush(); await flush()
    expect(gets(READ)).toBe(n)
  }

  it('a batch, left by the page\'s Back (a pop) to the Pantry', async () => {
    renderAt('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    await readsExactly(1)
    tap('stub-pantry-batch')
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(gets(READ)).toBe(1)                                  // the list is not read while a mode is open
    tap('putup-mode-back')
    await screen.findByTestId('pantry-view')
    await readsExactly(2)
  })

  it('a recipe, left by the system Back to the search it was opened from', async () => {
    renderAt('/put-up?view=pantry&find=petri')
    tap(await hit())
    await screen.findByTestId('recipe-detail')
    await flush()
    const before = gets(READ)
    expect(before).toBeGreaterThan(0)                           // instrument: the search did read the Pantry
    await systemBack()
    await screen.findByTestId('pantry-search-results')
    await readsExactly(before + 1)
  })

  it('a recipe, left by the page\'s Back (the push onto Recipes): nothing is read until the Pantry is chosen', async () => {
    renderAt('/put-up?view=pantry&find=petri')
    tap(await hit())
    await screen.findByTestId('recipe-detail')
    await flush()
    const before = gets(READ)
    tap('putup-mode-back')
    await screen.findByTestId('recipes-view')
    await flush(); await flush()
    expect(gets(READ)).toBe(before)                             // it landed on Recipes: nothing to read yet
    pickSegment('Pantry')
    await screen.findByTestId('pantry-view')
    await readsExactly(before + 1)
  })

  it('a cold ?batch= deep link with nothing going: one read when the Back\'s push lands on the Pantry', async () => {
    going = []
    renderAt('/put-up?view=pantry&batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    await flush()
    expect(gets(READ)).toBe(0)
    tap('putup-mode-back')
    await screen.findByTestId('pantry-view')
    await readsExactly(1)
  })
})
