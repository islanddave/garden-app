import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'

// getToken must be STABLE across renders (real Clerk memoizes it). A fresh vi.fn() per
// render would make the hook's reload() callback change every render -> useEffect reloads
// forever -> loading never settles. Hoist a single stable mock.
const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn().mockResolvedValue('test-token') }))
vi.mock('@clerk/react', () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}))

vi.mock('../lib/critterClient.js', () => ({
  fetchCollection: vi.fn(),
}))

import { fetchCollection } from '../lib/critterClient.js'
import { useCritterCollection } from '../hooks/useCritterCollection.js'

function Probe({ onState }) {
  const state = useCritterCollection()
  React.useEffect(() => { onState(state) }, [state, onState])
  return null
}

describe('useCritterCollection — fetch hook', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.clearAllMocks() })

  it('starts loading and reports collected on success', async () => {
    fetchCollection.mockResolvedValueOnce({
      species: [
        { species_id: 3, count: 4, first_seen_at: '2026-05-10T00:00:00Z', last_seen_at: '2026-05-20T00:00:00Z' },
        { species_id: 8, count: 1, first_seen_at: '2026-05-29T22:00:00Z', last_seen_at: '2026-05-29T22:00:00Z' },
      ],
    })
    let last = null
    render(<Probe onState={s => { last = s }} />)
    await waitFor(() => expect(last && last.loading === false).toBe(true))
    expect(last.error).toBeNull()
    expect(last.collected.size).toBe(2)
    expect(last.collected.has('C050')).toBe(true)
    expect(last.collected.get('C050').count).toBe(4)
    expect(last.collected.has('C007')).toBe(true)
  })

  it('handles null (no-op) with soft-error and empty collected', async () => {
    fetchCollection.mockResolvedValueOnce(null)
    let last = null
    render(<Probe onState={s => { last = s }} />)
    await waitFor(() => expect(last && last.loading === false).toBe(true))
    expect(last.error).toBe('Could not load your collection')
    expect(last.collected.size).toBe(0)
  })

  it('handles rejection with error message and empty collected', async () => {
    fetchCollection.mockRejectedValueOnce(new Error('boom'))
    let last = null
    render(<Probe onState={s => { last = s }} />)
    await waitFor(() => expect(last && last.loading === false).toBe(true))
    expect(last.error).toBe('boom')
    expect(last.collected.size).toBe(0)
  })

  it('handles missing species key gracefully (empty array)', async () => {
    fetchCollection.mockResolvedValueOnce({})
    let last = null
    render(<Probe onState={s => { last = s }} />)
    await waitFor(() => expect(last && last.loading === false).toBe(true))
    expect(last.error).toBeNull()
    expect(last.collected.size).toBe(0)
  })

  it('reload() refetches on demand', async () => {
    fetchCollection
      .mockResolvedValueOnce({ species: [] })
      .mockResolvedValueOnce({ species: [{ species_id: 3, count: 1, first_seen_at: '2026-05-30T10:00:00Z', last_seen_at: '2026-05-30T10:00:00Z' }] })
    let last = null
    render(<Probe onState={s => { last = s }} />)
    await waitFor(() => expect(last && last.loading === false).toBe(true))
    expect(last.collected.size).toBe(0)
    await act(async () => { await last.reload() })
    expect(last.collected.size).toBe(1)
    expect(last.collected.has('C050')).toBe(true)
  })
})
