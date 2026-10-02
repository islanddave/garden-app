// Put-Up R2a, lane F (amendment D7; PLAN-R2-V4-RULINGS Df-3 = F-3) — Put it up's discard preview, when Raw
// or In oil is what took the date away, says
//     no date — no general figure for raw or in-oil food. Set your own under Discard by.
// in the row's own preview and in the grouped one. Every OTHER reason a row has no date keeps the words it
// had ("no date — check it before using"), marked Raw / In oil or not: the sentence is printed exactly when
// un-marking Raw and In oil would bring a date back. putItUp.js is not edited: the sheet decides from the
// row's own state and from what previewDiscard answers.
//
// ONE TEST PER CAUSE (the causes a row on this sheet can reach):
//   Raw · In oil · both                         -> the new sentence
//   Raw / In oil in a deep freezer              -> a date, as before
//   no general figure for that food there       -> today's sentence
//   a dried food that still bends               -> today's sentence
//   cured produce with an estimated date        -> today's sentence
//   No date / a date from the label             -> "set by hand", as before
//   the recipe's own date                       -> "from the recipe", as before
// MUTATIONS (each run, each red here):
//   the sentence printed for ANY no-date row that is marked Raw or In oil (the "would a date come back"
//     check dropped)                             -> the three "today's sentence" causes
//   the sentence printed for every no-date row   -> the same three
//   the sentence never printed (= the base)      -> the three "new sentence" causes, the two-row test
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PutItUpSheet, { RAW_OIL_NO_DATE_WORDS } from '../components/putup/PutItUpSheet.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const SENTENCE = 'no date — no general figure for raw or in-oil food. Set your own under Discard by.'
const AS_BEFORE = 'no date — check it before using'
const BANNED = /\bsafe\b|shelf.life|shelf.stable|\bkeeps\b|\bgood\b|\bready\b|\bdone\b|\bexpired\b|\btable\b|\bdefault\b|\bbasis\b/i

const NOW = new Date('2026-09-29T15:00:00').getTime()
const BATCH = { id: 'kb-mash', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment',
  started_at: new Date('2026-09-20T09:00:00').toISOString(), start_precision: 'day', closed_at: null, suspended_at: null, outputs: [] }
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest freezer', kind: 'deep_freezer' },
  { id: 'loc-shelf', user_id: 'user_dave', label: 'Pantry shelf', kind: 'pantry' },
  { id: 'loc-cellar', user_id: 'user_dave', label: 'Cellar', kind: 'cold_storage' },
]
const JAR = { id: 'pl-1', label: 'Megatron mash', preserved_at: '2026-09-29', preserved_at_precision: 'day', use_by_target: null, use_by_basis: 'none' }

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
// The row's own preview (inside its details) and the grouped one above the footer.
const rowSays = (i = 0) => screen.getByTestId(`putup-row-${i}-preview`).textContent
const groupSays = () => screen.getAllByTestId('putup-preview-line').map(e => e.textContent)

// The sheet open on `method` (behind More… when the batch's kind does not offer it) at `place`, row 1's
// details open.
async function open(method, place, { batch = BATCH } = {}) {
  render(<PutItUpSheet open batch={batch} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} />)
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
  if (!screen.queryByTestId(`putup-method-${method}`)) await tap('putup-method-more')
  await tap(`putup-method-${method}`)
  await tap(`putup-row-0-place-id:${place}`)
  await tap('putup-row-0-more')
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path)) return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} })
    return Promise.resolve(null)
  })
  localStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('Put it up — the preview when Raw or In oil took the date away (D7)', () => {
  it('Raw: the row\'s preview and the grouped preview say the new sentence, from one constant', async () => {
    await open('hot_sauce', 'loc-fridge')
    expect(rowSays()).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
    await tap('putup-row-0-raw')
    expect(RAW_OIL_NO_DATE_WORDS).toBe(SENTENCE)
    expect(rowSays()).toBe(SENTENCE)
    expect(groupSays()).toEqual([SENTENCE])
    expect(screen.getByTestId('putup-preview').getAttribute('role')).toBe('status')
    // Un-marked, the date is back: that is what "Raw took it away" means.
    await tap('putup-row-0-raw')
    expect(rowSays()).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
  })

  it('In oil: the same sentence, on a method that has no Raw chip', async () => {
    await open('ferment', 'loc-fridge')
    expect(screen.queryByTestId('putup-row-0-raw')).toBeNull()
    expect(rowSays()).toBe('discard by Mar 29, 2027 · general figure: ferment, fridge')
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe(SENTENCE)
    expect(groupSays()).toEqual([SENTENCE])
  })

  it('Raw and In oil together: the sentence once, and it goes only when both are un-marked', async () => {
    await open('hot_sauce', 'loc-shelf')
    await tap('putup-row-0-raw')
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe(SENTENCE)
    expect(groupSays()).toEqual([SENTENCE])
    await tap('putup-row-0-raw')
    expect(rowSays()).toBe(SENTENCE)
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe('discard by Sep 29, 2027 · general figure: hot sauce, pantry shelf')
  })

  it('in a deep freezer Raw and In oil take nothing away: the date stays, in the words it had', async () => {
    await open('hot_sauce', 'loc-cf1')
    await tap('putup-row-0-raw')
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe('discard by Mar 29, 2027 · general figure: hot sauce, deep freezer')
    expect(groupSays()).toEqual(['discard by Mar 29, 2027 · general figure: hot sauce, deep freezer'])
  })
})

