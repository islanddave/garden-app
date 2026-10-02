// Put-Up R2a, lane P — the Pantry's list and its row sheet: the small fixes and the words.
//
// WHAT THIS FILE HOLDS:
//   • the search field's Search key puts the keyboard away (Enter blurs; the text stays);
//   • a FAILED read of the batch names is asked again at the next re-read of the list, and a read that
//     answered is still never repeated.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import { PantrySearchBox } from '../components/pantry/PantrySearch.jsx'
import { BATCH_NAMES_PATH } from '../lib/pantryApi.js'

const [CF1, , FRIDGE] = PLACES
const NOW = new Date(2026, 9, 1)
const inPlace = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const REAPER = inPlace(FRIDGE, { stock_id: 'jar-reaper', name: 'Megatron reaper', method: 'hot_sauce', count_left: 4, batch_id: 'kb-1' })
const PLAIN = inPlace(CF1, { stock_id: 'jar-plain', name: 'Pesto cubes', method: 'pesto', count_left: 3, batch_id: null })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge' })
const BATCHES = [{ id: 'kb-1', label: 'Petri Dish', kind: 'ferment', closed_at: '2026-09-11T12:00:00Z' }]
const ROWS = [PLAIN, REAPER, MILK]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, batches: BATCHES, ...opts })
  stableFetch.fn = fake
}
const namesGets = () => fake.calls('GET').filter(c => c.path === BATCH_NAMES_PATH)
const rowText = (id) => screen.getByTestId(`pantry-row-open-put_up:${id}`).textContent
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const host = { setRows: null }
function PantryHost({ rows = ROWS, ...props }) {
  const [list, setList] = useState(rows)
  const [recent, setRecent] = useState({})
  host.setRows = setList
  return (
    <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={list} loading={false} error={false}
      onReload={() => {}} recent={recent} onRecent={setRecent} now={NOW.getTime()} {...props} />
  )
}

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('the search field', () => {
  function Box({ onChange = () => {} }) {
    const [text, setText] = useState('pesto')
    return <PantrySearchBox value={text} onChange={(v) => { onChange(v); setText(v) }} onClear={() => setText('')} />
  }

  it('Enter blurs the field: the Search key puts the keyboard away, and the text stays', () => {
    const onChange = vi.fn()
    render(<Box onChange={onChange} />)
    const field = screen.getByTestId('pantry-search')
    field.focus()
    expect(document.activeElement).toBe(field)
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter' })
    expect(document.activeElement).not.toBe(field)
    expect(notPrevented).toBe(false)
    expect(field.value).toBe('pesto')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('any other key leaves the field focused', () => {
    render(<Box />)
    const field = screen.getByTestId('pantry-search')
    field.focus()
    for (const key of ['a', ' ', 'Backspace', 'Tab', 'ArrowDown']) fireEvent.keyDown(field, { key })
    expect(document.activeElement).toBe(field)
  })
})

describe('the batch names read', () => {
  it('a failed names read is asked again at the next re-read of the list, and then the row says its batch', async () => {
    let failing = true
    wire({ overrides: { 'GET /api/kitchen-batches': () => {
      if (failing) throw new Error('Failed to fetch')
      return { state: 'all', batches: BATCHES }
    } } })
    render(<PantryHost />)
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    await settle()
    expect(rowText('jar-reaper')).not.toMatch(/from /)
    // A re-render that is not a re-read asks nothing: no storm while the read keeps failing.
    await settle()
    expect(namesGets()).toHaveLength(1)
    // The list is re-read (a use, a move, an edit): the same rows, new objects.
    failing = false
    await act(async () => { host.setRows(ROWS.map(r => ({ ...r }))) })
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    expect(namesGets()).toHaveLength(2)
    // It answered: no further re-read asks again.
    await act(async () => { host.setRows(ROWS.map(r => ({ ...r }))) })
    await settle()
    expect(namesGets()).toHaveLength(2)
  })

  it('a read that keeps failing is asked once per re-read, never more', async () => {
    wire({ overrides: { 'GET /api/kitchen-batches': () => { throw new Error('Failed to fetch') } } })
    render(<PantryHost />)
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    await settle()
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { host.setRows(ROWS.map(r => ({ ...r }))) })
      await settle()
    }
    expect(namesGets()).toHaveLength(4)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
