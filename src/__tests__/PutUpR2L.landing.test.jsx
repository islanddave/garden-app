// Put-Up R2b, lane T — where an entry lands once the "Log a put-up" form is gone (PLAN-R2-V2 section 9;
// DECISIONS "Old state.prefill entries open no door"; the regression seat's rows b2, b3, b4 and b6).
//
// history.state outlives a reload AND a deploy, so the phone still holds entries the form wrote: a
// `state.prefill` in either shape its two senders stored, an origin that names the retired segment, and a
// draft under the form's own key. None of them may open anything, strand the page on a segment that no
// longer exists, or be read at all.
//
// WHAT THIS FILE HOLDS:
//   • an old prefill, in each stored shape: the Pantry is checked, its body is on screen, no door is open,
//     and no field of the prefill is read; the same inside the overlay; a push out of that entry drops it;
//   • an origin `{ label: 'Log a put-up' }` with no kind reads "Pantry" and lands there; with a kind it is a
//     sender like any other and is left alone;
//   • the form's draft ('put-up') is cleared at mount, by its exact key: 'put-up/batch-close' is untouched;
//   • three segments, none of them the form's.
//
// WHY BrowserRouter AND window.history (as PutUp.laneA.modes.test.jsx): the entries under test are STORED
// ones, seeded the way a reload finds them, and the origin's Back pops only on a real history index.
// The page is the real page with its real children; only the network, the signed-in user and two hooks the
// retired form read are stand-ins.
//
// MUTATIONS (to be applied after the cut has landed; each names the test it reds) are in the lane report,
// report-lane-t-r2b, as L-T1 to L-T9.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182). Nothing here reads a clock.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchMock, viewer } = vi.hoisted(() => ({ fetchMock: vi.fn(), viewer: { id: null } }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
// Read by the retired form only. Stood in so that this file RUNS at the base it is written against (where
// the form still mounts) and fails there on its assertions, never on a crash.
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'pepper', display_name: 'Peppers', category: 'vegetable' }], loading: false }),
}))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: viewer.id ? { id: viewer.id } : null, profile: null, loading: false, identity: viewer.id ? 'signed-in' : 'signed-out' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'
import { PUT_UP_SEGMENTS, segmentLabel, originSegment } from '../components/putup/goingNow.js'
import { CLOSE_DRAFT_KEY } from '../components/putup/BatchCloseField.jsx'
import { draftKey, writeDraft } from '../lib/draftStash.js'

// The retired segment's label and the retired form's draft key, as LITERALS: they are what is stored on a
// phone, and neither may be read off a constant the cut is free to delete.
const RETIRED_LABEL = 'Log a put-up'
const RETIRED_DRAFT = 'put-up'

// The two shapes the form's senders stored (recon B section 2.4): the planting links', and the form's own
// recent-harvest picker's (src/lib/putUpPrefill.js prefillFromHarvestEntry at the base) — which can have no
// planting at all, for a harvest nobody attributed.
const OLD_PREFILLS = [
  ['the planting link’s', { plant_id: 'p-1', crop_type_slug: 'pepper', variety_id: 'v-1' }],
  ['the harvest picker’s', { crop_type_slug: 'pepper', variety_id: 'v-1', plant_id: 'p-1', harvest_log_id: 'h-1', quantity_value: 2, quantity_unit: 'cups' }],
  ['the harvest picker’s, for an unattributed harvest', { crop_type_slug: 'pepper', harvest_log_id: 'h-2', quantity_value: 3, quantity_unit: 'count' }],
]
const BG = { pathname: '/today', search: '', hash: '', key: 'bg', historyEntry: { idx: 0, doc: 'd1' } }

const batch = (id, user_id) => ({
  id, user_id, label: id, kind: 'ferment', kind_other: null, started_at: null, start_precision: null,
  first_recorded_at: '2026-09-03T12:00:00.000Z', expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: '2026-09-03T12:00:00.000Z', input_count: 0, output_count: 0,
})
const DAVES = batch('kb-dave', 'user_dave')

