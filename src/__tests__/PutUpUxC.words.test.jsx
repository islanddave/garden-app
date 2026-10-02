// Put-Up UX pass R1, lane C — the banned-word sweeps of the four surfaces that had none (V4 §3.2): the
// Pantry list, the row sheet with every panel open, Put something up with its options open, and a Walk
// group with its options open. This pass added the most new copy to exactly these.
//
// THE LIST is the one the other nine sweeps use: safe, shelf life, shelf-stable, keeps, good, ready, done,
// expired, table, default, basis — whole words, any case. WHAT IS SWEPT is everything a person can read or
// have read to them: the text, and every aria-label, placeholder, title and alt inside the surface.
// A person's OWN words (a note they typed, a name they gave) are theirs and are not copy: the fixtures here
// hold none of the eleven words, so nothing has to be cut out of the sweep to make it pass.
//
// OUT OF THESE SWEEPS, and said plainly: (1) the jar's Edit panel is the page's RowEditor, in PutUp.jsx,
// frozen in this pass — the row sheet is swept with the panel's own frame around a stand-in editor.
// The Walk's fixed band (outside the group) is swept too: its exit read "Done", a banned word shipped with
// the freezer walk, until the train's render review renamed it "End the walk" (it pairs with "Start the walk").
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import PantryRowSheet, { HOUSE_DETAIL_TEXT, WENT_BAD_PART_REFUSED_TEXT, wentBadCta } from '../components/pantry/PantryRowSheet.jsx'
import PutSomethingUpSheet from '../components/pantry/PutSomethingUpSheet.jsx'
import WalkPlace from '../components/pantry/WalkPlace.jsx'
import { MOVE_RULE_TEXT } from '../components/putup/MoveJarSheet.jsx'
import { BRIDGE_TEXT } from '../components/pantry/pantryBridge.js'
import { afterUseWords, movedWords, USED_ONE, USED_UP } from '../components/pantry/pantryRows.js'
import {
  AS_IS, saveLabel, methodLabel, previewLine, METHOD_REQUIRED_TEXT, WHAT_REQUIRED_TEXT, WHERE_REQUIRED_TEXT, DISCARD_DATE_TEXT,
} from '../components/pantry/putSomethingUp.js'
import { ALL_PUT_UP_METHODS } from '../components/putup/putItUp.js'

const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const READ_ATTRS = ['aria-label', 'placeholder', 'title', 'alt']
// Everything in `root` a person can read or have read to them.
function wordsOf(root) {
  const out = [root.textContent]
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of READ_ATTRS) if (el.hasAttribute?.(a)) out.push(el.getAttribute(a))
  }
  return out.filter(Boolean)
}
// One assertion per string, so a failure names the string.
function expectClean(strings, where) {
  expect(strings.length, `${where}: nothing was swept`).toBeGreaterThan(0)
  for (const s of strings) expect(`${where}: ${s}`).not.toMatch(BANNED)
}

const [CF1, CF2, FRIDGE] = PLACES
const NOW = new Date(2026, 9, 1)
const at = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const REAPER = at(FRIDGE, { stock_id: 'jar-reaper', name: 'Megatron reaper', method: 'hot_sauce', count_left: 4, batch_id: 'kb-1',
  from_garden: true, where_from: 'Megatron jalapeño', discard: { date: '2027-02-01', basis: 'table', status: 'ok' } })
const SOON = at(FRIDGE, { stock_id: 'jar-soon', name: 'Pesto cubes', method: 'pesto', count_left: 1, discard: { date: '2026-10-03', basis: 'typed', status: 'soon' } })
const PAST = at(CF1, { stock_id: 'jar-past', name: 'Old passata', method: 'passata', count_left: 2, discard: { date: '2026-09-01', basis: 'recipe', status: 'past', recipe_name: 'Sunday sauce' } })
const CANDY = at(CF1, { stock_id: 'jar-candy', name: 'Candied ginger', method: 'candy', count_left: 3, discard: { date: '2027-01-01', basis: 'house', status: 'ok' } })
const NO_DATE = at(CF2, { stock_id: 'jar-nodate', name: 'Chili crisp', method: 'other', count_left: 2, discard: { date: null, basis: 'none', status: null } })
const BY_HAND = at(CF2, { stock_id: 'jar-hand', name: 'Kraut', method: 'ferment', count_left: 2, discard: { date: null, basis: 'typed', status: null } })
const BAG = at(CF1, { stock_id: 'jar-bag', name: 'Reaper, frozen', stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 92, method: 'whole_freeze' })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  acquired_at: '2026-09-18', acquired_precision: 'day', where_from: 'Megatron jalapeño', notes: 'the barista one',
  discard: { date: '2026-10-04', basis: 'typed', status: 'soon' } })
