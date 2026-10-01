// Put-Up UX pass R1, lane C — the Pantry list and the row sheet's notes (PLAN-V3 D13; findings F22, F25,
// F28; F16 on these files).
//
// WHAT THIS FILE HOLDS:
//   • F22 — grouped By place a row does not repeat the place its heading names; grouped By what it is the
//     place is still said. Decided from the ROW (its group IS its place), so a list being regrouped never
//     drops or doubles the place for a moment;
//   • D13 — a row whose discard date is soon or past sets its discard line on the soon tint; the SENTENCE
//     is unchanged (pinned unedited at Pantry.test.jsx: "discard by Oct 3 · set by hand · soon");
//   • F25 — an empty Pantry offers Put something up and Walk a place, as SECONDARY buttons, only when the
//     page hands them in; neither handed in, it is the one line it always was;
//   • F28 — the row sheet reads a "Next time (2026-09-02): …" line as "Next time: … · Sep 2"; the stored
//     note is untouched (its written shape is pinned unedited in PantryRowSheet.test.jsx);
//   • F16 — the 44 px fields and the quiet Try again on these surfaces are 48.
// MUTATIONS (run, see the lane report): decide the place from the `group` prop -> "being regrouped" reds;
// tint every row -> "a row that is not soon is untouched" reds; pass the click event on -> "with NO
// argument" reds; apply nextTimeWords to the whole note -> "line by line" reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import PantryRowSheet, { notesAsRead } from '../components/pantry/PantryRowSheet.jsx'
import Stepper from '../components/pantry/Stepper.jsx'
import { detailWords, inPlaceGroup, discardChip } from '../components/pantry/pantryRows.js'
import { SOON_CHIP_STYLE } from '../components/putup/soonTint.js'
import { buttonChrome } from '../components/forms/formStyles.js'
import { DOOR_CTA } from '../components/pantry/putSomethingUp.js'
import { WALK_TITLE } from '../components/pantry/WalkPlace.jsx'

const [CF1, , FRIDGE] = PLACES
const NOW = new Date(2026, 9, 1)                      // Oct 1 2026, local
const byPlace = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const byKind = (place, slug, label, o) => jarRow({ place, group_key: slug, group_label: label, crop_type_slug: slug, ...o })
const REAPER = byPlace(FRIDGE, { stock_id: 'jar-reaper', name: 'Megatron reaper', method: 'hot_sauce', count_left: 4, where_from: 'Megatron jalapeño',
  discard: { date: '2027-02-01', basis: 'table', status: 'ok' } })
const SOON = byPlace(FRIDGE, { stock_id: 'jar-soon', name: 'Pesto cubes', method: 'pesto', count_left: 1,
  discard: { date: '2026-10-03', basis: 'typed', status: 'soon' } })
const PAST = byPlace(CF1, { stock_id: 'jar-past', name: 'Old passata', method: 'passata', count_left: 2,
  discard: { date: '2026-09-01', basis: 'table', status: 'past' } })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  acquired_at: '2026-09-18', acquired_precision: 'day', where_from: 'Aldi' })
const SOON_ITEM = itemRow({ stock_id: 'item-soon', name: 'Tofu', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  acquired_at: null, discard: { date: '2026-10-04', basis: 'typed', status: 'soon' } })
const ROWS = [PAST, REAPER, SOON, MILK, SOON_ITEM]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, ...opts })
  stableFetch.fn = fake
}
const host = { setRows: null }
function PantryHost({ rows = ROWS, group = 'place', ...props }) {
  const [list, setList] = useState(rows)
  const [recent, setRecent] = useState({})
  host.setRows = setList
  return (
    <PantryView fetch={stableFetch.fn} group={group} onGroupChange={() => {}} rows={list} loading={false} error={false}
      onReload={() => {}} recent={recent} onRecent={setRecent} now={NOW.getTime()} {...props} />
  )
}
const open = (key) => screen.getByTestId(`pantry-row-open-${key}`)
const chipOf = (key) => screen.getByTestId(`pantry-row-chip-${key}`)
// A style object as React paints it (a hex token is kept as rgb(), a bare number becomes px), so the
// comparison below is of what is painted, not of how it was spelled.
const painted = (el, style) => Object.fromEntries(Object.keys(style).map(k => [k, el.style[k]]))
const asPainted = (style) => {
  const probe = render(<span data-testid="style-probe" style={style} />)
  const out = painted(probe.getByTestId('style-probe'), style)
  probe.unmount()
  return out
}

