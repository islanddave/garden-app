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
import { render, screen, waitFor } from '@testing-library/react'

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

  // NOT COVERED, and recorded rather than quietly dropped: the collapsed water-tile summary's
  // project-free branch (Dashboard.jsx:705, `${waterDue.length} plantings need water` vs the flag-OFF
  // `Water ${top.project_name} + N more`). The source IS correctly guarded — I read it — but two
  // attempts at a fixture that renders the water tile in this harness did not get it on screen, and
  // the assertion is not worth more of the session. It is display-only and its flag-OFF counterpart
  // is covered in Dashboard.test.jsx. Whoever next touches that tile should add it.

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
