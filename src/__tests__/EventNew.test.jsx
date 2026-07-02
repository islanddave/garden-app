// Unit tests for src/pages/EventNew.jsx — V1.2a-2 Wave 3 additions:
// harvest panel, observation flag form, POST body wiring, friendlyError,
// deep-link project safety. Pre-existing behavior is exercised only as far
// as needed to reach the new code paths.
//
// useApiFetch is mocked to a controllable fetch: GETs resolve the mount-time
// projects/locations/plants loads; POST /api/events captures the body and
// resolves (or rejects) per-test. react-router-dom is fully mocked (matches
// the Plants.test.jsx convention) — useSearchParams is driven by a hoisted ref
// so we can simulate deep-link query params per test.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
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


vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// ── apiFetch behavior: route GETs to fixture data, capture POSTs ────────
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

// Simulate deep-link query params, then render.
function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

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

// Wait for the mount-time projects/locations load to settle.
async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

describe('EventNew — harvest panel rendering', () => {
  it('renders the harvest panel when event_type is harvest', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
    expect(screen.getByLabelText('Harvest unit')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Harvest quality' })).toBeTruthy()
  })

  it('does NOT render the harvest panel for non-harvest event types', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.queryByLabelText('Harvest quantity')).toBeNull()
  })

  it('hides the generic Quantity section for harvest events', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    // The generic freetext quantity input has aria-label "Quantity"
    expect(screen.queryByLabelText('Quantity')).toBeNull()
  })

  it('shows the generic Quantity section for non-harvest events (under "Add details")', async () => {
    // V3-EVENT-008 §8: Quantity moved into the collapsed "Add details" section to
    // declutter the common logging path. It is NOT removed — expanding the section
    // reveals it. Assert it is reachable (the field + its state/payload wiring intact).
    renderEventNew('event_type=watering')
    await flushLoad()
    // Collapsed by default (EVENTNEW_ADD_DETAILS_EXPANDED=false): not yet in the DOM.
    expect(screen.queryByLabelText('Quantity')).toBeNull()
    // The expander label lives in its own <span> ("Add details  ·  optional"); match on
    // a stable substring so the leading toggle-arrow span doesn't break the matcher.
    fireEvent.click(screen.getByText(/Add details/i))
    expect(screen.getByLabelText('Quantity')).toBeTruthy()
  })

  it('renders anchored quality labels (not a star widget)', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByText('1 = inedible')).toBeTruthy()
    expect(screen.getByText('3 = acceptable')).toBeTruthy()
    expect(screen.getByText('5 = excellent')).toBeTruthy()
  })
})

describe('EventNew — harvest unit default from localStorage', () => {
  it('defaults the unit select to lastHarvestUnit when set and valid', async () => {
    localStorage.setItem('lastHarvestUnit', 'lb')
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('lb')
  })

  it("defaults to 'count' when localStorage is unset", async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('count')
  })

  it("defaults to 'count' when localStorage holds an invalid unit", async () => {
    localStorage.setItem('lastHarvestUnit', 'furlongs')
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('count')
  })
})

describe('EventNew — harvest client-side validation', () => {
  async function setupHarvest() {
    renderEventNew('event_type=harvest')
    await flushLoad()
    // select the project so the project gate passes
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  }

  it('blocks POST with an inline error when quantity is empty', async () => {
    await setupHarvest()
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity is zero', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '0' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity is negative', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '-5' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity exceeds MAX_PLAUSIBLE for the unit', async () => {
    await setupHarvest()
    // count cap is 10000
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'count' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '99999' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/higher than expected/i)).toBeTruthy()
  })
})

describe('EventNew — valid harvest submit', () => {
  it('fires a POST with harvest:{quantity,unit,quality_rating} and writes lastHarvestUnit', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'lb' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2.5' } })
    // pick a quality rating
    fireEvent.click(screen.getByLabelText('4 = good'))

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    const body = postCalls[0]
    expect(body.event_type).toBe('harvest')
    expect(body.harvest).toEqual({ quantity: 2.5, unit: 'lb', quality_rating: 4 })
    // generic freetext quantity nulled for harvest events
    expect(body.quantity).toBeNull()
    expect(localStorage.getItem('lastHarvestUnit')).toBe('lb')
  })

  it('sends quality_rating: null when no quality picked', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.quality_rating).toBeNull()
  })
})

