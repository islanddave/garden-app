// V4-LOSSUI-001 — the plant-reduction capture panel and the end-status offer, on the real form.
//
// RENDER + PAYLOAD + REAL HISTORY assertions. Never source-text, never "the module imports X": this
// codebase has twice shipped an inert feature whose suite asserted an import (the colour-window
// family, and the reloadGate that nothing ever held), and V4-LOSSEVENT-001 itself deliberately hid
// these two event types rather than ship a picker entry that 400s. A test that reads source cannot
// tell a wired panel from a dead one, so every test below mounts the form, taps what a user taps,
// and reads the body that actually reached POST /api/events.
//
// Flags are pinned to the PROD values (PROJECTS_HIDDEN + PLANTING_REQUIRED_ENABLED both true, which
// is what featureFlags.js ships) rather than the more convenient false: the reduction types are in
// PLANTING_REQUIRED_TYPES, and testing them with the planting gate disabled would exercise a
// configuration Dave never runs.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, postCalls, putCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  postCalls: [],
  putCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postResult: { id: 'evt-1', project_id: 'proj-1', plant_id: 'plant-1', plant_reduction: null },
    postError: null,
    putError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
  PLANTING_REQUIRED_ENABLED: true,
  DISMISS_REGISTRY_ENABLED: true,
  BACKNAV_ENABLED: true,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
// Real reloadGate, nothing spied: hasUnsavedInput feeds BOTH the overlay's backdrop guard and the
// service-worker reload gate through one predicate, and the gate is the half that can be observed
// without an OverlayContext. Asserting on a spy would re-create the blind spot
// EventNew.reloadGateWire.test.jsx exists to close.
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const PROJECT = { id: 'proj-1', name: 'Lettuce 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Buttercrunch #1', project_id: 'proj-1', quantity: 10, status: 'vegetative' }

// A floor entry so a real history.back() is never a silent index-0 no-op — the trap
// BackNav.history.test.jsx documents. Asserted before the traversal, not assumed.
const SENTINEL = { __floor: 1 }
const atFloor = () => !readMarker(window.history.state) && window.history.state?.__floor === 1

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      if (dataRef.postError) return Promise.reject(dataRef.postError)
      return Promise.resolve(dataRef.postResult)
    }
    if (options.method === 'PUT' && path.startsWith('/api/plants/')) {
      putCalls.push({ path, body: JSON.parse(options.body) })
      if (dataRef.putError) return Promise.reject(dataRef.putError)
      return Promise.resolve({ id: 'plant-1' })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = 'event_type=failed&plant=plant-1&project=proj-1') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(
    <DismissRegistryProvider>
      <ToastProvider><EventNew /></ToastProvider>
    </DismissRegistryProvider>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset(); postCalls.length = 0; putCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1', plant_id: 'plant-1', plant_reduction: null }
  dataRef.postError = null
  dataRef.putError = null
  try { localStorage.clear() } catch { /* noop */ }
  window.history.replaceState(SENTINEL, '')
  clearReloadBlocks()
  wireApiFetch()
})
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => {})
}
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save')) }) }
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

// ── The panel exists, and it exists for BOTH types ──────────────────────────────────────────────

