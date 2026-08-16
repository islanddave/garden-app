// BUG-READYBANDFETCH-001 — the retry/failure semantics shared by the three ambient Today bands.
// Exercised through HarvestReadyBand (a real consumer) rather than a synthetic host, so the test
// pins the behaviour Dave actually sees rather than the hook's internal shape.
//
// The defect being locked out: a failed fetch left band state at null, and every band renders
// nothing when state is null, so an outage was pixel-identical to "nothing is ready".
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
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
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'

const cand = (over = {}) => ({
  plant_id: 'p1', project_id: 'proj1', name: 'Wild Wineberry',
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 7,
  harvest_season_start_doy: null, harvest_season_end_doy: null, ...over,
})
const ok = { time_zone: 'America/New_York', et_doy: 202, candidates: [cand()] }

// Drain the retry gap AND the promise chain it starts.
const settleRetry = () => act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50) })

beforeEach(() => {
  navigateMock.mockReset(); fetchMock.mockReset(); sessionStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => { vi.useRealTimers() })

describe('ambient band fetch — failure is distinguishable from empty', () => {
  it('a persistent failure renders the muted notice instead of vanishing', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    render(<HarvestReadyBand />)
    await settleRetry()
    expect(screen.getByText(/Couldn’t check just now/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy()
  })

  it('a SINGLE transient failure never puts the notice on Today', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(ok)
    render(<HarvestReadyBand />)
    await settleRetry()
    expect(screen.queryByText(/Couldn’t check just now/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('leaks no error text, status code or alert affordance — Reward-UX V102 stays ambient', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))
    const { container } = render(<HarvestReadyBand />)
    await settleRetry()
    const text = container.textContent
    expect(text).not.toMatch(/503|Service Unavailable|Error|failed/i)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('an EMPTY result still renders nothing — the notice is not the empty state', async () => {
    fetchMock.mockResolvedValue({ time_zone: 'America/New_York', et_doy: 202, candidates: [] })
    const { container } = render(<HarvestReadyBand />)
    await settleRetry()
    expect(container.querySelector('section')).toBeNull()
  })

  it('Try again re-fetches and replaces the notice with rows', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    fetchMock.mockRejectedValue(new Error('boom'))
    render(<HarvestReadyBand />)
    await settleRetry()
    await screen.findByText(/Couldn’t check just now/i)

    fetchMock.mockResolvedValue(ok)
    await user.click(screen.getByRole('button', { name: /Try again/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })

    expect(screen.queryByText(/Couldn’t check just now/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()
  })

  it('a failed REFRESH keeps the rows already on screen rather than blanking them', async () => {
    fetchMock.mockResolvedValue(ok)
    render(<HarvestReadyBand />)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()

    fetchMock.mockRejectedValue(new Error('boom'))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await settleRetry()

    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()
    expect(screen.queryByText(/Couldn’t check just now/i)).toBeNull()
  })
})
