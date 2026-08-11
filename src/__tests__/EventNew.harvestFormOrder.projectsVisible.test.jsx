// V4-HARVFORMORDER-001 (S4) — the ROLLBACK configuration, PROJECTS_HIDDEN false.
//
// Why this file exists: the S4 plan says "hide the Project select for harvest". That is ALREADY
// true in the shipped config — projectBlock is `!PROJECTS_HIDDEN && (…)` and the flag is ON, so the
// select renders for no event type. S4 therefore adds NO second, harvest-shaped gate. This suite
// pins the consequence of that decision: with the flag rolled back, Project is a REQUIRED field
// again, and it must stay directly reachable on the harvest path — outside the collapsed
// disclosure, in its shipped position immediately before Planting. Burying a required field under
// a disclosure would make a harvest unsaveable without first expanding something, which is the
// exact failure a "redundant second gate" would have introduced.
// Flag-ON behaviour is covered by EventNew.harvestFormOrder.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

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

const precedes = (a, b) => !!(a.compareDocumentPosition(b) & 4)

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }; dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  try { sessionStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('V4-HARVFORMORDER-001 — Project stays reachable when PROJECTS_HIDDEN is rolled back', () => {
  it('renders the Project select on the harvest path WITHOUT expanding anything', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()

    const project = screen.getByLabelText('Project')
    expect(project).toBeTruthy()
    // Not inside the disclosure — which is still collapsed and has no body mounted.
    expect(screen.queryByTestId('harvest-more-body')).toBe(null)
  })

  it('keeps Project immediately before Planting, both ahead of Quantity', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()

    const project = screen.getByLabelText('Project')
    const planting = screen.getByLabelText('Plant or group')
    const qty = screen.getByLabelText('Harvest quantity')
    expect(precedes(project, planting)).toBe(true)
    expect(precedes(planting, qty)).toBe(true)
  })

  it('a harvest still saves with only the always-visible controls touched', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.click(screen.getByTestId('qty-chip-2'))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.quantity).toBe(2)
    expect(postCalls[0].project_id).toBe('proj-1')
  })
})
