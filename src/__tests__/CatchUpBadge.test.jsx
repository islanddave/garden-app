// V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #8) — CatchUpBadge component tests.
// Asserts: count matches mock /api/plants response, count=0 hides badge,
// tap navigates to /plants/catch-up, count helper is correct.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} data-to={to} {...rest}>{children}</a>
  ),
}))

import CatchUpBadge, { countCatchUpCandidates } from '../components/CatchUpBadge.jsx'

beforeEach(() => {
  apiFetchSpy.mockReset()
})

describe('countCatchUpCandidates helper', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(countCatchUpCandidates(null)).toBe(0)
    expect(countCatchUpCandidates(undefined)).toBe(0)
    expect(countCatchUpCandidates([])).toBe(0)
  })

  it('counts plants with sown_at=null AND any other lifecycle date null', () => {
    const plants = [
      // Catch-up candidate: no sown_at, no germinated_at
      { id: 'a', sown_at: null, germinated_at: null, transplanted_at: '2026-04-01', planted_out_at: '2026-05-01' },
      // Catch-up candidate: no sown_at, all subsequent dates null
      { id: 'b', sown_at: null, germinated_at: null, transplanted_at: null, planted_out_at: null },
      // NOT catch-up: sown_at present
      { id: 'c', sown_at: '2026-03-15', germinated_at: null, transplanted_at: null, planted_out_at: null },
      // NOT catch-up: sown_at null BUT all subsequent dates present
      { id: 'd', sown_at: null, germinated_at: '2026-03-20', transplanted_at: '2026-04-05', planted_out_at: '2026-05-10' },
    ]
    expect(countCatchUpCandidates(plants)).toBe(2)
  })

  it('treats missing fields as null', () => {
    const plants = [{ id: 'x' }] // all lifecycle fields missing
    expect(countCatchUpCandidates(plants)).toBe(1)
  })
})

describe('CatchUpBadge — render behavior', () => {
  it('renders nothing when count is 0', async () => {
    apiFetchSpy.mockResolvedValue([])
    await act(async () => { render(<CatchUpBadge />) })
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('catch-up-badge')).toBeNull()
  })

  it('renders the badge with count when there are candidates', async () => {
    apiFetchSpy.mockResolvedValue([
      { id: 'a', sown_at: null, germinated_at: null },
      { id: 'b', sown_at: null, transplanted_at: null },
      { id: 'c', sown_at: '2026-03-15', germinated_at: '2026-03-20', transplanted_at: '2026-04-01', planted_out_at: '2026-05-01' },
    ])
    await act(async () => { render(<CatchUpBadge />) })
    const badge = await screen.findByTestId('catch-up-badge')
    expect(badge.textContent).toContain('Catch up')
    expect(badge.textContent).toContain('2')
  })

  it('links to /plants/catch-up by default', async () => {
    apiFetchSpy.mockResolvedValue([{ id: 'a', sown_at: null, germinated_at: null }])
    await act(async () => { render(<CatchUpBadge />) })
    const badge = await screen.findByTestId('catch-up-badge')
    expect(badge.getAttribute('data-to')).toBe('/plants/catch-up')
  })

  it('respects custom `to` prop', async () => {
    apiFetchSpy.mockResolvedValue([{ id: 'a', sown_at: null, germinated_at: null }])
    await act(async () => { render(<CatchUpBadge to="/custom/route" />) })
    const badge = await screen.findByTestId('catch-up-badge')
    expect(badge.getAttribute('data-to')).toBe('/custom/route')
  })

  it('silently hides on fetch failure', async () => {
    apiFetchSpy.mockRejectedValue(new Error('network down'))
    await act(async () => { render(<CatchUpBadge />) })
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('catch-up-badge')).toBeNull()
  })
})
