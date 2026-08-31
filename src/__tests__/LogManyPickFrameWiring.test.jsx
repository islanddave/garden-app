// V4-LOGMANYUXREFRESH-001 S3 — the two things that live in the PAGE, not in the component.
//
// ScopeChecklist owns the frame; LogMany owns the commit. The seam between them is three bytes wide
// and every one of them is a way to ship something broken while both files pass their own tests:
//   1. `primaryAction` is a NODE handed down. If the page does not suppress its own copy while the
//      frame is up, the same `Log watered on 3` is in the document TWICE — one of them behind an
//      opaque full-screen layer, unreachable, and every getByText for it becomes ambiguous.
//   2. `frameOpen` is the signal that drives (1). It is a SIBLING of selectionState, so it must not
//      leak into the draft stash: a restore that reopened a full-screen picker over a form the user
//      came back to would be a new surprise, not a restored one.
//   3. `mode` DOES ride in the stash. Without it, a dismissed 3-planting pick comes back as a
//      236-exclusion review list — the same set, in the shape the user did not leave it in.
//
// Harness mirrors LogManySelectionSurvival.test.jsx: the REAL ScopeChecklist (the state under test
// is inside it), the real stash, a stable module-scope searchParams.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: {} }
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch, getToken: vi.fn(async () => null) }) }))

import LogMany from '../pages/LogMany.jsx'

const LOCATIONS = [{ id: 'bag', name: 'Bag Area', parent_id: null, sort_order: 1 }]
// Eight rows so the crop chip row clears CHIPS_MIN_ROWS and the frame renders its full track 1.
const ALL = [
  { id: 'pl-1', name: 'Aji Dulce', crop_type_slug: 'pepper' },
  { id: 'pl-2', name: 'Basil Row', crop_type_slug: 'basil' },
  { id: 'pl-3', name: 'Pepper Row', crop_type_slug: 'pepper' },
  { id: 'pl-4', name: 'Sun Gold', crop_type_slug: 'tomato' },
  { id: 'pl-5', name: 'Sunray', crop_type_slug: 'tomato' },
  { id: 'pl-6', name: 'Black Krim', crop_type_slug: 'tomato' },
  { id: 'pl-7', name: 'Genovese', crop_type_slug: 'basil' },
  { id: 'pl-8', name: 'Kousa Dogwood', crop_type_slug: null },
]

const STASH_KEY = 'gardenApp.draft.logmany'
const batchPosts = []
const readStash = () => {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
const seedStash = (data) => sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: LOCATIONS })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: ALL.length, plantings: ALL })
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: ALL.length - (body.exclude_plant_ids?.length ?? 0) })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

const renderReady = async () => {
  const out = render(<LogMany />)
  await screen.findByText(/Review \d+ plantings/)
  return out
}
const commitButtons = () => [...document.querySelectorAll('button')].filter(b => /^Log \w+ on \d+$/.test(b.textContent))
const enterPick = async () => {
  fireEvent.click(screen.getByTestId('sc-mode-pick'))
  return screen.findByTestId('pick-frame')
}

