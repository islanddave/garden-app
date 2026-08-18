// C5 — "when did I last water this" on the planting page. Two halves of the same defect:
// (a) last_watered_at rendered ONLY inside the Details fly-up's non-default Care tab, and
// (b) onOpenDetails force-reset the tab to Basics on every open, so the Care tab could never become
//     sticky and no repeat-visit accelerator was even representable.
// Harness mirrors PlantingDetail.test.jsx (mocked useApiFetch, real router, stubbed telemetry).
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

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

const DAY = 86400000
const iso = (ms) => new Date(Date.now() + ms).toISOString()

// Overdue by ~2 days so the CareStatus band is ACTIVE (it renders nothing on a calm day, by design).
const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3,
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
  location_path: 'Greenhouse / Bed 2',
  next_water_at: iso(-2 * DAY - 5000),
  last_watered_at: '2026-08-13',
  watering_interval_days: 2,
  featured_photo_view_url: null,
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/garden" element={<div>GARDEN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

describe('PlantingDetail — last-watered is visible without opening anything', () => {
  it('renders it in the care band, on the page, with zero taps', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const band = screen.getByRole('status', { name: /Watering .*overdue/i })
    expect(band.textContent).toContain('Last watered')
    expect(band.textContent).toContain('Aug 13')
  })
})

describe('PlantingDetail — the Details tab is sticky (no forced reset)', () => {
  it('keeps the Care tab selected when the fly-up is reopened', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })

    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    // Opens on Basics the FIRST time (initial tab state), as before.
    expect(screen.getByRole('radio', { name: 'Basics' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Care' }))
    expect(await screen.findByText('Last watered')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))

    // The regression: setTab('basics') on every open made this 'false' and sent Dave back to Basics.
    expect(screen.getByRole('radio', { name: 'Care' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Last watered')).toBeTruthy()
  })
})

// BUG-CADENCEONEDAY-001 — the WIRING guard. CareStatus's own suite proves the band renders the
// daily form when told the cadence; nothing there proves the page ever tells it. Drop the
// intervalDays prop at the call site and the band silently reverts to "2 days overdue" with every
// unit test still green, which is precisely the failure mode this case exists to catch.
describe('PlantingDetail — the care band is told the watering cadence', () => {
  const withInterval = (n) => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, watering_interval_days: n })
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
  }

  it('a daily planting reads as a cadence, not a two-day debt', async () => {
    withInterval(1)
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const band = screen.getByRole('status', { name: 'Watering due today' })
    expect(band.textContent).toContain('Due today')
    expect(band.textContent).toContain('daily')
    expect(band.textContent).not.toContain('overdue')
    expect(band.textContent).toContain('Aug 13')      // the elapsed fact survives
  })

  it('a longer cadence keeps its overdue count at the identical next_water_at', async () => {
    withInterval(2)
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const band = screen.getByRole('status', { name: /Watering .*overdue/i })
    expect(band.textContent).toContain('2 days overdue')
    expect(band.textContent).not.toContain('daily')
  })
})