describe('the required capture panel renders for the reduction types and nothing else', () => {
  it('failed gets a quantity field and the SEVEN loss reasons', async () => {
    renderEventNew()
    await flushLoad()
    expect(screen.getByTestId('reduction-panel-failed')).toBeTruthy()
    expect(screen.getByTestId('reduction-qty')).toBeTruthy()
    for (const r of ['pest', 'disease', 'weather', 'transplant_shock', 'unknown', 'animal_damage', 'culled']) {
      expect(screen.getByTestId(`reduction-reason-${r}`), r).toBeTruthy()
    }
    // ...and NOT the other vocabulary, which is the storage-layer separation made visible.
    expect(screen.queryByTestId('reduction-reason-friend')).toBeNull()
  })

  it('given_away gets the SIX giveaway reasons, including the three Dave just approved', async () => {
    renderEventNew('event_type=given_away&plant=plant-1&project=proj-1')
    await flushLoad()
    expect(screen.getByTestId('reduction-panel-given_away')).toBeTruthy()
    for (const r of ['friend', 'donated', 'plant_swap', 'sold', 'traded', 'community']) {
      expect(screen.getByTestId(`reduction-reason-${r}`), r).toBeTruthy()
    }
    expect(screen.queryByTestId('reduction-reason-pest')).toBeNull()
  })

  it('renders on NO other event type — this is a required panel, not a universal one', async () => {
    for (const t of ['watering', 'harvest', 'observation']) {
      const { unmount } = renderEventNew(`event_type=${t}&plant=plant-1&project=proj-1`)
      await flushLoad()
      expect(screen.queryByTestId('reduction-panel-failed'), t).toBeNull()
      expect(screen.queryByTestId('reduction-panel-given_away'), t).toBeNull()
      unmount()
    }
  })

  it('the catch-all hint appears only once its chip is chosen', async () => {
    renderEventNew('event_type=given_away&plant=plant-1&project=proj-1')
    await flushLoad()
    expect(screen.queryByTestId('reduction-reason-hint')).toBeNull()
    fireEvent.click(screen.getByTestId('reduction-reason-community'))
    expect(screen.getByTestId('reduction-reason-hint').textContent).toMatch(/neighbours/i)
  })

  it('shows the live count as information, never as a limit', async () => {
    renderEventNew()
    await flushLoad()
    expect(screen.getByTestId('reduction-remaining').textContent).toMatch(/10 left/)
    // The field accepts a number ABOVE the count — the refusal is the server's 409, and clamping
    // client-side is what V4-LOSSEVENT-001 expressly refused.
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '25' } })
    expect(screen.getByTestId('reduction-qty').value).toBe('25')
  })

  // ADDED AFTER A MUTATION SURVIVED. The test above asserted only that the FIELD keeps the typed
  // value, which a clamp applied on the way to the wire satisfies completely — so a
  // `Math.min(qty, remaining)` in buildReductionMetadata went undetected while the suite stayed
  // green. That is the precise defect V4-LOSSEVENT-001 refused ("a clamped row is
  // indistinguishable from a correct one afterwards"), and the only place it is observable is the
  // POSTED body. The field assertion is kept — it covers a different clamp, one applied on input.
  it('POSTS the typed quantity verbatim when it exceeds the remaining count — no silent clamp', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '25' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()
    expect(postCalls.length).toBe(1)
    // 25 against a planting holding 10. The server answers 409; the client's job is to state the
    // user's actual claim and let it.
    expect(postCalls[0].metadata.qty_reduced).toBe(25)
  })
})

// ── The panel BLOCKS the save. This is the requirement the picker gate stood in for. ─────────────

describe('Save is blocked until both required fields are filled', () => {
  it('no quantity -> refused, inline, with NO POST attempted', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()
    expect(postCalls.length).toBe(0)
    expect(screen.getByRole('alert').textContent).toMatch(/how many/i)
  })

  it('no reason -> refused, inline, with NO POST attempted', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
    await save()
    expect(postCalls.length).toBe(0)
    expect(screen.getByRole('alert').textContent).toMatch(/what happened to them/i)
  })

  it('a zero or fractional quantity is refused — losing one and losing nineteen must differ', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    for (const bad of ['0', '2.5', '-3', 'lots']) {
      fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: bad } })
      await save()
      expect(postCalls.length, `qty ${bad}`).toBe(0)
    }
  })

  it('a half-filled panel counts as unsaved input — a stray dismissal must not eat it', async () => {
    // These two fields are REQUIRED, so losing them to a backdrop tap or a service-worker reload
    // costs the whole entry, not an optional detail. hasUnsavedInput is the one predicate feeding
    // both channels, and the reload gate is the observable half.
    renderEventNew()
    await flushLoad()
    expect(isReloadBlocked()).toBe(false)
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a tapped reason alone also counts — not just typed text', async () => {
    renderEventNew()
    await flushLoad()
    expect(isReloadBlocked()).toBe(false)
    fireEvent.click(screen.getByTestId('reduction-reason-culled'))
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('the error clears the moment the user supplies what was missing', async () => {
    renderEventNew()
    await flushLoad()
    await save()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ── The payload ─────────────────────────────────────────────────────────────────────────────────

describe('a satisfied panel posts the reduction metadata the API requires', () => {
  it('failed posts qty_reduced + loss_reason, with the quantity as a NUMBER', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('reduction-reason-culled'))
    await save()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('failed')
    expect(postCalls[0].plant_id).toBe('plant-1')
    expect(postCalls[0].metadata).toEqual({ qty_reduced: 3, loss_reason: 'culled' })
    expect(typeof postCalls[0].metadata.qty_reduced).toBe('number')
  })

  it('given_away posts giveaway_reason and NEVER loss_reason — a gift is not a loss', async () => {
    renderEventNew('event_type=given_away&plant=plant-1&project=proj-1')
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('reduction-reason-community'))
    await save()
    expect(postCalls[0].metadata).toEqual({ qty_reduced: 2, giveaway_reason: 'community' })
    expect('loss_reason' in postCalls[0].metadata).toBe(false)
  })

  it('a NON-reduction event carries none of the three keys', async () => {
    renderEventNew('event_type=observation&plant=plant-1&project=proj-1')
    await flushLoad()
    await save()
    const meta = postCalls[0].metadata ?? {}
    for (const k of ['qty_reduced', 'loss_reason', 'giveaway_reason']) expect(k in meta, k).toBe(false)
  })

  it('a burst does not carry the previous entry\'s count onto the next planting', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()
    // Save keeps event_type (keepMode 'type'), so the type-change reset never fires — which is
    // exactly how treatment.* once leaked across a burst.
    expect(screen.getByTestId('reduction-qty').value).toBe('')
    expect(screen.getByTestId('reduction-reason-pest').getAttribute('aria-pressed')).toBe('false')
  })

  it('switching between the two types clears the count typed for the other one', async () => {
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    // Reach the type through the picker's own affordance, as a user would.
    fireEvent.click(screen.getByText('More event types'))
    fireEvent.click(screen.getByText('Plants given away'))
    expect(screen.getByTestId('reduction-panel-given_away')).toBeTruthy()
    expect(screen.getByTestId('reduction-qty').value).toBe('')
  })
})

