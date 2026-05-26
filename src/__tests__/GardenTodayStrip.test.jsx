import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigateMock = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }))

import GardenTodayStrip from '../components/GardenTodayStrip.jsx'

beforeEach(() => navigateMock.mockReset())

const overdue3 = new Date(Date.now() - 3 * 86400000).toISOString()
const overdue1 = new Date(Date.now() - 1 * 86400000).toISOString()

describe('GardenTodayStrip', () => {
  it('renders nothing when nothing needs attention', () => {
    const { container } = render(<GardenTodayStrip dashboard={{ water_due: [], harvest_ready: [], heads_up: [] }} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders nothing when dashboard is null/undefined', () => {
    const { container } = render(<GardenTodayStrip />)
    expect(container.firstChild).toBeNull()
  })
  it('shows an overdue watering row with reason-label + overdue detail', () => {
    render(<GardenTodayStrip dashboard={{ water_due: [{ project_id: 'a', project_name: 'Tomatoes', next_water_at: overdue3, location_type: 'outdoor' }] }} />)
    expect(screen.getByText('Tomatoes')).toBeDefined()
    expect(screen.getByText('NEEDS WATER')).toBeDefined()
    expect(screen.getByText(/3 days overdue/)).toBeDefined()
  })
  it('surfaces non-watering attention: harvest-ready + needs-a-look', () => {
    render(<GardenTodayStrip dashboard={{
      harvest_ready: [{ project_id: 'h', name: 'Beans', days_since_obs: 4 }],
      heads_up: [{ project_id: 'f', name: 'Squash', reason: 'flagged', severity: 2 }],
    }} />)
    expect(screen.getByText('READY TO HARVEST')).toBeDefined()
    expect(screen.getByText('Beans')).toBeDefined()
    expect(screen.getByText('NEEDS A LOOK')).toBeDefined()
    expect(screen.getByText('Squash')).toBeDefined()
  })
  it('caps rendered rows at 5 and shows a "+N more" count', () => {
    const harvest_ready = Array.from({ length: 7 }, (_, i) => ({ project_id: 'p' + i, name: 'P' + i, days_since_obs: i }))
    render(<GardenTodayStrip dashboard={{ harvest_ready }} />)
    expect(screen.getAllByRole('button')).toHaveLength(5)
    expect(screen.getByText(/2 more in your garden/)).toBeDefined()
  })
  it('tapping a watering row logs watering for that project', () => {
    render(<GardenTodayStrip dashboard={{ water_due: [{ project_id: 'a', project_name: 'Tomatoes', next_water_at: overdue3, location_type: 'outdoor' }] }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/log?project=a&event_type=watering')
  })
  it('tapping a harvest-ready row routes to a harvest log', () => {
    render(<GardenTodayStrip dashboard={{ harvest_ready: [{ project_id: 'h', name: 'Beans', days_since_obs: 4 }] }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/log?project=h&event_type=harvest')
  })
})
