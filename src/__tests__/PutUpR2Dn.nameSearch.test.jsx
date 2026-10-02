// Put-Up R2a, lane Dn — the name search ("What is it?", NameSearchField.jsx): PLAN-R2-V2 "Name search (A4)",
// amendments C3, C6, D9, rulings Dn-1 and Dn-2.
//
// WHAT THIS FILE HOLDS:
//   • TWO PATHS. An answer with `hits` is walked in the server's order and never re-sorted (the answers here
//     are built by the Lambda's own rankHits, and one is deliberately out of rank); an answer with no `hits`
//     still lists its plantings, then what we have, as it always did.
//   • A STOCK HIT KEEPS ITS PLACE. A put-up or pantry-item hit IS the host's Pantry row with that id when the
//     host holds one ("already here", "That's this one → move it here"); `stockRows` null uses the server's
//     hits. One jar is one line, under the host row's test id.
//   • CROP AND VARIETY HITS: their words, their test ids, the What a pick gives and what a save then sends.
//   • SAME-NAMED PLANTINGS read as different lines (wave and sown date), an answer without the two fields says
//     the name alone, and the sown day is the one `sown_at` names in New York and in UTC alike.
//   • A TYPED NAME carries the crop the answer resolved for the text on screen, and no other.
//   • SIX ROWS, then "More matches…".
//   • THE PICKED STATE: the name stays an editable field and keeps its hit; one line says what it is tied to;
//     "Search again" drops the hit; the wave and sown words are the field's own, never the What's.
//   • the banned-word sweep of the match list and the picked block.
// The body a save sends is built by the door's own jarBody / itemBody (putSomethingUp.js) from the What this
// field hands its host. The same answers through the real door and the real Walk are under this lane's
// anchors in PutUpUxC.door.test.jsx, PutUpUxC.walk.test.jsx and PutUpWalk.test.jsx.
// MUTATIONS (run, see the lane report): each test names the rule it holds; the report lists mutation → test.
// CI LANE: `npm test` plus the blocking TZ re-run (the sown-date tests are the reason). No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import NameSearchField, {
  MAX_MATCH_ROWS, MORE_MATCHES_TEXT, SEARCH_AGAIN_TEXT, sownDayWords, sharedPlantingNames, plantingHitName, plantingHitLine, tiedWords,
} from '../components/pantry/NameSearchField.jsx'
import { jarBody, itemBody, isPlantingHit } from '../components/pantry/putSomethingUp.js'
import { rankHits, resolvedCropOf } from '../../lambda/preservation/lineSearch.js'
import { jarRow, itemRow } from './helpers/pantryFake.js'

const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const READ_ATTRS = ['aria-label', 'placeholder', 'title', 'alt']
function wordsOf(root) {
  const out = [root.textContent]
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of READ_ATTRS) if (el.hasAttribute?.(a)) out.push(el.getAttribute(a))
  }
  return out.filter(Boolean)
}
function expectClean(strings, where) {
  expect(strings.length, `${where}: nothing was swept`).toBeGreaterThan(0)
  for (const s of strings) expect(`${where}: ${s}`).not.toMatch(BANNED)
}

// ── the answers, in the server's own shapes ─────────────────────────────────────────────────────────
const planting = (o = {}) => ({
  plant_id: 'p-1', label: 'Blueberries', crop_type_slug: 'blueberry', variety_id: 'v-blue', variety_name: 'Bluecrop', status: 'growing',
  ended: false, recent_at: '2026-05-01T00:00:00.000Z', recent_picks: [], succession_order: null, sown_at: null, ...o,
})
const jar = (o = {}) => ({
  preservation_log_id: 'jar-1', label: 'Blueberry jam', method: 'jam', crop_type_slug: 'blueberry', variety_id: null, quantity_value: null,
  quantity_unit: null, package_count: 6, remaining_count: 4, remaining_amount: null, stock_mode: 'counted', crop_name: 'Blueberry',
  recent_at: '2026-08-01T00:00:00.000Z', suggested_form: null, ...o,
})
const item = (o = {}) => ({
  pantry_item_id: 'item-1', label: 'Blue cheese', crop_type_slug: null, plant_id: null, place_label: 'Kitchen fridge',
  recent_at: '2026-09-18T00:00:00.000Z', ...o,
})
const crop = (o = {}) => ({ crop_type_slug: 'blueberry', label: 'Blueberry', ...o })
const variety = (o = {}) => ({ variety_id: 'v-blue', label: 'Bluecrop', crop_type_slug: 'blueberry', ...o })

// What GET /api/kitchen-batches/line-search answers for `q` over these arms: the Lambda's own ranking and
// its own resolved crop, so the field is read against the shape the server builds, not a hand-drawn one.
function answerFor(q, arms = {}) {
  const all = { plantings: [], put_ups: [], pantry_items: [], crops: [], varieties: [], ...arms }
  return { ...all, hits: rankHits(q, all), resolved_crop: resolvedCropOf(q, all.varieties) }
}
// An older Lambda's answer (or a stand-in's): the two arms, no `hits`.
const armsOnly = (arms = {}) => ({ plantings: [], put_ups: [], ...arms })