beforeEach(() => { wire(); localStorage.clear() })

describe('F22 — inside a place group a row does not repeat its place', () => {
  it('pure: the place is left out exactly when the row\'s group IS its place', () => {
    expect(inPlaceGroup(REAPER)).toBe(true)
    expect(detailWords(REAPER, { now: NOW })).toBe('Megatron jalapeño · 4 left')
    const kind = byKind(FRIDGE, 'pepper', 'Peppers', { name: 'Megatron reaper', count_left: 4, where_from: 'Megatron jalapeño' })
    expect(inPlaceGroup(kind)).toBe(false)
    expect(detailWords(kind, { now: NOW })).toBe('Kitchen fridge · Megatron jalapeño · 4 left')
    // No place at all: nothing to repeat and nothing to say.
    const nowhere = jarRow({ place: null, count_left: 2 })
    expect(inPlaceGroup(nowhere)).toBe(false)
    expect(detailWords(nowhere, { now: NOW })).toBe('2 left')
    // A crop slug that happens to equal nothing of the place's is not a place group.
    expect(inPlaceGroup({ group_key: 'loc-3', place: null })).toBe(false)
    expect(inPlaceGroup(null)).toBe(false)
    // A bought item: the same rule, and its age still follows.
    expect(detailWords(MILK, { now: NOW })).toBe('Aldi · had it 13 days')
  })

  it('By place: the heading says the place, the rows under it do not', () => {
    render(<PantryHost />)
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Chest Freezer 1', 'Kitchen fridge'])
    expect(open('put_up:jar-reaper').querySelectorAll('span')[1].textContent).toBe('Megatron jalapeño · 4 left')
    expect(open('put_up:jar-past').querySelectorAll('span')[1].textContent).toBe('2 left')
    expect(open('pantry_item:item-milk').querySelectorAll('span')[1].textContent).toBe('Aldi · had it 13 days')
    for (const r of ROWS) {
      expect(open(`${r.stock_kind}:${r.stock_id}`).textContent).not.toContain(r.place.label)
    }
  })

  it('By what it is: the place is still on the row', () => {
    const rows = [
      byKind(CF1, 'tomato', 'Tomatoes', { stock_id: 'jar-past', name: 'Old passata', count_left: 2 }),
      byKind(FRIDGE, 'pepper', 'Peppers', { stock_id: 'jar-reaper', name: 'Megatron reaper', count_left: 4, where_from: 'Megatron jalapeño' }),
    ]
    render(<PantryHost rows={rows} group="kind" />)
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Tomatoes', 'Peppers'])
    expect(open('put_up:jar-past').querySelectorAll('span')[1].textContent).toBe('Chest Freezer 1 · 2 left')
    expect(open('put_up:jar-reaper').querySelectorAll('span')[1].textContent).toBe('Kitchen fridge · Megatron jalapeño · 4 left')
  })

  it('a list being regrouped (By what it is asked for, the By-place rows still on screen) does not double the place', () => {
    render(<PantryHost group="kind" />)                                    // the rows are still the by-place answer
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Chest Freezer 1', 'Kitchen fridge'])
    expect(open('put_up:jar-reaper').querySelectorAll('span')[1].textContent).toBe('Megatron jalapeño · 4 left')
  })
})