describe('S3 wiring — the commit control moves, it does not multiply', () => {
  it('one on the page while the frame is closed; one inside the frame while it is open', async () => {
    await renderReady()
    expect(commitButtons()).toHaveLength(1)
    const frame = await enterPick()
    // Still ONE — and it is now the frame's, not the page's.
    const inFrame = commitButtons()
    expect(inFrame).toHaveLength(1)
    expect(frame.contains(inFrame[0])).toBe(true)
    fireEvent.click(screen.getByTestId('pick-done'))
    await waitFor(() => expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull())
    const back = commitButtons()
    expect(back).toHaveLength(1)
    expect(back[0].closest('[data-testid="pick-frame"]')).toBeNull()
  })

  it('the frame\'s copy really commits — it is the page\'s handler, not a look-alike', async () => {
    await renderReady()
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-pl-4'))     // Sun Gold
    await waitFor(() => expect(commitButtons()[0].textContent).toBe('Log watered on 1'))
    fireEvent.click(commitButtons()[0])
    await waitFor(() => expect(batchPosts).toHaveLength(1))
    // V4-LOGMANYUXREFRESH-001 S4 — THIS ASSERTION CHANGED, and the change is the slice. S3 shipped
    // PICK on the existing wire contract (the scope plus its COMPLEMENT as 7 exclusions) precisely
    // so it could ship without a Lambda diff; S4 added `scope.type:'ids'` and the commit now names
    // the picks. The old form is still correct arithmetic and is still what BULK sends — what it
    // cannot do is let the server notice that the set it resolves at commit time is no longer the
    // set the preview showed. See the confirm() comment in LogMany.jsx.
    expect(batchPosts[0].scope).toEqual({ type: 'ids', plant_ids: ['pl-4'] })
    // OMITTED, not empty: the server 400s a body carrying both models.
    expect('exclude_plant_ids' in batchPosts[0]).toBe(false)
  })

  it('BULK still commits on the exclusion contract — S4 changed the PICK path only', async () => {
    await renderReady()
    fireEvent.click(await screen.findByText(/Review \d+ plantings/))
    fireEvent.click(screen.getByTestId('sc-select-none'))
    fireEvent.click(screen.getByText('Sun Gold'))
    await waitFor(() => expect(commitButtons()[0].textContent).toBe('Log watered on 1'))
    fireEvent.click(commitButtons()[0])
    await waitFor(() => expect(batchPosts).toHaveLength(1))
    expect(batchPosts[0].scope).toEqual({ type: 'all' })
    expect(batchPosts[0].exclude_plant_ids.sort()).toEqual(
      ALL.map(p => p.id).filter(id => id !== 'pl-4').sort(),
    )
  })
})

describe('S3 wiring — the page stops pointing at controls PICK mode does not have', () => {
  // The water-depth hint says "Change individual ones under Review below." The per-row override is
  // a REVIEW-LIST affordance (renderRowExtra), and PICK mode has no review list — the frame's rows
  // are name + crop type by design. Left unconditional, the page would send the user looking for a
  // control that is not on screen, which is the same dishonesty V4-LOGMANYHONEST-001 fixed one
  // Section up on this very page.
  it('drops the "under Review below" pointer in PICK mode and keeps it in BULK', async () => {
    await renderReady()
    const hint = () => screen.getByText(/Applies to every planting in this batch/).textContent
    expect(hint()).toMatch(/Change individual ones under Review below/)
    await enterPick()
    await waitFor(() => expect(hint()).not.toMatch(/Review below/))
    expect(hint()).toMatch(/Applies to every planting in this batch/)
  })
})

describe('S3 wiring — what rides in the draft stash and what must not', () => {
  it('the MODE is stashed, so a dismissed pick comes back as a pick', async () => {
    await renderReady()
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-pl-4'))
    await waitFor(() => expect(readStash()?.selection?.mode).toBe('pick'))
    expect(readStash().selection.decisions).toEqual({ 'pl-4': true })
    expect(readStash().selection.baseline).toBe(false)
  })

  it('frameOpen is NOT stashed — a restore returns to the form, never to a full-screen picker', async () => {
    await renderReady()
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-pl-4'))
    await waitFor(() => expect(readStash()?.selection).toBeTruthy())
    expect('frameOpen' in readStash().selection).toBe(false)

    cleanup()
    render(<LogMany />)
    await screen.findByTestId('sc-pick-summary')
    expect(document.querySelector('[data-testid="pick-frame"]')).toBeNull()
    expect(screen.getByTestId('sc-open-pick').textContent).toBe('Change picks (1)')
  })

  it('a stash whose mode is garbage restores as BULK rather than propagating it', async () => {
    seedStash({
      eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '',
      selection: { decisions: { 'pl-4': false }, baseline: true, touched: true, mode: { evil: 1 } },
    })
    render(<LogMany />)
    await screen.findByText(/Review \d+ plantings/)
    expect(document.querySelector('[data-testid="sc-pick-summary"]')).toBeNull()
  })

  it('"Log more" clears the mode with the rest of the selection — a new batch is a new question', async () => {
    await renderReady()
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-pl-4'))
    await waitFor(() => expect(commitButtons()[0].textContent).toBe('Log watered on 1'))
    fireEvent.click(commitButtons()[0])
    await screen.findByText('Log more')
    fireEvent.click(screen.getByText('Log more'))
    // Back on a clean form: BULK, everything selected, no pick summary anywhere.
    await screen.findByText(/Review \d+ plantings/)
    expect(document.querySelector('[data-testid="sc-pick-summary"]')).toBeNull()
  })
})