const ROWS = [PAST, CANDY, BAG, NO_DATE, BY_HAND, REAPER, SOON, MILK]
const BATCHES = [{ id: 'kb-1', label: 'Petri Dish' }]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, batches: BATCHES, ...opts })
  stableFetch.fn = fake
}
beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('INSTRUMENT — the pattern and the sweep both bite', () => {
  it('the pattern catches each of the eleven, and lets their look-alikes through', () => {
    for (const w of ['safe', 'shelf life', 'shelf-stable', 'keeps', 'good', 'ready', 'done', 'expired', 'table', 'default', 'basis']) {
      expect(`Nothing is ${w} here.`).toMatch(BANNED)
    }
    for (const fine of ['discard by Oct 3 · set by hand · soon', 'general figure: hot sauce, fridge', 'kept', 'tabled', 'Goodness', 'unsafe-ish']) {
      expect(fine).not.toMatch(BANNED)
    }
  })

  it('the sweep reads attributes as well as text', () => {
    const { container } = render(<div><button type="button" aria-label="Done — the walk">x</button><input placeholder="a good name" /></div>)
    const words = wordsOf(container)
    expect(words).toContain('Done — the walk')
    expect(words).toContain('a good name')
    expect(words.some(s => BANNED.test(s))).toBe(true)
  })
})

