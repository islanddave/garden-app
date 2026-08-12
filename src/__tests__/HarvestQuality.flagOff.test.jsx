// HarvestQuality.flagOff.test.jsx — V4-HIDEQUALITY-001 (BD-006). THE ROLLBACK-LEVER PROOF.
//
// BD-006 was "HIDE harvest Quality, don't fully remove it." The whole reason it is a flag and not a
// deletion is that Dave can ask for it back, and getting it back must not be an archaeology project.
// This file is what makes that claim testable: it mocks HARVEST_QUALITY_HIDDEN false and proves both
// surfaces come back intact — the capture control on EventNew AND the dots on the Harvests list.
//
// Deliberately a PARTIAL mock (importOriginal + override) rather than the enumerated flag-object the
// SpacePhotos flag suites use. Those files must restate every flag in the module, so each new flag
// silently arrives as `undefined` inside them; a partial mock cannot drift that way.
//
// Its counterpart HarvestQuality.flagOn.test.jsx owns the pin on the SHIPPED value, so neither file
// breaks by construction on a future flip. Assertions here are mechanical (roles, labels, POST body).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PROJECTS_HIDDEN: false,
  HARVEST_QUALITY_HIDDEN: false,
  // V4-PLANTREQUIRED-001 flipped TRUE in source 2026-08-10; this suite asserts the
  // planting-OPTIONAL submit path. Pinned FALSE so it keeps covering that.
  PLANTING_REQUIRED_ENABLED: false,
}))

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef, harvestFetchSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  harvestFetchSpy: vi.fn(),
  dataRef: {
    projects: [],
    postResult: { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] },
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

// EventNew and Harvests both read useApiFetch; route by which suite is driving via a shared spy.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import Harvests from '../pages/Harvests.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

const HARVEST_ROW = {
  event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
  plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato',
  variety_name: 'Sungold', quantity: 4, unit: 'count', quality_rating: 4,
  harvest_log_id: 'h1', photos: [],
}

function wireEventNew() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

function wireHarvests() {
  apiFetchSpy.mockImplementation((url) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve([])
    if (u.includes('include=aggregates') && !u.includes('entries')) {
      return Promise.resolve({ aggregates: { crop_list: [], crops: [], other: [] } })
    }
    return Promise.resolve({ entries: [HARVEST_ROW], aggregates: { crops: [], other: [], first_pick: [] }, cursor: null })
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

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  harvestFetchSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  try { localStorage.clear() } catch { /* noop */ }
})

describe('V4-HIDEQUALITY-001 rollback lever — capture surface (EventNew)', () => {
  it('re-renders the quality radiogroup with the flag off', async () => {
    wireEventNew()
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByRole('radiogroup', { name: 'Harvest quality' })).toBeTruthy()
  })

  it('re-renders the anchored quality labels (not a star widget)', async () => {
    wireEventNew()
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByText('1 = inedible')).toBeTruthy()
    expect(screen.getByText('3 = acceptable')).toBeTruthy()
    expect(screen.getByText('5 = excellent')).toBeTruthy()
  })

  // The one that actually matters: the lever restores the ability to WRITE a rating, not just to see
  // the control. A hide that quietly severed the write path would still pass the two tests above.
  it('submits the picked rating in the POST body with the flag off', async () => {
    wireEventNew()
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'lb' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByLabelText('4 = good'))

    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest).toEqual({ quantity: 2.5, unit: 'lb', quality_rating: 4 })
  })

  it('restores the Clear quality escape hatch once a rating is picked', async () => {
    wireEventNew()
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.queryByText('Clear quality')).toBeNull()
    fireEvent.click(screen.getByLabelText('4 = good'))
    expect(screen.getByText('Clear quality')).toBeTruthy()
  })
})

describe('V4-HIDEQUALITY-001 rollback lever — output surface (Harvests)', () => {
  it('re-renders QualityDots for a rated harvest with the flag off', async () => {
    wireHarvests()
    render(<Harvests />)
    // V4-HARVDEFAULT-001: a bare arrival lands on TOTALS; the quality dots are a LOG-row element, so
    // toggle in (design §2a: insert a toggle step, never weaken an assertion).
    fireEvent.click(screen.getByRole('radio', { name: 'Log' }))
    await waitFor(() => expect(screen.getByLabelText('Quality 4 of 5')).toBeTruthy())
  })
})
