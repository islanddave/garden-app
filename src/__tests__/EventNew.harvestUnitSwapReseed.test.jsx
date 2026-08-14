// BUG-HARVUNITSTICKY-001 (BD-012) — the unit-touched guard is scoped to the PLANTING, not the
// entry. Pre-fix, unitTouchedRef reset on event-type change and post-save but never on a
// form.plant_id change, so a unit picked under planting A ("cup" for blueberries) survived a
// mid-entry swap to planting B (cucumber) and shipped a wrong-unit harvest row — the exact
// crop×unit corruption the per-crop lastHarvestUnit key exists to stop. A swap OFF a real
// planting now clears the guard so the new planting re-seeds through the same chain a fresh
// selection uses (per-crop memory → crop default_unit → global → 'count').
//
// Swap semantics ONLY — everything else is pinned unchanged:
//   - an explicit pick made BEFORE any planting is chosen still survives the first selection
//     (sibling suite EventNew.harvestUnitCropDefault: 'never overrides an explicit in-entry
//     unit choice');
//   - a pick made AFTER the swap sticks through save;
//   - quantity / notes / date survive the swap exactly as before (the re-seed only ever
//     touches `unit`);
//   - the entry-level resets (type change, post-save resetForNext) keep working.
//
// Harness mirrors EventNew.harvestUnitCropDefault.test.jsx.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postResult: { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] },
    postError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }),
    isUploading: false,
    error: null,
    photo: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

// Planting-optional arm, matching the sibling EventNew suites: these cases are about the unit
// control, and the required-planting flag only changes whether Save is reachable.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      if (dataRef.postError) return Promise.reject(dataRef.postError)
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

const PROJECT = { id: 'proj-1', name: 'Mixed Beds 2026', status: 'growing' }

// Shapes mirror the live /api/plants payload: variety_ref carries crop_type_slug AND the crop
// type's default_unit. blueberry=cup / cucumber=count / tomato=count on prod — real values.
const BLUEBERRY = { id: 'pl-blue', name: 'Blueberry Row', variety_ref: { id: 'v-b', name: 'Bluecrop', crop_type_slug: 'blueberry', default_unit: 'cup' } }
const CUCUMBER = { id: 'pl-cuke', name: 'Marketmore', variety_ref: { id: 'v-c', name: 'Marketmore', crop_type_slug: 'cucumber', default_unit: 'count' } }
const TOMATO = { id: 'pl-tom', name: 'Sungold', variety_ref: { id: 'v-t', name: 'Sungold', crop_type_slug: 'tomato', default_unit: 'count' } }

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// PlantingSelect collapses to a chip once a planting is chosen, so a SECOND pick has to reopen it
// via the chip's "Change" button rather than the combobox input.
async function pickPlanting(id) {
  const reopen = screen.queryByText('Change')
  if (reopen) fireEvent.click(reopen)
  else fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

// Render the harvest form with a project chosen and the given plantings loaded.
async function setup(plants) {
  dataRef.plants = plants
  renderEventNew('event_type=harvest')
  await flushLoad()
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
}

const unitValue = () => screen.getByLabelText('Harvest unit').value
const setUnit = (u) => fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: u } })