describe('the Pantry list', () => {
  function Host({ rows = ROWS, recent: initial = {}, ...props }) {
    const [recent, setRecent] = useState(initial)
    return (
      <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={rows} loading={false} error={false}
        onReload={() => {}} recent={recent} onRecent={setRecent} now={NOW.getTime()} {...props} />
    )
  }

  it('every row in every state of its discard line, with the batch named, the bridge, a saved line and the in-place lines', async () => {
    const recent = {
      'put_up:jar-reaper': { row: REAPER, action: 'went_bad', use: { id: 'u1', count_used: 2 }, jar: { remaining_count: 2 } },
      'put_up:jar-candy': { row: CANDY, action: USED_ONE, use: { id: 'u2' }, jar: { remaining_count: 2 } },
      'put_up:jar-past': { row: PAST, action: 'gave_away', use: { id: 'u3' }, jar: { remaining_count: 1 } },
      'put_up:jar-soon': { row: SOON, action: 'went_bad', use: { id: 'u4', count_used: 1 }, jar: { remaining_count: 0 } },
      'pantry_item:item-milk': { row: MILK, action: USED_UP, use: null, jar: null },
    }
    render(<Host recent={recent} showBridge onDismissBridge={() => {}} onOpenBatch={() => {}}
      completion={{ route: 'jar', saved: { id: 'jar-9', label: 'Corn' }, place: CF1, text: 'Corn — put up · Chest Freezer 1 · discard by Oct 1, 2027 · general figure: whole freeze, deep freezer' }}
      onCompletionDone={() => {}} onHowItWasMade={() => {}} />)
    const view = screen.getByTestId('pantry-view')
    await waitFor(() => expect(view.textContent).toContain('from Petri Dish'))
    // The states are really on screen, so the sweep below is of them.
    for (const there of [BRIDGE_TEXT, '2 left · 2 went bad', 'marked gone bad', '2 left · used one', '1 left · gave some away', 'used it up',
      'discard date passed Sep 1 · from the recipe: Sunday sauce', 'house estimate', 'no date — check it before using', 'no date · set by hand',
      'about 92 g left', 'From the garden', 'How it was made →']) {
      expect(view.textContent).toContain(there)
    }
    expectClean(wordsOf(view), 'Pantry list')
  })

  it('a move\'s line, the use-soon filter with its chip, and both empty states with their doors', async () => {
    const moved = render(<Host />)
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    fireEvent.click(await screen.findByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('move-save'))
    expect((await screen.findByTestId('pantry-moved')).textContent).toContain('Megatron reaper — moved to Chest Freezer 1 · no date — check it before using')
    expectClean(wordsOf(screen.getByTestId('pantry-view')), 'Pantry list after a move')
    moved.unmount()

    const soon = render(<Host useSoonOnly onClearUseSoon={() => {}} />)
    expect(screen.getByTestId('putup-use-soon-chip')).toBeTruthy()
    expectClean(wordsOf(screen.getByTestId('pantry-view')), 'Pantry list, Use soon')
    soon.unmount()

    const none = render(<Host rows={[REAPER]} useSoonOnly onClearUseSoon={() => {}} />)
    expect(screen.getByTestId('putup-use-soon-empty')).toBeTruthy()
    expectClean(wordsOf(screen.getByTestId('pantry-view')), 'Pantry list, nothing to use soon')
    none.unmount()

    render(<Host rows={[]} onPutSomethingUp={() => {}} onWalkPlace={() => {}} />)
    expect(within(screen.getByTestId('pantry-empty')).getAllByRole('button')).toHaveLength(2)
    expectClean(wordsOf(screen.getByTestId('pantry-view')), 'Pantry list, empty')
  })

  it('every in-place line and every moved line the list can say, from the helpers that say them', () => {
    const lines = []
    for (const action of [USED_ONE, USED_UP, 'went_bad', 'gave_away']) {
      for (const jar of [null, { remaining_count: 0 }, { remaining_count: 3 }]) {
        for (const use of [null, { count_used: 2 }]) lines.push(afterUseWords({ action, jar, use }))
      }
    }
    for (const row of ROWS) {
      for (const saved of [null, { use_by_target: null, use_by_basis: 'none', use_by_status: null },
        { use_by_target: '2026-10-03', use_by_basis: 'typed', use_by_status: 'use_soon' },
        { use_by_target: '2026-09-01', use_by_basis: 'table', use_by_status: 'past_use_by', method: 'hot_sauce' },
        { use_by_target: '2027-03-01', use_by_basis: 'house', use_by_status: 'ok', method: 'candy' },
        { use_by_target: '2027-03-01', use_by_basis: 'recipe', use_by_status: 'ok' }]) {
        lines.push(movedWords({ row, place: CF2, saved, now: NOW }))
      }
    }
    expect(lines.length).toBeGreaterThan(60)
    expectClean(lines, 'in-place lines')
  })
})