// ── the host: holds the What, as the door and the Walk do ───────────────────────────────────────────
const WHEN = { date: '2026-10-01', precision: 'day' }
const FRIDGE = { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' }
const FREEZER = { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const sentAsJar = (what) => jarBody({ key: 'K', what, storageLocationId: 'loc-3', method: 'hot_sauce', when: WHEN, count: 1, discard: { mode: 'auto', date: '' } })
const sentAsItem = (what) => itemBody({ key: 'K', what, place: FRIDGE, when: WHEN, discard: { mode: 'auto', date: '' } })

function Host({ initial, seen, ...props }) {
  const [what, setWhat] = useState(initial)
  return <NameSearchField value={what} onChange={v => { seen.push(v); setWhat(v) }} idPrefix="t" {...props} />
}
// `answer`: what the search answers — an object, or (q) => object | Promise.
function mount({ answer = armsOnly(), initial = null, ...props } = {}) {
  const seen = []
  const fetch = vi.fn(async (url) => {
    const q = decodeURIComponent(String(url).split('?q=')[1] ?? '')
    return typeof answer === 'function' ? answer(q) : answer
  })
  const view = render(<Host initial={initial} seen={seen} fetch={fetch} {...props} />)
  return { ...view, seen, fetch, what: () => (seen.length ? seen.at(-1) : initial) }
}
// The debounce, then the answer.
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}
async function type(v) {
  fireEvent.change(screen.getByTestId('t-name'), { target: { value: v } })
  await settle()
}
const list = () => screen.queryByRole('list')
const rowButtons = () => (list() ? [...list().querySelectorAll('button')] : [])
const rowIds = () => rowButtons().map(b => b.getAttribute('data-testid'))
const rowWords = () => rowButtons().map(b => b.textContent)
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const tie = () => screen.queryByTestId('t-tie')?.textContent ?? null

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('INSTRUMENT — the answers here are the server\'s, and the settle really waits for one', () => {
  it('rankHits ranks these arms as V4 says: exact, starts, contains; live, ended, what we have, then the catalog', () => {
    const a = answerFor('blue', {
      plantings: [planting({ plant_id: 'p-old', label: 'Blueberries 2024', ended: true }), planting({ plant_id: 'p-live', label: 'Blueberries' })],
      put_ups: [jar()], pantry_items: [item()], crops: [crop()], varieties: [variety()],
    })
    // (Within "what we have" the newer one first: the item came in on Sep 18, the jar was put up Aug 1.)
    expect(a.hits.map(h => h.key)).toEqual(['planting:p-live', 'planting:p-old', 'pantry:item-1', 'jar:jar-1', 'crop:blueberry', 'variety:v-blue'])
    expect(a.hits.every(h => h.tier === 'starts')).toBe(true)
  })

  it('nothing is listed before the debounce has run and the answer is in', async () => {
    const { fetch } = mount({ answer: answerFor('blue', { plantings: [planting()] }) })
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'blue' } })
    expect(fetch).not.toHaveBeenCalled()
    expect(list()).toBeNull()
    await settle()
    expect(fetch.mock.calls.map(c => c[0])).toEqual(['/api/kitchen-batches/line-search?q=blue'])
    expect(rowIds()).toEqual(['t-hit-planting:p-1'])
  })
})

describe('two paths — the server\'s `hits`, or the arms of an answer without them', () => {
  it('the rows are in the server\'s order', async () => {
    // (1) The Lambda's ranking, every kind in it.
    const a = answerFor('blue', {
      plantings: [planting({ plant_id: 'p-old', label: 'Blueberries 2024', ended: true }), planting({ plant_id: 'p-live', label: 'Blueberries' })],
      put_ups: [jar()], pantry_items: [item()], crops: [crop()], varieties: [variety()],
    })
    mount({ answer: a })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-live', 't-hit-planting:p-old', 't-hit-pantry_item:item-1', 't-hit-put_up:jar-1',
      't-hit-crop:blueberry', 't-hit-variety:v-blue'])
    cleanup()
    // (2) The same hits handed over OUT of rank (and out of the alphabet): the field prints the order it was
    // given. It holds no ranking of its own to "fix" one with.
    const shuffled = [a.hits[4], a.hits[3], a.hits[1], a.hits[5], a.hits[2], a.hits[0]]
    mount({ answer: { ...a, hits: shuffled } })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-crop:blueberry', 't-hit-put_up:jar-1', 't-hit-planting:p-old', 't-hit-variety:v-blue',
      't-hit-pantry_item:item-1', 't-hit-planting:p-live'])
  })

  it('an answer with no `hits` still lists its plantings', async () => {
    mount({ answer: armsOnly({ plantings: [planting({ plant_id: 'p-a' }), planting({ plant_id: 'p-b', label: 'Blue corn' })], put_ups: [jar()] }) })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-a', 't-hit-planting:p-b', 't-hit-put_up:jar-1'])
    expect(rowWords()).toEqual(['Blueberries · planting', 'Blue corn · planting', 'Blueberry jam'])
  })

  it('an answer with no `hits`, the host holding Pantry rows: the plantings, then the HOST\'s rows by name, never the answer\'s put-ups as well', async () => {
    const HOSTED = jarRow({ stock_id: 'jar-h', name: 'Blueberries, frozen', place: FREEZER, count_left: 3 })
    mount({ answer: armsOnly({ plantings: [planting()], put_ups: [jar({ preservation_log_id: 'jar-h', label: 'Blueberries, frozen' })] }), stockRows: [HOSTED] })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-1', 't-hit-put_up:jar-h'])
    expect(rowWords()[1]).toBe('Blueberries, frozen · Chest Freezer 1 · 3 left')
  })

  it('an empty `hits` is the ranked path, empty: no row is made up from the arms beside it', async () => {
    mount({ answer: { plantings: [planting()], put_ups: [jar()], pantry_items: [], crops: [], varieties: [], hits: [], resolved_crop: null } })
    await type('blue')
    expect(list()).toBeNull()
  })

  it('a hit sent twice is one row, where it first stood', async () => {
    const a = answerFor('blue', { plantings: [planting()], put_ups: [jar()], crops: [crop()] })
    mount({ answer: { ...a, hits: [...a.hits, ...a.hits] } })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-1', 't-hit-put_up:jar-1', 't-hit-crop:blueberry'])
  })

  it('a hit of a kind the field does not know, or with no id, is not a row', async () => {
    const a = answerFor('blue', { plantings: [planting()] })
    mount({ answer: { ...a, hits: [{ kind: 'recipe', key: 'recipe:r1', label: 'Blue sauce' }, { kind: 'put_up', key: 'jar:x', label: 'No id' }, ...a.hits, null] } })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-1'])
  })
})

