// Put-Up R2a, lane I (the integrator) — words two lanes each say, held to ONE answer once both are merged.
//
//   · THE KIND WORDS (amendment C5, ΔARCH D-08). recipes.STORAGE_KIND_WORDS is built from the one list of kinds
//     (putup/placeKinds.js), so the recipe sheet's chips and its keeps line name a kind of place exactly as the
//     door does: "Counter or other", never a "Counter" of its own. recipes.js holds no kind word of its own.
//   · THE RAW / IN-OIL NO-DATE SENTENCE (amendment D7; ruling Df-3 = F-3). Two doors say it, each from its own
//     constant (Put it up may not import across the putup → pantry line): PutItUpSheet.RAW_OIL_NO_DATE_WORDS
//     (lane F) and putSomethingUp.RAW_OIL_NO_DATE_WORDS (lane Df) are one string. And they say it for the same
//     cells: hot sauce in a fridge marked Raw (Raw took a date away) says it on both; pesto in a fridge marked
//     Raw (there was no date for Raw to take: no general figure for pesto in a fridge) says neither, and keeps
//     "no date — check it before using" on both. The door's preview is a whole line ("put up Oct 1 · …"); Put
//     it up's is the discard part alone (its When is a row above), so the cell compares what follows the date.
// MUTATIONS (each run, each red here):
//   the old literal back (other: 'Counter')                           -> "every kind in the door's words"
//   a literal with today's six words, not built from the list         -> "recipes.js holds no kind word"
//   one door's sentence reworded                                      -> "one string"
//   Put it up says the sentence for any Raw row with no date          -> "pesto in a fridge … Put it up"
//   the door says the sentence for any Raw row with no date           -> "pesto in a fridge … the door"
//   either door never says it                                         -> "hot sauce in a fridge …" on that door
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch } from './helpers/pantryFake.js'

installStoragePolyfill()

const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import { STORAGE_KIND_WORDS, keepsWords } from '../components/recipes/recipes.js'
import { PLACE_KINDS } from '../components/putup/placeKinds.js'
import PutItUpSheet, { RAW_OIL_NO_DATE_WORDS as PUT_IT_UP_WORDS } from '../components/putup/PutItUpSheet.jsx'
import PutSomethingUpSheet from '../components/pantry/PutSomethingUpSheet.jsx'
import { RAW_OIL_NO_DATE_WORDS as DOOR_WORDS, previewLine } from '../components/pantry/putSomethingUp.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const h = React.createElement
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STANDING = 'no date — check it before using'
const NOW = new Date(2026, 9, 1, 14, 0)                                // Oct 1 2026, 2 pm, local
const FRIDGE = 'loc-3'                                                 // pantryFake's Kitchen fridge
const BATCH = { id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment',
  started_at: new Date(2026, 8, 20, 9).toISOString(), start_precision: 'day', closed_at: null, suspended_at: null, outputs: [] }

const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
// What each door's preview says AFTER its date: the door's whole line is "put up Oct 1 · <this>".
const doorSays = () => screen.getByTestId('door-preview').textContent.replace(/^put up Oct 1 · /, '')
const putItUpSays = () => screen.getByTestId('putup-row-0-preview').textContent
const putItUpGroups = () => screen.getAllByTestId('putup-preview-line').map(e => e.textContent)

