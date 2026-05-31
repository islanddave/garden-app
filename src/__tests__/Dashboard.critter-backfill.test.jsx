import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

// Mock react-router-dom — Dashboard uses useLocation + useNavigate.
const mockLocation = { state: null, pathname: '/dashboard' }
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => () => {},
  useLocation: () => mockLocation,
}))

// Mock useApiFetch — provide getToken so backfill effect runs.
const apiFetchMock = vi.fn()
const getTokenMock = vi.fn().mockResolvedValue('tk')
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchMock, getToken: getTokenMock }) }))

// Mock critterClient.fetchActiveCritters.
const fetchActiveCrittersMock = vi.fn()
vi.mock('../lib/critterClient.js', () => ({
  fetchActiveCritters: (...a) => fetchActiveCrittersMock(...a),
}))

// Stub remaining Dashboard deps that aren't germane to backfill.
vi.mock('../components/CritterAnnouncement.jsx', () => ({
  default: ({ critter }) => critter ? <div data-testid="critter-announcement" data-critter-id={critter.id} /> : null,
}))
vi.mock('../components/TodayBand.jsx', () => ({ default: () => null }))
vi.mock('../components/HarvestReadyTile.jsx', () => ({ default: () => null }))
vi.mock('../components/HeadsUpTile.jsx', () => ({ default: () => null }))
vi.mock('../components/StreakModal.jsx', () => ({ default: () => null }))
vi.mock('../components/UndoToast.jsx', () => ({ default: () => null }))
vi.mock('../components/Streak.jsx', () => ({ default: () => null }))



vi.mock('../context/ZoneContext.jsx', () => ({
  useZone: () => ({ zone: '6b', setZone: vi.fn() }),
  ZoneProvider: ({ children }) => children,
}))
vi.mock('../components/ErrorBoundary.jsx', () => ({ default: ({ children }) => children }))
vi.mock('../components/NotifyButton.jsx', () => ({ default: () => null }))
vi.mock('../lib/waterDue.js', () => ({ severityTier: () => 'normal', SEVERITY_STYLES: { normal: {} } }))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1', clerk_sub: 's1' }, isLoaded: true, signOut: vi.fn() }),
  AuthProvider: ({ children }) => children,
}))

import Dashboard from '../pages/Dashboard.jsx'

function critter(over = {}) {
  return {
    id: 'c-fresh',
    species_id: 3,
    plant_id: 'p1',
    target_id: 'p1',
    target_kind: 'plant',
    earned_at: new Date().toISOString(),
    viewed_at: null,
    dot_visible_after: new Date().toISOString(),
    ...over,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  apiFetchMock.mockReset()
  fetchActiveCrittersMock.mockReset()
  apiFetchMock.mockResolvedValue({ active_projects: [], water_due: [], harvest_ready: [], heads_up: [], inactive_count: 0, user_stats: { current_streak: 0, longest_streak: 0, total_events: 0 } })
  mockLocation.state = null
})

afterEach(() => { cleanup() })

async function renderDashboard() {
  await act(async () => { render(<Dashboard />) })
  // Let mocked async effects settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('Dashboard Stage 1 backfill (Phase B+ canonical render path)', () => {
  it('renders Stage 1 announcement when a fresh non-baseline critter is active', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh', species_id: 3 })])
    await renderDashboard()
    const el = screen.queryByTestId('critter-announcement')
    expect(el).toBeDefined()
    expect(el?.getAttribute('data-critter-id')).toBe('c-fresh')
  })

  it('does NOT render Stage 1 when ONLY baseline critters (species_id 1-2) are active', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'b1', species_id: 1 }), critter({ id: 'b2', species_id: 2 })])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })

  it('does NOT render Stage 1 when the critter was earned >30s ago (window expired)', async () => {
    const old = new Date(Date.now() - 60 * 1000).toISOString()
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-old', species_id: 3, earned_at: old })])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })

  it('does NOT render Stage 1 when the critter is already viewed', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-viewed', species_id: 3, viewed_at: new Date().toISOString() })])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })

  it('picks the FRESHEST non-baseline critter when multiple are active', async () => {
    const t1 = new Date(Date.now() - 5000).toISOString()
    const t2 = new Date(Date.now() - 1000).toISOString()
    fetchActiveCrittersMock.mockResolvedValue([
      critter({ id: 'c-older', species_id: 3, earned_at: t1 }),
      critter({ id: 'c-newer', species_id: 5, earned_at: t2 }),
    ])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')?.getAttribute('data-critter-id')).toBe('c-newer')
  })

  it('sessionStorage de-dup: does NOT re-render same critter if id already in shown list', async () => {
    sessionStorage.setItem('gardenApp.stage1ShownIds', JSON.stringify(['c-fresh']))
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh', species_id: 3 })])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })

  it('after rendering, persists critter id to sessionStorage for de-dup', async () => {
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh', species_id: 3 })])
    await renderDashboard()
    const shown = JSON.parse(sessionStorage.getItem('gardenApp.stage1ShownIds') ?? '[]')
    expect(shown).toContain('c-fresh')
  })

  it('caps stored shown-ids list to 50 entries', async () => {
    // Pre-fill 60 entries
    const initial = Array.from({ length: 60 }, (_, i) => `c-${i}`)
    sessionStorage.setItem('gardenApp.stage1ShownIds', JSON.stringify(initial))
    fetchActiveCrittersMock.mockResolvedValue([critter({ id: 'c-fresh-new', species_id: 3 })])
    await renderDashboard()
    const shown = JSON.parse(sessionStorage.getItem('gardenApp.stage1ShownIds') ?? '[]')
    expect(shown.length).toBeLessThanOrEqual(50)
    expect(shown).toContain('c-fresh-new')  // newest is in the tail
  })

  it('fetchActiveCritters returning [] is a no-op (no Stage 1 render)', async () => {
    fetchActiveCrittersMock.mockResolvedValue([])
    await renderDashboard()
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })

  it('fetchActiveCritters throwing is a no-op (NEVER crashes Dashboard)', async () => {
    fetchActiveCrittersMock.mockRejectedValue(new Error('network'))
    await renderDashboard()
    // No render, no crash, no error boundary fired.
    expect(screen.queryByTestId('critter-announcement')).toBeNull()
  })
})
