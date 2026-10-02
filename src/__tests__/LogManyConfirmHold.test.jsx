// BUG-LOGMANYSTALECONFIRM-001 — the confirm button is HELD while the review card counts.
//
// THE DEFECT, in one line: from a scope / event-type / date change until the dry-run answered, the
// card read "Counting…" but LogMany's button stayed live on the PREVIOUS preview's count, and a tap
// posted the NEW scope with the OLD exclude_plant_ids. The server subtracts the excluded ids from the
// scope it resolves itself (lambda/events/index.js, `AND NOT (p.id = ANY(excludeIds))`), so for a
// "start with nothing selected" user that is an over-write: one planting picked in the Trough, then
// "All active", then Log, wrote a second planting that was never picked and never shown.
//
// THE RULE NOW: ScopeChecklist tags what it lifts with the scope/type/date it was resolved for
// (`previewFor`), and LogMany holds the confirm — disabled, reading the card's own "Counting…" —
// until that tag is the one on screen.
//
// Harness mirrors LogManySelectionSurvival.test.jsx — the REAL <ScopeChecklist> under the real
// <LogMany> (the hand-off between the two IS the thing under test, so a stub would test nothing) —
// with one addition: a dry-run that does not answer until the test lands it. The mock deliberately
// IGNORES the abort signal, so a superseded request really does come back; real `fetch` rejects an
// aborted call, which is the easier half of the same race.
//
// ASSERTION ORDER in `expectHeld` is deliberate: the tap comes first and "nothing was posted" is
// checked first, so with the product change taken out the red is the wrong POST itself (scope,
// exclusions, and what the server would have written) rather than a label mismatch.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
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
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

// Three scopes, three different sizes, so a count on the button names the scope it came from:
// All active = 3, Trough = 2, Bag Area = 1.
const LOCATIONS = [
  { id: 'bag', name: 'Bag Area', parent_id: null, sort_order: 1 },
  { id: 'trough', name: 'Trough', parent_id: null, sort_order: 2 },
]
const ALL = [
  { id: 'pl-1', name: 'Aji Dulce' },
  { id: 'pl-2', name: 'Basil Row' },
  { id: 'pl-3', name: 'Pepper Row' },
]
const TROUGH_ONLY = [ALL[0], ALL[1]]
const BAG_ONLY = [ALL[2]]
const ALL_SCOPE = { type: 'all' }
const TROUGH_SCOPE = { type: 'space', location_id: 'trough' }
const BAG_SCOPE = { type: 'space', location_id: 'bag' }

// The mock server's scope resolution, shared by the dry-run and the real write — the same property
// the Lambda has (one resolver, and the write subtracts exclude_plant_ids from what IT resolves).
const resolveScope = (scope) => (
  scope?.type === 'ids' ? ALL.filter(p => scope.plant_ids.includes(p.id))
    : scope?.location_id === 'trough' ? TROUGH_ONLY
    : scope?.location_id === 'bag' ? BAG_ONLY
    : ALL
)
const written = (body) => resolveScope(body.scope)
  .filter(p => !(body.exclude_plant_ids ?? []).includes(p.id))
  .map(p => p.name)

const STASH_KEY = 'gardenApp.draft.logmany'
const readStash = () => {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
const seedStash = (data) => sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))

const batchPosts = []
const dryRuns = []
// false = a dry-run answers at once (getting the page to a known state); true = it waits in
// `inFlight` until the test lands or fails it.
let deferDryRuns = false
const inFlight = []

// What the wire saw, with the consequence beside it: the scope, the exclusions, and the plantings
// the server would have written for that pair.
const wire = () => batchPosts.map(b => ({
  scope: b.scope,
  ...('exclude_plant_ids' in b ? { exclude_plant_ids: b.exclude_plant_ids } : {}),
  written: written(b),
}))

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  dryRuns.length = 0
  inFlight.length = 0
  deferDryRuns = false
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  clearReloadBlocks()
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: LOCATIONS })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) {
        dryRuns.push(body)
        const rows = resolveScope(body.scope)
        const answer = { count: rows.length, plantings: rows }
        if (!deferDryRuns) return Promise.resolve(answer)
        return new Promise((resolve, reject) => inFlight.push({
          body, land: () => resolve(answer), fail: (msg) => reject(new Error(msg)),
        }))
      }
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: written(body).length })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

