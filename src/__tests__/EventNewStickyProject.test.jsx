// V4-STICKY-001: Log One (EventNew) remembers the last chosen project across
// sessions. On a COLD mount the project select pre-fills from localStorage
// (key logone.lastProject), a deep-linked ?project= still wins, and a stale
// remembered id that no longer matches a live project falls back to no
// selection (without the deep-link "Project not found" notice).
//
// Harness mirrors EventNew.test.jsx: useApiFetch → controllable fetch, and
// react-router-dom fully mocked with a hoisted searchParams ref.

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

const PROJECT_A = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PROJECT_B = { id: 'proj-2', name: 'Peppers 2026', status: 'growing' }

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT_A, PROJECT_B]
  dataRef.locations = []
  dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — sticky project (V4-STICKY-001)', () => {
  it('writes the chosen project to localStorage on save', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].project_id).toBe('proj-2')
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-2')
  })

  it('pre-fills the project on a fresh cold mount (remount) from localStorage', async () => {
    // First session: pick proj-2 and save (persists it).
    const first = renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-2')
    first.unmount()

    // Cold remount, no deep link: the project pre-fills without any interaction.
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-2')
    })
    // No "Project not found" notice for a valid remembered project.
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
    // The plant load fired for the remembered project (proves it is truly selected).
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/plants?project_id=proj-2')
  })

  it('pre-fills directly when localStorage holds a valid project id', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
  })

  it('deep-linked ?project= wins over the remembered project', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering&project=proj-2')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-2')
    })
  })

  it('falls back to no selection (silently) when the remembered project no longer exists', async () => {
    localStorage.setItem('logone.lastProject', 'ghost-project')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('')
    })
    // Stale-remembered is NOT the deep-link case — no "Project not found" notice.
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
  })

  it('does not override an explicit in-session project change', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    // User switches project this session; the load effect must not clobber it.
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('Project').value).toBe('proj-2')
  })
})
