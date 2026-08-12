// V4-HARVUNITDEFAULT-001 (BD0806-15) — the harvest unit selector pre-selects the crop's curated
// crop_types.default_unit, carried to the client on variety_ref by lambda/plants/index.js.
//
// WHY THIS TIER EXISTS. Before this change the resolution chain was:
//   lastHarvestUnit:<slug>  →  lastHarvestUnit (GLOBAL)  →  'count'
// The global key is whatever unit the last harvest of ANY crop used, so the first time Dave
// harvested a new crop the selector offered the previous crop's unit — the documented "cups
// blueberry pick defaults cups onto the next count-crop harvest" corruption vector from
// BUG-LOGTARGETREQ-001. This suite pins the new tier BETWEEN the per-crop memory and that global
// key, so it can only ever displace a cross-crop guess and never a real per-crop signal.
//
// Every assertion below reads the rendered <select>.value — the user-visible pre-selection — not
// the helper's return value. A unit that resolves correctly in a pure function but never reaches
// the control is the inert-ship failure mode this file exists to prevent.
//
// Harness mirrors EventNewStickyProject.test.jsx.

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

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

// Shapes mirror the live /api/plants payload after the lambda/plants/index.js change:
// variety_ref carries crop_type_slug AND the crop type's default_unit.
// 'broccoli' is head / 'blueberry' is cup / 'tomato' is count on prod — real values.
const BROCCOLI = { id: 'pl-broc', name: 'Belstar', variety_ref: { id: 'v-br', name: 'Belstar', crop_type_slug: 'broccoli', default_unit: 'head' } }
const BLUEBERRY = { id: 'pl-blue', name: 'Blueberry Row', variety_ref: { id: 'v-b', name: 'Bluecrop', crop_type_slug: 'blueberry', default_unit: 'cup' } }
const TOMATO = { id: 'pl-tom', name: 'Sungold', variety_ref: { id: 'v-t', name: 'Sungold', crop_type_slug: 'tomato', default_unit: 'count' } }
// A flower: all 50 non-edible crop types on prod carry default_unit NULL by design.
const MARIGOLD = { id: 'pl-mar', name: 'Marigold Border', variety_ref: { id: 'v-m', name: 'Marigold', crop_type_slug: 'marigold', default_unit: null } }

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

describe('V4-HARVUNITDEFAULT-001 — crop default_unit pre-selects the harvest unit', () => {
  // THE FAILING-BEFORE CASE. No memory of any kind: pre-change this rendered 'count' (the hard
  // default). Post-change the crop's curated unit is the visible pre-selection.
  it('pre-selects the crop default_unit on a crop with no prior harvest memory', async () => {
    await setup([BROCCOLI])
    // Before any planting is chosen there is no crop context — the old chain still governs.
    await waitFor(() => expect(unitValue()).toBe('count'))
    await pickPlanting('pl-broc')
    // The rendered control now shows the crop's curated unit, not the hard default.
    await waitFor(() => expect(unitValue()).toBe('head'))
  })

  // THE CORRUPTION VECTOR. Global key says 'cup' (last save was blueberries); picking a
  // count-crop must NOT inherit it. Pre-change this rendered 'cup' — the exact silent wrong-unit
  // log this ticket exists to stop.
  it('crop default_unit outranks the global lastHarvestUnit from a different crop', async () => {
    localStorage.setItem('lastHarvestUnit', 'cup')
    await setup([TOMATO])
    await waitFor(() => expect(unitValue()).toBe('cup'))
    await pickPlanting('pl-tom')
    await waitFor(() => expect(unitValue()).toBe('count'))
  })

  // The per-crop memory is Dave's OWN history for THIS crop — strictly stronger evidence than a
  // curated table value. A default that overruled it would be a regression, not a feature.
  it('per-crop memory still wins over the crop default_unit', async () => {
    localStorage.setItem('lastHarvestUnit:blueberry', 'lb')
    await setup([BLUEBERRY])
    await pickPlanting('pl-blue')
    await waitFor(() => expect(unitValue()).toBe('lb'))
  })

  // FALLBACK — a crop with NO default_unit must degrade to today's behavior exactly.
  it('falls back to the global lastHarvestUnit when the crop default_unit is null', async () => {
    localStorage.setItem('lastHarvestUnit', 'lb')
    await setup([MARIGOLD])
    await pickPlanting('pl-mar')
    await act(async () => { await Promise.resolve() })
    expect(unitValue()).toBe('lb')
  })

  it("falls back to 'count' when the crop default_unit is null and nothing is remembered", async () => {
    await setup([MARIGOLD])
    await pickPlanting('pl-mar')
    await act(async () => { await Promise.resolve() })
    expect(unitValue()).toBe('count')
  })

  // A planting with no variety at all (3 live on prod) — both halves of the chain read undefined.
  it('falls back cleanly for a planting with no variety_ref', async () => {
    localStorage.setItem('lastHarvestUnit', 'oz')
    await setup([{ id: 'pl-bare', name: 'Mystery Row', variety_ref: null }])
    await pickPlanting('pl-bare')
    await act(async () => { await Promise.resolve() })
    expect(unitValue()).toBe('oz')
  })

  // A default_unit outside HARVEST_UNITS must never reach the <select>, or it renders as a dead
  // option that silently coerces the control to a blank value.
  it('ignores a crop default_unit that is not a valid harvest unit', async () => {
    localStorage.setItem('lastHarvestUnit', 'lb')
    await setup([{ id: 'pl-x', name: 'Odd', variety_ref: { crop_type_slug: 'odd', default_unit: 'furlongs' } }])
    await pickPlanting('pl-x')
    await act(async () => { await Promise.resolve() })
    expect(unitValue()).toBe('lb')
  })

  // An explicit in-entry pick is a deliberate user choice and outranks every seeded tier.
  it('never overrides an explicit in-entry unit choice', async () => {
    await setup([BROCCOLI])
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'lb' } })
    await pickPlanting('pl-broc')
    await act(async () => { await Promise.resolve() })
    expect(unitValue()).toBe('lb')
  })

  // Switching between crops re-seeds each time — the previous crop's default must not stick.
  it('re-seeds the default when the chosen planting changes crop', async () => {
    await setup([BROCCOLI, TOMATO])
    await pickPlanting('pl-broc')
    await waitFor(() => expect(unitValue()).toBe('head'))
    await pickPlanting('pl-tom')
    await waitFor(() => expect(unitValue()).toBe('count'))
  })

  // End-to-end: the pre-selected unit is what actually gets submitted, and it seeds the per-crop
  // memory so the SECOND harvest of this crop resolves at tier 1 rather than tier 2.
  it('submits the pre-selected crop default and writes it to the per-crop memory', async () => {
    await setup([BROCCOLI])
    await pickPlanting('pl-broc')
    await waitFor(() => expect(unitValue()).toBe('head'))
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.unit).toBe('head')
    expect(localStorage.getItem('lastHarvestUnit:broccoli')).toBe('head')
  })
})
