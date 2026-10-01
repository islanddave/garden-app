// Put-Up UX pass R1, lane A — the door's escape, joined: "Still going (a ferment)? Start a batch instead →"
// (PLAN-V3 D6, D10; contract 3). The REAL page and the REAL Start sheet; the Put something up door is a
// stand-in that honours the one prop lane C was promised, `onStartBatchInstead(name)`, from inside a real
// armed <Sheet>.
//
// WHAT THIS FILE HOLDS:
//   · a stored start/new draft, then the door's escape -> Start shows the DOOR's name, not yesterday's
//     half-typed batch (the page hands the name on as `initialLabel`; the sheet lets it win);
//   · one armed sheet handing over to another needs no landing: Back closes Start, the next Back leaves the
//     page — neither press does nothing, and nothing navigated.
// MUTATIONS: the page drops the name (opens Start with '') -> the first test reds; the sheet restores the
// draft over a handed-in name -> the first test reds (the same test PutUpStartFrom.laneA.test.jsx holds
// at the sheet).
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchMock, seen } = vi.hoisted(() => ({ fetchMock: vi.fn(), seen: { door: [] } }))
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
// Lane C's door, as far as this page is concerned: a real armed sheet with the escape line in it. The door
// clears its own draft before calling (its contract); here there is none to clear.
vi.mock('../components/pantry/PutSomethingUpSheet.jsx', async () => {
  const { default: Sheet } = await import('../components/forms/Sheet.jsx')
  return {
    default: (props) => {
      seen.door.push(props)
      return (
        <Sheet open onClose={props.onClose} title="Put something up" armsBack>
          <div data-testid="stub-door">
            {typeof props.onStartBatchInstead === 'function' && (
              <button type="button" data-testid="stub-door-escape" onClick={() => props.onStartBatchInstead('Megatron mash')}>
                Still going (a ferment)? Start a batch instead →
              </button>
            )}
          </div>
        </Sheet>
      )
    },
  }
})

import PutUp from '../pages/PutUp.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readAnyMarker } from '../lib/backNav.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:start:new'
const storeDraft = (data) => localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'start', savedAt: Date.now(), data }))
const draft = () => JSON.parse(localStorage.getItem(DRAFT_KEY))

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (method === 'POST' && path === '/api/kitchen-batches') return Promise.resolve({ id: 'kb-new', label: 'Megatron mash' })
    if (method !== 'GET') return Promise.resolve(null)
    if (path === '/api/kitchen-batches/kb-new') return Promise.resolve({ id: 'kb-new', label: 'Megatron mash', inputs: [], stages: [], outputs: [] })
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches: [] })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    return Promise.resolve(null)
  })
}

let pops = 0
window.addEventListener('popstate', () => { pops += 1 })
const settle = (from) => act(async () => {
  const deadline = Date.now() + 2000
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  await new Promise((r) => setTimeout(r, 0))
})
const systemBack = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }
const armed = () => !!readAnyMarker(window.history.state)

function renderPage() {
  window.history.pushState({ __floor: 1 }, '', '/floor')
  window.history.pushState(null, '', '/put-up?view=pantry')
  return render(
    <BrowserRouter>
      <DismissRegistryProvider>
        <Routes>
          <Route path="/put-up" element={<PutUp />} />
          <Route path="/floor" element={<div data-testid="floor">the entry under the app</div>} />
        </Routes>
      </DismissRegistryProvider>
    </BrowserRouter>,
  )
}
const tap = (id) => fireEvent.click(screen.getByTestId(id))