describe('the row sheet, every panel open', () => {
  // The frame of the jar's Edit panel is this lane's; the editor inside it is the page's (see the header).
  const JarEditor = ({ rec, onCancel }) => (
    <div data-testid="jar-editor"><span>{rec.label}</span><button type="button" onClick={onCancel}>Cancel</button></div>
  )
  function openSheet(row, props = {}) {
    return render(<PantryRowSheet row={row} fetch={stableFetch.fn} JarEditor={JarEditor} onClose={() => {}} onUsed={() => {}}
      onChanged={() => {}} onHowItWasMade={() => {}} onOpenBatch={() => {}} now={NOW.getTime()} {...props} />)
  }
  const sheet = () => screen.getByRole('dialog')
  const backToList = async () => {
    fireEvent.click(within(sheet()).getAllByRole('button', { name: 'Cancel' }).at(-1))
    await screen.findByTestId('row-move')
  }

  it('a put-up with several left: the action list, then Move (all three sentences), Next time, Gave it away, Went bad, Edit', async () => {
    wire({ overrides: { 'GET /api/preservation/jar-candy': () => ({ id: 'jar-candy', label: 'Candied ginger', method: 'candy', package_count: 6,
      container_label: '4 oz jar', preserved_at: '2026-08-01', preserved_at_precision: 'month', source_kind: 'farm_stand', source_label: 'Warner Farms',
      planting_name: 'Ginger bed', planting_succession_order: 2, notes: 'First try.\nNext time (2026-09-02): less sugar' }) } })
    openSheet(CANDY)
    await screen.findByTestId('row-sheet-record')
    expect(sheet().textContent).toContain(HOUSE_DETAIL_TEXT)
    expect(sheet().textContent).toContain('Next time: less sugar · Sep 2')
    expect(screen.getByTestId('row-went-bad').textContent).toBe('Went bad…')
    expectClean(wordsOf(sheet()), 'row sheet, action list')

    fireEvent.click(screen.getByTestId('row-move'))
    const seen = new Set()
    for (const place of ['move-place-id:loc-2', 'move-place-id:loc-3']) {
      fireEvent.click(await screen.findByTestId(place))
      seen.add(screen.getByTestId('move-rule').textContent)
      expectClean(wordsOf(sheet()), `row sheet, Move → ${place}`)
    }
    expect([...seen].sort()).toEqual([MOVE_RULE_TEXT.reworked, MOVE_RULE_TEXT.stays].sort())
    fireEvent.click(screen.getByTestId('move-when-earlier'))
    fireEvent.click(await screen.findByTestId('move-when-pickdate'))
    await screen.findByTestId('move-when-date')
    fireEvent.click(screen.getByTestId('move-save'))                        // Earlier with no date picked: the refusal line
    await screen.findByTestId('move-error')
    expectClean(wordsOf(sheet()), 'row sheet, Move, Earlier open')
    fireEvent.click(screen.getByTestId('move-cancel'))

    fireEvent.click(await screen.findByTestId('row-next'))
    fireEvent.click(screen.getByTestId('next-save'))                        // empty: its own refusal line
    await screen.findByTestId('next-error')
    expectClean(wordsOf(sheet()), 'row sheet, Next time')
    await backToList()

    fireEvent.click(screen.getByTestId('row-give'))
    expectClean(wordsOf(sheet()), 'row sheet, Gave it away')
    await backToList()

    fireEvent.click(screen.getByTestId('row-went-bad'))
    expect(screen.getByTestId('went-bad-save').textContent).toBe('All 3 went bad')
    expectClean(wordsOf(sheet()), 'row sheet, Went bad at all')
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    expect(screen.getByTestId('went-bad-save').textContent).toBe('2 went bad')
    expectClean(wordsOf(sheet()), 'row sheet, Went bad at a part')
    await backToList()

    fireEvent.click(screen.getByTestId('row-edit'))
    await screen.findByTestId('jar-editor')
    fireEvent.click(screen.getByTestId('jar-edit-remove'))
    expectClean(wordsOf(sheet()), 'row sheet, Edit with Remove asked')
  })

  it('the third Move sentence, a refused part, a single, a batch jar and a weighed bag', async () => {
    openSheet(REAPER)
    expect(screen.getByTestId('row-what-went-in').textContent).toBe('What went in →')
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    expect(screen.getByTestId('move-rule').textContent).toBe(MOVE_RULE_TEXT.clears)
    expectClean(wordsOf(sheet()), 'row sheet, Move clears')
    cleanup()

    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(400, { error: 'Went bad is all that is left — send all_remaining: true' }) } } })
    openSheet(REAPER)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe(WENT_BAD_PART_REFUSED_TEXT)
    expectClean(wordsOf(sheet()), 'row sheet, a refused part')
    cleanup()

    wire()
    for (const row of [SOON, BAG, NO_DATE, BY_HAND, PAST]) {
      openSheet(row)
      expect(screen.getByTestId('row-went-bad').textContent).toBe(row === SOON || row === BAG ? 'Went bad' : 'Went bad…')
      expectClean(wordsOf(sheet()), `row sheet, ${row.name}`)
      cleanup()
    }
    expectClean([1, 2, 5].flatMap(all => [...Array(all)].map((_, i) => wentBadCta(i + 1, all))), 'Went bad button words')
  })

  it('a bought item: the action list, Move with no When, Edit with Remove asked', async () => {
    openSheet(MILK)
    expectClean(wordsOf(sheet()), 'item sheet, action list')
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    expect(screen.getByTestId('move-rule').textContent).toBe(MOVE_RULE_TEXT.stays)
    expectClean(wordsOf(sheet()), 'item sheet, Move')
    fireEvent.click(screen.getByTestId('move-cancel'))
    fireEvent.click(await screen.findByTestId('row-edit'))
    fireEvent.click(screen.getByTestId('item-edit-remove'))
    expectClean(wordsOf(sheet()), 'item sheet, Edit')
  })
})