// ── Over-reduction: the 409 has to read like a sentence, not like a shrug ────────────────────────

describe('over-reduction is refused by the server and surfaced readably', () => {
  it('the 409\'s own sentence reaches the user, numbers intact', async () => {
    const err = new Error('this planting has 5 left, so 7 cannot be removed')
    err.status = 409
    err.body = { error: err.message, code: 'REDUCTION_EXCEEDS_REMAINING', available: 5 }
    dataRef.postError = err

    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()

    const banner = await screen.findByText(/5 left/)
    expect(banner.textContent).toMatch(/7 cannot be removed/)
    // NOT the generic 4xx line — which is what this branch exists to avoid.
    expect(banner.textContent).not.toMatch(/didn.t look right/i)
  })

  it('the typed values SURVIVE the refusal, so the correction is one edit', async () => {
    const err = new Error('this planting has 5 left, so 7 cannot be removed')
    err.status = 409
    err.body = { code: 'REDUCTION_EXCEEDS_REMAINING', available: 5 }
    dataRef.postError = err
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()
    expect(screen.getByTestId('reduction-qty').value).toBe('7')
    expect(screen.getByTestId('reduction-reason-pest').getAttribute('aria-pressed')).toBe('true')
  })
})

// ── The end-status offer ────────────────────────────────────────────────────────────────────────

const EMPTIED = {
  emptied: true,
  composition: { harvested: 5, lost: 3, given_away: 2 },
  offer_end_status: ['harvested', 'ended', 'failed'],
}

async function saveEmptyingReduction(query) {
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1', plant_id: 'plant-1', plant_reduction: EMPTIED }
  renderEventNew(query)
  await flushLoad()
  fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '3' } })
  fireEvent.click(screen.getByTestId('reduction-reason-pest'))
  await save()
}

describe('the offer appears ONLY on the reduction that empties the planting', () => {
  it('a PARTIAL reduction shows nothing — it stays a silent one-tap log', async () => {
    // plant_reduction: null is what the server sends on every partial reduction, which is the
    // common case ("10 -> 8, pest"). Anything rendered here would interrupt the fast path.
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('reduction-reason-pest'))
    await save()
    expect(postCalls.length).toBe(1)
    expect(screen.queryByTestId('end-status-harvested')).toBeNull()
    expect(screen.queryByTestId('end-status-decline')).toBeNull()
  })

  it('the EMPTYING reduction offers the server\'s ranking, in the server\'s order', async () => {
    await saveEmptyingReduction()
    const buttons = await screen.findAllByTestId(/^end-status-(harvested|ended|failed)$/)
    expect(buttons.map(b => b.getAttribute('data-testid')))
      .toEqual(['end-status-harvested', 'end-status-ended', 'end-status-failed'])
    expect(screen.getByTestId('end-status-composition').textContent)
      .toMatch(/harvested 5 · lost 3 · gave away 2/)
  })

  it('renders the server\'s ranking even when it leads with failed — the client never re-ranks', async () => {
    dataRef.postResult = {
      id: 'evt-2', project_id: 'proj-1', plant_id: 'plant-1',
      plant_reduction: { emptied: true, composition: { harvested: 0, lost: 9, given_away: 0 }, offer_end_status: ['failed', 'ended', 'harvested'] },
    }
    renderEventNew()
    await flushLoad()
    fireEvent.change(screen.getByTestId('reduction-qty'), { target: { value: '9' } })
    fireEvent.click(screen.getByTestId('reduction-reason-disease'))
    await save()
    const buttons = await screen.findAllByTestId(/^end-status-(harvested|ended|failed)$/)
    expect(buttons.map(b => b.getAttribute('data-testid'))).toEqual(['end-status-failed', 'end-status-ended', 'end-status-harvested'])
  })

  it('a non-reduction event never raises it, whatever else the response carries', async () => {
    dataRef.postResult = { id: 'evt-3', project_id: 'proj-1', plant_id: 'plant-1', plant_reduction: null }
    renderEventNew('event_type=watering&plant=plant-1&project=proj-1')
    await flushLoad()
    await save()
    expect(screen.queryByTestId('end-status-decline')).toBeNull()
  })
})

