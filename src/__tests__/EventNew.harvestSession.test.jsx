// V4-HARVSESSION-001 — /log?session=harvest weigh-in session mode.
// Covers: type pin + lock (picker replaced, stray ?event_type= overridden), the session ledger
// strip (row append, running totals, kg rollover, weightless rows), per-row undo via the
// sanctioned soft-delete, toast suppression in session mode, and the non-session control case
// (?event_type=harvest alone keeps today's toast, no strip). Harness mirrors EventNew.test.jsx:
// PLANTING_REQUIRED_ENABLED mocked false so plant-less project saves exercise the ledger without
// dragging PlantingSelect into every case (flag-ON coverage lives in the plantRequired files).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, postCalls, deleteCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  deleteCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postError: null,
    deleteError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false,
    error: null,
    photo: null,
    stage: null,
    progress: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

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

// ── apiFetch behavior: route GETs to fixtures, capture POST/DELETE ──────
// POST ids increment per call so per-row undo targets distinct events.
function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      if (dataRef.postError) return Promise.reject(dataRef.postError)
      return Promise.resolve({
        id: `evt-${postCalls.length}`,
        updated_streak: 1, xp_gained: 10, newly_earned_achievements: [],
      })
    }
    if (options.method === 'DELETE' && path.startsWith('/api/events/')) {
      deleteCalls.push(path)
      if (dataRef.deleteError) return Promise.reject(dataRef.deleteError)
      return Promise.resolve({ ok: true })
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

async function saveHarvest({ qty, weight }) {
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  if (weight != null) {
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: weight } })
  }
  await act(async () => {
    fireEvent.click(screen.getByText('Save'))
  })
}

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  deleteCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  dataRef.postError = null
  dataRef.deleteError = null
  localStorage.clear()
  wireApiFetch()
})

describe('EventNew — weigh-in session mode (V4-HARVSESSION-001)', () => {
  it('pins event_type=harvest and locks the type picker', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    // Harvest panel is live from mount…
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
    // …and the lock replaces the picker: no flag-mode doorway, lock copy present.
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
    expect(screen.queryByText('🚩 Flag an issue')).toBeNull()
  })

  it('session=harvest beats a stray ?event_type= (the lock must never strand a non-harvest type)', async () => {
    renderEventNew('session=harvest&event_type=watering')
    await flushLoad()
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
  })

  it('a save appends a ledger row with totals, resets the panel, and suppresses the toast', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })

    expect(postCalls.length).toBe(1)
    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 1 harvest')
    expect(strip.textContent).toContain('340 g')
    expect(strip.textContent).toContain('Tomatoes 2026 — 12 count · 340 g')
    // Panel reset for the next pile…
    expect(screen.getByLabelText('Harvest quantity').value).toBe('')
    // …and no transient toast competing with the ledger.
    expect(screen.queryByText(/Logged event/)).toBeNull()
  })

  it('accumulates rows and totals across saves, rolling grams into kg past 1000', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    await saveHarvest({ qty: '5', weight: '860' })

    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 2 harvests')
    expect(strip.textContent).toContain('1.2 kg')
  })

  it('a weightless save lists the row with no gram suffix and no total', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '3' })

    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 1 harvest')
    expect(strip.textContent).toContain('Tomatoes 2026 — 3 count')
    expect(strip.textContent).not.toContain(' g')
  })

  it('per-row Undo soft-deletes that row, strikes it from totals, and keeps it listed as removed', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    await saveHarvest({ qty: '5', weight: '160' })

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Undo Tomatoes 2026 harvest/ })[0])
    })

    expect(deleteCalls).toEqual(['/api/events/evt-1'])
    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 1 harvest')
    expect(strip.textContent).toContain('160 g')
    expect(strip.textContent).toContain('removed')
  })

  it('a failed undo surfaces a retryable error and does NOT strike the row', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })

    dataRef.deleteError = new Error('boom')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Undo Tomatoes 2026 harvest/ }))
    })

    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain("Couldn't undo — try again.")
    expect(strip.textContent).toContain('This session: 1 harvest')
    expect(strip.textContent).not.toContain('removed')
  })

  it('caps visible rows at 3 with an "+N earlier" note while the header counts the whole session', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    for (const qty of ['1', '2', '3', '4', '5']) {
      await saveHarvest({ qty, weight: '100' })
    }
    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 5 harvests')
    expect(strip.textContent).toContain('500 g')
    expect(strip.textContent).toContain('+2 earlier')
    expect(strip.textContent).not.toContain('— 1 count')
    expect(strip.textContent).toContain('— 5 count')
  })

  it('CONTROL: plain ?event_type=harvest keeps the shipped toast and renders no session strip', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '2' })

    expect(postCalls.length).toBe(1)
    expect(screen.queryByTestId('harvest-session-strip')).toBeNull()
    expect(screen.getByText('Logged event for Tomatoes 2026 — no planting attached')).toBeTruthy()
    // The picker (with its flag doorway) is present — the lock is session-only.
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
  })
})