let going
function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (method !== 'GET') return Promise.resolve(null)
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches: going })
    if (path.startsWith('/api/kitchen-batches?state=closed')) return Promise.resolve({ state: 'closed', batches: [] })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [] })
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    if (path === '/api/recipes') return Promise.resolve({ recipes: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

// ── the history rig (PutUp.laneA.modes.test.jsx's, cut down) ───────────────────────────────────────
// Every test starts on a floor with the entry under test on top of it. `state` is the router's `usr`, handed
// to history AS THE OBJECT IT IS (jsdom keeps the reference), so a getter on it counts the page's reads.
// `under` seeds app entries between the floor and the entry, as a reload finds them.
const at = { loc: null }
function Probe() {
  at.loc = useLocation()
  return null
}
let keys = 0
function renderAt(url, { state = null, idx = 0, under = [], overlay = false, as = 'user_dave' } = {}) {
  viewer.id = as
  window.history.pushState({ __floor: 1 }, '', '/floor')
  for (const e of under) window.history.pushState({ usr: e.state ?? null, key: `r2l-${keys++}`, idx: e.idx ?? 0 }, '', e.url)
  window.history.pushState({ usr: state, key: `r2l-${keys++}`, idx }, '', url)
  const page = overlay ? <OverlaySurfaceProvider><PutUp /></OverlaySurfaceProvider> : <PutUp />
  return render(
    <BrowserRouter>
      <Probe />
      <Routes>
        <Route path="/put-up" element={page} />
        <Route path="/floor" element={<div data-testid="floor">the entry under the app</div>} />
      </Routes>
    </BrowserRouter>
  )
}
const loc = () => at.loc.pathname + at.loc.search
const radios = () => within(screen.getByRole('radiogroup', { name: 'Put-Up view' })).getAllByRole('radio')
const segment = () => radios().find(r => r.getAttribute('aria-checked') === 'true')?.textContent
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
// The bare-open promotion is decided once, on the first answer to the page's own batch read; wait for that
// answer before reading where the page landed.
async function settled() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches?state=going'))
  await flush()
}
// A prefill whose every field counts its own reads. The page may carry the object about (a spread of the
// entry's state copies the reference); it may not look inside it.
function counted(shape) {
  const tally = { reads: 0 }
  const prefill = {}
  for (const [k, v] of Object.entries(shape)) {
    Object.defineProperty(prefill, k, { enumerable: true, get() { tally.reads += 1; return v } })
  }
  return { prefill, tally }
}
// What a landing on the Pantry is: its segment checked, its body on screen, and nothing over it.
function expectPantryAndNoDoor() {
  expect(segment()).toBe('Pantry')
  expect(screen.getByTestId('pantry-view')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByTestId('door-what-name')).toBeNull()
  expect(screen.queryByTestId('putup-prefill-strip')).toBeNull()
}

beforeEach(() => {
  fetchMock.mockReset(); going = []; wire(); viewer.id = null; at.loc = null
  localStorage.clear(); sessionStorage.clear()
})
afterEach(() => { cleanup() })

describe('an entry on /put-up that still carries an old state.prefill', () => {
  it.each(OLD_PREFILLS)('%s shape: the Pantry is checked, its body is showing, and no door is open', async (_name, prefill) => {
    renderAt('/put-up', { state: { prefill } })
    await settled()
    expect(segment()).toBe('Pantry')
    await screen.findByTestId('pantry-view')
    expectPantryAndNoDoor()
  })

  it.each(OLD_PREFILLS)('%s shape: no field of the prefill is ever read', async (_name, shape) => {
    const { prefill, tally } = counted(shape)
    renderAt('/put-up', { state: { prefill } })
    await settled()
    await flush()
    expect(tally.reads).toBe(0)
    // The count is a live one: the entry holds the very object, and a read of it is seen.
    expect(window.history.state.usr.prefill).toBe(prefill)
    void prefill[Object.keys(shape)[0]]
    expect(tally.reads).toBe(1)
  })

  it.each(OLD_PREFILLS)('%s shape, inside the overlay: the same landing, nothing read, and the background still on the entry', async (_name, shape) => {
    const { prefill, tally } = counted(shape)
    renderAt('/put-up', { state: { background: BG, prefill }, overlay: true })
    await settled()
    expect(segment()).toBe('Pantry')
    await screen.findByTestId('pantry-view')
    expectPantryAndNoDoor()
    expect(tally.reads).toBe(0)
    expect(at.loc.state.background).toEqual(BG)
  })

  // The bare-open rule is the only thing that may move such an entry off the Pantry: with a batch of the
  // viewer's own going, the segment checked is still one of the three, with its body, and no door.
  it.each(OLD_PREFILLS)('%s shape, with a batch of the viewer’s own going: a segment that exists is checked, with a body and no door', async (_name, prefill) => {
    going = [DAVES]
    renderAt('/put-up', { state: { prefill } })
    await settled()
    expect(['Going now', 'Pantry', 'Recipes']).toContain(segment())
    expect(screen.queryByTestId('going-now-view') ?? screen.queryByTestId('pantry-view')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('putup-prefill-strip')).toBeNull()
  })

  // withFrom is every write this page makes to an entry's state; the use-soon chip's is the one a Pantry
  // landing can reach in one tap. The overlay's background rides along, the prefill does not.
  it.each(OLD_PREFILLS)('%s shape: a write from that entry keeps the background and drops the prefill', async (_name, prefill) => {
    renderAt('/put-up?view=pantry&filter=use-soon', { state: { background: BG, prefill }, overlay: true })
    await settled()
    expect(segment()).toBe('Pantry')
    fireEvent.click(await screen.findByTestId('putup-use-soon-chip'))
    await waitFor(() => expect(loc()).toBe('/put-up?view=pantry'))
    expect(at.loc.state).toEqual({ background: BG })
  })
})

// A mode entry as a reload finds it: [the floor, the list at index 0, the mode at index 1]. A batch of the
// viewer's own is going, so the page that mounts on it holds Going now — which is not the Pantry, and so a
// landing on the Pantry is the press's doing and nobody else's.
describe('an entry whose stored origin is the retired segment', () => {
  const LIST = [{ url: '/put-up', idx: 0 }]

  it('with no kind: the Back reads "← Pantry", and lands on the Pantry', async () => {
    going = [DAVES]
    renderAt('/put-up?state=closed', { state: { from: { label: RETIRED_LABEL } }, idx: 1, under: LIST })
    await screen.findByTestId('putup-closed-mode')
    await settled()
    expect(screen.getByTestId('putup-mode-back').textContent).toBe('← Pantry')
    fireEvent.click(screen.getByTestId('putup-mode-back'))
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)                    // the pop, to the list entry under it
    expect(segment()).toBe('Pantry')
    expect(await screen.findByTestId('pantry-view')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with a kind it is a sender like any other: its words are left alone, and the press moves no segment', async () => {
    going = [DAVES]
    renderAt('/put-up?state=closed', { state: { from: { label: RETIRED_LABEL, kind: 'batch', id: 'kb-9' } }, idx: 1, under: LIST })
    await screen.findByTestId('putup-closed-mode')
    await settled()
    expect(screen.getByTestId('putup-mode-back').textContent).toBe('← Log a put-up (batch)')
    fireEvent.click(screen.getByTestId('putup-mode-back'))
    await waitFor(() => expect(loc()).toBe('/put-up'))
    expect(window.history.state.idx).toBe(0)
    expect(segment()).toBe('Going now')                         // what the page was holding; not the Pantry
  })

  it('originSegment: the retired label with no kind names the Pantry; with a kind it names nothing', () => {
    expect(originSegment({ from: { label: RETIRED_LABEL } })).toBe('pantry')
    expect(originSegment({ from: { label: `  ${RETIRED_LABEL}  ` } })).toBe('pantry')
    expect(originSegment({ from: { label: RETIRED_LABEL, kind: 'batch', id: 'kb-9' } })).toBeNull()
    expect(originSegment({ from: { label: RETIRED_LABEL, kind: 'recipe', id: 'rc-9' } })).toBeNull()
    // Only that label: nothing else a segment never carried starts naming one.
    expect(originSegment({ from: { label: 'Log a put up' } })).toBeNull()
    expect(originSegment({ from: { label: 'Pantry' } })).toBe('pantry')
  })
})

describe('the retired form’s draft', () => {
  const FORM_DRAFT = { ctx: '|||', crop_type_slug: 'pepper', quantity_value: '4', notes: 'half typed' }
  const CLOSE_DRAFT = { batchId: 'kb-1', kept: true, note: 'half typed' }
  function seedDrafts() {
    writeDraft(RETIRED_DRAFT, FORM_DRAFT)
    writeDraft(CLOSE_DRAFT_KEY, CLOSE_DRAFT)
    return sessionStorage.getItem(draftKey(CLOSE_DRAFT_KEY))
  }

  it('is cleared at mount, by its exact key: the batch-close draft beside it is untouched', async () => {
    const closeBefore = seedDrafts()
    expect(CLOSE_DRAFT_KEY).toBe('put-up/batch-close')
    expect(sessionStorage.getItem('gardenApp.draft.put-up')).not.toBeNull()
    renderAt('/put-up')
    await settled()
    expect(sessionStorage.getItem('gardenApp.draft.put-up')).toBeNull()
    expect(sessionStorage.getItem('gardenApp.draft.put-up/batch-close')).toBe(closeBefore)
  })

  it('is cleared on an entry that carries an old prefill too, and is not written again', async () => {
    const closeBefore = seedDrafts()
    renderAt('/put-up', { state: { prefill: OLD_PREFILLS[1][1] } })
    await settled()
    await flush()
    expect(sessionStorage.getItem('gardenApp.draft.put-up')).toBeNull()
    expect(sessionStorage.getItem('gardenApp.draft.put-up/batch-close')).toBe(closeBefore)
  })

  it('is cleared when the page mounts on a mode, where no segment is on screen', async () => {
    const closeBefore = seedDrafts()
    renderAt('/put-up?state=closed')
    await screen.findByTestId('putup-closed-mode')
    await settled()
    expect(sessionStorage.getItem('gardenApp.draft.put-up')).toBeNull()
    expect(sessionStorage.getItem('gardenApp.draft.put-up/batch-close')).toBe(closeBefore)
  })
})

describe('the segments', () => {
  it('exactly three are offered on the page, and none is "Log a put-up"', async () => {
    renderAt('/put-up')
    await settled()
    expect(radios().map(r => r.textContent)).toEqual(['Going now', 'Pantry', 'Recipes'])
    expect(screen.queryByRole('radio', { name: RETIRED_LABEL })).toBeNull()
    expect(screen.queryByText(RETIRED_LABEL)).toBeNull()
  })

  it('the one list behind the control and the Back’s words holds the same three, and no value is "log"', () => {
    expect(PUT_UP_SEGMENTS.map(s => [s.value, s.label])).toEqual([
      ['going', 'Going now'], ['pantry', 'Pantry'], ['recipes', 'Recipes'],
    ])
    expect(segmentLabel('log')).toBeNull()
  })
})
