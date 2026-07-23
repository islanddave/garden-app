import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Harvests from '../pages/Harvests.jsx'

beforeEach(() => fetchSpy.mockReset())

describe('Harvests page', () => {
  it('shows the first-run empty state when there are no harvests', async () => {
    fetchSpy.mockResolvedValue({ entries: [], aggregates: { crops: [], other: [] }, cursor: null })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByText(/harvests will collect here/i)).toBeTruthy())
  })

  it('renders a day-grouped entry (Log) and per-crop totals (Totals)', async () => {
    fetchSpy.mockResolvedValue({
      entries: [{
        event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
        plant_id: 'p1', project_id: 'pr1', crop_name: 'Tomato', variety_name: 'Sungold',
        quantity: 4, unit: 'count', quality_rating: 4, harvest_log_id: 'h1', photos: [],
      }],
      aggregates: {
        crops: [{ crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 4, count: 1 }], unquantified: 0, varieties: [] }],
        other: [],
      },
      cursor: null,
    })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    // the row deep-links to the planting
    expect(screen.getByText('Sungold').closest('a').getAttribute('href')).toBe('/projects/pr1/plantings/p1')
    // switch to Totals — the crop row appears
    fireEvent.click(screen.getByText('Totals'))
    expect(screen.getByText('Tomato')).toBeTruthy()
  })

  it('surfaces a retryable error state', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('down'), { body: { message: 'The harvest service had a problem.' } }))
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/harvest service had a problem/i)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})
