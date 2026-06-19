import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const navigateMock = vi.fn()
const locationRef = { pathname: '/garden' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))

import TodayBand from '../components/TodayBand.jsx'

const overdue3 = new Date(Date.now() - 3 * 86400000).toISOString()
const mockDash = (d) => fetchMock.mockImplementation((url) => Promise.resolve(url === '/api/dashboard' ? d : null))

beforeEach(() => {
  navigateMock.mockReset(); fetchMock.mockReset()
  locationRef.pathname = '/garden'
  document.documentElement.style.removeProperty('--today-band-height')
})

describe('TodayBand \u2014 color-coded Today bar (DRG-TODAY-003)', () => {
  it('all-caught-up: calm bar + reserves layout space even when nothing is waiting', async () => {
    mockDash({ water_due: [], harvest_ready: [], heads_up: [] })
    render(<TodayBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/dashboard'))
    const bar = await screen.findByRole('button', { name: /Today/ })
    expect(bar.getAttribute('data-tier')).toBe('clear')
    expect(bar.textContent).toMatch(/all caught up/i)
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--today-band-height')).not.toBe('0px'))
  })

  it('waiting: an unseen (stale) project shows the gold "needs a look" state', async () => {
    mockDash({ water_due: [], heads_up: [{ project_id: 's', name: 'Thyme', reason: 'stale', days_stale: 9 }] })
    render(<TodayBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/dashboard'))
    const bar = await screen.findByRole('button', { name: /Today/ })
    await waitFor(() => expect(bar.getAttribute('data-tier')).toBe('waiting'))
    expect(bar.textContent).toMatch(/needs a look/i)
  })

  it('urgent: overdue watering shows the terra urgent state + the specific callout', async () => {
    mockDash({ water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }] })
    render(<TodayBand />)
    const bar = await screen.findByRole('button', { name: /Today/ })
    // data-tier updates after the async /api/dashboard fetch resolves — wait for it
    // (matches the 'waiting' test; bare assert raced the initial 'clear' state → flaky). L-140 family.
    await waitFor(() => expect(bar.getAttribute('data-tier')).toBe('urgent'))
    expect(bar.textContent).toMatch(/Chilis/)
    expect(bar.textContent).toMatch(/overdue/)
  })

  it('tapping the bar opens the Today home (/today), not an inline log', async () => {
    mockDash({ water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }] })
    render(<TodayBand />)
    fireEvent.click(await screen.findByRole('button', { name: /Today/ }))
    expect(navigateMock).toHaveBeenCalledWith('/today')
  })

  it('is hidden (and reserves no space) on the /today page itself', async () => {
    locationRef.pathname = '/today'
    mockDash({ water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }] })
    const { container } = render(<TodayBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/dashboard'))
    expect(container.querySelector('button')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--today-band-height')).toBe('0px')
  })

  it('harvest-ready and flagged rows never surface in the bar (V3-HARVEST-001 / FLAG-REMOVAL)', async () => {
    mockDash({
      water_due: [],
      harvest_ready: [{ project_id: 'h', name: 'Beans', days_since_obs: 2 }],
      heads_up: [{ project_id: 'f', name: 'Basil', reason: 'flagged', severity: 3 }],
    })
    render(<TodayBand />)
    const bar = await screen.findByRole('button', { name: /Today/ })
    expect(bar.getAttribute('data-tier')).toBe('clear')
  })
})
