// V4-DRAFTFULLPAGE-001 (c) — the Log Many draft stash now covers the FULL-PAGE /log/many path, not
// just the overlay. Both stash effects and the confirm-time idemKey write used to early-return on
// !inOverlay, so a full-page /log/many — reached by deep link, bookmark or notification — persisted
// NOTHING. An exit there lost the event type, date, scope AND the persisted idempotency key that
// makes a failed batch's retry idempotent. No router blocker is possible (useBlocker needs a data
// router; App uses declarative BrowserRouter), so persistence is the only recovery mechanism.
//
// This mirrors the (a) change already shipped for EventNew (EventNewDraftFullPage.test.jsx) and
// pins BOTH directions: the full page now stashes/restores, and the overlay behaviour is unchanged.
//
// Harness mirrors LogManyStickyType.test.jsx (stable mock identities so LogMany's loader effect,
// deps [fetch, params], does not self-retrigger every render).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const navigate = vi.fn()
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
const apiFetch = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  Link: ({ children }) => children,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ScopeChecklist: ({ onSelectionChange }) => (
      <button type="button" onClick={() => onSelectionChange({ committedCount: 3, excludedIds: [] })}>
        stub-commit-scope
      </button>
    ),
  }
})

import LogMany from '../pages/LogMany.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const STASH_KEY = 'gardenApp.draft.logmany'
const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026' }

function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

// Full page = no OverlaySurfaceProvider (useInOverlaySurface defaults false).
const renderFullPage = () => render(<LogMany />)
const renderInOverlay = () => render(<OverlaySurfaceProvider><LogMany /></OverlaySurfaceProvider>)

describe('LogMany draft stash — full page (V4-DRAFTFULLPAGE-001 (c))', () => {
  beforeEach(() => {
    navigate.mockClear()
    localStorage.clear()
    sessionStorage.clear()
    searchParams.forEach((_, k) => searchParams.delete(k))
    apiFetch.mockReset()
    apiFetch.mockImplementation((path) => {
      if (path === '/api/projects') return Promise.resolve([PROJECT])
      if (path === '/api/locations') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  // THE REGRESSION THIS FILE EXISTS FOR. Pre-change this asserted null: the persist effect
  // early-returned on !inOverlay, so a dirty full-page form wrote nothing and an exit lost it all.
  it('persists a dirty form on the FULL PAGE (was inert before)', async () => {
    renderFullPage()
    fireEvent.click((await screen.findByText('Flowering')).closest('button'))
    await waitFor(() => expect(readStash()?.eventType).toBe('flowering'))
  })

  it('restores a full-page draft on mount', async () => {
    seedStash({ eventType: 'flowering', eventDate: '2026-08-01', scope: { type: 'all' }, idemKey: 'k-1' })
    renderFullPage()
    await screen.findByText('Flowering')
    expect(screen.getByText('Log flowering on 0')).toBeTruthy()
  })

  // The specific byte whose loss turned a failed batch's retry into a DUPLICATE write.
  it('persists the idempotency key at confirm time on the full page', async () => {
    apiFetch.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') return Promise.reject(new Error('network down'))
      if (path === '/api/projects') return Promise.resolve([PROJECT])
      if (path === '/api/locations') return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderFullPage()
    fireEvent.click((await screen.findByText('Flowering')).closest('button'))
    fireEvent.click(screen.getByText('stub-commit-scope'))
    fireEvent.click(await screen.findByText('Log flowering on 3'))
    await waitFor(() => expect(typeof readStash()?.idemKey).toBe('string'))
    const key = readStash().idemKey
    expect(key.length).toBeGreaterThan(0)

    // Re-mount after the failure: the SAME key is restored, so the retry is idempotent.
    screen.unmount?.()
    renderFullPage()
    await screen.findAllByText('Flowering')
    expect(readStash().idemKey).toBe(key)
  })

  it('does NOT persist a pristine default (watering / no date / scope all)', async () => {
    renderFullPage()
    await screen.findByText('Watered')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/projects'))
    expect(readStash()).toBeNull()
  })

  // A deep-link's params express an explicit fresh intent and must beat a stale draft — unchanged
  // by (c), and the reason the restore sits in the else-branch of the seed check.
  it('a ?project_id deep-link seed still wins over a stored draft', async () => {
    seedStash({ eventType: 'flowering', eventDate: '', scope: { type: 'all' } })
    searchParams.set('project_id', 'proj-1')
    renderFullPage()
    await screen.findByText('Watered')
    expect(screen.getByText('Log watered on 0')).toBeTruthy()
  })

  // Non-regression: the overlay path that (a)/(b) shipped must be byte-identical.
  it('overlay behaviour is unchanged — still stashes and still restores', async () => {
    renderInOverlay()
    fireEvent.click((await screen.findByText('Flowering')).closest('button'))
    await waitFor(() => expect(readStash()?.eventType).toBe('flowering'))
  })
})
