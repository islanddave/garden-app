// Put-Up R2a, lane P — the Pantry's list and its row sheet: the small fixes and the words.
//
// WHAT THIS FILE HOLDS:
//   • the search field's Search key puts the keyboard away (Enter blurs; the text stays);
//   • a FAILED read of the batch names is asked again at the next re-read of the list, and a read that
//     answered is still never repeated;
//   • M6 — a row its own use FINISHED (used up, all of it gone bad, all of it given away) says no "N left"
//     above its done line; a row a use left live still says it; and leftWords, which the name search and
//     the Walk print, is untouched;
//   • M8, the ellipsis rule — "…" opens a step that asks before anything is written, "→" leaves the sheet,
//     a bare label acts at the tap: the row sheet's action list word for word, Remove… inside Edit, and the
//     buttons that DO write (the Move panel's own, the count panel's) bare;
//   • N7 — a put-up's source that is not the garden reads "produce from <name>" in the row sheet;
//   • the Group-by control's two options are the 48 px tap target (SegmentedControl's `touch`);
//   • the optional `batchNames`: handed the names a host already read, the Pantry and the search results read
//     none of their own; left out, each reads them as it did.
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
import PantryRowSheet, { jarRecordWords } from '../components/pantry/PantryRowSheet.jsx'
import PantrySearchResults, { PantrySearchBox } from '../components/pantry/PantrySearch.jsx'
import { MOVE_TITLE } from '../components/putup/MoveJarSheet.jsx'
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

// M8 (UX 3.6 item 3). Testids are unchanged; these are the words.
describe('the row sheet\'s action list — what a label\'s ending says', () => {
  const JarEditor = ({ rec, onCancel }) => (
    <div data-testid="jar-editor"><span>{rec.label}</span><button type="button" onClick={onCancel}>Cancel</button></div>
  )
  function renderSheet(row, props = {}) {
    const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), ...props }
    render(<PantryRowSheet row={row} fetch={stableFetch.fn} JarEditor={JarEditor} now={NOW.getTime()} {...handlers} />)
    return handlers
  }
  const actions = () => [...screen.getByTestId('row-sheet').querySelectorAll('button[data-testid^="row-"]')]
    .map(b => [b.getAttribute('data-testid'), b.textContent])

  it('a put-up with several left: every action that asks first ends in an ellipsis, each door in an arrow', () => {
    renderSheet(REAPER, { onHowItWasMade: vi.fn(), onOpenBatch: vi.fn() })
    expect(actions()).toEqual([
      ['row-move', 'Move it…'], ['row-next', 'Next time…'], ['row-give', 'Gave it away…'], ['row-went-bad', 'Went bad…'],
      ['row-edit', 'Edit…'], ['row-how', 'How it was made →'], ['row-what-went-in', 'What went in →'],
    ])
  })

  it('a put-up with one left: Went bad acts at the tap, so it is the one bare label', () => {
    renderSheet({ ...PLAIN, count_left: 1 })
    expect(actions()).toEqual([
      ['row-move', 'Move it…'], ['row-next', 'Next time…'], ['row-give', 'Gave it away…'], ['row-went-bad', 'Went bad'], ['row-edit', 'Edit…'],
    ])
  })

  it('a bought item: Move it… and Edit…', () => {
    renderSheet(MILK)
    expect(actions()).toEqual([['row-move', 'Move it…'], ['row-edit', 'Edit…']])
  })

  it('the Move panel keeps "Move it" for its name and for its own button: that tap is the one that writes', async () => {
    renderSheet(PLAIN)
    fireEvent.click(screen.getByTestId('row-move'))
    expect(MOVE_TITLE).toBe('Move it')
    expect(screen.getByRole('group', { name: 'Move it' })).toBe(screen.getByTestId('move-panel'))
    expect(screen.getByTestId('move-save').textContent).toBe('Move it')
  })

  it('the count panel\'s filled button is bare: "Gave it away" is the tap that writes', () => {
    renderSheet(PLAIN)
    fireEvent.click(screen.getByTestId('row-give'))
    expect(screen.getByTestId('give-save').textContent).toBe('Gave it away')
  })

  it('inside Edit, Remove… asks first — on a put-up and on a bought item — and its second step is bare', async () => {
    const jar = render(<PantryRowSheet row={PLAIN} fetch={stableFetch.fn} JarEditor={JarEditor} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-edit'))
    expect(screen.getByTestId('jar-edit-remove').textContent).toBe('Remove…')
    fireEvent.click(screen.getByTestId('jar-edit-remove'))
    expect(screen.getByTestId('jar-edit-remove-confirm').textContent).toBe('Yes, remove it')
    expect(fake.calls('DELETE')).toHaveLength(0)
    jar.unmount()

    renderSheet(MILK)
    fireEvent.click(screen.getByTestId('row-edit'))
    expect(screen.getByTestId('item-edit-remove').textContent).toBe('Remove…')
    fireEvent.click(screen.getByTestId('item-edit-remove'))
    expect(screen.getByTestId('item-edit-remove-confirm').textContent).toBe('Yes, remove it')
    expect(fake.calls('DELETE')).toHaveLength(0)
  })
})

