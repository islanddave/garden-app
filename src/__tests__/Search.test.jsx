// V4-SEARCH-001 — Search page. No jest-dom (L-182): attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const SAMPLE = {
  '/api/plants': [
    { id: 'p1', project_id: 'pr1', name: 'Cherokee Purple', variety_ref: { name: 'Cherokee Purple', group: 'tomato' } },
    { id: 'p2', project_id: 'pr2', name: 'Jalapeno', variety_ref: { name: 'Jalapeno', group: 'pepper' } },
    // BUG-SEARCHDEADTAP-001 fixture: a Snap/CaptureFlow planting. No project_id, no variety_ref —
    // exactly the shape that made the row render as an inert <div> instead of a <Link>.
    // Measured on prod: 2 live plantings carry a null project_id.
    { id: 'p3', project_id: null, name: 'Aloe Vera' },
  ],
  '/api/locations': [{ id: 'l1', name: 'Greenhouse Bench' }, { id: 'l2', name: 'Pasture Bed' }],
  '/api/varieties': [{ id: 'v1', name: 'Sungold', group: 'tomato' }],
}
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: async (path) => SAMPLE[path] ?? [] }) }))
vi.mock('../lib/transcribe.js', () => ({ isTranscriptionSupported: () => false, startLiveTranscription: () => ({ stop() {}, cancel() {} }) }))

import Search from '../pages/Search.jsx'

const renderPage = () => render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)

describe('Search page (V4-SEARCH-001)', () => {
  it('filters plantings by query and links to the planting detail', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'cherokee' } })
    const row = await screen.findByText('Cherokee Purple')
    const link = row.closest('a')
    // Canonical un-scoped route (App.jsx:199, V4-UNSCOPEDROUTES-001). The scoped form survives only
    // as a redirect shim, so linking straight here also drops a redirect hop.
    expect(link.getAttribute('href')).toBe('/plantings/p1')
    expect(screen.queryByText('Jalapeno')).toBe(null)
  })
  // BUG-SEARCHDEADTAP-001 — the reported defect: a Snap-added planting was findable but the result
  // was a DEAD TAP. `to` fell to null on the missing project_id and <Row> rendered a <div>, which
  // looks identical to a link and does nothing. The canonical route needs no project_id.
  it('links a planting that has NO project_id (Snap/CaptureFlow) instead of rendering a dead row', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'aloe' } })
    const row = await screen.findByText('Aloe Vera')
    const link = row.closest('a')
    // The whole bug in one assertion: there must BE an anchor at all.
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/plantings/p3')
  })

  it('matches locations and varieties too', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'pasture' } })
    expect((await screen.findByText('Pasture Bed')).closest('a').getAttribute('href')).toBe('/locations/l2')
    fireEvent.change(input, { target: { value: 'sungold' } })
    expect(await screen.findByText('Sungold')).toBeTruthy()
  })
  it('shows a no-match message for gibberish', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'zzzzz' } })
    expect(await screen.findByText(/No matches/)).toBeTruthy()
  })

  it('§6: as an overlay surface it does NOT autofocus the input (the Sheet owns focus-on-open)', async () => {
    render(<MemoryRouter initialEntries={['/search']}><OverlaySurfaceProvider><Search /></OverlaySurfaceProvider></MemoryRouter>)
    const input = await screen.findByLabelText('Search your garden')
    // Full-page Search autofocuses on mount; inside a Sheet it must defer so it does not corrupt
    // the Sheet's focus-restore target (§6, SC 2.4.3). Nothing here focuses it.
    expect(document.activeElement).not.toBe(input)
  })
})
