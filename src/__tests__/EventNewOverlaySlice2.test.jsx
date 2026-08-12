// V4-OVERLAY-001 Slice 2 + V4-LOGCONF-001 (C1/C2) + V4-HARVFEEDBACK-001 S5b — EventNew overlay
// behaviors: the Save CTA is `sticky` (not `fixed`, the BUG-SHEET-001 class where a fixed CTA
// escapes the Sheet's scroll region), and inside the overlay a successful save shows a DURABLE
// confirmation — no auto-dismiss timer, cleared only by the next save or by leaving.
//
// S5b REWROTE what "durable confirmation" means on this surface. It used to REPLACE the sheet body
// with a card whose Close / View event / View planting / Log another actions were the only way out.
// It is now a NON-BLOCKING STRIP folded into the sticky Save band, with the form left mounted and
// live underneath. The assertion inversions below are the slice, not drift — each is annotated at
// its site. The dropped card actions and the deleted focus-steal are called out where they were
// pinned, so a future reader can see the contract changed on purpose.
//
// The non-overlay branch DELIBERATELY keeps the timed global undo toast (asserted below — this seam
// has regressed 3×, so BOTH branches are pinned here). Queries are role-based per L-275: assert
// what the a11y tree exposes, not attribute presence.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' }, postError: null, deleteError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx and EventNew.plantMismatch.plantRequired.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return dataRef.postError ? Promise.reject(dataRef.postError) : Promise.resolve(dataRef.postResult)
    }
    if (options.method === 'DELETE') {
      return dataRef.deleteError ? Promise.reject(dataRef.deleteError) : Promise.resolve({ undone: true })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    if (path.startsWith('/api/harvests')) return Promise.resolve(dataRef.harvestsAgg ?? null)
    return Promise.resolve(null)
  })
}

function renderInOverlay(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><OverlaySurfaceProvider><EventNew /></OverlaySurfaceProvider></ToastProvider>)
}

function renderFullPage(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// V4-PLANTPICKER-001: planting picks go through the shared PlantingSelect combobox (focus opens
// the listbox, click the ps-opt-<id> row); findBy waits out the async plants load.
async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

async function saveOnce() {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null; dataRef.deleteError = null; dataRef.harvestsAgg = null
  sessionStorage.clear()
  // S5b: added for ISOLATION, not to change any assertion. V4-STICKY-001 persists the last
  // project/plant to localStorage on every save, so a test that saves leaves the NEXT test's
  // PlantingSelect pre-seeded — and a pre-seeded PlantingSelect renders its chosen-state CHIP
  // instead of the combobox input, which makes getByLabelText('Plant or group') fail with a
  // confusing "no such label". The file happened to escape this before only because no test that
  // picked a planting followed one that saved. Same fix, same reason, as
  // EventNewPostSaveFeedback.characterization.test.jsx.
  localStorage.clear()
  wireApiFetch()
})

afterEach(() => { vi.useRealTimers() })

describe('EventNew — overlay Slice 2', () => {
  it('renders the Save CTA as position:sticky (not fixed — BUG-SHEET-001)', async () => {
    const { container } = renderInOverlay('event_type=watering')
    await flushLoad()
    const saveBtn = screen.getByText('Save')
    // walk up to the positioned wrapper
    let el = saveBtn
    let found = null
    while (el && el !== container) {
      if (el.getAttribute && /position:\s*sticky/.test(el.getAttribute('style') || '')) { found = el; break }
      el = el.parentElement
    }
    expect(found).not.toBeNull()
    expect(container.querySelector('[style*="position: fixed"]')).toBeNull()
  })
})

