// BUG-DELCLIENT-001 — a DELETE that 404s is SUCCESS from the user's seat.
//
// Why this file exists: BUG-DELNOOPOK-001 changed five Lambda DELETE routes from an unconditional
// `{ok:true}` to `404 {error:'Not found'}` when no row matched. That is the intended server
// contract, but `apiFetch` (src/lib/api.js:134-141) THROWS on every non-2xx — it does not merely
// return a bad status — so the change landed straight in each caller's `catch`. Untreated, the
// "already gone" case (double-submit, retry after a network blip, a second device, a stale list)
// renders as a RED ERROR over an outcome the user already has. Three call sites now tolerate a 404
// specifically; this file pins that tolerance and, just as importantly, pins that it is NARROW.
//
// Each component gets both directions, because a fix that swallowed everything would pass the
// happy half alone:
//   404      → treated as success (no banner, list converges, onDeleted fires)
//   500/etc. → still surfaces exactly as before
//
// The narrowness assertions are the load-bearing ones. The tempting "fix" was to make apiFetch
// swallow 404s globally, which would have silently masked genuine not-founds on every GET and PUT
// in the app. If someone later does that, these tests still pass — so the guard against it is the
// 500 arm plus the comments at each call site, not this file alone. Stated here so a future reader
// does not mistake this suite for proof that apiFetch was left alone.
//
// LIMITATION, deliberate and important: these tests SIMULATE the 404 by rejecting the mocked fetch
// with an `e.status = 404` error shaped exactly like apiFetch's throw. They cannot provoke a real
// one — this branch is based on c509fff, which does NOT contain the sibling lane's Lambda change.
// The wired-together behaviour is unproven until the two branches merge.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Shaped to match apiFetch's throw exactly: `new Error(errBody?.error ?? ...)` with `.status` and
// `.body` hung on it. The call sites branch on `.status`, so a plain Error must NOT be tolerated —
// that is what the 500/network arms below check.
function apiError(status, message) {
  const e = new Error(message)
  e.status = status
  e.body = { error: message }
  return e
}

const { apiFetchSpy, authUser } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  authUser: { current: { id: 'user-1' } },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: authUser.current }) }))

import Locations from '../pages/Locations.jsx'
import ProjectTypes from '../pages/ProjectTypes.jsx'
import PlantingEditor from '../components/PlantingEditor.jsx'

let confirmSpy
beforeEach(() => {
  apiFetchSpy.mockReset()
  authUser.current = { id: 'user-1' }
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { confirmSpy.mockRestore() })

// ───────────────────────── Locations ─────────────────────────

describe('Locations delete — 404 tolerance (BUG-DELCLIENT-001)', () => {
  const LOC = {
    id: 'loc1', name: 'Stable', slug: 'stable', level: 0, type_label: null,
    parent_id: null, sort_order: 0, description: null, is_active: true,
  }

  // `deleteResult` is installed BEFORE the click, never after — a rejection registered after the
  // delete has already resolved would make the test vacuous (it would assert "no banner" against a
  // request that never failed). The 500/timeout arms below prove the banner does appear when it
  // should, which is what stops the 404 arm from passing for that same empty reason.
  function mockAll(deleteResult) {
    apiFetchSpy.mockImplementation((path, opts) => {
      if (opts?.method === 'DELETE') return deleteResult()
      if (path === '/api/locations') return Promise.resolve([LOC])
      if (path === '/api/locations/with-path') return Promise.resolve([])
      return Promise.resolve({})
    })
  }

  async function renderAndDelete() {
    render(<MemoryRouter><Locations /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Stable')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Actions'))
    fireEvent.click(screen.getByText(/Delete/))
  }

  const deleteCall = () =>
    apiFetchSpy.mock.calls.find(([p, o]) => o?.method === 'DELETE' && p === '/api/locations/loc1')

  it('a 404 raises no error banner — the location is already gone, which is what was asked', async () => {
    mockAll(() => Promise.reject(apiError(404, 'Not found')))
    await renderAndDelete()
    await waitFor(() => expect(deleteCall()).toBeTruthy())
    // Nothing may appear in the op-error banner slot. Before this fix, 'Not found' rendered here.
    await waitFor(() => expect(screen.queryByText(/Not found/)).toBeNull())
  })

  it('still refetches the tree after a 404, so the vanished row leaves the list', async () => {
    // The refetch is the whole point of tolerating the 404: without it the dead row would sit in
    // the tree looking undeleted. `load()` must run on the caught path too, not just the happy one.
    mockAll(() => Promise.reject(apiError(404, 'Not found')))
    await renderAndDelete()
    await waitFor(() => expect(deleteCall()).toBeTruthy())
    // Two loads of the collection: the mount, plus the post-delete refetch.
    await waitFor(() =>
      expect(apiFetchSpy.mock.calls.filter(([p, o]) => p === '/api/locations' && !o?.method).length)
        .toBeGreaterThanOrEqual(2))
  })

  it('a 500 STILL surfaces — the tolerance is 404-only, not "ignore delete failures"', async () => {
    mockAll(() => Promise.reject(apiError(500, 'Internal error')))
    await renderAndDelete()
    await waitFor(() => expect(screen.getByText(/Internal error/)).toBeTruthy())
  })

  it('a bare Error with no .status surfaces (network/timeout must not be read as "already gone")', async () => {
    // apiFetch's timeout path throws status 0, and a raw network failure throws a DOMException with
    // no status at all. Neither is 404, and an `err?.status !== 404` test must reject both — a
    // truthiness check on the status would wrongly swallow the 0.
    mockAll(() => Promise.reject(new Error('Failed to fetch')))
    await renderAndDelete()
    await waitFor(() => expect(screen.getByText(/Failed to fetch/)).toBeTruthy())
  })

  it('a timeout (status 0) surfaces rather than passing as a 404', async () => {
    mockAll(() => Promise.reject(apiError(0, 'Request timed out')))
    await renderAndDelete()
    await waitFor(() => expect(screen.getByText(/Request timed out/)).toBeTruthy())
  })
})