describe('Put something up, its options open', () => {
  const LINE_HITS = { plantings: [{ plant_id: 'p-mj', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mj', recent_picks: [] }], put_ups: [] }
  async function openDoor(props = {}) {
    render(<PutSomethingUpSheet open onClose={() => {}} onSaved={() => {}} stockRows={ROWS} onStartBatchInstead={() => {}} now={NOW.getTime()} {...props} />)
    await screen.findByTestId('door-place-id:loc-1')
  }
  const door = () => screen.getByRole('dialog')

  it('at open; every method chip; As is; a put-up with every option, the new-place editor and Earlier… open; each refusal', async () => {
    wire({ lineSearch: LINE_HITS })
    await openDoor()
    expectClean(wordsOf(door()), 'door at open')

    fireEvent.click(screen.getByTestId('door-save'))                        // nothing typed: "What is it?"
    await screen.findByTestId('door-error')
    expectClean(wordsOf(door()), 'door, no name')
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'Mega' } })
    await screen.findByTestId('door-what-hit-planting:p-mj', {}, { timeout: 2000 })   // the matches, a planting among them
    expectClean(wordsOf(door()), 'door, matches showing')
    fireEvent.click(screen.getByTestId('door-save'))                        // no place: "Where does it live?"
    expectClean(wordsOf(door()), 'door, no place')
    fireEvent.click(screen.getByTestId('door-place-new'))
    expectClean(wordsOf(door()), 'door, a new place being named')
    fireEvent.click(screen.getByTestId('door-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('door-save'))                        // no method: the one line
    expect(screen.getByTestId('door-method-required').textContent).toBe(METHOD_REQUIRED_TEXT)
    fireEvent.click(screen.getByTestId('door-method-more'))                 // every method on the row
    expect(within(screen.getByTestId('door-methods')).getAllByRole('radio').length).toBe(ALL_PUT_UP_METHODS.length + 1)
    expectClean(wordsOf(door()), 'door, every method')

    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-preview-change'))
    await screen.findByTestId('door-more-panel')
    fireEvent.click(screen.getByTestId('door-discard-date'))
    expect(screen.getByTestId('door-preview').textContent).toBe('got it today · pick the date from the label')
    fireEvent.click(screen.getByTestId('door-save'))                        // a label date not picked
    expectClean(wordsOf(door()), 'door, As is, options open')

    fireEvent.click(screen.getByTestId('door-method-hot_sauce'))
    fireEvent.click(screen.getByTestId('door-when-earlier'))
    for (const chip of within(screen.getByRole('radiogroup', { name: 'Roughly when?' })).getAllByRole('radio')) {
      fireEvent.click(chip)
      expectClean(wordsOf(door()), `door, a put-up, Earlier → ${chip.textContent}`)
    }
    fireEvent.click(screen.getByTestId('door-when-today'))
    for (const mode of ['door-discard-auto', 'door-discard-none']) {
      fireEvent.click(screen.getByTestId(mode))
      expectClean(wordsOf(door()), `door, a put-up, ${mode}`)
    }
  })

  it('a planting chosen: "Fresh, as picked", and its save line', async () => {
    wire({ lineSearch: LINE_HITS })
    await openDoor()
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'mega' } })
    fireEvent.click(await screen.findByTestId('door-what-hit-planting:p-mj', {}, { timeout: 2000 }))
    fireEvent.click(screen.getByTestId('door-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    expect(screen.getByTestId('door-save').textContent).toBe('Save · fresh')
    expectClean(wordsOf(door()), 'door, a planting')
  })

  it('every word the door can say that depends on the method or the date, from the helpers that say them', () => {
    const typed = { source: 'typed', name: 'Garlic' }
    const said = [METHOD_REQUIRED_TEXT, WHAT_REQUIRED_TEXT, WHERE_REQUIRED_TEXT, DISCARD_DATE_TEXT]
    const whens = [{ date: '2026-10-01', precision: 'day' }, { date: '2026-09-01', precision: 'month' }, { date: '2026-07-01', precision: 'season' },
      { date: '2026-01-01', precision: 'year' }, { date: '2026-10-01', precision: 'unknown' }]
    for (const method of [...ALL_PUT_UP_METHODS, AS_IS]) {
      said.push(saveLabel(method, typed), methodLabel(method, typed))
      for (const place of PLACES) {
        for (const when of whens) {
          for (const discard of [{ mode: 'auto', date: '' }, { mode: 'none', date: '' }, { mode: 'date', date: '2026-12-01' }, { mode: 'date', date: '' }]) {
            for (const flags of [{}, { isRaw: true }, { inOil: true }]) said.push(previewLine({ method, place, when, discard, now: NOW, ...flags }))
          }
        }
      }
    }
    const lines = said.filter(Boolean)
    expect(lines.length).toBeGreaterThan(1000)
    expectClean([...new Set(lines)], 'door and Walk words')
  })
})

describe('a Walk group, its options open', () => {
  async function startWalk(place = 'Kitchen fridge') {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><WalkPlace /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('radio', { name: place }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
  }
  // The group, and the two disclosure lines above it. NOT the fixed band below (see the header).
  const walkWords = () => [
    ...wordsOf(screen.getByTestId('putup-walk-group')),
    ...wordsOf(screen.getByTestId('putup-walk-here-toggle')), ...wordsOf(screen.getByTestId('putup-walk-unrecorded-toggle')),
  ]

  it('at open; a put-up with Raw · In oil, every discard choice and another date open; a bought item; the refusal lines', async () => {
    await startWalk()
    expectClean(walkWords(), 'Walk group at open')
    fireEvent.click(screen.getByTestId('walk-save'))                        // nothing typed
    expectClean(walkWords(), 'Walk group, no name')
    fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: 'Reaper sauce' } })
    fireEvent.click(screen.getByTestId('walk-save'))                        // no method
    expect(screen.getByTestId('walk-error').textContent).toBe(METHOD_REQUIRED_TEXT)
    fireEvent.click(screen.getByTestId('walk-method-more'))
    expectClean(walkWords(), 'Walk group, every method')

    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    fireEvent.click(screen.getByTestId('walk-more'))
    expect(within(screen.getByTestId('walk-more-panel')).getByRole('group', { name: 'Raw or in oil' })).toBeTruthy()
    for (const tap of ['walk-raw', 'walk-inoil', 'walk-discard-date', 'walk-discard-none', 'walk-discard-auto', 'walk-own-pickdate', 'walk-own-unsure']) {
      fireEvent.click(screen.getByTestId(tap))
      expectClean(walkWords(), `Walk group, a put-up, after ${tap}`)
    }
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    expect(screen.getByTestId('walk-preview').textContent).toMatch(/no discard date$/)
    expectClean(walkWords(), 'Walk group, a bought item')
  })

  it('the band\'s exit button is outside the group, says what it does, and the band holds no banned word', async () => {
    await startWalk()
    expect(screen.getByTestId('putup-walk-group').contains(screen.getByTestId('putup-walk-exit'))).toBe(false)
    expect(screen.getByTestId('putup-walk-band').contains(screen.getByTestId('putup-walk-exit'))).toBe(true)
    expect(screen.getByTestId('putup-walk-exit').textContent.trim()).toBe('End the walk')
    expectClean(screen.getByTestId('putup-walk-band').textContent, 'Walk band')
  })
})

// R2 lane Df additions go directly under this line
// R2 lane P additions go directly under this line
