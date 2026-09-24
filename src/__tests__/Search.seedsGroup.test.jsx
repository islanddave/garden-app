// V5-SEEDSTAB-001 slice 2 — header Search files seed rows under "Seeds" (design V102 §8).
//
// The server slice returns seed packets and saved lots in its `inventory` list, told apart by their own
// `category`. Seed has its own page now, so a packet under "Inventory" pointed at a heading that holds
// no seed anywhere else. Pinned: seed rows sit under Seeds and open their packet/lot page; every other
// inventory row stays under Inventory, unchanged; either group is absent when it has nothing; the
// Varieties group keeps its own door; and the Seeds group lists every seed row the server sends, in its
// order (BUG-SEARCHSEEDCAP20-001). No jest-dom (L-182).
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

  // The Seeds group dropped the category subtitle, so a seed row with no location_text is ONE line:
  // 2x11 padding + 2x1 border + an ~18.75px line is about 43px, under the tap floor, unless the row
  // itself carries the floor (pre-ship QA). The row style is shared, so every group gets it.
  it('a one-line seed row sits on the 44px tap floor, like every result row', async () => {
    searchImpl = async () => payload([SAVED_LOT, SEED_PACKET, SPRAYER])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper — saved 2026')).toBeTruthy(), { timeout: 2000 })
    // The case that needs it: no location, so no subtitle — the row is its name and the chevron alone.
    expect(rowFor('Pepper — saved 2026').textContent).toBe('Pepper — saved 2026›')
    for (const name of ['Pepper — saved 2026', 'Pepper seed packet', 'Pepper sprayer', 'Pepper Mix Heirloom']) {
      expect(rowFor(name).style.minHeight).toBe('44px')
    }
  })

  it('leaves the Varieties group and its door untouched', async () => {
    searchImpl = async () => payload([SEED_PACKET])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper seed packet')).toBeTruthy(), { timeout: 2000 })
    expect(groupOf(rowFor('Pepper Mix Heirloom'))).toBe('Varieties')
    expect(rowFor('Pepper Mix Heirloom').getAttribute('href')).toBe('/varieties/v1/edit')
  })

  // v4.148.0 review M4 — Row is a module-scope component. Declared inside Search() it was a new component
  // type on every render, so every keystroke unmounted and remounted every result row, and with the Seeds
  // group uncapped that is hundreds of rows. A trailing space re-renders Search (the box's value changes)
  // while the trimmed query, and so every result, stays the same.
  it('a result row\'s DOM node survives a re-render that leaves the results unchanged', async () => {
    searchImpl = async () => payload([SEED_PACKET, SPRAYER])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper seed packet')).toBeTruthy(), { timeout: 2000 })
    const packet = rowFor('Pepper seed packet')
    const sprayer = rowFor('Pepper sprayer')
    const variety = rowFor('Pepper Mix Heirloom')
    await type('pepper ')
    expect(screen.getByLabelText('Search your garden').value).toBe('pepper ')
    expect(rowFor('Pepper seed packet')).toBe(packet)
    expect(rowFor('Pepper sprayer')).toBe(sprayer)
    expect(rowFor('Pepper Mix Heirloom')).toBe(variety)
    expect(packet.isConnected).toBe(true)
  })

  // BUG-SEARCHSEEDCAP20-001 — the cap that showed 20 of 94 was the SERVER's (one LIMIT 20 across every
  // inventory category, lambda/dashboard/handlers.js searchInventory). This pins that the page adds no
  // cap of its own and keeps the server's order: 94 is the q=pepper seed count on prod, 2026-09-24.
  it('lists every seed row the server sends under Seeds, in the server\'s order — no cap of its own', async () => {
    const seeds = Array.from({ length: 94 }, (_, i) => ({
      id: `i-seed-${i}`, name: `Pepper packet ${String(i + 1).padStart(3, '0')}`, category: 'seeds', status: 'active', location_text: null,
    }))
    searchImpl = async () => payload([...seeds, SPRAYER])
    renderPage()
    await type('pepper')
    await waitFor(() => expect(screen.queryByText('Pepper sprayer')).toBeTruthy(), { timeout: 2000 })
    const shown = [...document.querySelectorAll('a[href^="/inventory/i-seed-"]')].map((a) => a.getAttribute('href'))
    expect(shown).toEqual(seeds.map((s) => `/inventory/${s.id}`))
    // Either side of the old cut, and the last row, all sit in the Seeds group.
    for (const s of [seeds[0], seeds[19], seeds[20], seeds[93]]) expect(groupOf(rowFor(s.name))).toBe('Seeds')
    expect(groupOf(rowFor('Pepper sprayer'))).toBe('Inventory')
  })
})
