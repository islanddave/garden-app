import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import BottomNavDot from '../components/BottomNavDot.jsx'

const HOUR = 3600_000

function makeCritter({ viewedAt = null, visibleAfterDelta = -HOUR } = {}) {
  return {
    id: 'c1',
    species_id: 3,
    viewed_at: viewedAt,
    dot_visible_after: new Date(Date.now() + visibleAfterDelta).toISOString(),
  }
}

describe('BottomNavDot', () => {
  it('renders dot when critter is unviewed AND dot_visible_after is in past', async () => {
    const fetch = vi.fn().mockResolvedValue([makeCritter({ visibleAfterDelta: -HOUR })])
    render(<BottomNavDot getToken={() => Promise.resolve('tok')} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('data-visible')).toBe('true')
    })
    expect(fetch).toHaveBeenCalled()
  })

  it('does NOT render dot when viewed_at is set', async () => {
    const fetch = vi.fn().mockResolvedValue([makeCritter({ viewedAt: new Date().toISOString() })])
    render(<BottomNavDot getToken={() => Promise.resolve('tok')} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('data-visible')).toBe('false')
    })
  })

  it('does NOT render dot when dot_visible_after is in the future (quiet-hours gate)', async () => {
    const fetch = vi.fn().mockResolvedValue([makeCritter({ visibleAfterDelta: HOUR })])
    render(<BottomNavDot getToken={() => Promise.resolve('tok')} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('data-visible')).toBe('false')
    })
  })

  it('does NOT render dot when critters array is empty', async () => {
    const fetch = vi.fn().mockResolvedValue([])
    render(<BottomNavDot getToken={() => Promise.resolve('tok')} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('data-visible')).toBe('false')
    })
  })

  it('aria-hidden=true on the dot (decorative, not announced)', async () => {
    const fetch = vi.fn().mockResolvedValue([makeCritter()])
    render(<BottomNavDot getToken={() => Promise.resolve('tok')} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('aria-hidden')).toBe('true')
    })
  })

  it('renders dot=false when getToken is not a function', async () => {
    const fetch = vi.fn()
    render(<BottomNavDot getToken={null} testFetchActiveCritters={fetch} />)
    await waitFor(() => {
      expect(screen.getByTestId('bottom-nav-dot').getAttribute('data-visible')).toBe('false')
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