describe('a stock hit keeps its place — the host\'s Pantry row, when it holds one', () => {
  const HERE = jarRow({ stock_id: 'jar-here', name: 'Blueberries', place: FREEZER, group_key: 'loc-1', group_label: 'Chest Freezer 1', count_left: 4 })
  const THERE = jarRow({ stock_id: 'jar-there', name: 'Blueberry jam', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge', count_left: 2 })
  const ITEM_THERE = itemRow({ stock_id: 'item-there', name: 'Blue cheese', place: FRIDGE })
  const ANSWER = answerFor('blue', {
    put_ups: [jar({ preservation_log_id: 'jar-here', label: 'Blueberries' }), jar({ preservation_log_id: 'jar-there', label: 'Blueberry jam' })],
    pantry_items: [item({ pantry_item_id: 'item-there', label: 'Blue cheese' })],
  })

  it('one jar is one line', async () => {
    mount({ answer: ANSWER, stockRows: [HERE, THERE, ITEM_THERE] })
    await type('blue')
    // Three things we have, three rows: each under the HOST row's key (put_up:<id>, never the server's jar:<id>).
    expect(rowIds().sort()).toEqual(['t-hit-pantry_item:item-there', 't-hit-put_up:jar-here', 't-hit-put_up:jar-there'])
    expect(screen.getAllByTestId('t-hit-put_up:jar-here')).toHaveLength(1)
    expect(document.querySelector('[data-testid^="t-hit-jar:"], [data-testid^="t-hit-pantry:"]')).toBeNull()
    // … and the line is the host row's: its place and what is left, which the server's hit does not carry.
    expect(screen.getByTestId('t-hit-put_up:jar-here').textContent).toBe('Blueberries · Chest Freezer 1 · 4 left')
    expect(screen.getByTestId('t-hit-pantry_item:item-there').textContent).toBe('Blue cheese · Kitchen fridge')
  })

  it('in a Walk, a ranked match at this place reads "already here" and opens that row — nothing is picked', async () => {
    const onOpenExisting = vi.fn()
    const { seen } = mount({ answer: ANSWER, stockRows: [HERE, THERE], placeId: 'loc-1', onOpenExisting, onMoveHere: vi.fn() })
    await type('blue')
    const hit = screen.getByTestId('t-hit-put_up:jar-here')
    expect(hit.textContent).toBe('Blueberries · already here · 4 left')
    const before = seen.length
    fireEvent.click(hit)
    expect(onOpenExisting).toHaveBeenCalledTimes(1)
    expect(onOpenExisting.mock.calls[0][0]).toBe(HERE)                     // the host's own row, place and all
    expect(seen).toHaveLength(before)                                      // the What did not change
  })

  it('in a Walk, a ranked match at another place reads "That\'s this one → move it here" and is handed over to be moved', async () => {
    const onMoveHere = vi.fn()
    const { seen } = mount({ answer: ANSWER, stockRows: [HERE, THERE, ITEM_THERE], placeId: 'loc-1', onOpenExisting: vi.fn(), onMoveHere })
    await type('blue')
    const hit = screen.getByTestId('t-hit-put_up:jar-there')
    expect(hit.textContent).toBe("Blueberry jam · in Kitchen fridge — That's this one → move it here")
    const before = seen.length
    fireEvent.click(hit)
    fireEvent.click(screen.getByTestId('t-hit-pantry_item:item-there'))
    expect(onMoveHere.mock.calls.map(c => c[0])).toEqual([THERE, ITEM_THERE])
    expect(seen).toHaveLength(before)
  })

  it('`stockRows` null uses the server\'s stock hits, and a pick fills the name and the crop', async () => {
    const { what } = mount({ answer: ANSWER, stockRows: null })
    await type('blue')
    expect(rowIds().sort()).toEqual(['t-hit-pantry_item:item-there', 't-hit-put_up:jar-here', 't-hit-put_up:jar-there'])
    expect(screen.getByTestId('t-hit-put_up:jar-there').textContent).toBe('Blueberry jam')
    tap('t-hit-put_up:jar-there')
    expect(what()).toEqual({ source: 'put_up', name: 'Blueberry jam', crop_type_slug: 'blueberry', variety_id: null })
    expect(tie()).toBeNull()                                               // a put-up ties the name to nothing
    expect(screen.getByTestId('t-change').textContent).toBe('Search again')
  })

  it('a stock hit the host does not hold is the server\'s, beside the ones it does', async () => {
    mount({ answer: ANSWER, stockRows: [HERE], placeId: 'loc-1', onOpenExisting: vi.fn(), onMoveHere: vi.fn() })
    await type('blue')
    expect(screen.getByTestId('t-hit-put_up:jar-here').textContent).toBe('Blueberries · already here · 4 left')
    expect(screen.getByTestId('t-hit-put_up:jar-there').textContent).toBe('Blueberry jam')
    expect(screen.getByTestId('t-hit-pantry_item:item-there').textContent).toBe('Blue cheese')
  })
})

describe('crop and variety hits', () => {
  const ANSWER = answerFor('pe', {
    crops: [crop({ crop_type_slug: 'pepper', label: 'Pepper' })],
    varieties: [variety({ variety_id: 'v-rc', label: 'Peter pepper', crop_type_slug: 'pepper' })],
  })

  it('read "Pepper · crop" and "Peter pepper · variety", under their own test ids', async () => {
    mount({ answer: ANSWER })
    await type('pe')
    expect(rowIds()).toEqual(['t-hit-crop:pepper', 't-hit-variety:v-rc'])
    expect(rowWords()).toEqual(['Pepper · crop', 'Peter pepper · variety'])
  })

  it('a crop hit gives the What its crop, and a save sends it', async () => {
    const { what } = mount({ answer: ANSWER })
    await type('pe')
    tap('t-hit-crop:pepper')
    expect(what()).toEqual({ source: 'crop', name: 'Pepper', crop_type_slug: 'pepper' })
    expect(isPlantingHit(what())).toBe(false)
    const sent = sentAsJar(what())
    expect(sent).toMatchObject({ label: 'Pepper', crop_type_slug: 'pepper' })
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining(['variety_id']))
    expect('plant_id' in sent || 'source_kind' in sent).toBe(false)
    expect(sentAsItem(what())).toMatchObject({ name: 'Pepper', crop_type_slug: 'pepper' })
    expect(tie()).toBe('crop: Pepper')
  })

  it('a variety hit gives the What its variety and its crop, and a save sends both', async () => {
    const { what } = mount({ answer: ANSWER })
    await type('pe')
    tap('t-hit-variety:v-rc')
    expect(what()).toEqual({ source: 'variety', name: 'Peter pepper', variety_id: 'v-rc', crop_type_slug: 'pepper' })
    expect(sentAsJar(what())).toMatchObject({ label: 'Peter pepper', variety_id: 'v-rc', crop_type_slug: 'pepper' })
    expect('plant_id' in sentAsJar(what())).toBe(false)
    expect(sentAsItem(what())).toMatchObject({ name: 'Peter pepper', crop_type_slug: 'pepper' })
    expect(tie()).toBe('variety: Peter pepper')
  })
})

describe('planting hits — the name, then "planting"; same-named ones told apart', () => {
  const ZUKE = (o) => planting({ label: 'Dark Green Zucchini', crop_type_slug: 'zucchini', variety_id: 'v-dgz', variety_name: 'Dark Green', ...o })
  const WAVES = [
    ZUKE({ plant_id: 'p-w1', succession_order: 1, sown_at: '2026-04-10', recent_at: '2026-04-10T00:00:00.000Z' }),
    ZUKE({ plant_id: 'p-w2', succession_order: 2, sown_at: '2026-05-08T00:00:00.000Z', recent_at: '2026-05-08T00:00:00.000Z' }),
    ZUKE({ plant_id: 'p-w3', succession_order: 3, sown_at: '2026-06-05T00:00:00.000Z', recent_at: '2026-06-05T00:00:00.000Z', ended: true }),
  ]

  it('three plantings with one name read as three different lines', async () => {
    mount({ answer: answerFor('zucc', { plantings: [...WAVES, planting({ plant_id: 'p-gold', label: 'Golden zucchini' })] }) })
    await type('zucc')
    const words = Object.fromEntries(rowButtons().map(b => [b.getAttribute('data-testid'), b.textContent]))
    expect(words).toEqual({
      't-hit-planting:p-w1': 'Dark Green Zucchini — wave 1, sown Apr 10 · planting',
      't-hit-planting:p-w2': 'Dark Green Zucchini — wave 2, sown May 8 · planting',
      't-hit-planting:p-w3': 'Dark Green Zucchini — wave 3, sown Jun 5 · planting, ended',
      't-hit-planting:p-gold': 'Golden zucchini · planting',          // a name nobody shares says nothing more
    })
    expect(new Set(Object.values(words)).size).toBe(4)
  })

  it('the shared name is matched trimmed and case-folded; a hit carrying one of the two fields says that one', () => {
    const shared = sharedPlantingNames([{ label: ' dark green zucchini ' }, { label: 'Dark Green Zucchini' }, { label: 'Golden zucchini' }, { label: null }, { label: '' }])
    expect([...shared]).toEqual(['dark green zucchini'])
    expect(plantingHitName({ label: 'Dark Green Zucchini', succession_order: 2, sown_at: null }, shared)).toBe('Dark Green Zucchini — wave 2')
    expect(plantingHitName({ label: 'Dark Green Zucchini', succession_order: null, sown_at: '2026-04-10' }, shared)).toBe('Dark Green Zucchini — sown Apr 10')
    expect(plantingHitName({ label: 'Golden zucchini', succession_order: 2, sown_at: '2026-04-10' }, shared)).toBe('Golden zucchini')
    expect(plantingHitLine({ label: 'Dark Green Zucchini', ended: true }, null)).toBe('Dark Green Zucchini · planting, ended')
    expect(plantingHitLine({ label: '  ' }, null)).toBe('A planting · planting')
  })

  it('an arm without the two fields prints the name alone', async () => {
    // An older Lambda (a forward undo under a cached bundle), a stand-in: same-named plantings, neither field sent.
    const bare = (p) => { const c = { ...p }; delete c.succession_order; delete c.sown_at; return c }
    mount({ answer: armsOnly({ plantings: WAVES.map(bare) }) })
    await type('zucc')
    expect(rowWords()).toEqual(['Dark Green Zucchini · planting', 'Dark Green Zucchini · planting', 'Dark Green Zucchini · planting, ended'])
    cleanup()
    // … and the ranked path, the two fields null or not a wave / a day at all.
    const odd = [ZUKE({ plant_id: 'p-a' }), ZUKE({ plant_id: 'p-b', succession_order: undefined, sown_at: undefined }),
      ZUKE({ plant_id: 'p-c', succession_order: 'second', sown_at: 'spring' }), ZUKE({ plant_id: 'p-d', succession_order: '', sown_at: '2026-02-31' })]
    mount({ answer: answerFor('zucc', { plantings: odd }) })
    await type('zucc')
    expect(rowWords()).toEqual(Array(4).fill('Dark Green Zucchini · planting'))
    expect(document.body.textContent).not.toMatch(/undefined|null|NaN|Invalid|—/)
  })

  it('the sown date reads the same in New York and UTC: the day `sown_at` names, date-only or a midnight-UTC timestamp', () => {
    // A Date read in the device's zone prints 2026-04-10 (and midnight UTC of it) as "Apr 9" in New York.
    expect(sownDayWords('2026-04-10')).toBe('Apr 10')
    expect(sownDayWords('2026-04-10T00:00:00.000Z')).toBe('Apr 10')
    expect(sownDayWords('2026-04-10T00:00:00Z')).toBe('Apr 10')
    expect(sownDayWords('2026-01-01T00:00:00.000Z')).toBe('Jan 1')         // … and never the year before's last day
    expect(sownDayWords('2026-12-31')).toBe('Dec 31')
    // Not a day: no words (never "Invalid Date", never a rolled-over one).
    for (const bad of [null, undefined, '', 'spring', '2026-04', '2026-13-01', '2026-02-31', 20260410]) expect(sownDayWords(bad)).toBeNull()
  })

  it('the same holds on the line itself, for both shapes of `sown_at`', async () => {
    mount({ answer: answerFor('zucc', { plantings: [
      ZUKE({ plant_id: 'p-date', succession_order: 1, sown_at: '2026-04-10' }),
      ZUKE({ plant_id: 'p-stamp', succession_order: 2, sown_at: '2026-04-10T00:00:00.000Z' }),
    ] }) })
    await type('zucc')
    expect(screen.getByTestId('t-hit-planting:p-date').textContent).toBe('Dark Green Zucchini — wave 1, sown Apr 10 · planting')
    expect(screen.getByTestId('t-hit-planting:p-stamp').textContent).toBe('Dark Green Zucchini — wave 2, sown Apr 10 · planting')
  })

  it('a pick fills the planting, crop and variety; the name is the planting\'s own, the wave words stay on the line under it', async () => {
    const { what } = mount({ answer: answerFor('zucc', { plantings: WAVES }) })
    await type('zucc')
    tap('t-hit-planting:p-w2')
    expect(what()).toEqual({ source: 'planting', name: 'Dark Green Zucchini', plant_id: 'p-w2', crop_type_slug: 'zucchini', variety_id: 'v-dgz' })
    expect(screen.getByTestId('t-name').value).toBe('Dark Green Zucchini')
    expect(tie()).toBe('from your planting: Dark Green Zucchini — wave 2, sown May 8')
  })
})

describe('a typed name\'s crop is the one the answer resolved for the text on screen', () => {
  const VARIETIES = [variety({ variety_id: 'v-rc', label: 'Ristra Cayenne', crop_type_slug: 'capsicum_annuum' })]
  const answer = (q) => answerFor(q, { varieties: VARIETIES.filter(v => v.label.toLowerCase().includes(q.toLowerCase())) })

  it('the crop sent belongs to the name on screen', async () => {
    const { what, seen } = mount({ answer })
    await type('Ristra Cayenne')
    expect(what()).toEqual({ source: 'typed', name: 'Ristra Cayenne', crop_type_slug: 'capsicum_annuum' })
    expect(sentAsJar(what()).crop_type_slug).toBe('capsicum_annuum')
    expect(sentAsItem(what()).crop_type_slug).toBe('capsicum_annuum')
    // One more letter: the crop is gone AT ONCE, before any answer — it was resolved for other text.
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Ristra Cayenne jam' } })
    expect(what()).toEqual({ source: 'typed', name: 'Ristra Cayenne jam' })
    expect('crop_type_slug' in sentAsJar(what())).toBe(false)
    await settle()                                                         // … and the next answer resolves none
    expect(what()).toEqual({ source: 'typed', name: 'Ristra Cayenne jam' })
    expect('crop_type_slug' in sentAsJar(what())).toBe(false)
    expect('crop_type_slug' in sentAsItem(what())).toBe(false)
    // Back to the variety's exact name: resolved again, by the answer for THAT text.
    await type('ristra cayenne')
    expect(what()).toEqual({ source: 'typed', name: 'ristra cayenne', crop_type_slug: 'capsicum_annuum' })
    expect(seen.filter(w => w.source !== 'typed')).toEqual([])             // never anything but a typed What
  })

  it('an answer that resolves no crop changes nothing, and is not told to the host', async () => {
    const { seen } = mount({ answer })
    await type('Ristra')
    expect(seen).toEqual([{ source: 'typed', name: 'Ristra' }])            // the keystroke, and nothing after it
  })

  it('an answer that comes back after the name moved on never puts its crop on it', async () => {
    let release
    const held = new Promise(r => { release = r })
    const { what } = mount({ answer: (q) => (q === 'Ristra Cayenne' ? held.then(() => answer(q)) : answer(q)) })
    await type('Ristra Cayenne')                                           // asked; the answer is held
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'R' } })   // too short to search for
    await act(async () => { release(); for (let i = 0; i < 6; i++) await Promise.resolve() })
    expect(what()).toEqual({ source: 'typed', name: 'R' })
    expect(list()).toBeNull()                                              // nor does it paint its matches
  })

  it('a slug is never printed: the crop is said under the name only when the answer carried its label', async () => {
    mount({ answer })
    await type('Ristra Cayenne')
    expect(tie()).toBeNull()                                               // resolved, but no label came with it
    expect(document.body.textContent).not.toContain('capsicum_annuum')
    cleanup()
    const withLabel = (q) => ({ ...answer(q), crops: [crop({ crop_type_slug: 'capsicum_annuum', label: 'Pepper' })] })
    mount({ answer: withLabel })
    await type('Ristra Cayenne')
    expect(tie()).toBe('crop: Pepper')
    expect(screen.queryByTestId('t-picked')).toBeNull()                    // a typed name is not a picked one
    expect(screen.getByTestId('t-name').getAttribute('aria-describedby')).toBe(screen.getByTestId('t-tie').id)
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Ristra Cayenne x' } })
    expect(tie()).toBeNull()                                               // the line goes with the crop
  })

  it('a typed What that arrives with a crop (a restored draft) keeps it only if the answer for its name resolves it', async () => {
    const { what } = mount({ answer, initial: { source: 'typed', name: 'Ristra Cayenne mash', crop_type_slug: 'capsicum_annuum' } })
    await settle()
    expect(what()).toEqual({ source: 'typed', name: 'Ristra Cayenne mash' })
  })
})

