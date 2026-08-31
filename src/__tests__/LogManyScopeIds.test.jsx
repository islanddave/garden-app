// V4-LOGMANYUXREFRESH-001 S4 / BD-073 — the PAGE half: what LogMany puts on the wire in PICK mode,
// and the count assertion made visible.
//
// Three things live here and nowhere else:
//   1. A PICK commit sends `scope:{type:'ids', plant_ids:[…]}` and OMITS exclude_plant_ids. The
//      server 400s a body carrying both, so "sent as an empty array" is a shipped-broken commit
//      that every component test would still pass.
//   2. BULK is UNCHANGED. S4 is a PICK-path change; a regression that routed the exclusion model
//      through the ids scope would silently turn "water the whole Bag Area" into "water the 40
//      plantings that were in the Bag Area when the preview ran".
//   3. The server's `warning` reaches the screen. lambda/events/index.js has re-read event_log
//      after every batch since BUG-LOGMANYPROJECTLESS-001 and returned a warning whenever the rows
//      written disagreed with the plantings resolved — and its own comment hands the surfacing to
//      this lane. Until now the field was read by nothing, so the assertion fired into a green tick.
//
// Harness mirrors LogManyPickFrameWiring.test.jsx: the REAL ScopeChecklist and the real stash, with
// only the network stubbed.
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

const LOCATIONS = [
  { id: 'pasture', name: 'Pasture', parent_id: null, sort_order: 1 },
  { id: 'bag', name: 'Bag Area', parent_id: 'pasture', sort_order: 1 },
]
const ALL = [
  { id: 'pl-1', name: 'Aji Dulce', crop_type_slug: 'pepper', location_id: 'bag' },
  { id: 'pl-2', name: 'Basil Row', crop_type_slug: 'basil', location_id: 'bag' },
  { id: 'pl-3', name: 'Pepper Row', crop_type_slug: 'pepper', location_id: 'pasture' },
  { id: 'pl-4', name: 'Sun Gold', crop_type_slug: 'tomato', location_id: 'bag' },
  { id: 'pl-5', name: 'Sunray', crop_type_slug: 'tomato', location_id: 'bag' },
  { id: 'pl-6', name: 'Black Krim', crop_type_slug: 'tomato', location_id: 'pasture' },
  { id: 'pl-7', name: 'Genovese', crop_type_slug: 'basil', location_id: null },
  { id: 'pl-8', name: 'Kousa Dogwood', crop_type_slug: null, location_id: null },
]

const batchPosts = []
let batchReply = null

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  batchReply = null
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: LOCATIONS })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: ALL.length, plantings: ALL })
      batchPosts.push(body)
      if (batchReply instanceof Error) return Promise.reject(batchReply)
      if (batchReply) return Promise.resolve(batchReply)
      const n = body.scope?.type === 'ids'
        ? body.scope.plant_ids.length
        : ALL.length - (body.exclude_plant_ids?.length ?? 0)
      return Promise.resolve({ batch_id: 'b-1', count: n })
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
const pickAndCommit = async (...ids) => {
  await enterPick()
  ids.forEach(id => fireEvent.click(screen.getByTestId(`pick-row-${id}`)))
  await waitFor(() => expect(commitButtons()[0].textContent).toBe(`Log watered on ${ids.length}`))
  fireEvent.click(commitButtons()[0])
  await waitFor(() => expect(batchPosts).toHaveLength(1))
}

