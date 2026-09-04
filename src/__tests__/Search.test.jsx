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
  // BUG-CULTIVARUNREACHABLE-001 fixtures. v2/v3 are REAL prod rows, not invented ones: both are
  // live cultivars with ZERO plantings, which is the shape that made them unreachable — the only
  // door to /varieties/:id/edit is the "Edit variety" link on a PLANTING's page. 248 of 505 live
  // cultivars (49.1%) are in this state. v3 additionally carries no species, which is the row that
  // exposed the bug: it cannot be opened to record one.
  '/api/varieties': [
    { id: 'v1', name: 'Sungold', group: 'tomato' },
    { id: 'v2', name: 'Chabaud Blend', crop_type_slug: 'carnation', species: 'Dianthus caryophyllus' },
    { id: 'v3', name: 'Mixed Colors', crop_type_slug: 'dianthus' },
  ],
}
// `fetch` is defined ONCE in the factory, not per useApiFetch() call, because the real hook returns
// a useCallback'd function whose identity is stable across renders (lib/api.js:310) and a mock that
// mints a new one every render does not model it. Any consumer with `[fetch]` in an effect dep array
// then re-runs that effect on every render — Search now mounts useCropTypes, which sets state in
// exactly such an effect, so the per-call form spins forever and the suite HANGS rather than failing.
vi.mock('../lib/api.js', () => {
  const fetch = async (path) => SAMPLE[path] ?? []
  return { useApiFetch: () => ({ fetch }) }
})
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

  // BUG-CULTIVARUNREACHABLE-001 — the defect this pair exists to hold closed.
  //
  // The assertion directly above is the one that let it ship: findByText passes on an inert <div>
  // exactly as it does on a <Link>, so "varieties are matched" was verified while "varieties are
  // REACHABLE" never was. Search rendered its variety groups as hand-rolled divs — the only result
  // category on the page not routed through <Row> — so every cultivar result was a dead tap, the
  // same shape as BUG-SEARCHDEADTAP-001 two tests up, which repaired only the planting rows.
  //
  // These assert the anchor and its href, so a regression to a bare <div> fails on `.closest('a')`
  // being null rather than passing silently. Verified non-vacuous by reverting Search.jsx: both fail.
  it('links a cultivar that has NO planting — the only door to the editor is a planting page', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'mixed colors' } })
    const row = await screen.findByText('Mixed Colors')
    const link = row.closest('a')
    // The whole bug in one assertion: there must BE an anchor at all.
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/varieties/v3/edit')
  })

  it('keeps each variety group its own subtitle while routing both to the editor', async () => {
    renderPage()
    const input = await screen.findByLabelText('Search your garden')
    fireEvent.change(input, { target: { value: 'chabaud' } })
    const row = await screen.findByText('Chabaud Blend')
    expect(row.closest('a').getAttribute('href')).toBe('/varieties/v2/edit')
    // The local group subtitles on `group || crop_type_slug`; this row has no group, so the slug
    // shows. Asserted because the fix rewrote both groups and the two use DIFFERENT fields.
    expect(await screen.findByText('carnation')).toBeTruthy()
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