// The OLDEST in-flight dry-run for a scope (by its location, or 'all'), taken off the queue.
const take = (where) => {
  const i = inFlight.findIndex(w => (w.body.scope?.location_id ?? 'all') === where)
  if (i < 0) throw new Error(`no dry-run in flight for ${where}; in flight: ${JSON.stringify(inFlight.map(w => w.body.scope))}`)
  return inFlight.splice(i, 1)[0]
}
const land = async (where) => { const w = take(where); await act(async () => { w.land() }) }
const fail = async (where, msg) => { const w = take(where); await act(async () => { w.fail(msg) }) }

const renderReady = async (ui = <LogMany />) => {
  const out = render(ui)
  await screen.findByText(/Review \d+ plantings/)
  return out
}
// The page's ONE commit button, whatever it currently reads. Found by what it can say rather than by
// one label, so the same handle works held, live and saving.
const CONFIRM_TEXT = /^(Counting…|Logging…|Log .+ on \d+)$/
const confirmButton = () => {
  const found = [...document.querySelectorAll('button')].filter(b => CONFIRM_TEXT.test(b.textContent))
  expect(found).toHaveLength(1)
  return found[0]
}
const liveConfirm = (label) => waitFor(() => {
  const b = confirmButton()
  expect(b.textContent).toBe(label)
  expect(b.disabled).toBe(false)
  return b
})
const expectHeld = () => {
  fireEvent.click(confirmButton())
  expect(wire()).toEqual([])
  const b = confirmButton()
  expect(b.textContent).toBe('Counting…')
  expect(b.disabled).toBe(true)
}
const openList = async () => {
  await screen.findByText(/(Review|Hide) \d+ plantings?/)
  const link = screen.queryByText(/Review \d+ plantings?/)
  if (link) fireEvent.click(link)
}

describe('the confirm is held while the preview for what is on screen has not landed', () => {
  // Table case 1. Before: the button read "Log watered on 3" and a tap posted the Trough with no
  // exclusions — 2 written under a button that promised 3.
  it('All active → Trough: held during the count, then the Trough count and the Trough POST', async () => {
    await renderReady()
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))
    fireEvent.click(await screen.findByText('Trough'))

    expectHeld()

    await land('trough')
    fireEvent.click(await liveConfirm('Log watered on 2'))
    expect(wire()).toEqual([{ scope: TROUGH_SCOPE, exclude_plant_ids: [], written: ['Aji Dulce', 'Basil Row'] }])
  })

  // Table case 2 — the over-write. Before: the button read "Log watered on 1" and a tap posted
  // All active minus Basil Row, which wrote Aji Dulce AND Pepper Row.
  it('"start with nothing selected", one pick in the Trough → All active: held, then exactly the one pick', async () => {
    localStorage.setItem('quicklog.defaultAllSelected', '0')
    await renderReady()
    fireEvent.click(screen.getByText('By zone'))
    fireEvent.click(await screen.findByText('Trough'))
    await screen.findByText(/Review 2 plantings/)
    await openList()
    fireEvent.click(screen.getByText('Aji Dulce'))
    await liveConfirm('Log watered on 1')
    deferDryRuns = true
    fireEvent.click(screen.getByText('All active'))

    expectHeld()

    await land('all')
    fireEvent.click(await liveConfirm('Log watered on 1'))
    expect(wire()).toHaveLength(1)
    expect(wire()[0].scope).toEqual(ALL_SCOPE)
    expect([...wire()[0].exclude_plant_ids].sort()).toEqual(['pl-2', 'pl-3'])
    expect(wire()[0].written).toEqual(['Aji Dulce'])
  })

  it('the card and the button read the same word, and the hold wears the existing disabled treatment', async () => {
    await renderReady()
    const live = await liveConfirm('Log watered on 3')
    const box = { width: live.style.width, minHeight: live.style.minHeight }
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))

    // One in the review card, one on the button — the same string.
    expect(screen.getAllByText('Counting…')).toHaveLength(2)
    const heldBtn = confirmButton()
    expect(heldBtn.textContent).toBe('Counting…')
    expect(heldBtn.disabled).toBe(true)
    expect(heldBtn.style.opacity).toBe('0.5')
    expect(heldBtn.style.cursor).toBe('default')
    // Same box as the live button: full width over a fixed floor, so the shorter label moves nothing.
    expect({ width: heldBtn.style.width, minHeight: heldBtn.style.minHeight }).toEqual(box)
    expect(box).toEqual({ width: '100%', minHeight: '48px' })

    await land('bag')
    const back = await liveConfirm('Log watered on 1')
    expect(back.style.opacity).toBe('1')
    expect(screen.queryByText('Counting…')).toBeNull()
  })

  it('an event-type change holds it too', async () => {
    await renderReady()
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.click(screen.getByText('Fertilized / Fed'))

    expectHeld()

    const asked = inFlight[0].body.event_type
    expect(asked).not.toBe('watering')
    await land('all')
    const b = await waitFor(() => { const x = confirmButton(); expect(x.disabled).toBe(false); return x })
    expect(b.textContent).toMatch(/^Log .+ on 3$/)
    fireEvent.click(b)
    expect(batchPosts).toHaveLength(1)
    expect(batchPosts[0].event_type).toBe(asked)
  })

  it('a date change holds it too', async () => {
    await renderReady()
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.change(screen.getByLabelText(/Event date/), { target: { value: '2026-08-20' } })

    expectHeld()

    expect(inFlight[0].body.event_date).toBe('2026-08-20')
    await land('all')
    fireEvent.click(await liveConfirm('Log watered on 3'))
    expect(batchPosts).toHaveLength(1)
    expect(batchPosts[0].event_date).toBe('2026-08-20')
  })
})

