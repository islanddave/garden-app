// WS-A1 — ProjectPublic is the `/garden/:slug` share page. It was UNAUTHENTICATED until
// 2026-09-09; the route is now wrapped in <Protected> (pinned in App.routes.test.jsx) and the
// matching server bypass is retired. The page therefore fetches through useApiFetch().fetch, which
// attaches the signed-in user's token, like every other authenticated call. It fetches GET /api/projects/public/:slug and renders the deny-by-default
// projection: name/species/variety/status + an events timeline. A 404 (apiFetch rejects with
// err.status = 404) renders the not-found state.
//
// This file renders the COMPONENT, not the route, so it is unaffected by the wrapper — and that
// separation is deliberate: the auth boundary belongs to the route table and is asserted there,
// while the projection-rendering guarantees below stay independent of it.
//
// location_path was dropped from this route 2026-08-27. PUBLIC_PAYLOAD deliberately STILL carries
// it: the assertion below is that the page renders no location even when handed one, so the client
// half of the guard holds independently of the server half in lambda/projects/public-route.test.js.
// Deleting the field would make that test vacuous.
//
// The CREDENTIAL SEAM is mocked, not the raw transport, and that is the point. Until 2026-09-09
// this file mocked `apiFetch` and asserted `mock.calls[0]).toHaveLength(1)` — i.e. it PINNED the
// tokenless call. That assertion was correct while the route was public and became a LOCK ON A BUG
// the moment the route required auth: the page shipped to prod returning 401 for signed-in users
// with CI fully green. Both seams are mocked below so the test can assert the page uses
// useApiFetch().fetch AND never reaches past it to the raw apiFetch. react-router-dom is REAL —
// MemoryRouter supplies the :slug param. No jest-dom (L-182): assert .toBeTruthy() / queryByText.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, seamSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn(), seamSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  apiFetch: (...args) => apiFetchSpy(...args),
  useApiFetch: () => ({ fetch: seamSpy, getToken: vi.fn() }),
}))

import ProjectPublic from '../pages/ProjectPublic.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); seamSpy.mockReset() })

const PUBLIC_PAYLOAD = {
  name: 'Sungold Tomatoes',
  slug: 'sungold-2026',
  status: 'growing',
  species: 'Solanum lycopersicum',
  variety: 'Sungold',
  description: 'Cherry tomatoes on the south fence.',
  start_date: '2026-03-01',
  location_path: 'Backyard > Raised Bed 3',
  events: [
    { id: 'e1', event_type: 'watered', event_date: '2026-06-01', notes: 'Deep soak', quantity: null },
    { id: 'e2', event_type: 'harvest', event_date: '2026-06-10', notes: 'First ripe cluster', quantity: 12 },
  ],
}

function renderAt(slug) {
  return render(
    <MemoryRouter initialEntries={[`/garden/${slug}`]}>
      <Routes>
        <Route path="/garden/:slug" element={<ProjectPublic />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProjectPublic (public share page)', () => {
  it('fetches through the credential seam and renders species / events, never a location', async () => {
    seamSpy.mockResolvedValueOnce(PUBLIC_PAYLOAD)
    renderAt('sungold-2026')

    await waitFor(() => expect(screen.getByText('Sungold Tomatoes')).toBeTruthy())

    // BUG-TOKENLESS-401-001 guard. The route requires a token since 2026-09-09, so the page MUST
    // go through the credential seam. Asserting the seam was called is only half of it — the other
    // half is that the raw transport was NOT, because reaching past useApiFetch is precisely how
    // the headerless request got out. Reverting the page to `apiFetch(path)` fails both lines.
    expect(seamSpy).toHaveBeenCalledWith('/api/projects/public/sungold-2026')
    expect(apiFetchSpy).not.toHaveBeenCalled()

    expect(screen.getByText('Solanum lycopersicum')).toBeTruthy()
    expect(screen.getByText('Sungold')).toBeTruthy()
    // The payload carries location_path and the page must ignore it — neither the path nor the
    // pin glyph that used to precede it may appear anywhere in the rendered output.
    expect(screen.queryByText(/Backyard/)).toBeNull()
    expect(screen.queryByText(/Raised Bed 3/)).toBeNull()
    expect(document.body.textContent).not.toContain('📍')
    // Events timeline rendered from the allowlisted event fields.
    expect(screen.getByText('Deep soak')).toBeTruthy()
    expect(screen.getByText('First ripe cluster')).toBeTruthy()
  })

  it('renders the not-found state on a 404 (apiFetch rejects with status 404)', async () => {
    const err = new Error('Not found')
    err.status = 404
    seamSpy.mockRejectedValueOnce(err)
    renderAt('does-not-exist')

    await waitFor(() => expect(screen.getByText('Project not found')).toBeTruthy())
    // The success content never appears.
    expect(screen.queryByText('Sungold Tomatoes')).toBeNull()
  })
})
