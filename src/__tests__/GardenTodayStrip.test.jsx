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
  it('renders nothing when no watering is overdue', () => {
    const { container } = render(<GardenTodayStrip waterDue={[]} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders nothing when waterDue is undefined', () => {
    const { container } = render(<GardenTodayStrip />)
    expect(container.firstChild).toBeNull()
  })
  it('shows the single overdue project with an overdue label', () => {
    render(<GardenTodayStrip waterDue={[{ project_id: 'a', project_name: 'Tomatoes', next_water_at: overdue3, location_type: 'outdoor' }]} />)
    expect(screen.getByText('Tomatoes')).toBeDefined()
    expect(screen.getByText(/3 days overdue/)).toBeDefined()
  })
  it('shows "+N more" when multiple are overdue', () => {
    render(<GardenTodayStrip waterDue={[
      { project_id: 'a', project_name: 'Tomatoes', next_water_at: overdue3, location_type: 'outdoor' },
      { project_id: 'b', project_name: 'Basil', next_water_at: overdue1, location_type: 'outdoor' },
    ]} />)
    expect(screen.getByText('Tomatoes + 1 more')).toBeDefined()
  })
  it('tapping logs watering for the top project', () => {
    render(<GardenTodayStrip waterDue={[{ project_id: 'a', project_name: 'Tomatoes', next_water_at: overdue3, location_type: 'outdoor' }]} />)
    fireEvent.click(screen.getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/log?project=a&event_type=watering')
  })
})