describe('EventNew — V4-LOGCONF-001 durable confirmation (C1/C2) + S5b non-blocking strip', () => {
  it('save leaves the form LIVE and shows a non-blocking strip — no auto-dismiss timer', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    expect(postCalls.length).toBe(1)
    // confirmation announced via the a11y tree
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/Logged/)
    // S5b INVERSION — THIS IS THE SLICE. Was `expect(queryByText('Save')).toBeNull()`, which pinned
    // the body-replacing early return. The form staying mounted is the entire point of S5b, so the
    // assertion flips rather than being dropped: it still pins the render decision, opposite sign.
    expect(screen.getByText('Save')).toBeTruthy()
    // S5b: the card's Close/View event/View planting/Log another are GONE (spec §4.1/§4.2 dropped the
    // two links; §3 replaced Close with an always-present Done; Log another had nothing left to do).
    // What remains: an always-present Done exit, and Undo.
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log another' })).toBeNull()
    // RESCOPED B5 link invariant (spec §0.2/§9). It used to read `getAllByRole('link').length === 1`
    // and held only because the card unmounted the form. With the form live, the form header's own
    // Dashboard + Log many links make the document count 3+ unconditionally, so a document-wide
    // count would now pass or fail for reasons that have nothing to do with the feedback surface.
    // Scoped to the strip subtree the intent is preserved AND strengthened: the feedback surface
    // adds NO link at all (it used to add one), so nothing on it can end a burst.
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
    // S5b DELIBERATE CONTRACT REVERSAL (spec §6). This line previously pinned focus onto the card's
    // Close button. That focus effect is DELETED: with the form live, moving focus makes "the form
    // stays live" false for keyboard and TalkBack users — the premise of the slice — and on Chrome
    // Android a programmatic focus move can dismiss or re-raise the soft keyboard under the thumb.
    // The replacement pins the absence, so a re-introduced focus steal fails here.
    expect(screen.getByTestId('post-save-strip').contains(document.activeElement)).toBe(false)
    // DURABLE: a minute of timer advancement does not dismiss it
    act(() => { vi.advanceTimersByTime(60000) })
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
  })

  // RESCOPED from 'View event link is built from the POST response, not staged client state'.
  // The link is dropped (spec §4.1), but the invariant it guarded — the confirmation describes the
  // ROW THE SERVER SAVED, never staged client state — survives intact on the remaining surface:
  // plantId is still response-sourced and still decides how the confirmation attributes the log.
  it('the confirmation attributes the log from the POST RESPONSE, not staged client state', async () => {
    // a planting IS selected client-side, but the saved row carries none — the response wins
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    dataRef.postResult = { id: 'evt-7', project_id: 'proj-9' }
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/no planting attached/)
    expect(status.textContent).not.toMatch(/Cayenne #1/)
  })

  it('Undo soft-deletes via the sanctioned DELETE path and flips to a durable undone state', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/evt-1', { method: 'DELETE' })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
    // undone is terminal for this log: the Undo control is withdrawn. The 'View event' withdrawal
    // that used to be pinned here is gone with the link itself (spec §4.1) — the strip-subtree
    // zero-link invariant below is what replaces it, and it holds in the undone state too.
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull()
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
    // S5b: the exits that remain. 'Log another' is gone because the form never left; Done replaces
    // the card's Close and is present whether or not anything was saved.
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(screen.getByText('Save')).toBeTruthy()
    // still no timer dismissal in the undone state
    act(() => { vi.advanceTimersByTime(60000) })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
  })

  it('a failed Undo keeps the strip with a retryable error — never a silent loss', async () => {
    dataRef.deleteError = new Error('boom')
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.getByRole('alert').textContent).toMatch(/undo/i)
    // strip intact, Undo still offered for retry
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
    // retry succeeds
    dataRef.deleteError = null
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
  })

  // RESCOPED from 'Log another returns to the reset form'. The control is gone (spec §9), but every
  // BEHAVIOUR it guarded is asserted here unchanged — project kept, plant cleared, type kept, a
  // second POST lands with the right payload — now on the live form with NO intervening click. That
  // missing click is the measured 1-tap-per-harvest win, so its absence is itself the assertion.
  it('rapid entry (V3-EVENT-001) survives with ZERO dismissal taps — the form is already reset', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    // no click of any kind between the save and the next entry
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // second save works end-to-end without re-picking the type
    await pickPlanting('pl-2')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(2)
    expect(postCalls[1].event_type).toBe('watering')
    expect(postCalls[1].plant_id).toBe('pl-2')
  })

  // Was 'Close dismisses the overlay explicitly'. The navigateSpy half is load-bearing and kept
  // verbatim; only the control's name changes (spec §3: `Done` names the USER's state and is
  // deliberately distinct from the Sheet header's own `Close`, so the two exits don't read as
  // duplicates).
  it('Done dismisses the overlay explicitly', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    expect(navigateSpy).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    // no OverlayProvider in this harness → useOverlayDismiss falls back to /today (replace)
    expect(navigateSpy).toHaveBeenCalledWith('/today', { replace: true })
  })

  // Spec §3, load-bearing: Done is present FROM MOUNT, not only after a save. A control that
  // materialises post-save is one the user never learns exists, and the exit is needed MOST when
  // abandoning before saving — the header X has scrolled away and the backdrop locks on first keypress.
  it('Done is present before any save, and dismisses a pristine form', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    expect(screen.queryByTestId('post-save-strip')).toBeNull()   // nothing saved yet
    const done = screen.getByRole('button', { name: 'Done' })
    await act(async () => { fireEvent.click(done) })
    expect(navigateSpy).toHaveBeenCalledWith('/today', { replace: true })
    expect(postCalls.length).toBe(0)
  })

  // Spec §3: Done dismisses even while dirty, exactly as the Sheet's own Close does. The backdrop
  // is what locks while dirty (V4-DRAFTFULLPAGE-001 b); the labelled exits never do.
  it('Done dismisses even while the form is dirty — no confirmation dialog', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    // V4-NOTESCOLLAPSE-001: Notes is a collapsed disclosure at the foot of the form — open it first.
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'half typed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    expect(navigateSpy).toHaveBeenCalledWith('/today', { replace: true })
  })

  // Spec §2 lifetime: NO TIMER, EVER — and never cleared by typing. Clearing on input would remove
  // the undo path at exactly the moment the user realises the error (V4-LOGCONF-001's earned
  // rationale: the global toast was "a 5s race the user always loses"). Only the NEXT save
  // supersedes it.
  it('the strip is not cleared by typing, and the next save supersedes it', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    // V4-NOTESCOLLAPSE-001: Notes is a collapsed disclosure at the foot of the form — open it first.
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'next one' } })
    // still there, still undoable
    expect(screen.getByTestId('post-save-strip')).toBeTruthy()
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
    // the second save replaces it — and the Undo now targets the SECOND event, not the first
    dataRef.postResult = { id: 'evt-2', project_id: 'proj-1' }
    await pickPlanting('pl-2')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/evt-2', { method: 'DELETE' })
    expect(apiFetchSpy).not.toHaveBeenCalledWith('/api/events/evt-1', { method: 'DELETE' })
  })

  // Spec §7: the burst count is a REWARD SURFACE, so it is withheld until it carries information the
  // confirmation does not. At n=1 it would merely restate the line just read. Threshold derived, not
  // tuned — and it reads a property of the TASK, never identity.
  it('the session count is withheld at one save and renders from the second', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(screen.queryByText(/logged this session/)).toBeNull()
    await pickPlanting('pl-2')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(screen.getByText('2 logged this session')).toBeTruthy()
    // ambient, NOT announced: the count sits OUTSIDE the role=status live region, because that
    // region is implicitly aria-atomic and would re-read the whole confirmation on every save.
    expect(screen.getByRole('status').textContent).not.toMatch(/logged this session/)
  })

  // ── V4-VIEWPLANT-001 — the "View planting" link is DROPPED by S5b (spec §4.2) ──
  // ⚠️ This is a REAL REGRESSION against a deliberately-shipped feature, taken knowingly and
  // FLAGGED FOR DAVE (spec §10.1), not an oversight. Rationale: a <Link> ends the burst this slice
  // exists to protect, so it is never the right next action mid-burst. The rejected alternative —
  // linking the plant name inside the confirmation text — is an a11y defect: role="status" announces
  // as a block, leaving the user to hunt for a target inside what they just heard. Recovery is 2 taps
  // from Today/Garden. If the loss bites, the natural home is Done routing to the last-logged
  // planting, deliberately NOT specified because it changes dismiss semantics.
  //
  // The three tests below are RESCOPED, not deleted. What they really guarded was the
  // RESPONSE-SOURCED plantId gate — which still decides how the confirmation names its target
  // (V4-LOGTARGET-001) — plus the "no link on the feedback surface" invariant, which S5b
  // strengthens from "exactly one" to "none".
  it('a response plant_id makes the confirmation name the planting, from client state', async () => {
    // response ids deliberately differ from client selections — attribution follows the response's
    // plant_id gate, while the display NAME is the cheap client-state lookup
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    dataRef.postResult = { id: 'evt-7', project_id: 'proj-9', plant_id: 'pl-42' }
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(screen.getByRole('status').textContent).toMatch(/Cayenne #1/)
    expect(screen.getByRole('status').textContent).not.toMatch(/no planting attached/)
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
  })

  it('a response plant_id with no client-side name still counts as attached — the gate is response-driven', async () => {
    // no plant selected client-side, but the response row carries a plant_id → the confirmation must
    // NOT claim "no planting attached" (it would be describing a row that has one)
    dataRef.postResult = { id: 'evt-3', project_id: 'proj-1', plant_id: 'pl-77' }
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByRole('status').textContent).not.toMatch(/no planting attached/)
  })

  it('no plant_id in the response → the confirmation says so plainly, and the strip stays link-free', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    expect(screen.getByRole('status').textContent).toMatch(/no planting attached/)
    // RESCOPED B5 invariant (spec §0.2/§9): was `getAllByRole('link').length === 1` document-wide.
    // The live form's header links make that count 3+ for reasons unrelated to this surface, so the
    // count is scoped to the strip — where the correct number is now ZERO, not one.
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
  })

  it('Undo withdraws the Undo control and the ambient row — the strip stays link-free throughout', async () => {
    dataRef.postResult = { id: 'evt-3', project_id: 'proj-1', plant_id: 'pl-77' }
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    const strip = screen.getByTestId('post-save-strip')
    expect(within(strip).queryAllByRole('link')).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull()
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
  })

  it('non-overlay branch: no confirmation card; the timed global undo toast is preserved', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    expect(postCalls.length).toBe(1)
    // no card: form stays visible (zero-tap rapid entry), no View link
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'View event' })).toBeNull()
    // the global operational toast announces with its existing 5s lifetime
    expect(screen.getByRole('status').textContent).toMatch(/Logged event for Tomatoes 2026/)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  // ── V4-HARVESTVIEW-001 S4a: post-harvest ambient season-total line (the loop-closer, design §2) ──
  it('a logged harvest shows the running season total as STATIC text — scope-qualified, link-free, focus untouched', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Blue #1', variety_ref: { crop_type_slug: 'blueberry' } }]
    dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }
    dataRef.harvestsAgg = { aggregates: { crops: [{ crop_name: 'Blueberry', units: [{ unit: 'cup', total: 4.5 }] }] } }
    renderInOverlay('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    // S5b (spec §4.3): the phrase now STATES ITS SCOPE. The aggregate is household-scoped, so
    // unqualified it silently includes Jen's harvests and reads to each user as "mine" — a
    // two-user-disaggregation defect, not a wording preference. The `Season: ` prefix is preserved
    // so anchored /^Season: / assertions elsewhere keep passing.
    expect(await screen.findByText('Season: 4.5 cups blueberry (whole garden)')).toBeTruthy()
    // the season line is NOT a link — rescoped from "View event is the only link on the card" to
    // "the strip has no links at all"
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
    // S5b CONTRACT REVERSAL (2nd of 2 focus pins, spec §6): this asserted focus sat on the card's
    // Close button and that the async line did not steal it. The focus effect is DELETED — the
    // strip must never take focus at all, because the form underneath stays live. The surviving
    // half of the original intent (the async arrival does not disturb the user) is stronger here.
    expect(screen.getByTestId('post-save-strip').contains(document.activeElement)).toBe(false)
    // ...and it stays OUTSIDE the implicitly-aria-atomic live region, so its async arrival cannot
    // re-announce the whole confirmation mid-form.
    expect(screen.getByRole('status').textContent).not.toMatch(/Season:/)
  })

  // Spec §4.4: an error and an ambient brag must never co-occupy — a season total beside a failed
  // undo reads as celebrating the failure. The alert REPLACES row 2.
  it('an undo failure replaces the ambient row rather than sitting beside it', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Blue #1', variety_ref: { crop_type_slug: 'blueberry' } }]
    dataRef.harvestsAgg = { aggregates: { crops: [{ crop_name: 'Blueberry', units: [{ unit: 'cup', total: 4.5 }] }] } }
    dataRef.deleteError = new Error('boom')
    renderInOverlay('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(await screen.findByText('Season: 4.5 cups blueberry (whole garden)')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.getByRole('alert').textContent).toMatch(/undo/i)
    expect(screen.queryByText(/^Season: /)).toBeNull()
  })
})
