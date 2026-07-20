// V4-OVERLAY-001 Slice 2 (§4) — the LogMany post-batch state fix. Regression guard for the bug where
// navigate('.') REPLACED state wholesale → the carried `background` was destroyed → the overlay
// unmounted → `result` was lost → the success screen + Undo became permanently unreachable for a batch
// already written to the DB. This test drives a real confirm and asserts (a) the success screen +
// reachable Undo render, and (b) the same-path push PRESERVES `background`.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: { background: { pathname: '/today', search: '' } } }
// Stable identities so LogMany's loader effect (deps [fetch, params, inOverlay]) does not re-fire
// every render — a fresh URLSearchParams per render self-triggers the effect in a loop.
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

// Provide the overlay background + surface so the §4 spread path + draft stash run as in an overlay.
vi.mock('../context/OverlayContext.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useOverlayBackground: () => ({ pathname: '/today', search: '' }),
    useInOverlaySurface: () => true,
    useOverlayDismiss: () => vi.fn(),
    useOverlaySwap: () => vi.fn(),
  }
})

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

// Stub ScopeChecklist to immediately commit a non-zero selection so Confirm is enabled.
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ScopeChecklist: ({ onSelectionChange }) => (
      <button type="button" onClick={() => onSelectionChange({ committedCount: 4, excludedIds: [] })}>commit-scope</button>
    ),
  }
})

import LogMany from '../pages/LogMany.jsx'

beforeEach(() => {
  navigate.mockClear()
  sessionStorage.clear()
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: 4 })
      return Promise.resolve({ batch_id: 'b-1', count: 4 })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

describe('LogMany — post-batch result + Undo reachable (§4 spread-state fix)', () => {
  it('renders the success screen with a reachable Undo, and preserves background on the same-path push', async () => {
    render(<LogMany />)
    fireEvent.click(await screen.findByText('commit-scope'))
    const confirmBtn = await screen.findByText(/^Log watered on 4$/)
    fireEvent.click(confirmBtn)

    // Success screen + Undo render (would be unreachable under the old wholesale-replace bug).
    await screen.findByText(/plantings watered|planting watered/)
    expect(screen.getByText('Undo')).toBeTruthy()

    // The same-path push carried `background` through (spread), not a wholesale replace that nulled it.
    const call = navigate.mock.calls.find(([to]) => to === '.')
    expect(call).toBeTruthy()
    expect(call[1].replace).toBe(true)
    expect(call[1].state.background).toEqual({ pathname: '/today', search: '' })
    expect(typeof call[1].state.critterCheck).toBe('number')
  })
})