// N7 (ΔUX): on a put-up, where-from is where what WENT IN came from. "from Warner Farms" read as where the
// jar came from.
describe('the row sheet\'s record line — a put-up\'s source', () => {
  const rec = (o) => ({ preserved_at: null, preserved_at_precision: null, source_kind: null, source_label: null, ...o })

  it('a source that is not the garden reads "produce from <name>"', () => {
    expect(jarRecordWords(rec({ source_kind: 'farm_stand', source_label: 'Warner Farms' }), NOW)).toBe('produce from Warner Farms')
    expect(jarRecordWords(rec({ source_kind: 'other', source_label: 'Aunt May' }), NOW)).toBe('produce from Aunt May')
  })

  it('with no typed name it reads the kind\'s own word', () => {
    expect(jarRecordWords(rec({ source_kind: 'store' }), NOW)).toBe('produce from Store')
    expect(jarRecordWords(rec({ source_kind: 'gift' }), NOW)).toBe('produce from Gift')
  })

  it('the garden says nothing here, and a planting still reads "from <its name>"', () => {
    expect(jarRecordWords(rec({ source_kind: 'own_garden' }), NOW)).toBe('')
    expect(jarRecordWords(rec({ source_kind: 'own_garden', planting_name: 'Dark Green Zucchini', planting_succession_order: 2 }), NOW))
      .toBe('from Dark Green Zucchini · wave 2')
    expect(jarRecordWords(rec({ planting_name: 'Sungold' }), NOW)).toBe('from Sungold')
  })

  it('on the sheet: the record line of a jar from a farm stand', async () => {
    wire({ overrides: { 'GET /api/preservation/jar-plain': () => ({ id: 'jar-plain', label: 'Pesto cubes', method: 'pesto', package_count: 3,
      quantity_value: null, quantity_unit: null, notes: null, preserved_at: null, plant_id: null, source_kind: 'farm_stand', source_label: 'Warner Farms' }) } })
    render(<PantryRowSheet row={PLAIN} fetch={stableFetch.fn} onClose={() => {}} now={NOW.getTime()} />)
    await waitFor(() => expect(screen.getByTestId('row-sheet-record').textContent).toBe('produce from Warner Farms'))
  })
})

// Put-Up's floor is 48 px. The Group-by control was the one 40 px target left on the Pantry.
describe('the Group-by control', () => {
  it('its two options are the 48 px tap target', () => {
    render(<PantryHost />)
    const radios = [...screen.getByRole('radiogroup', { name: 'Group by' }).querySelectorAll('[role="radio"]')]
    expect(radios.map(r => r.textContent)).toEqual(['By place', 'By what it is'])
    expect(radios.map(r => r.style.minHeight)).toEqual(['48px', '48px'])
  })
})

// The page reads the batch names twice when a search is opened and cleared (the Pantry unmounts while the
// results show, and each side asks). The hoist is the page's; these two take what it reads.
describe('the optional batchNames', () => {
  const NAMES = { 'kb-1': 'Winter kraut' }                        // NOT what the names read would answer ("Petri Dish")
  const results = (props) => (
    <PantrySearchResults query="reaper" rows={ROWS} loading={false} fetch={stableFetch.fn} onPutUp={() => {}} onUsed={() => {}}
      onChanged={() => {}} now={NOW.getTime()} {...props} />
  )

  it('the Pantry, handed the names: it reads none of its own and says the handed name', async () => {
    render(<PantryHost batchNames={NAMES} />)
    await settle()
    expect(rowText('jar-reaper')).toContain('from Winter kraut · 4 left')
    expect(namesGets()).toHaveLength(0)
    // The door to the batch hangs on the same names.
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    expect(await screen.findByTestId('row-sheet')).toBeTruthy()
  })

  it('the Pantry, handed names that do not list a row\'s batch: no words about it, and still no read', async () => {
    render(<PantryHost batchNames={{}} />)
    await settle()
    expect(rowText('jar-reaper')).not.toMatch(/from /)
    expect(namesGets()).toHaveLength(0)
  })

  it('the Pantry, handed nothing: it reads the names itself, as it did', async () => {
    render(<PantryHost />)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    expect(namesGets()).toHaveLength(1)
  })

  it('the search results, handed the names: no read, and What went in → is offered for a batch the names list', async () => {
    render(results({ onOpenBatch: vi.fn(), batchNames: NAMES }))
    await settle()
    expect(namesGets()).toHaveLength(0)
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    expect(await screen.findByTestId('row-what-went-in')).toBeTruthy()
  })

  it('the search results, handed names that do not list the batch: no read and no door', async () => {
    render(results({ onOpenBatch: vi.fn(), batchNames: {} }))
    await settle()
    expect(namesGets()).toHaveLength(0)
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('the search results, handed nothing: they read the names themselves when a batch can be opened, as they did', async () => {
    render(results({ onOpenBatch: vi.fn() }))
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    expect(await screen.findByTestId('row-what-went-in')).toBeTruthy()
  })
})
