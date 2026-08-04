// V4-HARVESTSURF-001 — the Today "ready to pick" ambient card. Hidden when empty, ordered by overdue
// ratio, navigates (never one-tap POSTs), and Reward-UX V102 ambient-only compliant.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  Link: ({ children }) => <a>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import HarvestReadyBand from '../components/HarvestReadyBand.jsx'

const cand = (over = {}) => ({
  plant_id: 'p1', project_id: 'proj1', name: 'Wild Wineberry',
  // interval 3 / 7 days = ratio 2.33, deliberately INSIDE the BD-001 staleness ceiling
  // (MAX_OVERDUE_RATIO = 3) so this shared fixture keeps testing rendering, not the predicate.
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 7,
  harvest_season_start_doy: null, harvest_season_end_doy: null, ...over,
})

const payload = (candidates, et_doy = 202) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === '/api/events/harvest-ready' ? { time_zone: 'America/New_York', et_doy, candidates } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset() })

describe('HarvestReadyBand', () => {
  it('renders ready plantings with neutral cadence copy', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Ready to pick/i })
    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /last picked 7 days ago/i })).toBeTruthy()
  })

  it('orders rows by overdue ratio, most overdue first', async () => {
    payload([
      cand({ plant_id: 'sq', name: 'Zephyr Squash', repeat_interval_days: 2, days_since_last_harvest: 2 }),
      cand({ plant_id: 'wb', name: 'Wild Wineberry', repeat_interval_days: 3, days_since_last_harvest: 7 }),
      cand({ plant_id: 'br', name: 'Green Magic', repeat_interval_days: 6, days_since_last_harvest: 11 }),
    ])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Ready to pick/i })
    const names = screen.getAllByRole('button').map(b => b.textContent)
    expect(names[0]).toMatch(/Wild Wineberry/)
    expect(names[1]).toMatch(/Green Magic/)
    expect(names[2]).toMatch(/Zephyr Squash/)
  })

  it('renders nothing when no candidate is ready', async () => {
    payload([cand({ days_since_last_harvest: 1, repeat_interval_days: 5 })])
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('renders nothing on an empty candidate list', async () => {
    payload([])
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('suppresses an out-of-window DOY planting entirely (asparagus after the window)', async () => {
    // ratio 2.0 — inside the staleness ceiling on purpose, so DOY suppression is the ONLY reason
    // this renders nothing (the old interval-1/30-day fixture was ratio 30 and would now be
    // double-suppressed, passing for the wrong reason).
    payload([cand({ name: 'Asparagus Bed', repeat_interval_days: 15, days_since_last_harvest: 30,
      harvest_season_start_doy: 115, harvest_season_end_doy: 166 })], 202)
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('drops a staleness-ceiling row from the band (BD-001: the wineberry at 10.5x)', async () => {
    payload([
      cand({ plant_id: 'ok', name: 'Aster Blackberry', repeat_interval_days: 2, days_since_last_harvest: 4 }),
      cand({ plant_id: 'stale', name: 'Long Gone', repeat_interval_days: 2, days_since_last_harvest: 21 }),
    ])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Ready to pick/i })
    expect(screen.getByRole('button', { name: /Aster Blackberry/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Long Gone/i })).toBeNull()
  })

  it('swallows a fetch error — renders nothing, never throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('navigates to the prefilled harvest form — never one-tap POSTs', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const row = await screen.findByRole('button', { name: /Wild Wineberry/i })
    await userEvent.click(row)
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj1&plant=p1&event_type=harvest')
    const posts = fetchMock.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET')
    expect(posts).toHaveLength(0)
  })

  it('Reward-UX V102: ambient only — no count badge, no urgency/loss-aversion copy', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Ready to pick/i })
    expect(card.textContent).not.toMatch(/streak|don't let|hurry|overdue|urgent|!|days left|waste|rot/i)
    expect(card.querySelector('[role="dialog"], [role="alert"], [role="status"]')).toBeNull()
  })
})