describe(`at most ${MAX_MATCH_ROWS} rows, then "More matches…"`, () => {
  const many = (n) => Array.from({ length: n }, (_, i) => crop({ crop_type_slug: `bean-${i + 1}`, label: `Bean ${String(i + 1).padStart(2, '0')}` }))

  it('seven matches: six rows and More matches…', async () => {
    const a = answerFor('bean', { crops: many(7) })
    mount({ answer: a })
    await type('bean')
    expect(MAX_MATCH_ROWS).toBe(6)
    // The first six, in the server's order, then the one row that shows the rest.
    expect(rowIds()).toEqual([...a.hits.slice(0, 6).map(h => `t-hit-${h.key}`), 't-more'])
    const more = screen.getByTestId('t-more')
    expect(more.textContent).toBe('More matches…')
    expect(MORE_MATCHES_TEXT).toBe('More matches…')
    expect(parseInt(more.style.minHeight, 10)).toBe(48)
    fireEvent.click(more)
    expect(rowIds()).toEqual(a.hits.map(h => `t-hit-${h.key}`))            // all seven, the same order, and the row is gone
    expect(document.activeElement).toBe(screen.getByTestId('t-hit-crop:bean-7'))   // focus on the first row it revealed
  })

  it('six matches are six rows, with nothing more to show', async () => {
    mount({ answer: answerFor('bean', { crops: many(6) }) })
    await type('bean')
    expect(rowIds()).toHaveLength(6)
    expect(screen.queryByTestId('t-more')).toBeNull()
  })

  it('the rest is shown for THIS text only: a new search starts at six again', async () => {
    mount({ answer: (q) => answerFor(q, { crops: many(9) }) })
    await type('bean')
    tap('t-more')
    expect(rowIds()).toHaveLength(9)
    await type('bean 0')
    expect(rowIds()).toHaveLength(7)
    expect(rowIds().at(-1)).toBe('t-more')
  })

  it('holds on an answer with no `hits` too: plantings first, then what we have', async () => {
    const plantings = Array.from({ length: 5 }, (_, i) => planting({ plant_id: `p-${i + 1}`, label: `Blue ${i + 1}` }))
    mount({ answer: armsOnly({ plantings, put_ups: [jar({ preservation_log_id: 'j-1' }), jar({ preservation_log_id: 'j-2' }), jar({ preservation_log_id: 'j-3' })] }) })
    await type('blue')
    expect(rowIds()).toEqual(['t-hit-planting:p-1', 't-hit-planting:p-2', 't-hit-planting:p-3', 't-hit-planting:p-4', 't-hit-planting:p-5',
      't-hit-put_up:j-1', 't-more'])
    tap('t-more')
    expect(rowIds().slice(6)).toEqual(['t-hit-put_up:j-2', 't-hit-put_up:j-3'])
  })
})