describe('the offer is an OFFER — only an explicit pick writes a status', () => {
  it('the reduction itself never PUTs a status, offer or no offer', async () => {
    await saveEmptyingReduction()
    await screen.findByTestId('end-status-decline')
    // The event POST has landed and the sheet is up; NOTHING has been written to the planting.
    expect(putCalls.length).toBe(0)
  })

  it('tapping a status applies it as an ordinary plants PUT', async () => {
    await saveEmptyingReduction()
    const btn = await screen.findByTestId('end-status-harvested')
    await act(async () => { fireEvent.click(btn) })
    expect(putCalls).toEqual([{ path: '/api/plants/plant-1', body: { status: 'harvested' } }])
    await waitFor(() => expect(screen.queryByTestId('end-status-harvested')).toBeNull())
  })

  it('tapping `failed` sends the STATUS failed — the event type of the same name is unrelated', async () => {
    await saveEmptyingReduction()
    const btn = await screen.findByTestId('end-status-failed')
    await act(async () => { fireEvent.click(btn) })
    expect(putCalls[0].body).toEqual({ status: 'failed' })
  })

  it('DECLINING writes nothing and leaves the status alone', async () => {
    await saveEmptyingReduction()
    const decline = await screen.findByTestId('end-status-decline')
    await act(async () => { fireEvent.click(decline) })
    expect(putCalls.length).toBe(0)
    expect(screen.queryByTestId('end-status-decline')).toBeNull()
    // And the reduction it followed is still saved — declining costs the status, never the record.
    expect(postCalls.length).toBe(1)
  })

  it('ESCAPE dismisses without applying (arbitrated by DismissRegistry, not a local handler)', async () => {
    await saveEmptyingReduction()
    await screen.findByTestId('end-status-decline')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(putCalls.length).toBe(0)
    await waitFor(() => expect(screen.queryByTestId('end-status-decline')).toBeNull())
  })

  it('ANDROID BACK dismisses without applying — real history, real popstate', async () => {
    // Dave's device is Chrome on Android and Back is the gesture he actually uses. Sheet's
    // armsBack routes it through DismissRegistry's single popstate arbiter; a hand-rolled
    // outside-click handler would not be reachable by this test at all, which is the point.
    await saveEmptyingReduction()
    await screen.findByTestId('end-status-decline')
    // The marker proves the sheet ARMED. Without it, back() would walk the page and the assertion
    // below would pass for the wrong reason.
    expect(readMarker(window.history.state)).toBeTruthy()

    await act(async () => { window.history.back() })
    await settle()

    expect(putCalls.length).toBe(0)
    await waitFor(() => expect(screen.queryByTestId('end-status-decline')).toBeNull())
    expect(atFloor()).toBe(true)
  })

  it('a status PUT in flight blocks dismissal — a stray Escape cannot discard mid-write', async () => {
    // The `busy` prop is not decoration: DismissRegistry swallows Escape/Back on a busy topmost and
    // Sheet no-ops the backdrop. Claimed in EndStatusOffer's header, so it is proved here.
    let release
    dataRef.putError = null
    apiFetchSpy.mockImplementation((path, options = {}) => {
      if (options.method === 'PUT' && path.startsWith('/api/plants/')) {
        putCalls.push({ path, body: JSON.parse(options.body) })
        return new Promise(res => { release = () => res({ id: 'plant-1' }) })
      }
      if (options.method === 'POST' && path === '/api/events') {
        postCalls.push(JSON.parse(options.body))
        return Promise.resolve(dataRef.postResult)
      }
      if (path === '/api/projects') return Promise.resolve(dataRef.projects)
      if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
      if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
      return Promise.resolve(null)
    })

    await saveEmptyingReduction()
    const btn = await screen.findByTestId('end-status-harvested')
    await act(async () => { fireEvent.click(btn) })
    expect(putCalls.length).toBe(1)          // in flight, unresolved
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.getByTestId('end-status-harvested')).toBeTruthy()
    await act(async () => { release(); await Promise.resolve() })
  })

  it('a failed PUT keeps the sheet up and says so — the event is saved either way', async () => {
    dataRef.putError = Object.assign(new Error('boom'), { status: 500 })
    await saveEmptyingReduction()
    const btn = await screen.findByTestId('end-status-harvested')
    await act(async () => { fireEvent.click(btn) })
    expect(screen.getByTestId('end-status-harvested')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/didn.t go through/i)
  })
})
