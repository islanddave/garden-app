/**
 * src/__tests__/GardenActivity.test.jsx
 * Inc 0 success-metric admin diagnostic page.
 *
 * Mocks:
 *   - useApiFetch -> fetchSpy (we control the aggregate payload / 403)
 *
 * Covers:
 *   - Renders the three panels (M1/M2/M3) from the aggregate payload
 *   - M3 placeholder state when tasks table not yet present
 *   - Non-admin (403) renders the neutral Jen-invisible placard, NOT the panels
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import GardenActivity from '../pages/GardenActivity.jsx'

beforeEach(() => { fetchSpy.mockReset() })

const PAYLOAD = {
  generated_at: '2026-05-25T20:00:00.000Z',
  m1: { window_days: 30, by_flow: [
    { flow_id: 'create_project', samples: 4, avg_taps: '3.00', median_taps: '3', min_taps: 2, max_taps: 5 },
  ] },
  m2: { window_weeks: 8, by_week: [
    { iso_week: '2026-W20', captures: 7 },
    { iso_week: '2026-W21', captures: 12 },
  ] },
  m3: { available: false, reason: 'tasks table not yet created (Increment 3)', accept_rate: null, canary_threshold: 0.40 },
}

describe('GardenActivity admin diagnostic', () => {
  it('renders all three measure panels from the payload', async () => {
    fetchSpy.mockResolvedValueOnce(PAYLOAD)
    render(<GardenActivity />)
    await waitFor(() => expect(screen.getByText('Garden Activity')).toBeTruthy())
    expect(screen.getByText(/M1 — Taps to completion/)).toBeTruthy()
    expect(screen.getByText(/M2 — Capture-events \/ week/)).toBeTruthy()
    expect(screen.getByText(/M3 — Agent-proposal accept-rate/)).toBeTruthy()
    // M1 row label + a captured value
    expect(screen.getByText('Create a project')).toBeTruthy()
    // M2 bar value rendered
    expect(screen.getByText('12')).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledWith('/api/ux-events?admin=1')
  })

  it('shows the M3 not-yet-available note before the tasks table exists', async () => {
    fetchSpy.mockResolvedValueOnce(PAYLOAD)
    render(<GardenActivity />)
    await waitFor(() => expect(screen.getByText(/Increment 3/)).toBeTruthy())
  })

  it('renders a neutral placard (not the panels) for a non-admin 403', async () => {
    const err = new Error('Not authorized'); err.status = 403
    fetchSpy.mockRejectedValueOnce(err)
    render(<GardenActivity />)
    await waitFor(() => expect(screen.getByText(/Nothing to see here/)).toBeTruthy())
    expect(screen.queryByText('Garden Activity')).toBeNull()
    expect(screen.queryByText(/M1 — Taps/)).toBeNull()
  })
})