describe('the picked state — the name stays a field, and keeps its hit', () => {
  const PLANT = planting({ plant_id: 'p-mj', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mj', variety_name: 'Megatron' })
  const ANSWER = answerFor('mega', { plantings: [PLANT] })
  const PICKED = { source: 'planting', name: 'Megatron jalapeño', plant_id: 'p-mj', crop_type_slug: 'pepper', variety_id: 'v-mj' }

  it('after a pick the name is still the input, the field has let go of the keyboard, and one line says what it is tied to', async () => {
    const { what } = mount({ answer: ANSWER })
    const input = screen.getByTestId('t-name')
    input.focus()
    await type('mega')
    expect(document.activeElement).toBe(input)
    tap('t-hit-planting:p-mj')
    expect(what()).toEqual(PICKED)
    expect(screen.getByTestId('t-name')).toBe(input)                       // the same node: never unmounted
    expect(input.value).toBe('Megatron jalapeño')
    expect(input.disabled).toBe(false)
    expect(document.activeElement).not.toBe(input)                         // blurred on the pick
    expect(list()).toBeNull()
    const block = screen.getByTestId('t-picked')
    expect(block.textContent).toBe('from your planting: Megatron jalapeñoSearch again')
    expect(tie()).toBe('from your planting: Megatron jalapeño')
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByTestId('t-tie').id)
    const again = screen.getByTestId('t-change')
    expect(again.textContent).toBe('Search again')
    expect(SEARCH_AGAIN_TEXT).toBe('Search again')
    expect(parseInt(again.style.minHeight, 10)).toBe(48)
    expect(block.contains(again)).toBe(true)
    // The words this replaces are gone.
    expect(document.body.textContent).not.toMatch(/· from your planting|Change/)
  })

  it('the edited name keeps plant_id, crop and variety', async () => {
    const { what, fetch } = mount({ answer: ANSWER })
    await type('mega')
    tap('t-hit-planting:p-mj')
    const asked = fetch.mock.calls.length
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Megatron, the red ones' } })
    expect(what()).toEqual({ ...PICKED, name: 'Megatron, the red ones' })
    expect(isPlantingHit(what())).toBe(true)
    expect(sentAsJar(what())).toMatchObject({ label: 'Megatron, the red ones', plant_id: 'p-mj', crop_type_slug: 'pepper', variety_id: 'v-mj', source_kind: 'own_garden' })
    expect(sentAsItem(what())).toMatchObject({ name: 'Megatron, the red ones', plant_id: 'p-mj', crop_type_slug: 'pepper' })
    // The line still names the PLANTING, not what the name was edited to; and an edit is not a new search.
    expect(tie()).toBe('from your planting: Megatron jalapeño')
    await settle()
    expect(fetch.mock.calls.length).toBe(asked)
    expect(list()).toBeNull()
    expect(what()).toEqual({ ...PICKED, name: 'Megatron, the red ones' })
  })

  it('a crop and a variety keep theirs through an edit as well', async () => {
    const a = answerFor('pe', { crops: [crop({ crop_type_slug: 'pepper', label: 'Pepper' })], varieties: [variety({ variety_id: 'v-pp', label: 'Peter pepper', crop_type_slug: 'pepper' })] })
    const first = mount({ answer: a })
    await type('pe')
    tap('t-hit-variety:v-pp')
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Peter pepper mash' } })
    expect(first.what()).toEqual({ source: 'variety', name: 'Peter pepper mash', variety_id: 'v-pp', crop_type_slug: 'pepper' })
    expect(tie()).toBe('variety: Peter pepper')
    cleanup()
    const second = mount({ answer: a })
    await type('pe')
    tap('t-hit-crop:pepper')
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Pepper mash' } })
    expect(second.what()).toEqual({ source: 'crop', name: 'Pepper mash', crop_type_slug: 'pepper' })
    expect(tie()).toBe('crop: Pepper')
  })

  it('Search again drops the hit, keeps the name, goes back to the field and searches for it', async () => {
    const { what, fetch } = mount({ answer: (q) => answerFor(q, { plantings: [PLANT] }) })
    await type('mega')
    tap('t-hit-planting:p-mj')
    const asked = fetch.mock.calls.length
    tap('t-change')
    expect(what()).toEqual({ source: 'typed', name: 'Megatron jalapeño' })
    expect(screen.queryByTestId('t-picked')).toBeNull()
    expect(tie()).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('t-name'))
    await settle()
    expect(fetch.mock.calls.length).toBe(asked + 1)
    expect(rowIds()).toEqual(['t-hit-planting:p-mj'])
  })

  it('the wave and sown words are the field\'s own: never in the What, and a restored draft prints the name alone', async () => {
    const ZUKE = (o) => planting({ label: 'Dark Green Zucchini', crop_type_slug: 'zucchini', variety_id: 'v-dgz', ...o })
    const first = mount({ answer: answerFor('zucc', { plantings: [
      ZUKE({ plant_id: 'p-w1', succession_order: 1, sown_at: '2026-04-10' }), ZUKE({ plant_id: 'p-w2', succession_order: 2, sown_at: '2026-05-08' })] }) })
    await type('zucc')
    tap('t-hit-planting:p-w2')
    expect(tie()).toBe('from your planting: Dark Green Zucchini — wave 2, sown May 8')
    // The What is the five keys it always was: nothing of the wave or the day is in it …
    const picked = first.what()
    expect(Object.keys(picked).sort()).toEqual(['crop_type_slug', 'name', 'plant_id', 'source', 'variety_id'])
    expect(JSON.stringify(picked)).not.toMatch(/wave|sown|May/)
    cleanup()
    // … so the same What read back from a draft (or handed in by a door opened from a planting) says the name alone.
    const restored = mount({ initial: JSON.parse(JSON.stringify(picked)) })
    await settle()
    expect(screen.getByTestId('t-name').value).toBe('Dark Green Zucchini')
    expect(tie()).toBe('from your planting: Dark Green Zucchini')
    expect(screen.getByTestId('t-change').textContent).toBe('Search again')
    expect(restored.fetch).not.toHaveBeenCalled()                          // a picked name is not searched for
    // An edit after that still keeps the planting, and the line keeps the name it arrived with.
    fireEvent.change(screen.getByTestId('t-name'), { target: { value: 'Zucchini relish' } })
    expect(restored.what()).toEqual({ ...picked, name: 'Zucchini relish' })
    expect(tie()).toBe('from your planting: Dark Green Zucchini')
  })

  it('the line says each kind in its own words, and nothing for a put-up or a bought item', () => {
    expect(tiedWords('planting', 'Megatron jalapeño')).toBe('from your planting: Megatron jalapeño')
    expect(tiedWords('crop', 'Pepper')).toBe('crop: Pepper')
    expect(tiedWords('variety', ' Ristra Cayenne ')).toBe('variety: Ristra Cayenne')
    for (const s of ['put_up', 'pantry_item', 'typed', undefined]) expect(tiedWords(s, 'Blueberry jam')).toBeNull()
    for (const s of ['planting', 'crop', 'variety']) expect(tiedWords(s, '  ')).toBeNull()
  })

  it('the host\'s ref still reaches the input, picked or not', async () => {
    const ref = { current: null }
    mount({ answer: ANSWER, inputRef: ref })
    expect(ref.current).toBe(screen.getByTestId('t-name'))
    await type('mega')
    tap('t-hit-planting:p-mj')
    expect(ref.current).toBe(screen.getByTestId('t-name'))
  })
})

