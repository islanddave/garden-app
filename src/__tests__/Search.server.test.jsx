// V4-SEARCH-002 — Search page server-slice tests. Existing V4-SEARCH-001 client
// tests live untouched in Search.test.jsx; this file covers the hybrid merge:
// debounced /api/search call, extended sections, id-dedupe (client wins), and
// graceful degradation when the server call fails. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const SAMPLE = {
  '/api/plants': [
    { id: 'p1', project_id: 'pr1', name: 'Cherokee Purple', variety_ref: { name: 'Cherokee Purple', group: 'tomato' } },
  ],
  '/api/locations': [{ id: 'l1', name: 'Greenhouse Bench' }],
  '/api/varieties': [{ id: 'v1', name: 'Sungold', group: 'tomato' }],
}

const SERVER_PAYLOAD = {
  query: 'cherokee',
  results: {
    plantings: [
      { id: 'p1', project_id: 'pr1', name: 'Cherokee Purple', snippet: '' },            // dup — client wins
      { id: 'p9', project_id: 'pr9', name: 'Cherokee Carbon', snippet: 'notes match' }, // server-only extra
    ],
    projects: [{ id: 'pr7', name: 'Cherokee Bed Rebuild', species: 'tomato', snippet: '' }],
    locations: [],
    varieties: [],
    events: [{ id: 'e1', project_id: 'pr1', event_type: 'note', title: 'Cherokee staking', event_date: '2026-06-20', project_name: 'Tomatoes', snippet: 'tied to stakes' }],
    inventory: [{ id: 'i1', name: 'Cherokee seed packet', category: 'seeds', location_text: 'shed' }],
    photos: [{ id: 'ph1', project_id: 'pr1', plant_id: 'p1', caption: 'Cherokee first fruit' }],
  },
}

let searchImpl
// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

// One `fetch` for the whole factory, not one per useApiFetch() call — the real hook useCallbacks it
// (lib/api.js:310). A per-call identity re-runs every consumer effect keyed on `[fetch]` on every
// render; Search mounts useCropTypes, whose effect sets state, so the unstable form spins forever.
vi.mock('../lib/api.js', () => {
  const fetch = async (path, options) => {
    if (path.startsWith('/api/search')) return searchImpl(path, options)
    return SAMPLE[path] ?? []
  }
  return { useApiFetch: () => ({ fetch }) }
})
vi.mock('../lib/transcribe.js', () => ({ isTranscriptionSupported: () => false, startLiveTranscription: () => ({ stop() {}, cancel() {} }) }))

import Search from '../pages/Search.jsx'

const renderPage = () => render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)
const type = async (value) => {
  const input = await screen.findByLabelText('Search your garden')
  fireEvent.change(input, { target: { value } })
}

describe('Search page server slice (V4-SEARCH-002)', () => {
  it('renders extended server sections after debounce and dedupes client-covered ids', async () => {
    searchImpl = async () => SERVER_PAYLOAD
    renderPage()
    await type('cherokee')
    // client-side result is instant
    expect(await screen.findByText('Cherokee Purple')).toBeTruthy()
    // extended sections arrive post-debounce
    await waitFor(() => expect(screen.queryByText('Cherokee Bed Rebuild')).toBeTruthy(), { timeout: 2000 })
    expect(screen.getByText('Cherokee staking')).toBeTruthy()
    expect(screen.getByText('Cherokee seed packet')).toBeTruthy()
    expect(screen.getByText('Cherokee first fruit')).toBeTruthy()
    // server-only planting appended; duplicate id NOT rendered twice
    expect(screen.getByText('Cherokee Carbon')).toBeTruthy()
    expect(screen.getAllByText('Cherokee Purple').length).toBe(1)
    // deep links
    expect(screen.getByText('Cherokee Bed Rebuild').closest('a').getAttribute('href')).toBe('/projects/pr7')
    expect(screen.getByText('Cherokee staking').closest('a').getAttribute('href')).toBe('/events/e1')
    expect(screen.getByText('Cherokee seed packet').closest('a').getAttribute('href')).toBe('/inventory/i1')
    expect(screen.getByText('Cherokee first fruit').closest('a').getAttribute('href')).toBe('/plantings/p1')
  })

  it('degrades gracefully when the server call fails — client results still render', async () => {
    searchImpl = async () => { throw new Error('network down') }
    renderPage()
    await type('cherokee')
    expect(await screen.findByText('Cherokee Purple')).toBeTruthy()
    // give the debounce + rejection time to land, then confirm no crash and no extended sections
    await new Promise(r => setTimeout(r, 600))
    expect(screen.getByText('Cherokee Purple')).toBeTruthy()
    expect(screen.queryByText('Projects')).toBe(null)
    expect(screen.queryByText(/No matches/)).toBe(null)
  })

  it('does not fire the server call for single-character queries', async () => {
    const calls = []
    searchImpl = async (path) => { calls.push(path); return SERVER_PAYLOAD }
    renderPage()
    await type('c')
    await new Promise(r => setTimeout(r, 600))
    expect(calls.length).toBe(0)
  })
})
