// Put-Up R2a, lane I (the integrator; lane E's item 6, lane P's optional prop) — the page reads the batch names
// ONCE and hands them down. PutUp() calls useBatchNames beside usePantryList and passes `batchNames` to both
// children that name a jar's batch (the Pantry list and the page search's results), so neither reads its own.
//
// BEFORE: each child read the names when it mounted, so a Pantry open, a search, and the Pantry again was three
// reads of GET /api/kitchen-batches?state=all for one visit. NOW: one, for as long as the page is mounted —
// and one more only when a batch id turns up that no read was sent for (useBatchNames' own rule).
// The read is the Pantry's and the search's, nobody else's: Going now (even with the door open, which reads
// the Pantry list for its name search) and Walk a place send none. PutUpUxC.jarBatch.test.jsx's page pin
// ("four reads, never more — and three when no jar has a batch") holds unedited.
// MUTATIONS (each run, each red here):
//   PantrySearchResults not handed batchNames         -> "a search … asks nothing more"
//   PantryView not handed batchNames                  -> "back on the Pantry … asks nothing more"
//   the page's read enabled everywhere                -> "Going now with the door open reads no names"
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { BATCH_NAMES_PATH } from '../lib/pantryApi.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const [CF1, , FRIDGE] = PLACES
const inPlace = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const REAPER = inPlace(FRIDGE, { stock_id: 'jar-reaper', name: 'Megatron reaper', method: 'hot_sauce', count_left: 4, batch_id: 'kb-1' })
const KRAUT = inPlace(FRIDGE, { stock_id: 'jar-kraut', name: 'Kraut', method: 'ferment', count_left: 1, batch_id: 'kb-2' })
const PLAIN = inPlace(CF1, { stock_id: 'jar-plain', name: 'Pesto cubes', method: 'pesto', count_left: 3, batch_id: null })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge' })
const BATCHES = [
  { id: 'kb-1', label: 'Petri Dish', kind: 'ferment', closed_at: '2026-09-11T12:00:00Z' },
  { id: 'kb-2', label: 'Winter kraut', kind: 'ferment', closed_at: null },
]

function wire(rows = [PLAIN, REAPER, KRAUT, MILK]) {
  fake = pantryFetch({ rows, batches: BATCHES })
  stableFetch.fn = fake
}
const namesGets = () => fake.calls('GET').filter(c => c.path === BATCH_NAMES_PATH)
const pantryGets = () => fake.calls('GET').filter(c => c.path.startsWith('/api/pantry?'))
const rowText = (id) => screen.getByTestId(`pantry-row-open-put_up:${id}`).textContent
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const page = (at = '/put-up?view=pantry') => render(<MemoryRouter initialEntries={[at]}><PutUp /></MemoryRouter>)
const search = (text) => fireEvent.change(screen.getByTestId('pantry-search'), { target: { value: text } })

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the page reads the batch names once, for both children', () => {
  it('a Pantry open asks once; a search, and the Pantry again, ask nothing more', async () => {
    page()
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    await settle()
    expect(namesGets()).toHaveLength(1)

    // The page search: its results name the batch from the page's read (the row sheet offers What went in →).
    search('reaper')
    await screen.findByTestId('pantry-search-results')
    await settle()
    expect(namesGets()).toHaveLength(1)
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    expect((await screen.findByTestId('row-what-went-in')).textContent).toBe('What went in →')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())

    // Back on the Pantry: the list mounts again and names its jars at once, from the same read.
    fireEvent.click(screen.getByTestId('pantry-search-clear'))
    await screen.findByTestId('pantry-view')
    expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left')
    expect(rowText('jar-kraut')).toContain('from Winter kraut')
    await settle()
    expect(namesGets()).toHaveLength(1)
  })

  it('no jar with a batch: no names read, on the Pantry or under a search', async () => {
    wire([PLAIN, MILK])
    page()
    await screen.findByTestId('pantry-row-open-put_up:jar-plain')
    search('pesto')
    await screen.findByTestId('pantry-search-hit-put_up:jar-plain')
    await settle()
    expect(namesGets()).toHaveLength(0)
  })

  it('Going now with the door open reads no names, though the door re-reads a list with a new batch in it; the Pantry asks on return', async () => {
    page()
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    await settle()
    expect(namesGets()).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: 'Going now' }))
    await settle()
    // A jar from a batch no read has named: the door's open re-reads the list (its name search reads it).
    // (A new array: the fake answers its own, and the page holds the one the last read answered.)
    fake.state.rows = [...fake.state.rows, inPlace(FRIDGE, { stock_id: 'jar-new', name: 'New kraut', method: 'ferment', count_left: 2, batch_id: 'kb-3' })]
    const before = pantryGets().length
    fireEvent.click(await screen.findByTestId('putup-door'))
    await screen.findByTestId('door-place-id:loc-1')
    await waitFor(() => expect(pantryGets().length).toBeGreaterThan(before))
    await settle()
    expect(namesGets()).toHaveLength(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    // On the Pantry the new batch id is one no read was sent for: ONE more read, by the page.
    fireEvent.click(screen.getByRole('radio', { name: 'Pantry' }))
    await screen.findByTestId('pantry-row-open-put_up:jar-new')
    await settle()
    expect(namesGets()).toHaveLength(2)
  })
})
