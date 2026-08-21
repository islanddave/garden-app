// Garden ?edit=<id> deep link — the REAL router, and a by-id fetch that resolves LATE.
//
// BUG-EDITDEEPLINKRACE-001. Every other Garden test mocks `react-router-dom` and hands
// `useSearchParams` a plain mutable ref, so `setSearchParams` mutates an object and re-renders
// NOTHING. That mock is why this shipped green: under the real router the strip changes
// `location.search`, `useSearchParams` re-memoises, the effect's deps change, its cleanup runs, and
// an in-flight fetch resolving afterwards was discarded — the editor never opened and Dave landed on
// /garden with no form. So this file uses MemoryRouter and no router mock at all; that is the point
// of it, not an incidental style difference.
//
// The fetch for the ?edit= target resolves on a macrotask (`setTimeout 0`), strictly after the
// re-render the strip used to trigger. A test whose fetch resolves synchronously passes against the
// broken code and proves nothing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'

const { fetchSpy, getTokenSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>,
}))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Krim Plant', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: 'wide-shape notes',
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}

// Resolves on a macrotask — a tick strictly later than the re-render the param strip triggers.
const late = value => new Promise(resolve => { setTimeout(() => resolve(value), 0) })

function primeFetch({ byId = () => late(PLANT) } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid' && !opts.method) return Promise.resolve([PLANT])
    if (url === '/api/plants/plant-2' && !opts.method) return byId()
    return Promise.resolve([])
  })
}

function Search() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="search">{location.search}</span>
      <button data-testid="redeeplink" onClick={() => navigate('/garden?edit=plant-2')}>re-deep-link</button>
      <button data-testid="addparam" onClick={() => navigate('/garden?groupBy=tag')}>change an unrelated param</button>
    </>
  )
}

async function renderAt(entry) {
  await act(async () => {
    render(<MemoryRouter initialEntries={[entry]}><Garden /><Search /></MemoryRouter>)
  })
  await screen.findByText(/Log many/)
}

const byIdGets = () => fetchSpy.mock.calls.filter(c => c[0] === '/api/plants/plant-2' && !c[1]?.method).length

beforeEach(() => {
  localStorage.clear()
  fetchSpy.mockReset()
})

describe('Garden ?edit= deep link under the real router', () => {
  it('opens the editor when the by-id fetch resolves AFTER the param-strip re-render', async () => {
    primeFetch()
    await renderAt('/garden?edit=plant-2')
    // The editor is identified by its heading; the wide-shape `notes` prove the by-id row prefilled
    // the form rather than a projected list row.
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    expect(screen.getByDisplayValue('Krim Plant')).toBeTruthy()
    expect(screen.getByDisplayValue('wide-shape notes')).toBeTruthy()
  })

  it('strips ?edit from the URL so a reload does not silently reopen the editor', async () => {
    primeFetch()
    await renderAt('/garden?edit=plant-2')
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('search').textContent).not.toContain('edit'))
  })

  it('opens nothing when the by-id fetch rejects (404 / offline), and still strips the param', async () => {
    primeFetch({ byId: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('offline')), 0) }) })
    await renderAt('/garden?edit=plant-2')
    await waitFor(() => expect(screen.getByTestId('search').textContent).not.toContain('edit'))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(screen.queryByText('Edit Krim Plant')).toBeNull()
  })

  it('opens nothing for an unknown id (response without an id), and still strips the param', async () => {
    primeFetch({ byId: () => late({}) })
    await renderAt('/garden?edit=plant-2')
    await waitFor(() => expect(screen.getByTestId('search').textContent).not.toContain('edit'))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(screen.queryByText('Edit Krim Plant')).toBeNull()
  })

  it('issues exactly ONE by-id GET per deep link', async () => {
    primeFetch()
    await renderAt('/garden?edit=plant-2')
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(byIdGets()).toBe(1)
  })

  it('survives an unrelated URL change while the by-id GET is still in flight', async () => {
    // The cancel guard has to be scoped to TEARDOWN, not to an effect re-run. Any dep change
    // during the request window re-runs this effect, and an effect-local `on = false` would eat a
    // response that is already on its way. Same lesson the scroll timer next to it learned. This
    // test holds the GET open, changes the query underneath it, and only then resolves.
    let release
    primeFetch({ byId: () => new Promise(resolve => { release = () => resolve(PLANT) }) })
    await renderAt('/garden?edit=plant-2')
    expect(screen.queryByText('Edit Krim Plant')).toBeNull()   // still pending, nothing opened yet
    await act(async () => { screen.getByTestId('addparam').click() })
    await act(async () => { release(); await new Promise(r => setTimeout(r, 0)) })
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    // …and the unrelated param the user set mid-flight survives: the strip happened in its own
    // tick, so it cannot write back a stale snapshot of the query over the top of this.
    expect(screen.getByTestId('search').textContent).toContain('groupBy=tag')
    expect(screen.getByTestId('search').textContent).not.toContain('edit')
  })

  it('re-triggers on a repeat deep link to the SAME id (the contract the strip exists to serve)', async () => {
    primeFetch()
    await renderAt('/garden?edit=plant-2')
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('search').textContent).not.toContain('edit'))
    // Close the editor, then arrive at the same URL again — Garden never unmounted, so the
    // one-fetch-per-id guard has to have been released by the strip's own re-run.
    await act(async () => { screen.getByRole('button', { name: /^Cancel$/i }).click() })
    expect(screen.queryByText('Edit Krim Plant')).toBeNull()
    await act(async () => { screen.getByTestId('redeeplink').click() })
    await waitFor(() => expect(screen.getByText('Edit Krim Plant')).toBeTruthy())
    expect(byIdGets()).toBe(2)
  })
})
