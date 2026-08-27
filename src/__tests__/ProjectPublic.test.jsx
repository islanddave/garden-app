// WS-A1 — ProjectPublic is the UNAUTHENTICATED `/garden/:slug` share page. It fetches
// GET /api/projects/public/:slug via apiFetch WITHOUT a token and renders the deny-by-default
// public projection: name/species/variety/status + an events timeline. A 404
// (apiFetch rejects with err.status = 404) renders the not-found state.
//
// location_path was dropped from this route 2026-08-27. PUBLIC_PAYLOAD deliberately STILL carries
// it: the assertion below is that the page renders no location even when handed one, so the client
// half of the guard holds independently of the server half in lambda/projects/public-route.test.js.
// Deleting the field would make that test vacuous.
//
// apiFetch is mocked (we control the payload); react-router-dom is REAL — MemoryRouter supplies
// the :slug param. No jest-dom (L-182): assert with .toBeTruthy() / queryByText.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  apiFetch: (...args) => apiFetchSpy(...args),
}))

import ProjectPublic from '../pages/ProjectPublic.jsx'

beforeEach(() => { apiFetchSpy.mockReset() })

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
  it('fetches the public endpoint UNauthenticated and renders species / events, never a location', async () => {
    apiFetchSpy.mockResolvedValueOnce(PUBLIC_PAYLOAD)
    renderAt('sungold-2026')

    await waitFor(() => expect(screen.getByText('Sungold Tomatoes')).toBeTruthy())

    // Called with the public path ONLY — no token argument (unauthenticated fetch).
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects/public/sungold-2026')
    expect(apiFetchSpy.mock.calls[0]).toHaveLength(1)

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
    apiFetchSpy.mockRejectedValueOnce(err)
    renderAt('does-not-exist')

    await waitFor(() => expect(screen.getByText('Project not found')).toBeTruthy())
    // The success content never appears.
    expect(screen.queryByText('Sungold Tomatoes')).toBeNull()
  })
})
