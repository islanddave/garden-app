// V4-EVENTSEL-003 — LogMany renders the UNIFIED <EventTypePicker> tile grid (same as Log Event).
// This is the first RENDER test of LogMany (previously only its pure helpers were covered), so it
// guards the chip->tile swap that is otherwise invisible to CI: tiles are <button>s, photo is
// hidden in bulk, and the harvest tile routes to the single-event per-plant flow (not a batch select).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children }) => children,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])) }) }))
// Stub ScopeChecklist — its own dry-run fetch/render is out of scope for the selector test.
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ScopeChecklist: () => null }
})

import LogMany from '../pages/LogMany.jsx'

describe('LogMany — unified event selector (V4-EVENTSEL-003)', () => {
  beforeEach(() => { navigate.mockClear() })

  it('renders the shared first-class tiles as <button>s (same grid as Log Event)', async () => {
    render(<LogMany />)
    const watered = await screen.findByText('Watered')
    expect(watered.closest('button')).toBeTruthy()
    expect(screen.getByText('Flowering')).toBeTruthy()
    expect(screen.getByText('Fruit Set')).toBeTruthy()
    expect(screen.getByText('Harvested')).toBeTruthy()
  })

  it('hides Photo in bulk (needs a file upload)', async () => {
    render(<LogMany />)
    await screen.findByText('Watered')
    expect(screen.queryByText('Photo')).toBeNull()
  })

  it('routes the Harvested tile to per-plant single-event entry (not a batch select)', async () => {
    render(<LogMany />)
    const harvested = await screen.findByText('Harvested')
    fireEvent.click(harvested.closest('button'))
    // V4-OVERLAY-001 Slice 2: harvest routing now goes through useOverlaySwap (cross-nav that
    // preserves the background inside an overlay). With no overlay open it is a plain navigate to the
    // same target; the swap passes an (empty) options object, so assert the first arg.
    expect(navigate.mock.calls[0][0]).toBe('/log?event_type=harvest')
  })
})