describe('D13 — a soon or past row stands out; its sentence does not change', () => {
  it('a soon row and a past row: the discard line is on the soon tint, the words exactly what they were', () => {
    render(<PantryHost />)
    const want = asPainted(SOON_CHIP_STYLE)
    expect(Object.keys(want).sort()).toEqual(['backgroundColor', 'borderRadius', 'color', 'fontWeight', 'padding'])
    for (const [key, row, words] of [
      ['put_up:jar-soon', SOON, 'discard by Oct 3 · set by hand · soon'],
      ['put_up:jar-past', PAST, 'discard date passed Sep 1 · general figure: passata / sauce, deep freezer'],
      ['pantry_item:item-soon', SOON_ITEM, 'discard by Oct 4 · set by hand · soon'],
    ]) {
      const chip = chipOf(key)
      expect(chip.textContent).toBe(words)
      expect(chip.textContent).toBe(discardChip(row, NOW))                 // the one sentence, from the one helper
      expect(painted(chip, SOON_CHIP_STYLE)).toEqual(want)
      expect(chip.style.background).not.toMatch(/none/)                    // no shorthand fighting the tint
      expect(open(key).contains(chip)).toBe(true)                          // still inside the row's one open target
      expect(open(key).querySelector('button, a')).toBeNull()              // and still nothing nested in it
    }
  })

  it('a row that is not soon is untouched: quiet ink, no tint, normal weight', () => {
    render(<PantryHost />)
    const chip = chipOf('put_up:jar-reaper')
    expect(chip.textContent).toBe('discard by Feb 1, 2027 · general figure: hot sauce, fridge')
    expect(chip.style.backgroundColor).toBe('')
    expect(chip.style.fontWeight).toBe('')
    expect(chip.getAttribute('data-soon')).toBeNull()
    expect(screen.queryByTestId('pantry-row-chip-pantry_item:item-milk')).toBeNull()   // a bought item with no date says nothing
  })
})

describe('F25 — an empty Pantry offers the two ways to fill it', () => {
  const emptyHost = (props) => render(<PantryHost rows={[]} {...props} />)

  it('with nothing handed in it is the one line it always was', () => {
    emptyHost()
    const empty = screen.getByTestId('pantry-empty')
    expect(empty.innerHTML).toBe('Nothing in the pantry yet.')
    expect(empty.querySelector('button')).toBeNull()
  })

  it('handed both: two SECONDARY buttons, in the page\'s own words, each called with NO argument', () => {
    const onPutSomethingUp = vi.fn()
    const onWalkPlace = vi.fn()
    emptyHost({ onPutSomethingUp, onWalkPlace })
    const empty = screen.getByTestId('pantry-empty')
    expect(empty.textContent).toBe('Nothing in the pantry yet.' + 'Put something up' + 'Walk a place')
    const [putUp, walk] = within(empty).getAllByRole('button')
    expect([putUp.textContent, walk.textContent]).toEqual([DOOR_CTA, WALK_TITLE])
    expect([putUp.getAttribute('data-testid'), walk.getAttribute('data-testid')]).toEqual(['pantry-empty-putup', 'pantry-empty-walk'])
    // Secondary: the outline button, not the filled one — and 48 px.
    const secondary = asPainted(buttonChrome('secondary'))
    const primary = asPainted(buttonChrome('primary'))
    for (const b of [putUp, walk]) {
      expect(b.style.backgroundColor).toBe(secondary.backgroundColor)
      expect(b.style.backgroundColor).not.toBe(primary.backgroundColor)
      expect(parseInt(b.style.minHeight, 10)).toBe(48)
    }
    fireEvent.click(putUp)
    fireEvent.click(walk)
    expect(onPutSomethingUp.mock.calls).toEqual([[]])                      // not the click event: its one argument is a NAME
    expect(onWalkPlace.mock.calls).toEqual([[]])
  })

  it('handed one, it offers that one', () => {
    emptyHost({ onWalkPlace: vi.fn() })
    expect(within(screen.getByTestId('pantry-empty')).getAllByRole('button').map(b => b.textContent)).toEqual(['Walk a place'])
  })

  it('"Nothing to use soon right now." is not an empty Pantry: no buttons there', () => {
    render(<PantryHost rows={[REAPER]} useSoonOnly onClearUseSoon={() => {}} onPutSomethingUp={vi.fn()} onWalkPlace={vi.fn()} />)
    const empty = screen.getByTestId('putup-use-soon-empty')
    expect(empty.innerHTML).toBe('Nothing to use soon right now.')
    expect(screen.queryByTestId('pantry-empty')).toBeNull()
  })

  it('a Pantry with rows shows neither button', () => {
    render(<PantryHost onPutSomethingUp={vi.fn()} onWalkPlace={vi.fn()} />)
    expect(screen.queryByTestId('pantry-empty-putup')).toBeNull()
    expect(screen.queryByTestId('pantry-empty-walk')).toBeNull()
  })
})

