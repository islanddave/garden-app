// BUG-TREATMENTPRODUCT-001 — treatment_product_text was NULL on all 405 pest_treatment and all
// 1130 fertilizing rows: only `doctored` ever wrote it. pest_treatment/doctored turned out to
// already be wired end-to-end (TreatmentDetails + the shared isTreatment gate) — the 405 NULL rows
// predate the V4-TREATLOG-001 column. fertilizing had NO product capture at all: TreatmentDetails
// never rendered for it, so treatment_product_text stayed unreachable regardless of user intent.
//
// Render + PAYLOAD assertions only, per this suite's convention (EventNew.waterDepth.test.jsx):
// mount the real form, do what a user would do, read the body that actually reached POST
// /api/events — never source-text/import assertions, which cannot tell a wired field from a dead
// one.

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
    postResult: { id: 'evt-1', project_id: 'proj-1', plant_id: null },
    postError: null,
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

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

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

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1', plant_id: null }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => {})
}

async function save() {
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

describe('EventNew — fertilizing product capture (BUG-TREATMENTPRODUCT-001)', () => {
  it('renders a Product field on a fertilizing event', async () => {
    renderEventNew('event_type=fertilizing')
    await flushLoad()
    expect(screen.getByLabelText(/^Product/i)).toBeTruthy()
  })

  it('does NOT render on an unrelated event type', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.queryByLabelText(/^Product/i)).toBeNull()
  })

  it('sends the typed product as treatment_product_text', async () => {
    renderEventNew('event_type=fertilizing')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText(/^Product/i), { target: { value: "Jack's 20-20-20" } })
    await save()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].treatment_product_text).toBe("Jack's 20-20-20")
  })

  it('stays optional — a blank product still saves, posting null rather than blocking', async () => {
    renderEventNew('event_type=fertilizing')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await save()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].treatment_product_text).toBeNull()
  })

  it('does not send treatment_category / treatment_amount / pest_target — pest-treatment-only columns', async () => {
    renderEventNew('event_type=fertilizing')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText(/^Product/i), { target: { value: 'Fish emulsion' } })
    await save()
    expect(postCalls[0].treatment_category).toBeUndefined()
    expect(postCalls[0].treatment_amount).toBeUndefined()
    expect(postCalls[0].pest_target).toBeUndefined()
  })
})

describe('EventNew — pest_treatment / doctored still send treatment_product_text (confirmation)', () => {
  // Both types already routed through the shared isTreatment gate before this change (TreatmentDetails
  // + EventNew's treatmentPayload) — the ticket's 405 all-NULL pest_treatment rows predate the
  // V4-TREATLOG-001 column, not a live capture gap. These pin that the widened isFertilizing branch
  // added alongside isTreatment did not disturb the existing path.
  for (const type of ['pest_treatment', 'doctored']) {
    it(`${type}: the free-typed product still reaches the POST body`, async () => {
      renderEventNew(`event_type=${type}`)
      await flushLoad()
      fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
      fireEvent.change(screen.getByPlaceholderText(/Not in inventory/i), { target: { value: 'Neem oil' } })
      await save()
      expect(postCalls[0].treatment_product_text).toBe('Neem oil')
    })
  }
})