describe('rapid changes — only the answer for what is on screen releases the hold', () => {
  const abc = async () => {
    await renderReady()
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))            // A — Bag Area (the first zone), 1
    fireEvent.click(await screen.findByText('Trough'))      // B — Trough, 2
    fireEvent.click(screen.getByText('All active'))         // C — All active, 3
    expect(inFlight.map(w => w.body.scope)).toEqual([BAG_SCOPE, TROUGH_SCOPE, ALL_SCOPE])
  }

  it('A → B → C, with B then A landing before C: neither older answer re-enables the button', async () => {
    await abc()
    expectHeld()

    await land('trough')
    expectHeld()
    // …and the stale answer did not reach the card either.
    expect(screen.queryByText(/(Review|Hide) \d+ plantings?/)).toBeNull()

    await land('bag')
    expectHeld()
    expect(screen.queryByText(/(Review|Hide) \d+ plantings?/)).toBeNull()

    await land('all')
    fireEvent.click(await liveConfirm('Log watered on 3'))
    expect(wire()).toEqual([{ scope: ALL_SCOPE, exclude_plant_ids: [], written: ['Aji Dulce', 'Basil Row', 'Pepper Row'] }])
  })

  it('A → B → C, with C landing FIRST: the older answers arriving afterwards change nothing', async () => {
    await abc()
    expectHeld()

    await land('all')
    await liveConfirm('Log watered on 3')

    await land('trough')
    await land('bag')
    expect(confirmButton().textContent).toBe('Log watered on 3')
    expect(confirmButton().disabled).toBe(false)
    expect(screen.getByText(/Review 3 plantings/)).toBeDefined()

    fireEvent.click(confirmButton())
    expect(wire()).toEqual([{ scope: ALL_SCOPE, exclude_plant_ids: [], written: ['Aji Dulce', 'Basil Row', 'Pepper Row'] }])
  })
})

describe('a preview that FAILS', () => {
  // The state after a failure is the one the page already had: the card shows the error, and the
  // button reads "on 0" and is disabled. What must NOT happen is either of the two new ways to get
  // it wrong — a live button on the previous scope's number, or a "Counting…" that never ends.
  it('leaves no stale number and no endless "Counting…", and the page\'s own way forward still works', async () => {
    await renderReady()
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))
    expectHeld()

    await fail('bag', 'Request timed out')
    expect((await screen.findByRole('alert')).textContent).toBe('Request timed out')
    expect(screen.queryByText('Counting…')).toBeNull()
    expect(confirmButton().textContent).toBe('Log watered on 0')
    expect(confirmButton().disabled).toBe(true)
    fireEvent.click(confirmButton())
    expect(wire()).toEqual([])

    // The way forward the page already offered: tapping a scope chip asks again (here the SAME
    // zone, so this is a retry in everything but name).
    fireEvent.click(screen.getByText('Bag Area'))
    expectHeld()
    await land('bag')
    fireEvent.click(await liveConfirm('Log watered on 1'))
    expect(wire()).toEqual([{ scope: BAG_SCOPE, exclude_plant_ids: [], written: ['Pepper Row'] }])
  })

  it('on first load behaves as it did: error on the card, "on 0" disabled, and a chip tap recovers', async () => {
    deferDryRuns = true
    render(<LogMany />)
    await waitFor(() => expect(inFlight).toHaveLength(1))
    await fail('all', 'Failed to fetch')
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch')
    expect(screen.queryByText('Counting…')).toBeNull()
    expect(confirmButton().textContent).toBe('Log watered on 0')
    expect(confirmButton().disabled).toBe(true)

    fireEvent.click(screen.getByText('All active'))
    await land('all')
    await liveConfirm('Log watered on 3')
  })
})

