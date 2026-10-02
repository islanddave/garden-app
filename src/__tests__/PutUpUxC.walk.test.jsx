// Put-Up UX pass R1, lane C — Walk a place (PLAN-V3 D6; findings F13, F31; the Walk's Raw · In oil).
//
// WHAT THIS FILE HOLDS:
//   • the options disclosure says what it holds ("▸ Raw or in oil, discard by, another date"), and the
//     garden line is named for what it holds ("From the garden, not put up yet");
//   • Raw · In oil sit beside the discard choice: Raw only on a method the engine allows it on, neither on
//     a bought item (the item route refuses a key it does not know);
//   • `is_raw` / `in_oil` are sent ONLY when chosen — an untouched save's body is exactly what it was (that
//     exact body is pinned, unedited, in PutUpWalk.test.jsx);
//   • the preview line changes the moment either is tapped, through the same engine the server resolves with;
//   • a group's two required answers are unchanged with the options open.
// MUTATIONS (run, see the lane report): send is_raw: false when nothing was chosen -> PutUpWalk.test.jsx's
// exact-body pin reds; drop isRaw / inOil from previewLine -> "changes at once" reds here.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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

import PutUp from '../pages/PutUp.jsx'
import { UNRECORDED_LABEL } from '../components/pantry/WalkPlace.jsx'
import { AS_IS, jarBody, itemBody, previewLine, WALK_OPTIONS_LABEL } from '../components/pantry/putSomethingUp.js'
import { RAW_METHODS, RAW_LABEL, IN_OIL_LABEL, ALL_PUT_UP_METHODS } from '../components/putup/putItUp.js'

const LOCATIONS = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
]
function wire(opts = {}) {
  fake = pantryFetch({ places: LOCATIONS, ...opts })
  stableFetch.fn = fake
}
const posts = (path) => fake.calls('POST', path).filter(c => c.path === path)
async function startWalk(place = 'Kitchen fridge') {
  render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('radio', { name: place }))
  fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
  fireEvent.click(screen.getByTestId('putup-walk-start'))
  await screen.findByTestId('putup-walk-group')
}
const typeWhat = (v) => fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: v } })
const openOptions = () => fireEvent.click(screen.getByTestId('walk-more'))
const save = () => fireEvent.click(screen.getByTestId('walk-save'))
const preview = () => screen.getByTestId('walk-preview').textContent
const rawGroup = () => within(screen.getByTestId('walk-more-panel')).queryByRole('group', { name: 'Raw or in oil' })

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('the words', () => {
  it('the options disclosure and the garden line each say what they hold', async () => {
    expect(WALK_OPTIONS_LABEL).toBe('Raw or in oil, discard by, another date')
    expect(UNRECORDED_LABEL).toBe('From the garden, not put up yet')
    await startWalk()
    const more = screen.getByTestId('walk-more')
    expect(more.textContent).toBe('▸ Raw or in oil, discard by, another date')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(parseInt(more.style.minHeight, 10)).toBe(48)
    openOptions()
    expect(more.textContent).toBe('▾ Raw or in oil, discard by, another date')
    const garden = screen.getByTestId('putup-walk-unrecorded-toggle')
    expect(garden.textContent).toBe('▸' + 'From the garden, not put up yet')
    expect(garden.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('walk-method-more').textContent).toBe('Other ways…')
    expect(document.body.textContent).not.toMatch(/What haven.t I put up/)
  })

  it('the group still asks exactly two things with the options open and nothing chosen', async () => {
    await startWalk()
    openOptions()
    const req = [...screen.getByTestId('putup-walk-group').querySelectorAll('[aria-required="true"]')]
    expect(req.map(e => e.getAttribute('aria-label') ?? e.tagName.toLowerCase())).toEqual(['input', 'How was it put up?'])
    expect(within(screen.getByTestId('putup-walk-group')).queryAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')
      .map(r => r.textContent)).toEqual(['Work it out'])                   // the discard choice's own starting answer, as before
  })
})