describe('Put it up — every other reason for no date keeps the words it had', () => {
  it('no general figure for that food in that place (pesto in a fridge): as before, Raw or not', async () => {
    await open('pesto', 'loc-fridge')
    expect(rowSays()).toBe(AS_BEFORE)
    await tap('putup-row-0-raw')
    expect(rowSays()).toBe(AS_BEFORE)
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe(AS_BEFORE)
    expect(groupSays()).toEqual([AS_BEFORE])
  })

  it('a dried food that still bends: as before, In oil or not', async () => {
    await open('dehydrate', 'loc-shelf')
    expect(rowSays()).toBe('discard by Jan 29, 2027 · general figure: dehydrated, pantry shelf')
    await tap('putup-row-0-texture-bends')
    expect(rowSays()).toBe(AS_BEFORE)
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe(AS_BEFORE)
    expect(groupSays()).toEqual([AS_BEFORE])
  })

  it('cured produce with an estimated put-up date: as before, In oil or not', async () => {
    await open('cure_store', 'loc-cellar')
    expect(rowSays()).toBe('discard by Jan 29, 2027 · general figure: cure & store, cellar')
    await tap('putup-when-earlier')
    await tap('putup-when-last_month')
    expect(rowSays()).toBe(AS_BEFORE)
    await tap('putup-row-0-inoil')
    expect(rowSays()).toBe(AS_BEFORE)
    expect(groupSays()).toEqual([AS_BEFORE])
  })

  it('No date, or a date from the label, is said as "set by hand" — Raw changes neither', async () => {
    await open('hot_sauce', 'loc-fridge')
    await tap('putup-row-0-raw')
    await tap('putup-row-0-discard-none')
    expect(rowSays()).toBe('no date · set by hand')
    await tap('putup-row-0-discard-date')
    fireEvent.change(screen.getByTestId('putup-row-0-discard-day'), { target: { value: '2026-12-08' } })
    expect(rowSays()).toBe('discard by Dec 8 · set by hand')
    // Back on Work it out, the worked-out answer is the sentence again.
    await tap('putup-row-0-discard-auto')
    expect(rowSays()).toBe(SENTENCE)
  })

  it('the recipe\'s own date is said as it was: Raw does not replace it', async () => {
    const recipe = { id: 'r1', name: 'Roll for Initiative', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge', lines: [] }
    await open('hot_sauce', 'loc-fridge', { batch: { ...BATCH, recipe_id: 'r1', recipe } })
    expect(rowSays()).toBe('discard by Oct 6 · from the recipe: Roll for Initiative')
    await tap('putup-row-0-raw')
    expect(rowSays()).toBe('discard by Oct 6 · from the recipe: Roll for Initiative')
  })
})

describe('Put it up — the sentence on the sheet', () => {
  it('two rows: it is said for the row it is true of, and the other row keeps its date', async () => {
    await open('hot_sauce', 'loc-fridge')
    await tap('putup-row-0-raw')
    await tap('putup-row-add')                                           // row 2 copies the place, not the mark
    expect(groupSays()).toEqual([
      `Row 1: ${SENTENCE}`,
      'Row 2: discard by Mar 29, 2027 · general figure: hot sauce, fridge',
    ])
    await tap('putup-row-1-more')
    await tap('putup-row-1-inoil')
    expect(groupSays()).toEqual([`Rows 1, 2: ${SENTENCE}`])
  })

  it('the body is what it was: a Raw row sends is_raw and no date key', async () => {
    await open('hot_sauce', 'loc-fridge')
    await tap('putup-row-0-raw')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(JSON.parse(putUps()[0][1].body).rows).toEqual([{ count: 1, place: { id: 'loc-fridge' }, is_raw: true }])
  })

  it('no banned word with the sentence showing; the words are one constant here, and nothing is imported from the pantry', async () => {
    await open('hot_sauce', 'loc-fridge')
    await tap('putup-row-0-raw')
    const text = screen.getByTestId('putup-sheet').textContent
    expect(text).toContain(SENTENCE)
    expect(text).not.toMatch(BANNED)
    expect(SENTENCE).not.toMatch(BANNED)
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../components/putup/PutItUpSheet.jsx'), 'utf8')
    expect(src.split('no general figure for raw or in-oil food').length - 1).toBe(1)
    expect(src).not.toMatch(/from '\.\.\/pantry\//)
  })
})