describe('BUG-HARVUNITSTICKY-001 — planting swap re-seeds an explicitly touched unit', () => {
  // THE FAILING-BEFORE CASE. Unit explicitly touched under planting A; swapping to planting B
  // pre-fix kept the touched unit (guard never reset on plant_id change). Post-fix the swap
  // clears the guard and B seeds its own default.
  it('re-seeds the unit on a planting swap even after an explicit in-entry pick', async () => {
    await setup([BLUEBERRY, CUCUMBER])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    setUnit('lb') // deliberate pick under the blueberry planting
    expect(unitValue()).toBe('lb')
    await pickPlanting('pl-cuke')
    await waitFor(() => expect(unitValue()).toBe('count'))
  })

  // The LITERAL ledger scenario: blueberries logged in "cup" (explicitly confirmed by touching
  // the control), planting swapped to cucumber mid-entry. Pre-fix the row would save as
  // cucumber×cup. The touch sequence goes through a different value and back because a
  // same-value change never reaches React's onChange (value tracking dedupes it).
  it("blueberries-in-cup swapped to cucumber does not keep 'cup'", async () => {
    await setup([BLUEBERRY, CUCUMBER])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    setUnit('lb')
    setUnit('cup') // Dave lands on 'cup' via explicit touches — guard is set, value matches seed
    expect(unitValue()).toBe('cup')
    await pickPlanting('pl-cuke')
    await waitFor(() => expect(unitValue()).toBe('count'))
  })

  // A pick made AFTER the swap is a deliberate choice about the NEW planting — it must survive
  // to the save payload untouched (and seed the new crop's per-crop memory).
  it('an explicit pick AFTER the swap sticks through save', async () => {
    await setup([BLUEBERRY, TOMATO])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    await pickPlanting('pl-tom')
    await waitFor(() => expect(unitValue()).toBe('count'))
    setUnit('lb') // post-swap deliberate pick
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.unit).toBe('lb')
    expect(localStorage.getItem('lastHarvestUnit:tomato')).toBe('lb')
  })

  // FOR UNIT SEEDING ONLY: the swap must not clobber any other in-progress field. The re-seed
  // effect only ever writes `unit`; quantity, notes, and the event date ride through the swap
  // exactly as they did pre-fix. (Notes and When live inside the "Photo, notes & date"
  // disclosure on the harvest layout.)
  it('quantity, notes, and date survive the swap unchanged', async () => {
    await setup([BLUEBERRY, CUCUMBER])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'first picking' } })
    fireEvent.change(screen.getByLabelText('Event date'), { target: { value: '2026-08-10' } })
    await pickPlanting('pl-cuke')
    await waitFor(() => expect(unitValue()).toBe('count'))
    expect(screen.getByLabelText('Harvest quantity').value).toBe('2.5')
    expect(screen.getByLabelText('Notes').value).toBe('first picking')
    expect(screen.getByLabelText('Event date').value).toBe('2026-08-10')
  })

  // REGRESSION PIN — the entry-level reset on event-type change (EventNew ~L528) still works:
  // a touched unit does not survive a type round-trip; re-entering harvest re-seeds from the
  // per-crop chain for the still-selected planting. The per-crop key is rewritten between the
  // two type clicks so the assertion discriminates a fresh seed from leftover touched state.
  it('event-type change still resets the guard and re-seeds on return to harvest', async () => {
    await setup([BLUEBERRY])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    setUnit('lb')
    fireEvent.click(screen.getByText('Watered'))
    localStorage.setItem('lastHarvestUnit:blueberry', 'oz')
    fireEvent.click(screen.getByText('Harvested'))
    await waitFor(() => expect(unitValue()).toBe('oz'))
  })

  // REGRESSION PIN — the post-save reset (resetForNext) still works: the single Save is the
  // V4-EVENTSAVE-001 rapid next-plant flow (keepMode 'type': harvest KEPT, planting CLEARED),
  // so post-save the unit falls back to the global key — the touched pick does not linger as a
  // pin. Re-picking a planting for harvest #2 then seeds from the per-crop chain like a fresh
  // entry. The per-crop key is overwritten after the save (which itself writes 'lb' to it) so
  // the assertion discriminates a fresh per-crop seed from leftover touched state.
  it('post-save reset still re-seeds the next harvest entry', async () => {
    await setup([BLUEBERRY])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    setUnit('lb')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.unit).toBe('lb')
    // planting cleared, no crop context → the global key ('lb', written by the save) seeds
    await waitFor(() => expect(unitValue()).toBe('lb'))
    localStorage.setItem('lastHarvestUnit:blueberry', 'oz')
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('oz'))
  })

  // REGRESSION PIN — an untouched unit keeps re-seeding across swaps (the pre-fix happy path,
  // also pinned by the sibling suite's 're-seeds the default when the chosen planting changes
  // crop'; kept here so this file alone covers the swap matrix touched × untouched).
  it('an untouched unit still re-seeds across swaps', async () => {
    await setup([BLUEBERRY, CUCUMBER])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
    await pickPlanting('pl-cuke')
    await waitFor(() => expect(unitValue()).toBe('count'))
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('cup'))
  })
})