// ───────────────────────── ProjectTypes ─────────────────────────

describe('ProjectTypes delete — 404 tolerance (BUG-DELCLIENT-001)', () => {
  // The Delete button renders only when `t.created_by === user.id` (TypeRow), so the fixture must
  // be owned or there is nothing to click.
  const TYPE = { id: 'pt1', name: 'Raised Bed', category: 'garden', icon: '🌱', created_by: 'user-1' }

  async function renderAndDelete() {
    render(<MemoryRouter><ProjectTypes /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Raised Bed')).toBeTruthy())
    fireEvent.click(screen.getByText('Delete'))
  }

  it('a 404 removes the row and shows no banner', async () => {
    apiFetchSpy.mockImplementation((path, opts) => {
      if (opts?.method === 'DELETE') return Promise.reject(apiError(404, 'Not found'))
      if (path === '/api/projects/types') return Promise.resolve([TYPE])
      return Promise.resolve({})
    })
    await renderAndDelete()
    // The row leaving the list is the user-visible success signal — this list is filtered locally,
    // not refetched, so if the catch returned early the dead type would stay on screen forever.
    await waitFor(() => expect(screen.queryByText('Raised Bed')).toBeNull())
    expect(screen.queryByText(/Not found/)).toBeNull()
  })

  it('a 500 keeps the row and surfaces the error', async () => {
    apiFetchSpy.mockImplementation((path, opts) => {
      if (opts?.method === 'DELETE') return Promise.reject(apiError(500, 'Internal error'))
      if (path === '/api/projects/types') return Promise.resolve([TYPE])
      return Promise.resolve({})
    })
    await renderAndDelete()
    await waitFor(() => expect(screen.getByText(/Internal error/)).toBeTruthy())
    // Not removed: we have no evidence the server dropped it.
    expect(screen.getByText('Raised Bed')).toBeTruthy()
  })
})

// ───────────────────────── PlantingEditor ─────────────────────────

describe('PlantingEditor remove — 404 tolerance (BUG-DELCLIENT-001)', () => {
  const PLANT = {
    id: 'p1', name: 'Black Krim', quantity: 1, project_id: 'proj1',
    variety_ref: null, notes: '', status: 'seed',
  }

  function renderEditor(fetchImpl, handlers = {}) {
    const onDeleted = vi.fn()
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <PlantingEditor
          mode="edit" plant={PLANT} plants={[PLANT]}
          projects={[{ id: 'proj1', name: 'Beds' }]}
          fetch={fetchImpl} onDeleted={onDeleted} onClose={onClose} {...handlers}
        />
      </MemoryRouter>,
    )
    return { onDeleted, onClose }
  }

  it('a 404 still fires onDeleted — otherwise the planting lingers in Garden with no server row', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(apiError(404, 'Not found')))
    const { onDeleted, onClose } = renderEditor(fetchImpl)
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('p1'))
    // The editor closes either way — that was already true and is what made the missing onDeleted
    // read to the user as "the delete silently did nothing".
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  // BUG-SILENTFAILSWEEP-001 REVERSED THE SECOND HALF OF THIS TEST. It used to read "…but still
  // closes (unchanged prior behaviour)", which pinned the defect: onClose fired from `finally` on
  // every path, so a failed Remove closed the editor exactly like a successful one and the only
  // tell was the planting still sitting in Garden's list. onClose UNMOUNTS the editor, so "close
  // and show the error" was never available — the close had to move onto the success arms.
  it('a 500 does NOT fire onDeleted and does NOT close — the reason stays on screen instead', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(apiError(500, 'Internal error')))
    const { onDeleted, onClose } = renderEditor(fetchImpl)
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Couldn't remove this planting/))
    expect(onClose).not.toHaveBeenCalled()
    // The row may well still exist server-side; claiming it was deleted would be a lie to Garden.
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('a 2xx fires onDeleted exactly once (the happy path is not double-fired by the new branch)', async () => {
    // Vacuity floor: if the catch branch were written to call onDeleted unconditionally, the 404
    // test above would still pass. This pins that success goes through the try, not the catch.
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true }))
    const { onDeleted } = renderEditor(fetchImpl)
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })
})
