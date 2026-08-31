// V4-HARVFEEDBACK-001 S5a — CHARACTERIZATION tests for the post-save confirmation card.
//
// Written against the UNEXTRACTED EventNew.jsx and proven green BEFORE the S5a component
// extraction, so they function as a no-op oracle for the extraction itself. They cover three
// behaviours that EventNewOverlaySlice2.test.jsx does NOT, and that a props extraction is
// specifically likely to break:
//
//   1. PreserveOffer DOUBLE-HOSTING — it renders both inside the card and again in the form body.
//      Before this file, `grep -rln "PreserveOffer\|preserveCtx" src/__tests__/` returned NOTHING.
//      The claim "extracting the card is not a feature move" rests entirely on that second host
//      surviving; nothing pinned it.
//   2. CAPTURE-BEFORE-RESET ORDERING — plantName and seasonCropSlug are read out of client state
//      BEFORE resetForNext() clears form.plant_id. Move the feedback call after the reset and you
//      get a card with no planting name and no season line, with every other test still green.
//   3. photoError propagating into BOTH arms — one variable feeds the overlay card AND the
//      full-page toast. A props extraction is exactly where one arm silently loses it.
//
// These render the REAL EventNew (no source-text guards — a text guard cannot see that the file
// it reads does not parse).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef, uploadRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' }, postError: null, deleteError: null, harvestsAgg: null },
  searchParamsRef: { current: new URLSearchParams() },
  uploadRef: { result: { photo: { id: 'p1' } } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve(uploadRef.result)),
    isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
// Mirrors EventNewOverlaySlice2's flag posture so both suites describe the same configuration.
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
const PRESERVE_PROMPT = 'Putting any of this up for later?'

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

async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

// BUG-PHOTOSTAGEDREAD-001 made the pick handler async — it copies each picked file's bytes out of
// the picker's handle before staging anything, so the item is no longer on screen by the time
// fireEvent.change returns. Awaited here rather than at the four call sites; every assertion in this
// file is unchanged, and what it characterizes (a photo failure reaching both the strip and the
// toast) is untouched by the copy.
async function stagePhoto(container) {
  const input = container.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  const file = new File(['x'], 'shot.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }
  dataRef.postError = null; dataRef.deleteError = null; dataRef.harvestsAgg = null
  uploadRef.result = { photo: { id: 'p1' } }
  // jsdom implements neither; the photo staging path uses both.
  if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:stub'
  if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {}
  sessionStorage.clear()
  // V4-STICKY-001 persists the last project/plant to localStorage on every save, so without this
  // each test cold-mounts pre-seeded from its predecessor and the planting picker renders in its
  // already-chosen state. Isolation, not a behaviour change.
  localStorage.clear()
  wireApiFetch()
})

// ── 1. PreserveOffer hosting — INVERTED 2026-08-26 to ZERO hosts (V4-PRESERVEOFFERKILL-001) ────
// HISTORY, because this file's whole value is that it is the only place the offer was ever pinned:
//   S5a  the offer had TWO render sites — the confirmation card and the form body — mutually
//        exclusive only because the card unmounted the form.
//   S5b  the card went away and the form stayed live, so this file pinned "exactly ONE host".
//   NOW  Dave's directive, verbatim: "hide the do you want to do a put up banner which comes up
//        after doing a harvest event: it is never going to be used at that point, wrong process for
//        that." The trigger, both hosts and the component are deleted, so the count is ZERO.
//
// This block is INVERTED rather than deleted, deliberately. A deleted test leaves nothing to stop a
// future session re-adding the offer as a "small ambient nudge" — it was, after all, a reasonable
// idea; it was wrong about THIS HOUSEHOLD, which is a fact only a test can carry forward. Note the
// harvest paths are asserted separately from the non-harvest one: the shipped gate was
// harvest-gated, so a regression that restores it would show up on the harvest paths FIRST, and a
// single combined assertion would let the old (d) case keep passing while (a)-(c) rot.
describe('V4-PRESERVEOFFERKILL-001 — a harvest save raises NO put-up offer, on any path', () => {
  it('(a) overlay path: nothing offered, and the form is still live with its strip intact', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Roma #1', variety_ref: { id: 'v-1', crop_type_slug: 'tomato' } }]
    renderInOverlay('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    // THE assertion of this block now — no prompt, and no residue of its two buttons.
    expect(screen.queryByText(PRESERVE_PROMPT)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Log a put-up' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()

    // NON-VACUITY, and it is the whole reason this test is not just three queryBy nulls: the save
    // must genuinely have happened. Without these, a save that silently failed would pass every
    // assertion above. The S5b slice's own guarantees ride along — form live, strip present, undo
    // reachable — so removing the offer cannot quietly take the confirmation path with it.
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByTestId('post-save-strip')).toBeTruthy()
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
  })

  it('(b) full-page path: the form-body host is gone too, not merely the card', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Roma #1', variety_ref: { id: 'v-1', crop_type_slug: 'tomato' } }]
    renderFullPage('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    // The form-body host was the one that survived S5b and covered THIS path — so a fix that only
    // removed the card's host would still leave the banner here, which is where Dave meets it.
    expect(screen.queryByText(PRESERVE_PROMPT)).toBeNull()
    expect(screen.getByText('Save')).toBeTruthy()
    expect(postCalls.length).toBe(1)   // non-vacuity: the save really went out on this path too
  })

  it('(c) a non-harvest save is unchanged — it never offered, and still does not', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.queryByText(PRESERVE_PROMPT)).toBeNull()
  })
})