describe('F28 — the row sheet reads a Next time line as it is said', () => {
  it('pure: line by line; a line of any other shape, and every other line, is as it was written', () => {
    expect(notesAsRead('Next time (2026-09-02): less basil', NOW)).toBe('Next time: less basil · Sep 2')
    expect(notesAsRead('Next time (2025-08-11): more garlic', NOW)).toBe('Next time: more garlic · Aug 11, 2025')
    expect(notesAsRead('First pick of the year.\nNext time (2026-09-02): less basil\nNext time (2026-09-20): more salt', NOW))
      .toBe('First pick of the year.\nNext time: less basil · Sep 2\nNext time: more salt · Sep 20')
    expect(notesAsRead('a\r\nNext time (2026-09-02): b', NOW)).toBe('a\nNext time: b · Sep 2')
    for (const untouched of ['Next time: less basil', 'next time (2026-09-02): lower case', 'Note — Next time (2026-09-02): mid-line',
      'Next time (2026-13-40): not a day', '', '  ']) {
      expect(notesAsRead(untouched, NOW)).toBe(untouched)
    }
    expect(notesAsRead(null, NOW)).toBe('')
  })

  it('a put-up\'s notes, read from its own record', async () => {
    const notes = 'From the first pick.\nNext time (2026-09-02): less basil'
    wire({ overrides: { 'GET /api/preservation/jar-reaper': () => ({ id: 'jar-reaper', label: 'Megatron reaper', method: 'hot_sauce', package_count: 6, notes }) } })
    render(<PantryRowSheet row={REAPER} fetch={stableFetch.fn} onClose={() => {}} now={NOW.getTime()} />)
    const shown = await screen.findByTestId('row-sheet-notes')
    expect(shown.textContent).toBe('From the first pick.\nNext time: less basil · Sep 2')
    expect(shown.style.whiteSpace).toBe('pre-wrap')
    expect(shown.textContent).not.toContain('(2026-09-02)')
  })

  it('a bought item\'s notes pass through the same reading, and a note with no such line is untouched', () => {
    render(<PantryRowSheet row={{ ...MILK, notes: 'the barista one' }} fetch={stableFetch.fn} onClose={() => {}} now={NOW.getTime()} />)
    expect(screen.getByTestId('row-sheet-notes').textContent).toBe('the barista one')
  })
})

describe('F16 — 48 px on these surfaces', () => {
  it('the list\'s Try again, the count field, and a bought item\'s edit fields', () => {
    render(<PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={null} loading={false} error onReload={() => {}} recent={{}} onRecent={() => {}} />)
    expect(parseInt(screen.getByRole('button', { name: 'Try again' }).style.minHeight, 10)).toBe(48)

    render(<Stepper value="2" onChange={() => {}} name="Megatron reaper" idPrefix="t" />)
    expect(parseInt(screen.getByTestId('t-count').style.minHeight, 10)).toBe(48)
    expect(screen.getByTestId('t-minus').style.height).toBe('48px')

    render(<PantryRowSheet row={MILK} fetch={stableFetch.fn} onClose={() => {}} />)
    for (const id of ['row-move', 'row-edit']) expect(parseInt(screen.getByTestId(id).style.minHeight, 10)).toBe(48)
    fireEvent.click(screen.getByTestId('row-edit'))
    for (const id of ['item-edit-name', 'item-edit-acquired', 'item-edit-useby']) {
      expect(parseInt(screen.getByTestId(id).style.minHeight, 10)).toBe(48)
    }
  })
})
