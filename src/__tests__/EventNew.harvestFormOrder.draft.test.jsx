// V4-HARVFORMORDER-001 (S4) — draft-stash survival across the reorder.
//
// The stash is unconditional (V4-DRAFTFULLPAGE-001 — both surfaces, not overlay-gated) and stores
// `form` plus the disclosure toggles. S4 moved Notes UNDER a collapsed disclosure on the harvest
// path, which creates a failure mode the byte-level stash cannot see: the draft restores correctly
// and the user still cannot SEE their half-typed note. Restoring bytes into an invisible control is
// indistinguishable from losing them.
//
// The load-bearing case is a PRE-S4 draft — one written by the currently-deployed bundle, which has
// no showHarvestMore key at all. That is what a real user carries across this deploy, and it is
// pinned first below. No jest-dom (L-182). Harness mirrors EventNewDraftFullPage.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
// Shipped configuration.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }
const DRAFT_KEY = 'gardenApp.draft.logone'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return dataRef.postError ? Promise.reject(dataRef.postError) : Promise.resolve(dataRef.postResult)
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

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// A draft exactly as the CURRENTLY DEPLOYED bundle writes it: no showHarvestMore key.
function seedPreS4Draft(formOverrides = {}) {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
    v: 1,
    data: {
      form: {
        event_type: 'harvest', notes: 'two ripe, one split', private_notes: '', quantity: '',
        event_date: '2026-08-01T10:00', is_public: true, plant_id: 'plant-1',
        ...formOverrides,
      },
      showPrivate: false, showAddDetails: false,
    },
  }))
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }; dataRef.postError = null
  sessionStorage.clear()
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('V4-HARVFORMORDER-001 — draft stash survives the reorder', () => {
  it('a PRE-S4 harvest draft restores its notes AND makes them visible', async () => {
    seedPreS4Draft()
    renderEventNew('')
    await flushLoad()

    // The disclosure is force-opened because restored text exists — otherwise the note would be
    // in the form state and nowhere on the screen.
    expect(screen.getByTestId('harvest-more-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Notes').value).toBe('two ripe, one split')
    // The rest of the draft came back too — this is a restore, not just a disclosure state.
    // V4-EVENTSEL-005: the When control is now type="date". This draft was WRITTEN in the
    // datetime-local shape ('2026-08-01T10:00'), which is exactly the back-compat case the
    // `.slice(0, 10)` at the input guards — an <input type="date"> renders that raw string as
    // EMPTY. Asserting the sliced value here is the regression pin for restored legacy drafts.
    expect(screen.getByLabelText('Event date').value).toBe('2026-08-01')
    // PlantingSelect swaps its combobox for a selected-state chip once it holds a value, so the
    // restored plant_id is asserted on the chip — NOT on the 'Plant or group' combobox, which is
    // not in the tree at all in this state.
    expect(screen.getByTestId('evtnew-planting-chip').textContent).toMatch(/Sungold/)
  })

  it('a PRE-S4 harvest draft with NO text leaves the disclosure collapsed', async () => {
    seedPreS4Draft({ notes: '', quantity: 'x' })  // quantity is what makes it dirty, not text in the disclosure
    renderEventNew('')
    await flushLoad()
    expect(screen.getByTestId('harvest-more-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('typing into the disclosed Notes writes the draft, and the toggle state rides along', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'first pick of the row' } })

    const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY))
    expect(parsed.data.form.notes).toBe('first pick of the row')
    expect(parsed.data.form.event_type).toBe('harvest')
    expect(parsed.data.showHarvestMore).toBe(true)
  })

  it('round-trips: type on harvest, unmount, remount, the note is back and readable', async () => {
    const first = renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'half a colander' } })
    first.unmount()

    renderEventNew('')   // bare mount — no deep-link seed, so the draft wins
    await flushLoad()
    expect(screen.getByLabelText('Notes').value).toBe('half a colander')
  })

  it('a non-harvest draft is untouched by any of this', async () => {
    seedPreS4Draft({ event_type: 'watering', notes: 'ran the drip 20 min', plant_id: '' })
    renderEventNew('')
    await flushLoad()
    // No disclosure exists on a non-harvest type; Notes is simply visible where it has always been.
    expect(screen.queryByTestId('harvest-more-toggle')).toBe(null)
    expect(screen.getByLabelText('Notes').value).toBe('ran the drip 20 min')
  })
})