// ── 2. capture-before-reset ORDERING ─────────────────────────────────────────────────────────
// plantName (~:932) and seasonCropSlug (~:939-946) are read from client state BEFORE
// resetForNext(keepMode) (~:950) clears form.plant_id. If the feedback call ever moves after the
// reset, the card loses BOTH the planting name and the season line — and no other test notices.
describe('S5a characterization — client-state capture happens BEFORE resetForNext', () => {
  it('the confirmation names the planting AND shows the season line, even though the reset cleared plant_id', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Roma #1', variety_ref: { id: 'v-1', crop_type_slug: 'tomato' } }]
    // response carries plant_id, so the card renders the plantName-bearing arm
    dataRef.postResult = { id: 'evt-9', project_id: 'proj-1', plant_id: 'pl-1' }
    dataRef.harvestsAgg = { aggregates: { crops: [{ crop_name: 'Tomato', units: [{ unit: 'lb', total: 12 }] }] } }
    renderInOverlay('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    // (i) plantName was captured pre-reset — the card names the planting, not "no planting attached"
    expect(screen.getByRole('status').textContent).toMatch(/Roma #1/)
    expect(screen.getByRole('status').textContent).not.toMatch(/no planting attached/)

    // (ii) seasonCropSlug was captured pre-reset — the aggregates GET fired for the RIGHT crop
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/harvests?include=aggregates&crop=tomato'))
    expect(await screen.findByText(/^Season: /)).toBeTruthy()

    // (iii) the reset genuinely DID clear form.plant_id — which is what makes (i)+(ii) an
    //       ordering proof rather than a coincidence: read after the reset, both would be empty.
    //       S5b: read directly off the LIVE form; the `Log another` click that used to be needed
    //       here is the tap this slice removes, so its absence is part of what is being pinned.
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    expect(screen.getByLabelText('Project').value).toBe('proj-1')  // project is deliberately kept
  })

  it('no client-side planting → no aggregates GET and no season line (the same capture, empty)', async () => {
    dataRef.postResult = { id: 'evt-9', project_id: 'proj-1' }
    dataRef.harvestsAgg = { aggregates: { crops: [{ crop_name: 'Tomato', units: [{ unit: 'lb', total: 12 }] }] } }
    renderInOverlay('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    // V4-HARVFAB-001 re-anchor (design §5.3 — an inserted STEP, never a weakened assertion).
    // `event_type=harvest` with no ?plant= and no draft now auto-opens the planting picker, and
    // V4-PICKERUX-001 hides the ENTIRE sticky band (Save + the post-save strip) while a listbox is
    // open — so role=status is correctly inaccessible until the picker is dismissed. The sibling
    // case above needs no such step because pickPlanting() closes the picker by selecting. Escape
    // is the user's own dismissal, not a test-only backdoor. Every assertion below is unchanged.
    fireEvent.keyDown(screen.getByLabelText('Plant or group'), { key: 'Escape' })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(apiFetchSpy.mock.calls.some(c => String(c[0]).startsWith('/api/harvests'))).toBe(false)
    expect(screen.queryByText(/^Season: /)).toBeNull()
  })
})

// ── 3. photoError propagates into BOTH arms ──────────────────────────────────────────────────
// One variable (photoError, ~:908-919) feeds two renderings: the overlay card's role=alert
// (~:1066-1070) and the full-page toast's message text (~:993-998). BUG-PHOTOUPLOADHANG-001: a
// swallowed photo failure must stay VISIBLE on whichever surface the user is actually on.
describe('S5a characterization — photoError reaches both the strip and the toast', () => {
  it('overlay arm: the strip surfaces the photo failure as an alert, and the event still logged', async () => {
    uploadRef.result = { error: 'S3 rejected the upload' }
    const { container } = renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await stagePhoto(container)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    // the save itself succeeded — the photo failure is non-fatal
    expect(postCalls.length).toBe(1)
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    // ...and is visible, with the underlying reason, not silently swallowed
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/photo didn't upload/)
    expect(alert.textContent).toMatch(/S3 rejected the upload/)
    // RESCOPED B5 link invariant (spec §0.2/§9). Was `getAllByRole('link').length === 1`, holding
    // only because the card unmounted the form; the live form's own header links make the
    // document-wide count 3+ for reasons unrelated to this surface. Scoped to the strip, the intent
    // survives and strengthens: the feedback surface contributes NO link at all.
    expect(within(screen.getByTestId('post-save-strip')).queryAllByRole('link')).toHaveLength(0)
    // and there is exactly ONE alert node, not one per failure (spec §4.4/§6) — photoError and an
    // undo error can co-occur, and every test here uses singular getByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('full-page arm: the same failure rides the global undo toast text', async () => {
    uploadRef.result = { error: 'S3 rejected the upload' }
    const { container } = renderFullPage('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await stagePhoto(container)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    const toast = screen.getByRole('status')
    expect(toast.textContent).toMatch(/Logged event for Tomatoes 2026/)
    expect(toast.textContent).toMatch(/but the photo didn't upload/)
  })

  // S5b (spec §4.4/§6): photoError and an undo error CAN co-occur. Before S5b they were two
  // separate role="alert" nodes while every test in the codebase used singular getByRole('alert') —
  // i.e. the second alert would have thrown, not been caught. One container now holds both.
  it('a photo failure and a failed undo share ONE alert node', async () => {
    uploadRef.result = { error: 'S3 rejected the upload' }
    dataRef.deleteError = new Error('boom')
    const { container } = renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await stagePhoto(container)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/undo/i)
    expect(alert.textContent).toMatch(/photo didn't upload/)
  })

  it('a clean photo upload adds no failure text to either arm', async () => {
    const { container } = renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await stagePhoto(container)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
