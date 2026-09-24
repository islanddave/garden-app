// V5-SEEDSTAB-001 slice 2 — header Search files seed rows under "Seeds" (design V102 §8).
//
// The server slice returns seed packets and saved lots in its `inventory` list, told apart by their own
// `category`. Seed has its own page now, so a packet under "Inventory" pointed at a heading that holds
// no seed anywhere else. Pinned: seed rows sit under Seeds and open their packet/lot page; every other
// inventory row stays under Inventory, unchanged; either group is absent when it has nothing; and the
// Varieties group keeps its own door. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const SAMPLE = {
  '/api/plants': [],
  '/api/locations': [],
  '/api/varieties': [{ id: 'v1', name: 'Pepper Mix Heirloom', group: 'pepper' }],
}

let searchImpl
// One `fetch` for the whole factory — see Search.server.test.jsx for why a per-call identity spins.
vi.mock('../lib/api.js', () => {
  const fetch = async (path, options) => {
    if (path.startsWith('/api/search')) return searchImpl(path, options)
    return SAMPLE[path] ?? []
  }
  return { useApiFetch: () => ({ fetch }) }
})
vi.mock('../lib/transcribe.js', () => ({ isTranscriptionSupported: () => false, startLiveTranscription: () => ({ stop() {}, cancel() {} }) }))

import Search from '../pages/Search.jsx'

const GROUPS = ['Plantings', 'Locations', 'Varieties', 'Projects', 'Events', 'Seeds', 'Inventory', 'Photos']
const payload = (inventory) => ({
  query: 'pepper',
  results: { plantings: [], projects: [], locations: [], varieties: [], events: [], inventory, photos: [] },
})
const SEED_PACKET = { id: 'i-seed', name: 'Pepper seed packet', category: 'seeds', status: 'active', location_text: 'seed tin' }
const SAVED_LOT = { id: 'i-lot', name: 'Pepper — saved 2026', category: 'seeds', status: 'active', location_text: null }
const SPRAYER = { id: 'i-tool', name: 'Pepper sprayer', category: 'tools', status: 'active', location_text: 'shed' }

const renderPage = () => render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)
const type = async (value) => {
  const input = await screen.findByLabelText('Search your garden')
  fireEvent.change(input, { target: { value } })
}
const heading = (name) => [...document.querySelectorAll('div')].find((d) => d.textContent === name && GROUPS.includes(name) && !d.querySelector('div')) ?? null
// The group a result row sits in: the nearest group heading before it among its siblings.
const groupOf = (el) => {
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (GROUPS.includes(s.textContent) && !s.querySelector('a')) return s.textContent
  }
  return null
}
const rowFor = (name) => screen.getByText(name).closest('a')

describe('Search — seed rows are grouped under "Seeds"', () => {
  it('files seed packets and saved lots under Seeds, each opening its own page; other inventory stays put', async () => {
    searchImpl = async () => payload([SEED_PACKET, SPRAYER, SAVED_LOT])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper sprayer')).toBeTruthy(), { timeout: 2000 })
    expect(groupOf(rowFor('Pepper seed packet'))).toBe('Seeds')
    expect(groupOf(rowFor('Pepper — saved 2026'))).toBe('Seeds')
    expect(groupOf(rowFor('Pepper sprayer'))).toBe('Inventory')
    expect(rowFor('Pepper seed packet').getAttribute('href')).toBe('/inventory/i-seed')
    expect(rowFor('Pepper — saved 2026').getAttribute('href')).toBe('/inventory/i-lot')
    expect(rowFor('Pepper sprayer').getAttribute('href')).toBe('/inventory/i-tool')
    // Seeds sits in the Inventory group's slot, just ahead of it.
    const order = GROUPS.filter((g) => heading(g))
    expect(order.indexOf('Seeds')).toBe(order.indexOf('Inventory') - 1)
    // The heading names the category now, so the subtitle does not repeat it; the place still shows.
    expect(rowFor('Pepper seed packet').textContent).toContain('seed tin')
    expect(rowFor('Pepper seed packet').textContent).not.toContain('seeds')
    // A non-seed row keeps its category word, as before.
    expect(rowFor('Pepper sprayer').textContent).toContain('tools · shed')
  })

  it('no Seeds heading when no seed row matched, and no Inventory heading when only seed rows did', async () => {
    searchImpl = async () => payload([SPRAYER])
    const first = renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper sprayer')).toBeTruthy(), { timeout: 2000 })
    expect(heading('Seeds')).toBeNull()
    expect(heading('Inventory')).toBeTruthy()
    first.unmount()

    searchImpl = async () => payload([SEED_PACKET])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper seed packet')).toBeTruthy(), { timeout: 2000 })
    expect(heading('Seeds')).toBeTruthy()
    expect(heading('Inventory')).toBeNull()
  })

  it('leaves the Varieties group and its door untouched', async () => {
    searchImpl = async () => payload([SEED_PACKET])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper seed packet')).toBeTruthy(), { timeout: 2000 })
    expect(groupOf(rowFor('Pepper Mix Heirloom'))).toBe('Varieties')
    expect(rowFor('Pepper Mix Heirloom').getAttribute('href')).toBe('/varieties/v1/edit')
  })
})
