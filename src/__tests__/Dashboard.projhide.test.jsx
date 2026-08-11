// V4-PROJHIDE-001 — Dashboard with PROJECTS_HIDDEN mocked TRUE.
//
// GAP CLOSED 2026-08-10: the last of three genuinely uncovered surfaces at flip time. Dashboard has
// the most PROJHIDE read sites of any page (6) and they are all DISPLAY decisions — which is exactly
// why they need pinning rather than why they can be skipped: a display regression here is silent,
// shows up on the app's landing screen, and no server error would ever reveal it.
//
// Harness lifted from Dashboard.test.jsx with the flag inverted; flag-OFF stays covered there.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy, authMock, zoneMock, locationRef, navigateSpy } = vi.hoisted(() => ({
  fetchSpy:    vi.fn(),
  authMock:    { profile: { display_name: 'Dave Nichols' } },
  zoneMock:    { activeZone: null },
  locationRef: { pathname: '/dashboard', state: null },
  navigateSpy: vi.fn(),
}))

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => authMock }))
vi.mock('../context/ZoneContext.jsx', () => ({ useZone: () => zoneMock }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('../components/HarvestReadyTile.jsx', () => ({
  default: () => <div data-testid="harvest-ready-tile">HarvestReadyTile</div>,
}))
vi.mock('../components/HeadsUpTile.jsx', () => ({
  default: () => <div data-testid="heads-up-tile">HeadsUpTile</div>,
}))
vi.mock('../components/NotifyButton.jsx', () => ({
  default: () => <div data-testid="notify-button">NotifyButton</div>,
}))
vi.mock('../components/ErrorBoundary.jsx', () => ({
  default: ({ children }) => <>{children}</>,
}))

import Dashboard from '../pages/Dashboard.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const BASE_DASH = {
  active_projects: [],
  recent_events: [],
  user_stats: { current_streak: 0, longest_streak: 0, last_active_date: null, total_events: 0, xp: 0 },
  water_due: [],
  inactive_projects_count: 0,
  harvest_ready: [],
  heads_up: [],
}

function primeDash(overrides = {}) {
  fetchSpy.mockResolvedValueOnce({ ...BASE_DASH, ...overrides })
}

beforeEach(() => {
  fetchSpy.mockReset()
  authMock.profile = { display_name: 'Dave Nichols' }
  zoneMock.activeZone = null
  locationRef.state = null
})


describe('Dashboard — V4-PROJHIDE-001 (flag ON)', () => {
  it('hides the inactive-projects entry even when the count is non-zero', async () => {
    // Flag OFF this renders on inactiveCount > 0. The count is deliberately non-zero here so the
    // assertion cannot pass merely because there was nothing to show.
    primeDash({ inactive_projects_count: 4 })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(screen.queryByText(/inactive/i)).toBeNull()
  })

  // GAP CLOSED 2026-08-10 (second pass). The two earlier fixture attempts failed for a reason worth
  // recording, because it will bite the next person the same way: WaterMeTile is NOT gated on
  // `water_due`. It is gated on `hasProjects` (Dashboard.jsx:236 → :628 `if (!hasProjects) return null`),
  // which is `projects.length > 0` where `projects` = `active_projects` FILTERED by
  // ATTENTION_LIST_STATUSES (:105-108). So there are two independent ways to prime water_due perfectly
  // and still render an empty screen with no error and no warning:
  //   (a) active_projects: [] — the BASE_DASH default. Priming only the obviously-relevant key is the
  //       natural fixture, and it silently renders nothing.
  //   (b) active_projects non-empty but every row's status outside ATTENTION_LIST_STATUSES
  //       (= PROJECT_STATUSES minus 'harvesting'). A 'harvesting' project ALSO yields hasProjects false.
  // Both reproduced and observed failing before this suite was written. NOT the cause: the
  // `waitFor(fetchSpy called)` idiom used above — verified sufficient, waitFor's act() flush lands the
  // state; and NOT severityTier, which returns 'gold' on a missing next_water_at rather than throwing.
  // Both tests below therefore carry a status-valid active project, and the fixture keeps project_name
  // POPULATED so the flag-ON assertions cannot pass merely because there was no project name to leak.
  const WATER_TWO = [
    { project_id: 'pr1', project_name: 'Bed Alpha', plant_name: 'Sungold', next_water_at: '2026-08-08T12:00:00Z' },
    { project_id: 'pr2', project_name: 'Bed Beta',                        next_water_at: '2026-08-09T12:00:00Z' },
  ]
  const ACTIVE_OK = [{ id: 'pr1', name: 'Bed Alpha', status: 'growing', last_activity_at: '2026-08-01' }]

  it('collapsed water-tile summary is a project-free count, not "Water {project} + N more"', async () => {
    // Dashboard.jsx:705 — the >1 branch. Flag OFF this reads `Water Bed Alpha + 1 more`.
    primeDash({ water_due: WATER_TWO, active_projects: ACTIVE_OK })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByText('2 plantings need water')).toBeDefined())
    // The flag-OFF string is fully constructible from this fixture — its absence is the real assertion.
    expect(screen.queryByText('Water Bed Alpha + 1 more')).toBeNull()
  })

  it('expanded water-tile rows name the planting or a neutral subject, never the project', async () => {
    // Dashboard.jsx:742 — the per-row subject, reached only after expanding. Covers BOTH sides of
    // `w.plant_name || 'Water due'`: pr1 has a plant_name, pr2 deliberately does not.
    primeDash({ water_due: WATER_TWO, active_projects: ACTIVE_OK })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    const summary = await waitFor(() => screen.getByText('2 plantings need water'))
    fireEvent.click(summary)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeDefined())
    expect(screen.getByText('Water due')).toBeDefined()
    // 'Bed Beta' exists ONLY in water_due, so it can leak from nowhere else on this page.
    expect(screen.queryByText('Bed Beta')).toBeNull()
    expect(screen.queryByText('Bed Alpha')).toBeNull()
  })

  it('renders no link into the retired /projects tree', async () => {
    primeDash({
      inactive_projects_count: 4,
      water_due: [{ project_id: 'pr1', project_name: 'Bed Alpha', plant_id: 'pl1', plant_name: 'Sungold' }],
      active_projects: [{ id: 'pr1', name: 'Bed Alpha', status: 'growing', last_activity_at: '2026-08-01' }],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const stale = Array.from(document.querySelectorAll('a'))
      .filter(a => (a.getAttribute('href') || '').startsWith('/projects'))
    expect(stale.length).toBe(0)
  })
})
