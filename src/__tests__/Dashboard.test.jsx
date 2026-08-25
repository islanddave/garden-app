/**
 * src/__tests__/Dashboard.test.jsx
 * V1.2a-3 Increment C / PR-C2 (2026-05-18) — paired test for the Dashboard.jsx polish batch.
 *
 * Covers:
 *  - I10-greeting: greeting uses first name only when display_name is a full name (L-063).
 *  - BUG-JENGREETEDDAVE-001: no resolvable name greets neutrally, never as a specific user.
 *  - DASH-LOC-REDUNDANT: the "WHERE ARE YOU?" zone-link card is no longer rendered.
 *  - DASH-ORDER-HARVEST-GATE: HarvestReadyTile hidden when no project is fruiting/flowering.
 *  - DASH-ORDER-HARVEST-GATE: HarvestReadyTile visible when at least one project is fruiting/flowering.
 *
 * Child tile components are mocked to simple data-testid stubs so the test focuses on
 * Dashboard's own composition logic, not the tile internals (which have their own tests).
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

const { fetchSpy, authMock, locationRef, navigateSpy } = vi.hoisted(() => ({
  fetchSpy:    vi.fn(),
  authMock:    { profile: { display_name: 'Dave Nichols' } },
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
  PROJECTS_HIDDEN: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => authMock }))
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
  locationRef.state = null
})

describe('Dashboard — I10-greeting (first-name only per L-063)', () => {
  it('renders first name only when display_name is a full name', async () => {
    primeDash()
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toMatch(/Welcome back, Dave/)
    expect(heading.textContent).not.toMatch(/Nichols/)
  })

  it('handles single-name display_name without surname', async () => {
    authMock.profile = { display_name: 'Jen' }
    primeDash()
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Welcome back, Jen/)
  })

  // BUG-JENGREETEDDAVE-001. This case previously ASSERTED the bug — it required the fallback to be
  // "Dave". Both halves below matter and neither alone is sufficient: the positive half pins the
  // neutral noun, and the negative half is the one that actually fails against the old source,
  // because "Dave" satisfies "renders something" perfectly well. There are exactly two real users,
  // so the failure this guards is naming the WRONG one, not naming nobody.
  it.each([
    ['missing display_name', {}],
    ['null profile',         null],
    ['whitespace-only name', { display_name: '   ' }],
  ])('greets neutrally, never as a specific user, on %s', async (_label, profile) => {
    authMock.profile = profile
    primeDash()
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    const text = screen.getByRole('heading', { level: 1 }).textContent
    expect(text).toMatch(/Welcome back, Gardener/)
    expect(text).not.toMatch(/Dave|Jen/)
  })
})

describe('Dashboard — DASH-LOC-REDUNDANT', () => {
  it('does NOT render the "WHERE ARE YOU?" zone link (covered by TopBar pill)', async () => {
    primeDash()
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    expect(screen.queryByText(/WHERE ARE YOU/i)).toBeNull()
  })
})

describe('Dashboard — DASH-ORDER-HARVEST-GATE', () => {
  it('hides HarvestReadyTile when no project is fruiting/flowering', async () => {
    primeDash({
      active_projects: [
        { id: 'p1', name: 'Basil', status: 'growing' },
        { id: 'p2', name: 'Tomato', status: 'seeding' },
      ],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    expect(screen.queryByTestId('harvest-ready-tile')).toBeNull()
    // HeadsUp still renders
    expect(screen.getByTestId('heads-up-tile')).toBeDefined()
  })

  it('shows HarvestReadyTile when at least one project is fruiting', async () => {
    primeDash({
      active_projects: [
        { id: 'p1', name: 'Basil', status: 'growing' },
        { id: 'p2', name: 'Tomato', status: 'fruiting' },
      ],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    expect(screen.getByTestId('harvest-ready-tile')).toBeDefined()
  })

  it('shows HarvestReadyTile when at least one project is flowering', async () => {
    primeDash({
      active_projects: [
        { id: 'p1', name: 'Basil', status: 'flowering' },
      ],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    expect(screen.getByTestId('harvest-ready-tile')).toBeDefined()
  })

  it('renders HarvestReadyTile BEFORE HeadsUpTile when both present (order check)', async () => {
    primeDash({
      active_projects: [{ id: 'p1', name: 'Tomato', status: 'fruiting' }],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeDefined())
    const harvest = screen.getByTestId('harvest-ready-tile')
    const headsUp = screen.getByTestId('heads-up-tile')
    // DOM order: harvest precedes heads-up
    expect(harvest.compareDocumentPosition(headsUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Dashboard — V3-FEED-001 recent-activity batch entries', () => {
  it('renders a collapsed batch as "type × N" + "N plantings"; singleton keeps its project name', async () => {
    const now = new Date().toISOString()
    primeDash({
      recent_events: [
        { id: 'b1', event_type: 'watering', created_at: now, batch_id: 'B', batch_count: 12, project_name: 'Pepper 3' },
        { id: 's1', event_type: 'observation', created_at: now, batch_count: 1, project_name: 'Basil' },
      ],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByText('Recent activity')).toBeDefined())
    expect(screen.getByText('watering × 12')).toBeDefined()
    expect(screen.getByText('12 plantings')).toBeDefined()
    // The batch entry shows the count, not one arbitrary planting's project name.
    expect(screen.queryByText('Pepper 3')).toBeNull()
    expect(screen.getByText('observation')).toBeDefined()
    expect(screen.getByText('Basil')).toBeDefined()
  })

  it('tolerates recent_events rows without batch_count (legacy shape) as singletons', async () => {
    const now = new Date().toISOString()
    primeDash({
      recent_events: [
        { id: 'l1', event_type: 'watering', created_at: now, project_name: 'Fig' },
      ],
    })
    render(<ToastProvider><Dashboard /></ToastProvider>)
    await waitFor(() => expect(screen.getByText('Recent activity')).toBeDefined())
    expect(screen.getByText('watering')).toBeDefined()
    expect(screen.getByText('Fig')).toBeDefined()
  })
})

// BUG-SILENTFAILSWEEP-001 — the global Undo toast's soft-delete. `catch { console.warn(…) }`, and
// the toast has already dismissed itself by the time the DELETE settles, so a failed undo left the
// event logged with nothing on screen and no affordance left to try again. EventNew's undoEvent is
// the same soft-delete and has surfaced its failure since V4-LOGCONF-001 — one feature, two
// implementations, and this was the silent one.
describe('Dashboard — a failed undo is said out loud (BUG-SILENTFAILSWEEP-001)', () => {
  const errText = () => screen.queryByText(/Couldn't undo/)

  async function undoWith(deleteImpl) {
    locationRef.state = { logged: { id: 'evt-9', project_name: 'Peppers' } }
    fetchSpy.mockImplementation((path, opts) => (
      opts?.method === 'DELETE' ? deleteImpl(path) : Promise.resolve(BASE_DASH)
    ))
    const view = render(<ToastProvider><Dashboard /></ToastProvider>)
    const undo = await screen.findByRole('button', { name: /^Undo$/ })
    await act(async () => { fireEvent.click(undo) })
    return view
  }

  it('a failed undo and a successful one do NOT render the same thing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = await undoWith(() => Promise.reject(new Error('nope')))
    // FAILURE: the undo toast is gone either way, so the error toast is the entire difference.
    await waitFor(() => expect(errText()).not.toBeNull())
    expect(screen.queryByRole('button', { name: /^Undo$/ })).toBeNull()
    warnSpy.mockRestore()
    failed.unmount()

    await undoWith(() => Promise.resolve({ ok: true }))
    // SUCCESS: same dismissed toast, and nothing said — silence is only correct on this arm.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Undo$/ })).toBeNull())
    expect(errText()).toBeNull()
  })

  it('names the undo as what failed and the event as what survives it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await undoWith(() => Promise.reject(new Error('nope')))
    const t = await waitFor(() => { const el = errText(); expect(el).not.toBeNull(); return el })
    // Not EventNew's "try again": the toast that offered the retry is already gone, so pointing at
    // it would send the reader looking for a control that no longer exists. State, not affordance.
    expect(t.textContent).toMatch(/still logged/)
    expect(t.textContent).not.toMatch(/try again/i)
    warnSpy.mockRestore()
  })
})
