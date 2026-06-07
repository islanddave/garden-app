import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Stable getToken across renders (mirrors CritterOfDay.test.jsx).
const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn().mockResolvedValue('test-token') }))
vi.mock('@clerk/react', () => ({ useAuth: () => ({ getToken: getTokenMock }) }))

vi.mock('../lib/sharedStateClient.js', () => ({
  getTally: vi.fn(),
  TALLY_SIGHTINGS: 'tally:sightings',
}))

import { getTally, TALLY_SIGHTINGS } from '../lib/sharedStateClient.js'
import TallyDisplay from '../components/TallyDisplay.jsx'

describe('TallyDisplay — ambient shared sighting tally (V3-DELIGHT D2)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders the household count and queries the shared tally key', async () => {
    getTally.mockResolvedValueOnce({ natural_key: TALLY_SIGHTINGS, counter: 42 })
    render(<TallyDisplay />)
    expect(await screen.findByText('42')).toBeTruthy()
    expect(screen.getByText(/visits logged across the garden/i)).toBeTruthy()
    await waitFor(() => expect(getTally).toHaveBeenCalledTimes(1))
    expect(getTally.mock.calls[0][0].key).toBe('tally:sightings')
  })

  it('renders nothing when the endpoint no-ops / errors (null result)', async () => {
    getTally.mockResolvedValueOnce(null)
    const { container } = render(<TallyDisplay />)
    await waitFor(() => expect(getTally).toHaveBeenCalled())
    expect(container.querySelector('section')).toBeNull()
  })

  it('renders nothing on a malformed payload (no numeric counter)', async () => {
    getTally.mockResolvedValueOnce({ natural_key: TALLY_SIGHTINGS })
    const { container } = render(<TallyDisplay />)
    await waitFor(() => expect(getTally).toHaveBeenCalled())
    expect(container.querySelector('section')).toBeNull()
  })

  it('uses the singular noun for a count of 1', async () => {
    getTally.mockResolvedValueOnce({ natural_key: TALLY_SIGHTINGS, counter: 1 })
    render(<TallyDisplay />)
    expect(await screen.findByText('1')).toBeTruthy()
    expect(screen.getByText(/\bvisit logged across the garden/i)).toBeTruthy()
    expect(screen.queryByText(/visits logged/i)).toBeNull()
  })

  it('renders a zero count (de-FOMO neutral, never a "waiting" frame)', async () => {
    getTally.mockResolvedValueOnce({ natural_key: TALLY_SIGHTINGS, counter: 0 })
    render(<TallyDisplay />)
    expect(await screen.findByText('0')).toBeTruthy()
    expect(screen.getByText(/visits logged across the garden/i)).toBeTruthy()
    expect(screen.queryByText(/waiting/i)).toBeNull()
  })
})
