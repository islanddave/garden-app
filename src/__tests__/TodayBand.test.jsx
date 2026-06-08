import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const navigateMock = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: '/garden' }),
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))

import TodayBand from '../components/TodayBand.jsx'

const overdue3 = new Date(Date.now() - 3 * 86400000).toISOString()
const mockDash = (d) => fetchMock.mockImplementation((url) => Promise.resolve(url === '/api/dashboard' ? d : null))

beforeEach(() => {
  navigateMock.mockReset(); fetchMock.mockReset()
  document.documentElement.style.removeProperty('--today-band-height')
})

describe('TodayBand (global, above-nav)', () => {
  it('renders nothing + reserves no space when nothing needs attention', async () => {
    mockDash({ water_due: [], harvest_ready: [], heads_up: [] })
    const { container } = render(<TodayBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/dashboard'))
    expect(container.querySelector('button')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--today-band-height')).toBe('0px')
  })

  it('shows the most-urgent item and reserves layout space when present', async () => {
    mockDash({ water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }] })
    render(<TodayBand />)
    expect(await screen.findByText('Chilis')).toBeDefined()
    expect(screen.getByText('NEEDS WATER')).toBeDefined()
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--today-band-height')).not.toBe('0px'))
  })

  it('1-tap on the top row logs that item', async () => {
    mockDash({ water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }] })
    render(<TodayBand />)
    fireEvent.click(await screen.findByLabelText(/Needs water: Chilis/))
    expect(navigateMock).toHaveBeenCalledWith('/log?project=a&event_type=watering')
  })

  it('tapping the count expands to the full ranked list (harvest excluded per V3-HARVEST-001)', async () => {
    mockDash({
      water_due: [{ project_id: 'a', project_name: 'Chilis', next_water_at: overdue3, location_type: 'outdoor' }],
      // harvest_ready is supplied but must NOT surface in the band (V3-HARVEST-001).
      harvest_ready: [{ project_id: 'h', name: 'Beans', days_since_obs: 2 }],
      heads_up: [
        { project_id: 'f', name: 'Basil', reason: 'flagged', severity: 3 },
        { project_id: 's', name: 'Thyme', reason: 'stale', days_stale: 9 },
      ],
    })
    render(<TodayBand />)
    // 3 band items: water + flag + stale. Harvest is intentionally NOT one of them.
    expect(await screen.findByText(/\+2 more/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Show all 3 items/ }))
    expect(await screen.findByText('Basil')).toBeDefined()
    expect(screen.getByText('Thyme')).toBeDefined()
    // Harvest-ready 'Beans' must NOT appear in the above-nav band (V3-HARVEST-001).
    expect(screen.queryByText('Beans')).toBeNull()
  })
})