describe('the words — the match list and the picked block, swept', () => {
  it('a crop hit, a variety hit, a planting with a wave, an ended one, what we have and More matches…; then each picked line', async () => {
    const ZUKE = (o) => planting({ label: 'Dark Green Zucchini', crop_type_slug: 'zucchini', variety_id: 'v-dgz', ...o })
    const a = answerFor('zucc', {
      plantings: [ZUKE({ plant_id: 'p-w1', succession_order: 1, sown_at: '2026-04-10' }), ZUKE({ plant_id: 'p-w2', succession_order: 2, sown_at: '2026-05-08', ended: true })],
      put_ups: [jar({ preservation_log_id: 'j-z', label: 'Zucchini relish' })], pantry_items: [item({ pantry_item_id: 'i-z', label: 'Zucchini bread' })],
      crops: [crop({ crop_type_slug: 'zucchini', label: 'Zucchini' })],
      varieties: [variety({ variety_id: 'v-dgz', label: 'Dark Green zucchini seed', crop_type_slug: 'zucchini' }), variety({ variety_id: 'v-gz', label: 'Golden zucchini', crop_type_slug: 'zucchini' })],
    })
    for (const id of ['t-hit-planting:p-w1', 't-hit-planting:p-w2', 't-hit-crop:zucchini', 't-hit-variety:v-gz', 't-hit-put_up:j-z']) {
      const { container } = mount({ answer: a })
      await type('zucc')
      expect(screen.getByTestId('t-more')).toBeTruthy()
      expectClean(wordsOf(container), 'the match list, six rows')
      tap('t-more')
      expect(rowIds()).toHaveLength(7)
      expectClean(wordsOf(container), 'the match list, every row')
      tap(id)
      expect(screen.getByTestId('t-picked')).toBeTruthy()
      expectClean(wordsOf(container), `picked: ${id}`)
      cleanup()
    }
    expectClean([MORE_MATCHES_TEXT, SEARCH_AGAIN_TEXT, tiedWords('planting', 'x'), tiedWords('crop', 'x'), tiedWords('variety', 'x'),
      plantingHitLine({ label: 'x', ended: true }, null)], 'the constants')
  })
})
