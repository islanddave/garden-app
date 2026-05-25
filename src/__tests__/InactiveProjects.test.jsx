/**
 * src/__tests__/InactiveProjects.test.jsx
 * Component tests for the /inactive page (V1.2a-2 S3 W4).
 * Covers: Active + Dismissed section rendering, client-side dismissed_at DESC sort,
 * the dismiss -> undo-toast -> (undo restores, no POST) / (window elapses, POST fires)
 * flow, the no-Restore-affordance + "coming soon" caption, relative-date formatting, and the
 * empty state.
 *
 * useApiFetch is mocked so no network / Clerk dependency is needed. Fake timers
 * drive the 5s undo window deterministically.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import InactiveProjects, { relativeActivity } from '../pages/InactiveProjects.jsx'

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString()
}

const ACTIVE_1 = {
  id: 'a-1', name: 'Black Krim', variety: 'tomato', status: 'growing',
  start_date: '2026-01-01', last_event_at: iso(3), last_harvested_at: null,
  dismissed: false, dismissed_at: null,
}
const ACTIVE_2 = {
  id: 'a-2', name: 'Sungold', variety: null, status: 'fruiting',
  start_date: '2026-01-01', last_event_at: iso(12), last_harvested_at: null,
  dismissed: false, dismissed_at: null,
}
const DISMISSED_OLD = {
  id: 'd-old', name: 'Old Basil', variety: 'basil', status: 'planning',
  start_date: '2026-01-01', last_event_at: iso(60), last_harvested_at: null,
  dismissed: true, dismissed_at: '2026-05-01T08:00:00.000Z',
}
const DISMISSED_NEW = {
  id: 'd-new', name: 'Recent Mint', variety: 'mint', status: 'planning',
  start_date: '2026-01-01', last_event_at: iso(45), last_harvested_at: null,
  dismissed: true, dismissed_at: '2026-05-10T08:00:00.000Z',
}

function renderPage() {
  return render(
    <MemoryRouter>
      <InactiveProjects />
    </MemoryRouter>
  )
}

beforeEach(() => {
  fetchSpy.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InactiveProjects — sections', () => {
  it('renders Active and Dismissed sections with the right rows', async () => {
    fetchSpy.mockResolvedValueOnce([ACTIVE_1, ACTIVE_2, DISMISSED_OLD, DISMISSED_NEW])
    renderPage()

    await screen.findByText('Black Krim')
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Dismissed')).toBeTruthy()
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByText('Old Basil')).toBeTruthy()
    expect(screen.getByText('Recent Mint')).toBeTruthy()
  })

  it('sorts the Dismissed section by dismissed_at DESC', async () => {
    fetchSpy.mockResolvedValueOnce([DISMISSED_OLD, DISMISSED_NEW])
    renderPage()

    await screen.findByText('Recent Mint')
    const names = screen.getAllByText(/Recent Mint|Old Basil/).map(n => n.textContent)
    // DISMISSED_NEW (2026-05-10) before DISMISSED_OLD (2026-05-01).
    expect(names).toEqual(['Recent Mint', 'Old Basil'])
  })

  it('renders the empty state when there are no inactive projects', async () => {
    fetchSpy.mockResolvedValueOnce([])
    renderPage()
    await screen.findByText('No inactive projects')
  })

  it('renders an error state on load failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    await screen.findByText(/Error loading inactive projects/)
  })
})

describe('InactiveProjects — dismiss / undo flow', () => {
  it('tapping Dismiss shows the undo toast and moves the row to Dismissed', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce([ACTIVE_1])
    renderPage()

    // Flush the mount load.
    await act(async () => { await Promise.resolve() })

    const dismissBtn = screen.getByText('Dismiss')
    act(() => { dismissBtn.click() })

    // Undo toast appears.
    expect(screen.getByText(/Dismissed Black Krim/)).toBeTruthy()
    expect(screen.getByText('Undo')).toBeTruthy()

    // Row now sits under Dismissed (caption appears; no Restore button).
    expect(screen.getByText(/Restoring dismissed projects is coming soon/i)).toBeTruthy()
    expect(screen.queryByText('Restore')).toBeNull()
    // No POST fired yet.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('clicking Undo within the window restores the row and fires NO POST', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce([ACTIVE_1])
    renderPage()
    await act(async () => { await Promise.resolve() })

    act(() => { screen.getByText('Dismiss').click() })
    act(() => { screen.getByText('Undo').click() })

    // Row back under Active.
    expect(screen.getByText('Dismiss')).toBeTruthy()
    expect(screen.queryByText('Restore')).toBeNull()
    expect(screen.queryByText(/Dismissed Black Krim/)).toBeNull()

    // Advance past the window — still no POST.
    act(() => { vi.advanceTimersByTime(6000) })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the mount load
  })

  it('letting the undo window elapse fires the dismiss POST', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce([ACTIVE_1])
    renderPage()
    await act(async () => { await Promise.resolve() })

    fetchSpy.mockResolvedValueOnce({ dismissed: true, dismissed_at: '2026-05-14T00:00:00.000Z' })

    act(() => { screen.getByText('Dismiss').click() })
    await act(async () => { vi.advanceTimersByTime(5000) })

    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/projects/inactive/a-1/dismiss')
    expect(postCall).toBeTruthy()
    expect(postCall[1].method).toBe('POST')
    // Undo toast gone.
    expect(screen.queryByText(/Dismissed Black Krim/)).toBeNull()
  })
})

describe('InactiveProjects — dismissed rows have no Restore affordance', () => {
  it('renders no Restore button and shows the "coming soon" caption', async () => {
    fetchSpy.mockResolvedValueOnce([DISMISSED_OLD])
    renderPage()

    await screen.findByText('Old Basil')

    // No fake Restore affordance on dismissed rows.
    expect(screen.queryByText('Restore')).toBeNull()
    // Caption signposts the future capability.
    expect(screen.getByText(/Restoring dismissed projects is coming soon/i)).toBeTruthy()
    // Only the mount load — no endpoint hit.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('relativeActivity — date formatting', () => {
  it('formats < 7 days as "N days ago"', () => {
    expect(relativeActivity({ last_event_at: iso(3) })).toBe('3 days ago')
    expect(relativeActivity({ last_event_at: iso(1) })).toBe('1 day ago')
    expect(relativeActivity({ last_event_at: iso(0) })).toBe('today')
  })

  it('formats 7-30 days as "N weeks ago"', () => {
    expect(relativeActivity({ last_event_at: iso(14) })).toBe('2 weeks ago')
    expect(relativeActivity({ last_event_at: iso(7) })).toBe('1 week ago')
  })

  it('formats > 30 days as "Month YYYY"', () => {
    const result = relativeActivity({ last_event_at: '2026-03-15T12:00:00.000Z' })
    expect(result).toBe('March 2026')
  })

  it('falls back through last_harvested_at then start_date', () => {
    expect(relativeActivity({
      last_event_at: null, last_harvested_at: iso(2), start_date: '2026-01-01',
    })).toBe('2 days ago')
    expect(relativeActivity({
      last_event_at: null, last_harvested_at: null, start_date: iso(4),
    })).toBe('4 days ago')
  })

  it('returns "no recent activity" when all dates are null', () => {
    expect(relativeActivity({
      last_event_at: null, last_harvested_at: null, start_date: null,
    })).toBe('no recent activity')
  })
})