describe('S4 — a PICK commit names the picks', () => {
  it('sends scope.type=ids carrying exactly what was picked', async () => {
    await renderReady()
    await pickAndCommit('pl-4', 'pl-6')
    expect(batchPosts[0].scope.type).toBe('ids')
    expect([...batchPosts[0].scope.plant_ids].sort()).toEqual(['pl-4', 'pl-6'])
  })

  // OMITTED, not empty. validateBatchBody rejects a body carrying both models, so an
  // `exclude_plant_ids: []` that "looks harmless" is a 400 on every PICK batch — and one that
  // carried the complement would be a 400 the user could never explain.
  it('omits exclude_plant_ids entirely on the ids path', async () => {
    await renderReady()
    await pickAndCommit('pl-4')
    expect('exclude_plant_ids' in batchPosts[0]).toBe(false)
  })

  it('carries the batch note, date and depth metadata unchanged onto the ids scope', async () => {
    await renderReady()
    await enterPick()
    fireEvent.click(screen.getByTestId('pick-row-pl-4'))
    fireEvent.click(screen.getByTestId('pick-done'))
    await waitFor(() => expect(commitButtons()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('logmany-notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes for this batch'), { target: { value: 'side-dressed' } })
    fireEvent.click(commitButtons()[0])
    await waitFor(() => expect(batchPosts).toHaveLength(1))
    expect(batchPosts[0].scope.type).toBe('ids')
    expect(batchPosts[0].notes).toBe('side-dressed')
    // The water-depth metadata rides on every watering batch and is keyed to the committed set —
    // an ids scope must not have quietly dropped it on the way past.
    expect(batchPosts[0].metadata).toBeTruthy()
  })

  it('BULK is untouched — still the shipped scope plus the complement', async () => {
    await renderReady()
    fireEvent.click(screen.getByText(/Review \d+ plantings/))
    fireEvent.click(screen.getByText('Sun Gold'))
    await waitFor(() => expect(commitButtons()[0].textContent).toBe(`Log watered on ${ALL.length - 1}`))
    fireEvent.click(commitButtons()[0])
    await waitFor(() => expect(batchPosts).toHaveLength(1))
    expect(batchPosts[0].scope).toEqual({ type: 'all' })
    expect(batchPosts[0].exclude_plant_ids).toEqual(['pl-4'])
  })

  it('the remembered scope stays the POOL, never the id list', async () => {
    // localStorage 'quicklog.lastScope' seeds the NEXT batch. Writing `{type:'ids'}` there would
    // re-open Log Many pinned to eight ids from yesterday, and the restore path validates only
    // all/project/space so it would silently fall back — after a dry-run against a scope that no
    // longer means anything.
    await renderReady()
    await pickAndCommit('pl-4')
    expect(JSON.parse(localStorage.getItem('quicklog.lastScope'))).toEqual({ type: 'all' })
  })

  it('an empty pick cannot commit at all, so an empty id list never reaches the server', async () => {
    await renderReady()
    await enterPick()
    expect(commitButtons()[0].disabled).toBe(true)
    fireEvent.click(commitButtons()[0])
    expect(batchPosts).toHaveLength(0)
  })

  it('names the picks on the result card instead of the pool they came from', async () => {
    await renderReady()
    await pickAndCommit('pl-4', 'pl-6')
    expect(await screen.findByText(/the plantings you picked/)).toBeTruthy()
  })
})

describe('S4 — the count assertion is VISIBLE, not just logged', () => {
  it('renders the server warning on the success card when fewer rows were written', async () => {
    batchReply = {
      batch_id: 'b-1',
      count: 6,
      requested_count: 8,
      skipped_plant_ids: ['pl-7', 'pl-8'],
      warning: '2 of 8 selected plantings could not be logged',
    }
    await renderReady()
    fireEvent.click(commitButtons()[0])
    const el = await screen.findByTestId('logmany-partial-warning')
    expect(el.textContent).toMatch(/2 of 8 selected plantings could not be logged/)
    // Both numbers, so the user can see the shortfall without doing the subtraction.
    expect(el.textContent).toMatch(/6 of 8 were logged/)
    // It is the one thing on a success screen that is not success.
    expect(el.getAttribute('role')).toBe('alert')
  })

  it('a normal batch shows no warning at all — this is not a permanent scold', async () => {
    await renderReady()
    await pickAndCommit('pl-4')
    expect(await screen.findByText('in the plantings you picked')).toBeTruthy()
    expect(document.querySelector('[data-testid="logmany-partial-warning"]')).toBeNull()
  })

  it('surfaces the 409 when the server refuses to log against a stale pick', async () => {
    // SCOPE_IDS_UNRESOLVED. The server writes nothing and says so; the page must show that text
    // rather than a bare "HTTP 409", and must NOT land on the success card.
    const err = new Error('1 of 2 picked plantings are no longer available to log — nothing was logged. Re-check your picks.')
    err.status = 409
    batchReply = err
    await renderReady()
    await pickAndCommit('pl-4', 'pl-6')
    expect(await screen.findByText(/no longer available to log/)).toBeTruthy()
    expect(screen.queryByText(/plantings watered/)).toBeNull()
    // The picks survive the refusal — they are the thing the user has to fix.
    expect(commitButtons()[0].textContent).toBe('Log watered on 2')
  })
})