beforeEach(() => { fetchMock.mockReset(); wire(); seen.door.length = 0; localStorage.clear(); sessionStorage.clear(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the door\'s escape opens Start with the name it carried', () => {
  it('a stored start/new draft, then the escape: Start shows the door\'s name — and the door is gone', async () => {
    storeDraft({ label: 'Half-typed yesterday', chip: 'yesterday', earlier: null, pickedDate: '', kind: 'candy', kindOther: '', key: 'k-old' })
    renderPage()
    await screen.findByTestId('pantry-view')
    tap('putup-door')
    await screen.findByTestId('stub-door')
    tap('stub-door-escape')
    const name = await screen.findByTestId('start-label')
    expect(name.value).toBe('Megatron mash')
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy()
    expect(screen.queryByTestId('stub-door')).toBeNull()
    // The rest of yesterday's draft did not come back with it…
    expect(screen.getByTestId('start-when-today').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('start-kind-toggle').getAttribute('aria-expanded')).toBe('false')
    // …and what is stored now is this start, so reopening Start later shows this name, not that one.
    expect(draft().data.label).toBe('Megatron mash')
    expect(window.location.pathname + window.location.search).toBe('/put-up?view=pantry')
  })

  it('Start opened from its own button afterwards carries no name: a stored draft restores as it always did', async () => {
    storeDraft({ label: 'Half-typed yesterday', chip: 'yesterday', earlier: null, pickedDate: '', kind: null, kindOther: '', key: 'k-old' })
    renderPage()
    await screen.findByTestId('pantry-view')
    fireEvent.click(screen.getByRole('radio', { name: 'Going now' }))
    tap('start-a-batch')
    expect((await screen.findByTestId('start-label')).value).toBe('Half-typed yesterday')
  })

  // One armed sheet handing over to another in ONE handler reuses the Back marker (the seat's probe, held
  // here at the page): no landing is needed and none is done.
  it('Back closes Start; the next Back leaves the page — no press is dead, and nothing navigated', async () => {
    renderPage()
    await screen.findByTestId('pantry-view')
    tap('putup-door')
    await waitFor(() => expect(armed()).toBe(true))
    const length = window.history.length
    tap('stub-door-escape')
    await screen.findByTestId('start-label')
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(armed()).toBe(true)
    expect(window.history.length).toBe(length)                   // one marker, reused: no second entry
    await systemBack()
    await waitFor(() => expect(screen.queryByTestId('start-label')).toBeNull())
    expect(screen.queryByTestId('stub-door')).toBeNull()
    expect(window.location.pathname + window.location.search).toBe('/put-up?view=pantry')
    expect(screen.getByTestId('pantry-view')).toBeTruthy()
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()
  })
})

// The REAL sheet's landing meeting the REAL page's opener, on a real history stack: the sheet closes, its
// Back marker is consumed, and only then does the page push the batch. So the stack is [list, batch] — and
// the escape's name is what was started.
describe('Start it, after the escape: the landing and the one opener leave no dead Back entry', () => {
  it('the batch opens by a push; Back returns to the list it was started from; the next Back leaves', async () => {
    renderPage()
    await screen.findByTestId('pantry-view')
    tap('putup-door')
    await waitFor(() => expect(armed()).toBe(true))
    tap('stub-door-escape')
    await screen.findByTestId('start-label')
    const depth = window.history.state.idx
    const from = pops
    await act(async () => { tap('start-submit') })
    await settle(from)
    await waitFor(() => expect(window.location.search).toBe('?view=pantry&batch=kb-new'))
    await screen.findByTestId('putup-batch-mode')
    expect(armed()).toBe(false)                                  // the sheet's marker is gone, not stranded under the batch
    expect(window.history.state.idx).toBe(depth + 1)             // one push
    expect(JSON.parse(fetchMock.mock.calls.find(([p, o]) => p === '/api/kitchen-batches' && o?.method === 'POST')[1].body).label)
      .toBe('Megatron mash')
    // The batch names no origin, so its Back says the segment it leaves onto.
    expect(screen.getByTestId('putup-mode-back').textContent).toBe('← Pantry')
    await systemBack()
    expect(window.location.pathname + window.location.search).toBe('/put-up?view=pantry')
    expect(screen.getByTestId('pantry-view')).toBeTruthy()
    expect(screen.queryByTestId('start-label')).toBeNull()
    await systemBack()
    expect(screen.getByTestId('floor')).toBeTruthy()
  })
})
