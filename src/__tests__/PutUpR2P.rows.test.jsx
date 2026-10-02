// Put-Up R2a, lane P — the Pantry's list and its row sheet: the small fixes and the words.
//
// WHAT THIS FILE HOLDS:
//   • the search field's Search key puts the keyboard away (Enter blurs; the text stays);
//   • a FAILED read of the batch names is asked again at the next re-read of the list, and a read that
//     answered is still never repeated;
//   • M6 — a row its own use FINISHED (used up, all of it gone bad, all of it given away) says no "N left"
//     above its done line; a row a use left live still says it; and leftWords, which the name search and
//     the Walk print, is untouched.
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
import { detailWords, leftWords, discardChip } from '../components/pantry/pantryRows.js'
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

// M6 (UX 3.6 item 4): every use that finishes a row, not Went bad alone. The row stays on screen for its
// Undo, drawn from the snapshot taken BEFORE the use, so what it says is left is stale by exactly that use.
describe('a row its use finished says no "N left" above its done line', () => {
  const rowWords = (key) => screen.getByTestId(`pantry-row-${key}`).textContent
  const openWords = (key) => screen.getByTestId(`pantry-row-open-${key}`).textContent
  const done = (key) => screen.getByTestId(`pantry-row-done-${key}`)
  const chipOf = (row) => discardChip(row, NOW)

  it('Went bad, all of them: the row is its name and its discard line, then "marked gone bad" and Undo', async () => {
    render(<PantryHost rows={[PLAIN]} />)
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + '3 left' + chipOf(PLAIN))
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-plain'))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(done('put_up:jar-plain')).toBeTruthy())
    // The server no longer lists a row with nothing left: it is on screen from the person's own record.
    await act(async () => { host.setRows([]) })
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + chipOf(PLAIN))
    expect(rowWords('put_up:jar-plain')).toBe('Pesto cubes' + chipOf(PLAIN) + 'marked gone bad' + 'Undo')
    expect(rowWords('put_up:jar-plain')).not.toMatch(/\bleft\b/)
  })

  it('Used it up on the last one: no "1 left" above "used it up"', async () => {
    const LAST = { ...PLAIN, count_left: 1 }
    wire({ rows: [LAST] })
    render(<PantryHost rows={[LAST]} />)
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + '1 left' + chipOf(LAST))
    fireEvent.click(screen.getByTestId('pantry-row-action-put_up:jar-plain'))
    await waitFor(() => expect(done('put_up:jar-plain')).toBeTruthy())
    expect(rowWords('put_up:jar-plain')).toBe('Pesto cubes' + chipOf(LAST) + 'used it up' + 'Undo')
  })

  it('Gave it away, all of them: no "2 left" above the done line', async () => {
    const TWO = { ...PLAIN, count_left: 2 }
    wire({ rows: [TWO] })
    render(<PantryHost rows={[TWO]} />)
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-plain'))
    fireEvent.click(await screen.findByTestId('row-give'))
    fireEvent.click(screen.getByTestId('give-plus'))
    fireEvent.click(screen.getByTestId('give-save'))
    await waitFor(() => expect(done('put_up:jar-plain')).toBeTruthy())
    expect(done('put_up:jar-plain').textContent).toBe('0 left · gave some away' + 'Undo')
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + chipOf(TWO))
  })

  it('a finished row keeps the rest of its line: its place under By what it is, and the batch it came from', async () => {
    const byKind = { ...REAPER, group_key: 'pepper', group_label: 'Peppers', count_left: 1 }
    wire({ rows: [byKind] })
    render(<PantryHost rows={[byKind]} />)
    await waitFor(() => expect(openWords('put_up:jar-reaper')).toContain('Kitchen fridge · from Petri Dish · 1 left'))
    fireEvent.click(screen.getByTestId('pantry-row-action-put_up:jar-reaper'))
    await waitFor(() => expect(done('put_up:jar-reaper')).toBeTruthy())
    expect(openWords('put_up:jar-reaper')).toBe('Megatron reaper' + 'Kitchen fridge · from Petri Dish' + chipOf(byKind))
  })

  it('a row a use left LIVE still says what is left: Used one', async () => {
    render(<PantryHost rows={[PLAIN]} />)
    fireEvent.click(screen.getByTestId('pantry-row-action-put_up:jar-plain'))
    await waitFor(() => expect(done('put_up:jar-plain').textContent).toBe('2 left · used one' + 'Undo'))
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + '3 left' + chipOf(PLAIN))
    expect(screen.getByTestId('pantry-row-action-put_up:jar-plain')).toBeTruthy()
  })

  it('a row a use left LIVE still says what is left: a part gone bad', async () => {
    render(<PantryHost rows={[PLAIN]} />)
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-plain'))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(done('put_up:jar-plain').textContent).toBe('1 left · 2 went bad' + 'Undo'))
    expect(openWords('put_up:jar-plain')).toBe('Pesto cubes' + '3 left' + chipOf(PLAIN))
    expect(screen.getByTestId('pantry-row-action-put_up:jar-plain')).toBeTruthy()
  })

  it('a bought item that was used up reads as it did: it never said "left"', async () => {
    render(<PantryHost rows={[MILK]} />)
    const before = openWords('pantry_item:item-milk')
    fireEvent.click(screen.getByTestId('pantry-row-action-pantry_item:item-milk'))
    await waitFor(() => expect(done('pantry_item:item-milk').textContent).toBe('used it up' + 'Undo'))
    expect(openWords('pantry_item:item-milk')).toBe(before)
  })

  it('the rule is the row\'s, never leftWords\': the name search and the Walk still print the count', () => {
    expect(leftWords(PLAIN)).toBe('3 left')
    const byKind = { ...PLAIN, group_key: 'basil', group_label: 'Basil' }
    expect(detailWords(byKind, { now: NOW })).toBe('Chest Freezer 1 · 3 left')
    expect(detailWords(byKind, { now: NOW, finished: false })).toBe('Chest Freezer 1 · 3 left')
    expect(detailWords(byKind, { now: NOW, finished: true })).toBe('Chest Freezer 1')
    const BAG = { ...byKind, stock_mode: 'weighed', count_left: null, grams_left: 92 }
    expect(detailWords(BAG, { now: NOW })).toBe('Chest Freezer 1 · about 92 g left')
    expect(detailWords(BAG, { now: NOW, finished: true })).toBe('Chest Freezer 1')
  })
})
