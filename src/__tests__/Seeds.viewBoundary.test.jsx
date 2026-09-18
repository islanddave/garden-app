// V5-SEEDSTAB-001 — one boundary PER VIEW. /sow and /seeds/saved used to be separate routes, each with
// its own ErrorBoundary, so a Sow now engine throw (sowEngine.js documents a white-screen class: a
// bucket key missing from the seed object makes `buckets[bucket].push` throw out of SowNow's useMemo)
// cost Sow now only. One route would put the whole page — the switch, Saved seeds, the only overdue-
// ferment warning — behind that one throw. This forces the throw and proves the other views survive.
//
// Own file because the engine mock is module-wide. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../lib/sowEngine.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, bucketize: () => { throw new Error('engine exploded') } }
})

import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import Seeds from '../pages/Seeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/inventory-items?category=seeds')) {
      return Promise.resolve([{ id: 'pkt', name: 'Sungold', variety_name: 'Sungold', category: 'seeds', type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1, crop_slug: 'tomato' }])
    }
    if (p.startsWith('/api/inventory-items/sow-candidates')) return Promise.resolve({ items: [] })
    return Promise.resolve([])
  })
  // The boundary logs what it caught; keep the run readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Seeds — a view that throws costs that view only', () => {
  it('a Sow now engine throw leaves the switch standing, and My seeds still mounts', async () => {
    const router = createMemoryRouter(
      [{ path: '/seeds', element: <ToastProvider><Seeds /></ToastProvider> }],
      { initialEntries: ['/seeds?view=sow'] },
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(screen.getByTestId('seeds-view-error')).toBeTruthy())
    expect(screen.getByTestId('seeds-view-switch')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'My seeds' })) })
    await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
    expect(screen.queryByTestId('seeds-view-error')).toBeNull()
  })
})
