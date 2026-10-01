// Put-Up UX pass R1, lane C — "Move it" (PLAN-V3 D4): a panel inside the row sheet that says what the move
// will do to THIS jar's discard date before Save, and one in-place line afterwards built from the row the
// server answered.
//
// WHAT THIS FILE HOLDS:
//   • the rule line is the SERVER's rule: moveRule agrees with lambda/preservation/jarRoutes.js moveUseBy
//     on every stored basis × kind pair (a client sentence that drifts from the server's rule is a false
//     statement on the only guard a move has — a cleared date has no Undo);
//   • it reads the STORED basis, never the display fallback (a candied row written before a basis was stored
//     reads "house estimate" on the Pantry and still keeps its date on a move);
//   • nothing is said until a destination is tapped, and nothing at all for a jar with no date;
//   • the helper fake answers a move in the server's own row shape, for the three cases the line is built on;
//   • the line at the top of the Pantry is built from that answer, not from the hint.
// The popstate half (Back in the panel) is in PutUpUxC.back.test.jsx; the Sheet-site freeze, the a11y gate
// and the required-input census are amended where they live.
// MUTATIONS (run, see the lane report): read the effective basis -> "the STORED basis" reds; build the line
// from the row instead of the answer -> "a worked-out date at another kind of place" reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'
import { moveUseBy } from '../../lambda/preservation/jarRoutes.js'
import { projectRow } from '../../lambda/preservation/jarRules.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import { moveRule, MOVE_RULE_TEXT, MOVE_TITLE } from '../components/putup/MoveJarSheet.jsx'
import PantryRowSheet from '../components/pantry/PantryRowSheet.jsx'
import PantryView from '../components/pantry/PantryView.jsx'
import { movedWords, discardChip } from '../components/pantry/pantryRows.js'

const [CF1, CF2, FRIDGE] = PLACES                     // deep_freezer, deep_freezer, fridge
const NOW = new Date(2026, 9, 1)                      // Oct 1 2026, local
// Far dates: the answered row's status is the server's own classification against the real clock.
const at = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const TABLE = at(FRIDGE, { stock_id: 'jar-t', name: 'Megatron reaper', method: 'hot_sauce', discard: { date: '2031-02-01', basis: 'table', status: 'ok' } })
const TYPED = at(FRIDGE, { stock_id: 'jar-y', name: 'Pesto cubes', method: 'pesto', discard: { date: '2031-03-01', basis: 'typed', status: 'ok' } })
const RECIPE = at(FRIDGE, { stock_id: 'jar-r', name: 'Petri Dish sauce', method: 'hot_sauce', discard: { date: '2031-04-01', basis: 'recipe', status: 'ok' } })
const HOUSE = at(CF1, { stock_id: 'jar-h', name: 'Candied ginger', method: 'candy', discard: { date: '2031-05-01', basis: 'house', status: 'ok' } })
const LEGACY_CANDY = at(CF1, { stock_id: 'jar-l', name: 'Candied peel', method: 'candy', discard: { date: '2031-06-01', basis: null, status: 'ok' } })
const NO_DATE = at(FRIDGE, { stock_id: 'jar-n', name: 'Chili crisp', method: 'other', discard: { date: null, basis: 'none', status: null } })
const FROZEN = at(CF1, { stock_id: 'jar-f', name: 'Blueberries', method: 'whole_freeze', discard: { date: '2031-07-01', basis: 'table', status: 'ok' } })
const MILK = itemRow({ stock_id: 'item-m', name: 'Oat milk', place: FRIDGE })
const DATED_ITEM = itemRow({ stock_id: 'item-d', name: 'Tofu', place: FRIDGE, discard: { date: '2031-08-01', basis: 'typed', status: 'ok' } })
const ROWS = [TABLE, TYPED, RECIPE, HOUSE, LEGACY_CANDY, NO_DATE, FROZEN, MILK, DATED_ITEM]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, ...opts })
  stableFetch.fn = fake
}
function renderSheet(row, props = {}) {
  const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), onMoved: vi.fn(), ...props }
  const view = render(<PantryRowSheet row={row} fetch={stableFetch.fn} {...handlers} />)
  return { ...view, ...handlers }
}
async function openMove(row, props) {
  const r = renderSheet(row, props)
  fireEvent.click(screen.getByTestId('row-move'))
  await screen.findAllByTestId(/^move-place-/)                             // the places have loaded
  return r
}
const rule = () => screen.getByTestId('move-rule')
const moves = () => fake.calls('POST').filter(c => /\/move$/.test(c.path))

beforeEach(() => { wire(); localStorage.clear() })

