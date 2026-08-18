// V4-LOGMANYDEPTHSTASH-001 — the water-amount class is submitted with the batch but was absent from
// the draft snapshot AND from both predicates. Two losses, one omission:
//   - a user who set the chips and dismissed came back to Normal/default, silently re-answering a
//     question they had already answered — on every row in the batch;
//   - neither guard channel knew the form was dirty, so a deploy reload landed on it and a stray
//     backdrop tap discarded it.
//
// Harness is LogMany.waterDepth.test.jsx (the REAL <ScopeChecklist>, because the per-row override
// renders inside its review list and stubbing it would leave that half untested while the suite went
// green) plus the reloadGate/OverlayDirtyProvider wiring from LogMany.reloadGateWire.test.jsx (real
// gate, no spy between them — a mocked setReloadBlocked would hide the exact "nothing holds it"
// blind spot). `searchParams` is a stable module-scope instance: LogMany's loader effect depends on
// it, so a fresh instance per call re-runs that effect forever.
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
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

import LogMany from '../pages/LogMany.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const PLANTINGS = [{ id: 'pl-1', name: 'Aji Dulce' }, { id: 'pl-2', name: 'Basil Row' }]
const STASH_KEY = 'gardenApp.draft.logmany'
const batchPosts = []

function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  clearReloadBlocks()
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: PLANTINGS.length, plantings: PLANTINGS })
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: PLANTINGS.length })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

async function renderReady(ui = <LogMany />) {
  const result = render(ui)
  await screen.findByText(/^Log watered on 2$/)
  return result
}
async function openReviewList() {
  fireEvent.click(await screen.findByText(/Review 2 plantings/))
}
async function confirm() {
  fireEvent.click(await screen.findByText(/^Log watered on 2$/))
  await waitFor(() => expect(batchPosts.length).toBe(1))
}

describe('LogMany amount class — draft stash round trip (V4-LOGMANYDEPTHSTASH-001)', () => {
  // The write half. Both bytes matter: a restored 'deep' recorded as source='default' would report a
  // deliberate pick as the preselected default and deflate the annotation-rate signal the
  // instrumentation gate reads (waterDepth.js header).
  it('a tapped batch chip is stashed with its source flag', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await waitFor(() => expect(readStash()?.batchDepth).toBe('deep'))
    expect(readStash().batchDepthTouched).toBe(true)
  })

  // The read half, and the landmine: the restore sets eventType + scope, which are the deps of the
  // "a new type or scope is a new batch" reset effect — so the reset fires in the SAME passive-effect
  // pass as the restore and would wipe the class if the apply effect were not declared after it.
  // Asserted on the WIRE, not just the chip: the class only matters if it reaches the POST.
  it('a stashed class is restored on the next mount and reaches the POST as a user choice', async () => {
    seedStash({ eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '', batchDepth: 'deep', batchDepthTouched: true })
    await renderReady()
    await waitFor(() => expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('false')
    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'deep', water_depth_source: 'user' })
  })

  it('a tapped per-row override is stashed', async () => {
    await renderReady()
    await openReviewList()
    fireEvent.click(screen.getByTestId('row-depth-toggle-pl-2'))
    fireEvent.click(screen.getByTestId('row-depth-pl-2-light'))
    await waitFor(() => expect(readStash()?.rowDepth).toEqual({ 'pl-2': 'light' }))
  })

  it('a stashed per-row override is restored and reaches plant_metadata', async () => {
    seedStash({ eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '', batchDepth: 'normal', batchDepthTouched: false, rowDepth: { 'pl-2': 'light' } })
    await renderReady()
    await openReviewList()
    await waitFor(() => expect(screen.getByTestId('row-depth-toggle-pl-2').getAttribute('aria-label')).toMatch(/Light/))
    // The row that was never overridden still inherits — a restore must not turn the whole list into
    // overrides, or the "N changed" count and the per-row source='user' flag both start lying.
    expect(screen.getByTestId('row-depth-toggle-pl-1').getAttribute('aria-label')).toMatch(/Normal/)
    await confirm()
    expect(batchPosts[0].plant_metadata).toEqual({ 'pl-2': { water_depth: 'light', water_depth_source: 'user' } })
  })

  // Negative control for the widened stash predicate: a mount nobody has touched must still write
  // nothing, or the "don't stash a pristine default" rule is gone and every mount rewrites the draft.
  it('an untouched form still stashes nothing', async () => {
    await renderReady()
    expect(readStash()).toBeNull()
  })

  // Negative control for the apply effect: it must be a ONE-SHOT handoff, not a permanent skip of the
  // new-batch reset. A class chosen for one type/scope riding onto a different batch is the exact
  // thing that reset effect exists to prevent.
  it('a restored class is still reset by a genuine type change (the reset is not disabled)', async () => {
    seedStash({ eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '', batchDepth: 'deep', batchDepthTouched: true })
    await renderReady()
    await waitFor(() => expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('true'))

    fireEvent.click((await screen.findByText('Flowering')).closest('button'))
    fireEvent.click((await screen.findByText('Watered')).closest('button'))
    await waitFor(() => expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('false')
    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'normal', water_depth_source: 'default' })
  })
})

describe('LogMany amount class — the guard predicate (V4-LOGMANYDEPTHSTASH-001)', () => {
  it('a tapped batch chip alone arms BOTH guard channels', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    onDirtyChange.mockClear()   // drop the pristine-mount report
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    expect(isReloadBlocked()).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('a tapped per-row override alone arms BOTH guard channels', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    await openReviewList()
    onDirtyChange.mockClear()
    fireEvent.click(screen.getByTestId('row-depth-toggle-pl-2'))
    fireEvent.click(screen.getByTestId('row-depth-pl-2-light'))
    expect(isReloadBlocked()).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  // The other side of the same coin, and the reason the guard terms are `batchDepthTouched` /
  // a non-empty rowDepth rather than "the value differs from the default": a preselected chip is not
  // user input, and arming here would hold a deploy and kill the backdrop for anyone who merely
  // opened Log Many.
  it('the preselected chip on a pristine mount arms NEITHER channel', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    // Non-vacuity: the chips really are on screen with Normal preselected.
    expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('true')
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
  })

  // Tapping the ALREADY-selected chip is still a deliberate answer — it flips water_depth_source to
  // 'user', which is a real change to what gets written, so both channels must see it.
  it('re-tapping the preselected chip counts (it changes what is recorded)', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('water-depth-normal'))
    expect(isReloadBlocked()).toBe(true)
    await confirm()
    expect(batchPosts[0].metadata).toEqual({ water_depth: 'normal', water_depth_source: 'user' })
  })
})
