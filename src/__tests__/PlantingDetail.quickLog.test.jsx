// V4-QUICKLOG-001 (R10, ATTESTED 14:52Z) — the quiet quick-log affordance on the planting page.
// "I definitely want a quick log button right there… It doesn't have to be prominent."
// Contract under test: a NON-PROMINENT secondary control that (1) meets the 44px touch floor,
// (2) NAVIGATES to the existing /log flow (EventNew) prefilled to THIS planting via the shipped
// ?project=&plant= deep-link — never a one-tap POST, never a new form, (3) fires no celebration
// (Reward-UX: logging is task-required), (4) omits the project param for a project-less planting
// (V4-UNSCOPEDROUTES-001). Harness mirrors PlantingDetail.test.jsx: real router, mocked fetch.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Holy Basil', project_id: 'proj1', project_name: 'Herbs 2026',
  status: 'harvested', quantity: 1,
  variety_ref: { name: 'Kapoor Tulsi', species: 'Ocimum tenuiflorum' },
  featured_photo_view_url: null,
}

function LogMarker() {
  const location = useLocation()
  return <div data-testid="log-page">{location.search}</div>
}

function renderAt(path = '/projects/proj1/plantings/pl1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/log" element={<LogMarker />} />
      </Routes>
    </MemoryRouter>,
  )
}

function mockApi(planting = PLANTING) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(planting)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — quick-log affordance (R10)', () => {
  it('renders a quiet Log control with a >=44px tap target (not btnGhost-sized)', async () => {
    mockApi()
    renderAt()
    const btn = await screen.findByRole('button', { name: 'Log an event for this planting' })
    expect(btn.textContent).toContain('Log')
    expect(btn.style.minHeight).toBe('44px')
  })

  it('navigates to the existing /log flow prefilled with project + plant — never a one-tap POST', async () => {
    mockApi()
    renderAt()
    const btn = await screen.findByRole('button', { name: 'Log an event for this planting' })
    await userEvent.click(btn)
    const marker = await screen.findByTestId('log-page')
    expect(marker.textContent).toBe('?project=proj1&plant=pl1')
    // A quick-log is a navigation into the existing form — nothing may have been written.
    const writes = apiFetchSpy.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET')
    expect(writes).toHaveLength(0)
  })

  it('does not presume an event type (general log — no event_type param)', async () => {
    mockApi()
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Log an event for this planting' }))
    const marker = await screen.findByTestId('log-page')
    expect(marker.textContent).not.toMatch(/event_type/)
  })

  it('omits the project param for a project-less planting (V4-UNSCOPEDROUTES-001)', async () => {
    mockApi({ ...PLANTING, project_id: null, project_name: null })
    renderAt('/plantings/pl1')
    await userEvent.click(await screen.findByRole('button', { name: 'Log an event for this planting' }))
    const marker = await screen.findByTestId('log-page')
    expect(marker.textContent).toBe('?plant=pl1')
  })

  it('Reward-UX: tapping Log raises no celebration surface (no dialog/alert)', async () => {
    mockApi()
    const { container } = renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Log an event for this planting' }))
    await screen.findByTestId('log-page')
    expect(container.querySelector('[role="dialog"], [role="alert"]')).toBeNull()
  })
})