describe('EventNew — deep-link project safety', () => {
  it('clears an unknown ?project= param and shows the "Project not found" notice', async () => {
    renderEventNew('project=ghost-project')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByText('Project not found — pick one.')).toBeTruthy()
    })
    // selection cleared back to placeholder
    expect(screen.getByLabelText('Project').value).toBe('')
  })

  it('keeps a valid ?project= param and shows no notice', async () => {
    renderEventNew('project=proj-1')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-1')
    })
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
  })
})

describe('EventNew — friendlyError on server failure', () => {
  it('maps a server quantity-exceeds error to canned copy, never the raw string', async () => {
    dataRef.postError = Object.assign(
      new Error('harvest.quantity exceeds max for unit lb'),
      { status: 400 },
    )
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Quantity is unusually high — double-check?')).toBeTruthy()
    // raw server string must NOT appear
    expect(screen.queryByText(/exceeds max for unit/i)).toBeNull()
  })

  it('maps a generic 5xx to "Couldn\'t save — try again."', async () => {
    dataRef.postError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Couldn’t save — try again.')).toBeTruthy()
  })

  it('maps a generic 4xx to a check-the-form message', async () => {
    dataRef.postError = Object.assign(new Error('Bad Request'), { status: 422 })
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Something didn’t look right — check the form and try again.')).toBeTruthy()
  })
})

describe('EventNew — non-harvest POST unchanged', () => {
  it('a plain watering submit has no harvest or flag fields', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest).toBeUndefined()
    expect(postCalls[0].flagged_as_issue).toBeUndefined()
    expect(postCalls[0].event_type).toBe('watering')
  })
})

describe('EventNew — V3-EVENTCONTSIZE-001 container capture on potting_up/transplant', () => {
  it('PUTs the planting container_type/size when a potting_up event captures a new container', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    renderEventNew('event_type=potting_up')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await waitFor(() => screen.getByText('Cayenne #1'))
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-1' } })
    fireEvent.change(screen.getByLabelText(/Pot \/ bag type/i), { target: { value: 'fabric_bag' } })
    fireEvent.change(screen.getByLabelText(/Pot size/i), { target: { value: '5 gal' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('potting_up')
    const putCall = apiFetchSpy.mock.calls.find(
      ([path, opts]) => path === '/api/plants/pl-1' && opts && opts.method === 'PUT'
    )
    expect(putCall).toBeTruthy()
    expect(JSON.parse(putCall[1].body)).toEqual({ container_type: 'fabric_bag', container_size: '5 gal' })
  })

  it('does NOT PUT the planting when no container is entered', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    renderEventNew('event_type=potting_up')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await waitFor(() => screen.getByText('Cayenne #1'))
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-1' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    const putCall = apiFetchSpy.mock.calls.find(
      ([path, opts]) => typeof path === 'string' && path.startsWith('/api/plants/') && opts && opts.method === 'PUT'
    )
    expect(putCall).toBeUndefined()
  })
})

describe('EventNew — V4-EVENTSAVE-001 single Save = next-of-type', () => {
  it('Save fires the POST and does NOT navigate', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
    expect(postCalls[0].project_id).toBe('proj-1')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('Save keeps the type, clears the plant', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await waitFor(() => screen.getByText('Cayenne #1'))
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-1' } })

    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
    expect(postCalls[0].plant_id).toBe('pl-1')
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    await waitFor(() => { expect(screen.getByText('Logged event for Tomatoes 2026')).toBeTruthy() })
    expect(screen.getByText('Undo')).toBeTruthy()

    // log the SAME type against the next plant WITHOUT re-picking the type
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(2)
    expect(postCalls[1].event_type).toBe('watering')
    expect(postCalls[1].plant_id).toBe('pl-2')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('has no save-and-leave button and never navigates on save', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    expect(screen.queryByText('+ Log event')).toBeNull()
    expect(screen.getAllByText('Save').length).toBe(1)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('global undo toast: clicking Undo soft-deletes the just-logged event', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await waitFor(() => screen.getByText('Undo'))
    await act(async () => { fireEvent.click(screen.getByText('Undo')) })
    const del = apiFetchSpy.mock.calls.find(([p, o]) => p === '/api/events/evt-1' && o && o.method === 'DELETE')
    expect(del).toBeTruthy()
  })
})
