// Locations — the activate/deactivate toggle's request contract.
//
// Why this file exists: the toggle shipped as PATCH /api/locations/:id/active, a route the Lambda
// does not implement. lambda/locations/index.js matches /^\/api\/locations\/([^/]+)$/, which the
// `/active` suffix defeats, so every tap fell through to `405 Method not allowed`. Prod agrees:
// 21 locations, 0 inactive. src/pages/** is outside coverage.include, so nothing in CI observed it.
//
// These tests pin the VERB, the ROUTE SHAPE, and the PAYLOAD KEYS — not merely "a request went
// out". A mocked fetch can never prove the Lambda routes what we send; asserting the exact request
// is the most a unit test can do, and it is exactly what was missing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { apiFetchSpy, locations } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  locations: { current: [] },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import Locations from '../pages/Locations.jsx'

const ACTIVE = {
  id: 'loc1', name: 'Stable', slug: 'stable', level: 0, type_label: null,
  parent_id: null, sort_order: 0, description: null, is_active: true,
}

beforeEach(() => {
  locations.current = [ACTIVE]
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/locations') return Promise.resolve(locations.current)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve({})
  })
})

async function renderAndOpenMenu() {
  render(<MemoryRouter><Locations /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Stable')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Actions'))
}

// The toggle is the only caller, so its write is call #3 (after the two loaders).
const writeCall = () => apiFetchSpy.mock.calls.find(([, opts]) => opts?.method)

describe('Locations activate/deactivate toggle', () => {
  it('PUTs the collection route the Lambda implements, not a /active sub-route', async () => {
    await renderAndOpenMenu()
    fireEvent.click(screen.getByText(/Deactivate/))
    await waitFor(() => expect(writeCall()).toBeTruthy())
    const [path, opts] = writeCall()
    expect(path).toBe('/api/locations/loc1')
    // The whole bug: a trailing /active segment never matches the Lambda's idMatch → 405.
    expect(path).toMatch(/^\/api\/locations\/[^/]+$/)
    expect(opts.method).toBe('PUT')
  })

  it('sends is_active alone, so COALESCE preserves every other column', async () => {
    // locations PUT is SET x = COALESCE(body.x, x) per column. An omitted key preserves its
    // column, so the minimal body cannot blank name/slug/sort_order/description/featured_photo_id.
    await renderAndOpenMenu()
    fireEvent.click(screen.getByText(/Deactivate/))
    await waitFor(() => expect(writeCall()).toBeTruthy())
    const body = JSON.parse(writeCall()[1].body)
    expect(Object.keys(body)).toEqual(['is_active'])
    expect(body.is_active).toBe(false)
  })

  it('reactivates an inactive location', async () => {
    // Both directions matter: `false` is not NULL, so COALESCE(false, is_active) writes false —
    // the deactivate direction is not silently a no-op the way a null-clear would be.
    locations.current = [{ ...ACTIVE, is_active: false }]
    await renderAndOpenMenu()
    fireEvent.click(screen.getByText(/Activate/))
    await waitFor(() => expect(writeCall()).toBeTruthy())
    const [path, opts] = writeCall()
    expect(path).toBe('/api/locations/loc1')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ is_active: true })
  })

  it('reloads the tree after a successful toggle', async () => {
    await renderAndOpenMenu()
    apiFetchSpy.mockClear()
    fireEvent.click(screen.getByText(/Deactivate/))
    await waitFor(() => expect(apiFetchSpy.mock.calls.filter(([p]) => p === '/api/locations').length).toBe(1))
  })

  it('surfaces a toggle failure and clears it on the next attempt', async () => {
    // toggleActive is now reachable-on-success for the first time, which makes a stale opError
    // banner newly observable: it must not outlive the failed op that set it.
    await renderAndOpenMenu()
    apiFetchSpy.mockImplementationOnce(() => Promise.reject(new Error('405 Method not allowed')))
    fireEvent.click(screen.getByText(/Deactivate/))
    await waitFor(() => expect(screen.getByText(/405 Method not allowed/)).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Actions'))
    fireEvent.click(screen.getByText(/Deactivate/))
    await waitFor(() => expect(screen.queryByText(/405 Method not allowed/)).toBeNull())
  })
})
