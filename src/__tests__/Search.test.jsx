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
    expect(link.getAttribute('href')).toBe('/projects/pr1/plantings/p1')
    expect(screen.queryByText('Jalapeno')).toBe(null)
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
