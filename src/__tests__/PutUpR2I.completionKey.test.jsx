// Put-Up R2a, lane I (the integrator; found by lane K) — the Pantry's completion line is ONE line per save.
//
// THE DEFECT. PantryView mounted CompletionLine with no key, and the line keeps its "undone" state when its
// `completion` prop changes. On the Pantry: Save → Undo → a second Save, without closing the line, showed
// "Undone — <the new item>" with no Undo, and nothing held the page's reload for the new line (an undone
// line holds nothing). The planting page's host already keys its line per save; the Pantry's line is now
// keyed by the save it shows (the host hands in a new `completion` for each).
// THE FLOW IS THE PAGE'S: the real PutUp page, the header's Put something up, the real door, the real line.
// MUTATION: remove the key -> "a second save after an Undo is a new line" reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch } from './helpers/pantryFake.js'

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
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const line = () => screen.queryByTestId('pantry-completion')
const lineText = () => line()?.querySelector('span')?.textContent ?? null
const undo = () => screen.queryByTestId('pantry-completion-undo')

async function openDoor() {
  fireEvent.click(screen.getAllByTestId('putup-door')[0])
  await screen.findByTestId('door-place-id:loc-1')
  await settle()
}
// The door's three answers, then Save; the host closes the door.
async function save(name, place, method) {
  fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: name } })
  fireEvent.click(screen.getByTestId(`door-place-id:${place}`))
  if (!screen.queryByTestId(`door-method-${method}`)) fireEvent.click(screen.getByTestId('door-method-more'))
  fireEvent.click(screen.getByTestId(`door-method-${method}`))
  fireEvent.click(screen.getByTestId('door-save'))
  await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
  await waitFor(() => expect(line()).toBeTruthy())
  await settle()
}

beforeEach(() => {
  fake = pantryFetch()
  stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the Pantry\'s completion line — one line per save', () => {
  it('a second save after an Undo is a new line: its own words, its own Undo, and it holds the reload', async () => {
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByTestId('pantry-view')
    await openDoor()
    await save('Sungold cherry', 'loc-1', 'whole_freeze')
    const first = lineText()
    expect(first).toMatch(/^Sungold cherry — put up/)
    fireEvent.click(undo())
    await waitFor(() => expect(lineText()).toBe(`Undone — ${first}`))
    expect(undo()).toBeNull()
    expect(isReloadBlocked()).toBe(false)                                     // an undone line holds nothing

    await openDoor()
    await save('Oat milk', 'loc-3', 'as_is')
    expect(lineText()).toBe('Oat milk — in the pantry · Kitchen fridge')
    expect(undo()).toBeTruthy()
    expect(isReloadBlocked()).toBe(true)
    // Its Undo undoes the second save, not the first.
    fireEvent.click(undo())
    await waitFor(() => expect(lineText()).toBe('Undone — Oat milk — in the pantry · Kitchen fridge'))
    expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/preservation/jar-new-1', '/api/pantry/items/item-new-2'])
  })

  it('a second save with the first line still showing replaces it: one line, the new one', async () => {
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByTestId('pantry-view')
    await openDoor()
    await save('Sungold cherry', 'loc-1', 'whole_freeze')
    await openDoor()
    await save('Oat milk', 'loc-3', 'as_is')
    expect(screen.getAllByTestId('pantry-completion')).toHaveLength(1)
    expect(lineText()).toBe('Oat milk — in the pantry · Kitchen fridge')
    expect(undo()).toBeTruthy()
  })
})