// The door: a name, the fridge, the method (behind More… when it is not on the first row), Raw tapped.
async function doorRaw(method) {
  render(h(PutSomethingUpSheet, { open: true, now: NOW.getTime(), onClose: vi.fn(), onSaved: vi.fn() }))
  await screen.findByTestId(`door-place-id:${FRIDGE}`)
  fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'Megatron mash' } })
  await tap(`door-place-id:${FRIDGE}`)
  if (!screen.queryByTestId(`door-method-${method}`)) await tap('door-method-more')
  await tap(`door-method-${method}`)
  await tap('door-raw')
  expect(screen.getByTestId('door-raw').getAttribute('aria-pressed')).toBe('true')
}
// Put it up: the method (behind More… when the batch's kind does not offer it), row 1 in the fridge, its
// details open, Raw tapped.
async function putItUpRaw(method) {
  render(h(PutItUpSheet, { open: true, batch: BATCH, lines: [], now: NOW.getTime(), onClose: () => {}, onDone: () => {} }))
  await waitFor(() => expect(screen.getByTestId(`putup-row-0-place-id:${FRIDGE}`)).toBeTruthy())
  if (!screen.queryByTestId(`putup-method-${method}`)) await tap('putup-method-more')
  await tap(`putup-method-${method}`)
  await tap(`putup-row-0-place-id:${FRIDGE}`)
  await tap('putup-row-0-more')
  await tap('putup-row-0-raw')
  expect(screen.getByTestId('putup-row-0-raw').getAttribute('aria-pressed')).toBe('true')
}

beforeEach(() => {
  stableFetch.fn = pantryFetch()
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the kind words — the recipe sheet says a kind of place in the door\'s words (C5)', () => {
  it('every kind in the door\'s words, in the keeps line too: Counter or other', () => {
    expect(STORAGE_KIND_WORDS).toEqual(Object.fromEntries(PLACE_KINDS.map(k => [k.kind, k.label])))
    expect(STORAGE_KIND_WORDS.other).toBe('Counter or other')
    expect(keepsWords({ keeps_n: 3, keeps_unit: 'day', keeps_storage_kind: 'other' })).toBe('Counter or other · 3 days')
    expect(Object.isFrozen(STORAGE_KIND_WORDS)).toBe(true)
  })

  it('recipes.js holds no kind word of its own: one list, so a kind renamed there is renamed here', () => {
    const src = readFileSync(resolve(SRC, 'components/recipes/recipes.js'), 'utf8')
    for (const { label } of PLACE_KINDS) expect(src, label).not.toContain(`'${label}'`)
    expect(src).not.toMatch(/'Counter'/)
  })
})

describe('the raw / in-oil no-date sentence — one string, two doors, the same cells (D7)', () => {
  it('one string: Put it up\'s constant is the door\'s', () => {
    expect(PUT_IT_UP_WORDS).toBe(DOOR_WORDS)
    expect(DOOR_WORDS).toBe('no date — no general figure for raw or in-oil food. Set your own under Discard by.')
  })

  it('hot sauce in a fridge marked Raw: Raw took the date away, and both doors say the sentence — the door', async () => {
    await doorRaw('hot_sauce')
    expect(doorSays()).toBe(DOOR_WORDS)
  })

  it('hot sauce in a fridge marked Raw: Raw took the date away, and both doors say the sentence — Put it up', async () => {
    await putItUpRaw('hot_sauce')
    expect(putItUpSays()).toBe(PUT_IT_UP_WORDS)
    expect(putItUpGroups()).toEqual([PUT_IT_UP_WORDS])
  })

  it('pesto in a fridge marked Raw: there was no date for Raw to take, and the door keeps the standing words', async () => {
    // No general figure for pesto in a fridge, Raw or not: the same jar unmarked has no date either.
    expect(previewLine({ method: 'pesto', place: { kind: 'fridge', label: 'Kitchen fridge' }, when: { date: '2026-10-01', precision: 'day' }, now: NOW }))
      .toBe(`put up Oct 1 · ${STANDING}`)
    await doorRaw('pesto')
    expect(screen.getByTestId('door-preview').textContent).toBe(`put up Oct 1 · ${STANDING}`)
    expect(doorSays()).not.toContain(DOOR_WORDS)
  })

  it('pesto in a fridge marked Raw: there was no date for Raw to take, and Put it up keeps the standing words', async () => {
    await putItUpRaw('pesto')
    expect(putItUpSays()).toBe(STANDING)
    expect(putItUpGroups()).toEqual([STANDING])
  })
})