describe('the three sentences', () => {
  it('are these, exactly', () => {
    expect(MOVE_RULE_TEXT).toEqual({
      stays: 'Its discard date stays.',
      clears: 'Its discard date was worked out for where it is now, so it clears with this move. You can set a new one after.',
      reworked: 'Its discard date is worked out again from the day it moves.',
    })
    expect(MOVE_TITLE).toBe('Move it')
  })
})

describe('moveRule is the server\'s move rule', () => {
  const KINDS = [null, 'fridge', 'deep_freezer', 'fridge_freezer', 'pantry', 'cold_storage', 'other']
  const BASES = [null, 'typed', 'table', 'recipe', 'house', 'none']
  // What lambda/preservation/jarRoutes.js moveUseBy does to a stored date, in the client's three words.
  const serverSays = (basis, from, to) => {
    const { useBy } = moveUseBy({ storage_kind: from, use_by_basis: basis, method: 'candy' }, to, '2026-10-01')
    if (useBy == null) return 'stays'
    return basis === 'house' ? 'reworked' : 'clears'
  }

  it('agrees with jarRoutes.moveUseBy on every stored basis and every pair of place kinds', () => {
    let pairs = 0
    for (const basis of BASES) {
      for (const from of KINDS) {
        for (const to of KINDS.filter(k => k != null)) {
          expect(`${basis} ${from}→${to}: ${moveRule({ date: '2031-01-01', basis, fromKind: from, toKind: to })}`)
            .toBe(`${basis} ${from}→${to}: ${serverSays(basis, from, to)}`)
          pairs += 1
        }
      }
    }
    expect(pairs).toBe(6 * 7 * 6)
    // The instrument reads all three answers off the server, or the loop above proved one case 252 times.
    expect(new Set(BASES.flatMap(b => KINDS.map(f => serverSays(b, f, 'fridge'))))).toEqual(new Set(['stays', 'clears', 'reworked']))
  })

  it('a cleared date really is cleared, and a house date really is worked out again, on the server', () => {
    expect(moveUseBy({ storage_kind: 'fridge', use_by_basis: 'table', method: 'hot_sauce' }, 'deep_freezer', '2026-10-01').useBy)
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
    expect(moveUseBy({ storage_kind: 'fridge', use_by_basis: 'recipe', method: 'hot_sauce' }, 'deep_freezer', '2026-10-01').useBy)
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
    expect(moveUseBy({ storage_kind: 'deep_freezer', use_by_basis: 'house', method: 'candy' }, 'fridge', '2026-10-01').useBy.use_by_basis).toBe('house')
  })

  it('says nothing for a jar with no discard date, whatever its basis and wherever it goes', () => {
    for (const basis of BASES) {
      for (const to of KINDS) expect(moveRule({ date: null, basis, fromKind: 'fridge', toKind: to })).toBeNull()
    }
    expect(moveRule()).toBeNull()
  })

  it('reads the STORED basis: a candied row written before a basis was stored keeps its date', () => {
    // The Pantry SAYS "house estimate" for it (pantryRows.effectiveBasis, a display fallback) …
    expect(discardChip(LEGACY_CANDY, NOW)).toBe('discard by Jun 1, 2031 · house estimate')
    // … and the server treats a NULL basis as typed: never re-derived, never cleared.
    expect(moveRule({ date: '2031-06-01', basis: null, fromKind: 'deep_freezer', toKind: 'fridge' })).toBe('stays')
    expect(moveUseBy({ storage_kind: 'deep_freezer', use_by_basis: null, method: 'candy' }, 'fridge', '2026-10-01').useBy).toBeNull()
  })
})