describe('what the hold does NOT change', () => {
  // First load: nothing has answered yet, so there is no tag and no stale number to hold back. The
  // button reads "on 0" and is disabled, exactly as before; only the card says "Counting…".
  it('first load — "on 0" and disabled until the first preview lands', async () => {
    deferDryRuns = true
    render(<LogMany />)
    await waitFor(() => expect(inFlight).toHaveLength(1))
    await screen.findByText('Counting…')
    expect(screen.getAllByText('Counting…')).toHaveLength(1)
    expect(confirmButton().textContent).toBe('Log watered on 0')
    expect(confirmButton().disabled).toBe(true)

    await land('all')
    await liveConfirm('Log watered on 3')
  })

  // The draft restore sets scope, date and selection BEFORE the checklist mounts, so the first
  // answer is already tagged with the restored values. A restored draft that left the button held
  // for good would be this fix trading one dead end for another.
  it('a restored draft is released by its first preview, and posts the restored scope with its own skips', async () => {
    seedStash({
      eventType: 'watering', eventDate: '2026-08-20', scope: TROUGH_SCOPE, notes: '',
      selection: { decisions: { 'pl-2': false }, baseline: true, touched: true },
    })
    deferDryRuns = true
    render(<LogMany />)
    await waitFor(() => expect(inFlight).toHaveLength(1))
    expect(inFlight[0].body.scope).toEqual(TROUGH_SCOPE)
    expect(inFlight[0].body.event_date).toBe('2026-08-20')

    await land('trough')
    fireEvent.click(await liveConfirm('Log watered on 1'))
    expect(wire()).toEqual([{ scope: TROUGH_SCOPE, exclude_plant_ids: ['pl-2'], written: ['Aji Dulce'] }])
    expect(batchPosts[0].event_date).toBe('2026-08-20')
  })

  // The tag is a sibling of `selectionState`, like `frameOpen`: it describes a preview, not a
  // selection, and a stashed copy would be compared by identity against objects that no longer
  // exist after a reload.
  it('the tag is not written to the draft stash', async () => {
    await renderReady()
    await openList()
    fireEvent.click(screen.getByText('Basil Row'))
    await waitFor(() => expect(readStash()?.selection?.decisions).toEqual({ 'pl-2': false }))
    expect(Object.keys(readStash().selection).sort()).toEqual(['baseline', 'decisions', 'mode', 'touched'])
    expect(JSON.stringify(readStash())).not.toContain('previewFor')
  })

  // A hold is the page waiting, not the person's unsaved input: it must arm neither guard.
  it('a hold arms neither the reload gate nor the backdrop guard', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    await liveConfirm('Log watered on 3')
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))
    expectHeld()
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
    await land('bag')
    await liveConfirm('Log watered on 1')
    expect(isReloadBlocked()).toBe(false)
  })

  // PICK commits name the picks (`{type:'ids'}`) and omit exclude_plant_ids — that wire shape is
  // untouched. The button is the same node in both modes, so the same hold applies while the pool
  // the picks are read against is being re-resolved.
  it('PICK mode — still commits explicit ids with no exclude_plant_ids, after the same hold', async () => {
    await renderReady()
    fireEvent.click(screen.getByTestId('sc-mode-pick'))
    await screen.findByTestId('pick-frame')
    fireEvent.click(screen.getByTestId('pick-row-pl-1'))
    fireEvent.click(screen.getByTestId('pick-row-pl-3'))
    fireEvent.click(screen.getByTestId('pick-done'))
    await liveConfirm('Log watered on 2')
    deferDryRuns = true
    fireEvent.click(screen.getByText('By zone'))

    expectHeld()

    await land('bag')
    fireEvent.click(await liveConfirm('Log watered on 1'))
    expect(batchPosts).toHaveLength(1)
    expect(batchPosts[0].scope).toEqual({ type: 'ids', plant_ids: ['pl-3'] })
    expect('exclude_plant_ids' in batchPosts[0]).toBe(false)
  })
})