describe('Raw · In oil, beside the discard choice', () => {
  it('In oil is offered for a put-up; Raw only on a method that allows it; neither on a bought item', async () => {
    await startWalk()
    openOptions()
    const names = () => (rawGroup() ? within(rawGroup()).getAllByRole('button').map(b => b.textContent) : null)
    expect(names()).toEqual(['In oil'])                                     // no method yet
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    expect(names()).toEqual(['Raw', 'In oil'])
    expect([RAW_LABEL, IN_OIL_LABEL]).toEqual(['Raw', 'In oil'])
    fireEvent.click(screen.getByTestId('walk-method-quick_pickle'))
    expect(names()).toEqual(['In oil'])
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    expect(names()).toBeNull()
    // Raw's methods are the engine's own list, not one typed here.
    expect([...RAW_METHODS].sort()).toEqual(['hot_sauce', 'other', 'pesto'])
    // Beside the discard choice: the group sits directly above it in the same panel, and its chips are
    // toggles (aria-pressed), 48 px.
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    const panel = screen.getByTestId('walk-more-panel')
    expect(panel.firstElementChild).toBe(rawGroup())
    expect(rawGroup().nextElementSibling.querySelector('[role="radiogroup"]').getAttribute('aria-label')).toBe('Discard by')
    for (const id of ['walk-raw', 'walk-inoil']) {
      expect(screen.getByTestId(id).getAttribute('aria-pressed')).toBe('false')
      expect(parseInt(screen.getByTestId(id).style.minHeight, 10)).toBe(48)
    }
  })

  it('the preview line changes at once: Raw or In oil outside a freezer has no worked-out date', async () => {
    await startWalk('Kitchen fridge')
    typeWhat('Reaper sauce')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    const dated = /^put up sometime in .+ · discard by around .+ · general figure: hot sauce, fridge$/
    const none = /^put up sometime in .+ · no date — no general figure for raw or in-oil food\. Set your own under Discard by\.$/
    expect(preview()).toMatch(dated)
    fireEvent.click(screen.getByTestId('walk-raw'))
    expect(screen.getByTestId('walk-raw').getAttribute('aria-pressed')).toBe('true')
    expect(preview()).toMatch(none)
    fireEvent.click(screen.getByTestId('walk-raw'))
    expect(preview()).toMatch(dated)
    fireEvent.click(screen.getByTestId('walk-inoil'))
    expect(preview()).toMatch(none)
    expect(posts('/api/preservation')).toEqual([])                         // a tap on a chip writes nothing
  })

  it('in a freezer the date is worked out all the same, Raw or not', async () => {
    await startWalk('Chest Freezer 1')
    typeWhat('Pesto')
    fireEvent.click(screen.getByTestId('walk-method-pesto'))
    openOptions()
    const dated = /^put up sometime in .+ · discard by around .+ · general figure: pesto, deep freezer$/
    expect(preview()).toMatch(dated)
    fireEvent.click(screen.getByTestId('walk-raw'))
    fireEvent.click(screen.getByTestId('walk-inoil'))
    expect(preview()).toMatch(dated)
  })

  // [what, the taps, the keys the body gains]
  it.each([
    ['Raw', ['walk-raw'], { is_raw: true }],
    ['In oil', ['walk-inoil'], { in_oil: true }],
    ['both', ['walk-raw', 'walk-inoil'], { is_raw: true, in_oil: true }],
  ])('%s chosen: the body gains exactly that, and nothing else', async (_, taps, gained) => {
    await startWalk('Kitchen fridge')
    typeWhat('Reaper sauce')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    for (const t of taps) fireEvent.click(screen.getByTestId(t))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    const b = posts('/api/preservation')[0].body
    expect(Object.keys(b).sort()).toEqual([
      'idempotency_key', 'label', 'method', 'package_count', 'preserved_at', 'preserved_at_approx', 'preserved_at_precision',
      'storage_location_id', ...Object.keys(gained)].sort())
    expect(b).toMatchObject({ label: 'Reaper sauce', method: 'hot_sauce', storage_location_id: 'loc-3', ...gained })
  })

  it('nothing chosen, the options opened and closed: no is_raw and no in_oil key at all', async () => {
    await startWalk('Kitchen fridge')
    typeWhat('Reaper sauce')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    fireEvent.click(screen.getByTestId('walk-raw'))
    fireEvent.click(screen.getByTestId('walk-raw'))                         // chosen, then not
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    const b = posts('/api/preservation')[0].body
    expect('is_raw' in b).toBe(false)
    expect('in_oil' in b).toBe(false)
  })

  it('Raw chosen, then a method that does not allow it: the chip is gone and Raw is not sent', async () => {
    await startWalk('Kitchen fridge')
    typeWhat('Pickles')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    fireEvent.click(screen.getByTestId('walk-raw'))
    fireEvent.click(screen.getByTestId('walk-method-quick_pickle'))
    expect(screen.queryByTestId('walk-raw')).toBeNull()
    expect(preview()).toMatch(/discard by around .+ · general figure: quick pickle, fridge$/)
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect('is_raw' in posts('/api/preservation')[0].body).toBe(false)
  })

  it('a bought item never carries either key, whatever was tapped before As is', async () => {
    await startWalk('Kitchen fridge')
    typeWhat('Oat milk')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    fireEvent.click(screen.getByTestId('walk-raw'))
    fireEvent.click(screen.getByTestId('walk-inoil'))
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    expect(preview()).toMatch(/^got it sometime in .+ · no discard date$/)
    save()
    await waitFor(() => expect(posts('/api/pantry/items')).toHaveLength(1))
    expect(Object.keys(posts('/api/pantry/items')[0].body).sort()).toEqual(['acquired_at', 'acquired_precision', 'idempotency_key', 'name', 'storage_location_id'])
    expect(posts('/api/preservation')).toEqual([])
  })

  it('the next group starts clean: nothing carried over from the one just saved', async () => {
    await startWalk('Kitchen fridge')
    typeWhat('Reaper sauce')
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    openOptions()
    fireEvent.click(screen.getByTestId('walk-raw'))
    fireEvent.click(screen.getByTestId('walk-inoil'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(screen.queryByTestId('walk-more-panel')).toBeNull()
    typeWhat('Pesto')
    fireEvent.click(screen.getByTestId('walk-method-pesto'))
    openOptions()
    expect(screen.getByTestId('walk-raw').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('walk-inoil').getAttribute('aria-pressed')).toBe('false')
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(2))
    const b = posts('/api/preservation')[1].body
    expect('is_raw' in b || 'in_oil' in b).toBe(false)
  })
})

describe('jarBody and previewLine, pure', () => {
  const what = { source: 'typed', name: 'Reaper sauce' }
  const when = { date: '2026-10-01', precision: 'day' }
  const NOW = new Date(2026, 9, 1)
  const base = { key: 'k', what, storageLocationId: 'loc-3', when, count: 1, discard: { mode: 'auto', date: '' } }
  const fridge = { kind: 'fridge', label: 'Kitchen fridge' }

  it('is_raw / in_oil only when TRUE — never false, never null — and Raw only where the engine allows it', () => {
    for (const method of ALL_PUT_UP_METHODS) {
      const plain = jarBody({ ...base, method })
      expect('is_raw' in plain || 'in_oil' in plain).toBe(false)
      expect(jarBody({ ...base, method, isRaw: false, inOil: false })).toEqual(plain)
      expect(jarBody({ ...base, method, isRaw: null, inOil: undefined })).toEqual(plain)
      expect(jarBody({ ...base, method, isRaw: true, inOil: true }))
        .toEqual(RAW_METHODS.has(method) ? { ...plain, is_raw: true, in_oil: true } : { ...plain, in_oil: true })
    }
  })

  it('a bought item\'s body has no place for them', () => {
    const b = itemBody({ key: 'k', what, place: { id: 'loc-3' }, when, discard: { mode: 'auto', date: '' }, isRaw: true, inOil: true })
    expect(Object.keys(b).sort()).toEqual(['acquired_at', 'acquired_precision', 'idempotency_key', 'name', 'storage_location_id'])
  })

  it('previewLine passes both to the engine: no worked-out date outside a freezer, the usual one inside', () => {
    const dated = 'put up Oct 1 · discard by Apr 1, 2027 · general figure: hot sauce, fridge'
    const none = 'put up Oct 1 · no date — no general figure for raw or in-oil food. Set your own under Discard by.'
    expect(previewLine({ method: 'hot_sauce', place: fridge, when, now: NOW })).toBe(dated)
    expect(previewLine({ method: 'hot_sauce', place: fridge, when, isRaw: false, inOil: false, now: NOW })).toBe(dated)
    expect(previewLine({ method: 'hot_sauce', place: fridge, when, isRaw: true, now: NOW })).toBe(none)
    expect(previewLine({ method: 'hot_sauce', place: fridge, when, inOil: true, now: NOW })).toBe(none)
    // Raw on a method that does not allow it changes nothing (the chip is never shown for it).
    expect(previewLine({ method: 'quick_pickle', place: fridge, when, isRaw: true, now: NOW }))
      .toBe(previewLine({ method: 'quick_pickle', place: fridge, when, now: NOW }))
    expect(previewLine({ method: AS_IS, place: fridge, when, isRaw: true, inOil: true, now: NOW })).toBe('got it today · no discard date')
  })
})

// R2 lane Dn additions go directly under this line
// R2 lane Df additions go directly under this line