describe('the panel, inside the row sheet', () => {
  it('is a panel of the row sheet (one dialog), says nothing until a place is tapped, and Save reads Move it', async () => {
    await openMove(TABLE)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Megatron reaper' }).contains(screen.getByTestId('move-panel'))).toBe(true)
    expect(screen.getByRole('group', { name: 'Move it' })).toBe(screen.getByTestId('move-panel'))
    expect(rule().getAttribute('role')).toBe('status')
    expect(rule().textContent).toBe('')
    expect(screen.getByTestId('move-save').textContent).toBe('Move it')
    expect(screen.queryByTestId('move-place-id:loc-3')).toBeNull()         // where it already is
    expect(screen.queryByTestId('row-move')).toBeNull()                    // the panel replaced the action list
  })

  // [what, the row, the place tapped, the sentence, Save's words]
  it.each([
    ['a worked-out date, another kind of place', TABLE, 'id:loc-1', MOVE_RULE_TEXT.clears, 'Move to Chest Freezer 1'],
    ['a recipe date, another kind of place', RECIPE, 'id:loc-1', MOVE_RULE_TEXT.clears, 'Move to Chest Freezer 1'],
    ['a typed date, another kind of place', TYPED, 'id:loc-2', MOVE_RULE_TEXT.stays, 'Move to Chest Freezer 2'],
    ['a worked-out date, the same kind of place', FROZEN, 'id:loc-2', MOVE_RULE_TEXT.stays, 'Move to Chest Freezer 2'],
    ['a house estimate, another kind of place', HOUSE, 'id:loc-3', MOVE_RULE_TEXT.reworked, 'Move to Kitchen fridge'],
    ['a house estimate, the same kind of place', HOUSE, 'id:loc-2', MOVE_RULE_TEXT.stays, 'Move to Chest Freezer 2'],
    ['a candied row with no stored basis, another kind', LEGACY_CANDY, 'id:loc-3', MOVE_RULE_TEXT.stays, 'Move to Kitchen fridge'],
    ['no discard date', NO_DATE, 'id:loc-1', '', 'Move to Chest Freezer 1'],
    ['a worked-out date, a place not made yet', TABLE, 'new:pantry:pantry shelf', MOVE_RULE_TEXT.clears, 'Move to Pantry shelf'],
  ])('%s', async (_, row, place, sentence, saveWords) => {
    await openMove(row)
    fireEvent.click(screen.getByTestId(`move-place-${place}`))
    expect(rule().textContent).toBe(sentence)
    expect(screen.getByTestId('move-save').textContent).toBe(saveWords)
    expect(moves()).toEqual([])                                            // a tap on a place writes nothing
  })

  it('the line follows the place: the same kind stays, another kind clears', async () => {
    await openMove(FROZEN)
    fireEvent.click(screen.getByTestId('move-place-id:loc-2'))
    expect(rule().textContent).toBe('Its discard date stays.')
    fireEvent.click(screen.getByTestId('move-place-id:loc-3'))
    expect(rule().textContent).toBe(MOVE_RULE_TEXT.clears)
    expect(screen.getByTestId('move-save').textContent).toBe('Move to Kitchen fridge')
  })

  it('Cancel returns to the action list with nothing written; the sheet stays open', async () => {
    const { onClose, onChanged } = await openMove(TABLE)
    fireEvent.click(screen.getByTestId('move-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('move-cancel'))
    expect(screen.queryByTestId('move-panel')).toBeNull()
    expect(screen.getByTestId('row-move')).toBeTruthy()
    expect(moves()).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a bought item: no When; a typed date stays, and with no date there is no line', async () => {
    const dated = await openMove(DATED_ITEM)
    expect(screen.queryByTestId('move-when-today')).toBeNull()
    fireEvent.click(screen.getByTestId('move-place-id:loc-1'))
    expect(rule().textContent).toBe('Its discard date stays.')
    dated.unmount()
    await openMove(MILK)
    fireEvent.click(screen.getByTestId('move-place-id:loc-1'))
    expect(rule().textContent).toBe('')
  })

  it('a refused move keeps the panel, the place and the reason', async () => {
    wire({ overrides: { 'POST /api/preservation/*': () => { throw Object.assign(new Error('409'), { status: 409, body: { code: 'client_stale', error: 'stale' } }) } } })
    const { onMoved, onClose } = await openMove(TABLE)
    fireEvent.click(screen.getByTestId('move-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('move-save'))
    expect((await screen.findByTestId('move-error')).textContent).toMatch(/out of date/)
    expect(screen.getByTestId('move-place-id:loc-1').getAttribute('aria-checked')).toBe('true')
    expect(onMoved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the helper fake answers a move in the server\'s own row shape', () => {
  const post = (id, place) => fake(`/api/preservation/${id}/move`, { method: 'POST', body: JSON.stringify({ place, when: { date: '2026-10-01', precision: 'day' } }) })
  const KEYS = Object.keys(projectRow({})).sort()

  it('a worked-out date at another kind of place comes back with NO date', async () => {
    const r = await post('jar-t', { id: 'loc-1' })
    expect(Object.keys(r).sort()).toEqual(KEYS)
    expect(r).toMatchObject({ id: 'jar-t', label: 'Megatron reaper', method: 'hot_sauce', storage_location_id: 'loc-1', use_by_target: null, use_by_basis: 'none' })
    expect(r.storage_moved_at).not.toBeNull()
  })
  it('a typed date stays', async () => {
    const r = await post('jar-y', { id: 'loc-1' })
    expect(Object.keys(r).sort()).toEqual(KEYS)
    expect(r).toMatchObject({ storage_location_id: 'loc-1', use_by_target: '2031-03-01', use_by_basis: 'typed' })
  })
  it('a move within one kind keeps the date, and stamps no move', async () => {
    const r = await post('jar-f', { id: 'loc-2' })
    expect(Object.keys(r).sort()).toEqual(KEYS)
    expect(r).toMatchObject({ storage_location_id: 'loc-2', use_by_target: '2031-07-01', use_by_basis: 'table', storage_moved_at: null })
  })
  it('a house estimate is worked out again from the move day, and a place not made yet gets an id', async () => {
    const r = await post('jar-h', { kind: 'fridge', label: 'Garage fridge' })
    expect(r.use_by_basis).toBe('house')
    expect(r.use_by_target).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r.use_by_target).not.toBe('2031-05-01')
    expect(r.storage_location_id).toMatch(/^loc-new-\d+$/)
  })
  it('a jar the fake does not list answers { id }, as it always did', async () => {
    expect(await post('jar-unknown', { id: 'loc-1' })).toEqual({ id: 'jar-unknown' })
  })
})

describe('after the move — one line at the top of the Pantry, from the row the server answered', () => {
  function PantryHost({ onReload }) {
    const [recent, setRecent] = useState({})
    return (
      <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={ROWS} loading={false} error={false}
        onReload={onReload} recent={recent} onRecent={setRecent} now={NOW.getTime()} />
    )
  }
  async function moveOnPantry(row, place) {
    const onReload = vi.fn()
    render(<PantryHost onReload={onReload} />)
    expect(screen.queryByTestId('pantry-moved')).toBeNull()
    fireEvent.click(screen.getByTestId(`pantry-row-open-${row.stock_kind}:${row.stock_id}`))
    fireEvent.click(await screen.findByTestId('row-move'))
    fireEvent.click(await screen.findByTestId(`move-place-${place}`))
    fireEvent.click(screen.getByTestId('move-save'))
    const line = await screen.findByTestId('pantry-moved')
    return { line, onReload }
  }
  const words = (line) => line.querySelector('span').textContent

  it('a worked-out date at another kind of place: the line says the date is gone — the server\'s words, not the hint\'s', async () => {
    const { line, onReload } = await moveOnPantry(TABLE, 'id:loc-1')
    expect(words(line)).toBe('Megatron reaper — moved to Chest Freezer 1 · no date — check it before using')
    expect(line.getAttribute('role')).toBe('status')
    expect(screen.queryByTestId('row-sheet')).toBeNull()                   // the row sheet closed with the move
    expect(onReload).toHaveBeenCalled()
    expect(moves().map(c => [c.path, c.body.place])).toEqual([['/api/preservation/jar-t/move', { id: 'loc-1' }]])
    // The line is the first thing in the Pantry, above the grouping control.
    expect(screen.getByTestId('pantry-view').firstElementChild).toBe(line)
  })

  it('a typed date stays', async () => {
    const { line } = await moveOnPantry(TYPED, 'id:loc-1')
    expect(words(line)).toBe('Pesto cubes — moved to Chest Freezer 1 · discard by Mar 1, 2031 · set by hand')
  })

  // The row that moved may be a screen or more down the list, and it leaves its place when the list is
  // re-read: a line at the top that nobody is looking at says nothing. (Found on the 426×836 render: the
  // line was 900 px above the picture.)
  it('the line is brought into view when it appears, and not again for a re-render', async () => {
    const seen = []
    const had = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Element.prototype.scrollIntoView = function scrollIntoView(arg) { seen.push([this.getAttribute('data-testid'), arg]) }
    // WHEN it scrolls: inside an animation frame, never in the commit that shows the line (the row sheet has
    // just closed, and a browser restoring the page's scroll as the sheet's Back entry is popped must be
    // finished first). MUTATION: scroll in the effect itself -> `inFrame` is [false] and this reds.
    expect(typeof requestAnimationFrame).toBe('function')
    const realFrame = requestAnimationFrame
    let inside = false
    const inFrame = []
    const scrolled = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function scrollIntoView(arg) { inFrame.push(inside); return scrolled.call(this, arg) }
    vi.stubGlobal('requestAnimationFrame', (cb) => realFrame((t) => { inside = true; try { cb(t) } finally { inside = false } }))
    try {
      const { line } = await moveOnPantry(TYPED, 'id:loc-1')
      await waitFor(() => expect(seen).toEqual([['pantry-moved', { block: 'center' }]]))   // a frame after it appears
      expect(inFrame).toEqual([true])
      fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-t'))      // any re-render of the list
      await new Promise(r => setTimeout(r, 50))
      expect(seen).toHaveLength(1)
      expect(line.isConnected).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      if (had) Object.defineProperty(Element.prototype, 'scrollIntoView', had)
      else delete Element.prototype.scrollIntoView
    }
  })

  it('a move within one kind keeps the date and its basis words', async () => {
    const { line } = await moveOnPantry(FROZEN, 'id:loc-2')
    expect(words(line)).toBe('Blueberries — moved to Chest Freezer 2 · discard by Jul 1, 2031 · general figure: whole freeze, deep freezer')
  })

  it('a house estimate is worked out again: the line carries the NEW date, from the answer', async () => {
    const { line } = await moveOnPantry(HOUSE, 'id:loc-3')
    expect(words(line)).toMatch(/^Candied ginger — moved to Kitchen fridge · discard by .+ · house estimate$/)
    expect(words(line)).not.toContain('May 1, 2031')
  })

  it('a bought item: where it went, and its typed date when it has one', async () => {
    const plain = await moveOnPantry(MILK, 'id:loc-1')
    expect(words(plain.line)).toBe('Oat milk — moved to Chest Freezer 1')
    expect(fake.calls('PATCH').map(c => [c.path, c.body])).toEqual([['/api/pantry/items/item-m', { storage_location_id: 'loc-1' }]])
  })

  it('× closes the line; the next move replaces it', async () => {
    const { line } = await moveOnPantry(TYPED, 'id:loc-1')
    fireEvent.click(within(line).getByRole('button', { name: 'Close — the moved line' }))
    expect(screen.queryByTestId('pantry-moved')).toBeNull()
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-f'))
    fireEvent.click(await screen.findByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-2'))
    fireEvent.click(screen.getByTestId('move-save'))
    await waitFor(() => expect(screen.getByTestId('pantry-moved').textContent).toContain('Blueberries — moved to Chest Freezer 2'))
    expect(screen.getAllByTestId('pantry-moved')).toHaveLength(1)
  })
})

describe('movedWords, pure', () => {
  const place = { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
  it('carries the answer\'s status words, and the recipe\'s name when the date stayed', () => {
    expect(movedWords({ row: TYPED, place, saved: { use_by_target: '2026-10-03', use_by_basis: 'typed', use_by_status: 'use_soon' }, now: NOW }))
      .toBe('Pesto cubes — moved to Chest Freezer 1 · discard by Oct 3 · set by hand · soon')
    expect(movedWords({ row: TYPED, place, saved: { use_by_target: '2026-09-01', use_by_basis: 'typed', use_by_status: 'past_use_by' }, now: NOW }))
      .toBe('Pesto cubes — moved to Chest Freezer 1 · discard date passed Sep 1 · set by hand')
    const named = { ...RECIPE, discard: { ...RECIPE.discard, recipe_name: 'Petri Dish' } }
    expect(movedWords({ row: named, place: FRIDGE, saved: { use_by_target: '2031-04-01', use_by_basis: 'recipe', use_by_status: 'ok' }, now: NOW }))
      .toBe('Petri Dish sauce — moved to Kitchen fridge · discard by Apr 1, 2031 · from the recipe: Petri Dish')
  })
  it('an answer that is not a row leaves the name and the place; a missing place leaves the name', () => {
    expect(movedWords({ row: TABLE, place, saved: null, now: NOW })).toBe('Megatron reaper — moved to Chest Freezer 1')
    expect(movedWords({ row: TABLE, place, saved: { id: 'jar-t' }, now: NOW })).toBe('Megatron reaper — moved to Chest Freezer 1')
    expect(movedWords({ row: TABLE, place: null, saved: null, now: NOW })).toBe('Megatron reaper — moved')
  })
  it('a bought item keeps its typed date (a move never touches it), from the answer when it carries one', () => {
    expect(movedWords({ row: DATED_ITEM, place, saved: { id: 'item-d', storage_location_id: 'loc-1' }, now: NOW }))
      .toBe('Tofu — moved to Chest Freezer 1 · discard by Aug 1, 2031 · set by hand')
    expect(movedWords({ row: DATED_ITEM, place, saved: { id: 'item-d', use_by_target: null }, now: NOW })).toBe('Tofu — moved to Chest Freezer 1')
    expect(movedWords({ row: MILK, place, saved: { id: 'item-m', use_by_target: '2031-09-01' }, now: NOW }))
      .toBe('Oat milk — moved to Chest Freezer 1 · discard by Sep 1, 2031 · set by hand')
  })
})
