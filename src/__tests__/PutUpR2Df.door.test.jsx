// Put-Up R2a, lane Df — the Put something up door's new fields (plan V2 section 2 as amended by V3 A–D and the
// V4 rulings Df-1 to Df-7).
//
// WHAT THIS FILE HOLDS:
//   • the words, exactly;
//   • the first screen's order, and the ONE slot under the method row (the canning line · Raw with its line ·
//     How dry?), never two at once, brought into view by a method tap without moving focus;
//   • Size of each container: one quiet link, the field in place, the total on the wire as a JSON number,
//     the echo, the refusals in place;
//   • How much on As is: its own link, its own units, its own cell in the draft (ΔQA Δ-I4, twin row 8);
//   • the two disclosures: what each is called by method and by What, what each holds, where-from's two
//     headings, Other needing its name, and what a method change does to a choice (amendment D3);
//   • the six kinds of place: the Fridge freezer chip makes a fridge_freezer and previews its own figure;
//   • the draft: every new field comes back; a v4.169 checker still takes an R2a record (RIA I-9);
//   • the retry key: a new one only after an answered 4xx (RIA I-3); a replayed answer is the server's row;
//   • a restored place re-resolved against the live list, and first focus on a seeded open;
//   • the footer band has its test id, and the size block is marked to be cleared whole;
//   • a banned-word sweep of every state this lane added.
// The reload-gate and seeded-door rules are in PutUpR2Df.guard.test.jsx; the bodies in the two parity files.
// MUTATIONS (run, see the lane report) are named beside the test each reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PutSomethingUpSheet, { isDoorDraft, resolveDraftPlace, sameSeed } from '../components/pantry/PutSomethingUpSheet.jsx'
import {
  AS_IS, DOOR_SHEET, DOOR_OPTIONS_LABEL, DOOR_OPTIONS_LABEL_PUT_UP, DOOR_FROM_LABEL, DOOR_FROM_LABEL_PLANTING,
  DOOR_NOTES_PLACEHOLDER, DOOR_NOTES_PLACEHOLDER_PUT_UP, WHERE_FROM_HEADING, MADE_WITH_HEADING, SIZE_LINK_LABEL,
  AMOUNT_LINK_LABEL, HOW_DRY_LABEL, RAW_OR_IN_OIL_LABEL, RAW_OIL_NO_DATE_WORDS, CANNING_LINE, CANNING_METHODS,
  SIZE_TOTAL_TOO_BIG_TEXT, WHERE_REQUIRED_TEXT, methodSlot, previewLine, completionWords,
} from '../components/pantry/putSomethingUp.js'
import { SIZE_WORDS, AMOUNT_WORDS, MORE_UNITS_LABEL } from '../components/pantry/AmountField.jsx'
import { WHERE_EXACTLY_ERROR, WHICH_ONE_LABEL } from '../components/pantry/WhereFromField.jsx'
import { ALL_PUT_UP_METHODS, RAW_METHODS, TEXTURE_METHODS, placeChips } from '../components/putup/putItUp.js'
import { sizeWords, qtyText } from '../components/putup/jarWords.js'
import { sheetDraftKey, writeSheetDraft, readSheetDraft } from '../components/kitchen/sheetDraft.js'

const NOW = new Date(2026, 9, 1, 14, 0)               // Oct 1 2026, 2 pm, local
const TODAY = { date: '2026-10-01', precision: 'day' }
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const PLANTING = { source: 'planting', name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper', variety_id: 'v1' }
const LINE_HITS = { plantings: [{ plant_id: 'p-mj', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mj', recent_picks: [] }], put_ups: [] }
const FRIDGE = PLACES[2]
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

function wire(opts = {}) {
  fake = pantryFetch({ rows: [], lineSearch: LINE_HITS, ...opts })
  stableFetch.fn = fake
}
async function openDoor(props = {}) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn(), ...props }
  const view = render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} />)
  await screen.findByTestId('door-place-id:loc-1')
  return { ...view, ...handlers }
}
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeInto = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } })
const typeWhat = (v) => typeInto('door-what-name', v)
const posts = (path) => fake.calls('POST').filter(c => c.path === path)
const preview = () => screen.getByTestId('door-preview').textContent
const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
const save = () => tap('door-save')
// The three answers, then a method.
function answer(method, place = 'door-place-id:loc-3', name = 'Corn') {
  typeWhat(name); tap(place)
  if (!screen.queryByTestId(`door-method-${method}`)) tap('door-method-more')
  tap(`door-method-${method}`)
}
const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
// Everything in `root` a person can read or have read to them.
function wordsOf(root) {
  const out = [root.textContent]
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of ['aria-label', 'placeholder', 'title', 'alt']) if (el.hasAttribute?.(a)) out.push(el.getAttribute(a))
  }
  return out.filter(Boolean)
}
function expectClean(where) {
  const strings = wordsOf(screen.getByRole('dialog'))
  expect(strings.length, `${where}: nothing was swept`).toBeGreaterThan(0)
  for (const s of strings) expect(`${where}: ${s}`).not.toMatch(BANNED)
}

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { delete Element.prototype.scrollIntoView })

describe('the words', () => {
  it('are these, exactly', () => {
    expect([DOOR_OPTIONS_LABEL, DOOR_OPTIONS_LABEL_PUT_UP]).toEqual(['Date, discard by', 'Date, discard by, in oil'])
    expect([DOOR_FROM_LABEL, DOOR_FROM_LABEL_PLANTING]).toEqual(['Where from, notes', 'Notes'])
    expect([DOOR_NOTES_PLACEHOLDER, DOOR_NOTES_PLACEHOLDER_PUT_UP]).toEqual(['Anything to remember', 'Recipe you followed, or anything to remember'])
    expect([WHERE_FROM_HEADING, MADE_WITH_HEADING]).toEqual(["Where it's from", 'Made with produce from'])
    expect([SIZE_LINK_LABEL, AMOUNT_LINK_LABEL]).toEqual(['＋ Size of each container', '＋ How much'])
    expect([SIZE_WORDS.label, AMOUNT_WORDS.label, MORE_UNITS_LABEL]).toEqual(['Size of each container', 'How much', 'More units…'])
    expect([HOW_DRY_LABEL, RAW_OR_IN_OIL_LABEL]).toEqual(['How dry?', 'Raw or in oil'])
    expect(RAW_OIL_NO_DATE_WORDS).toBe('no date — no general figure for raw or in-oil food. Set your own under Discard by.')
    expect(SIZE_TOTAL_TOO_BIG_TEXT).toBe('That is more in all than a put-up can record — type a smaller size, or clear the size.')
  })

  it('the canning line: two sentences and one link, in one constant', () => {
    expect(CANNING_LINE).toEqual({
      lines: [
        'Published home-canning advice: water-bath canning is only for acid foods (most fruit, jam, pickles, tomatoes with added acid).',
        'Low-acid foods (vegetables, meat) need a pressure canner.',
      ],
      linkText: 'National Center for Home Food Preservation →',
      linkName: 'National Center for Home Food Preservation — opens in a new tab',
      href: 'https://nchfp.uga.edu/how/can',
    })
    expect([...CANNING_METHODS].sort()).toEqual(['can_pressure', 'can_water_bath'])
    for (const s of [...CANNING_LINE.lines, CANNING_LINE.linkText, CANNING_LINE.linkName]) expect(s).not.toMatch(BANNED)
  })
})

describe('the slot under the method row — one thing, by method, never two', () => {
  it('each method gets its own, and eleven get none', () => {
    const want = (m) => (CANNING_METHODS.has(m) ? 'canning' : RAW_METHODS.has(m) ? 'raw' : TEXTURE_METHODS.has(m) ? 'dry' : null)
    expect(ALL_PUT_UP_METHODS.map(m => [m, methodSlot(m)])).toEqual(ALL_PUT_UP_METHODS.map(m => [m, want(m)]))
    expect(ALL_PUT_UP_METHODS.filter(m => methodSlot(m) === 'canning')).toEqual(['can_water_bath', 'can_pressure'])
    expect(ALL_PUT_UP_METHODS.filter(m => methodSlot(m) === 'raw').sort()).toEqual(['hot_sauce', 'other', 'pesto'])
    expect(ALL_PUT_UP_METHODS.filter(m => methodSlot(m) === 'dry')).toEqual(['dehydrate', 'powder'])
    expect(ALL_PUT_UP_METHODS.filter(m => methodSlot(m) == null)).toHaveLength(11)
    expect([methodSlot(AS_IS), methodSlot(null)]).toEqual([null, null])
  })

  it('the canning line shows for the two canning methods and for no other, on the door', async () => {
    await openDoor()
    tap('door-method-more')
    expect(screen.queryByTestId('door-canning-line')).toBeNull()
    for (const m of [...ALL_PUT_UP_METHODS, AS_IS]) {
      tap(`door-method-${m}`)
      expect(`${m}: ${!!screen.queryByTestId('door-canning-line')}`).toBe(`${m}: ${m === 'can_water_bath' || m === 'can_pressure'}`)
      // Never two at once.
      const shown = ['door-canning-line', 'door-raw', 'door-texture'].filter(id => screen.queryByTestId(id))
      expect(`${m}: ${shown.length <= 1}`).toBe(`${m}: true`)
    }
  })

  it('the canning line is a note in three lines: two sentences, then a link that opens a new tab and says so', async () => {
    await openDoor()
    tap('door-method-can_water_bath')
    const note = screen.getByTestId('door-canning-line')
    expect(note.getAttribute('role')).toBe('note')
    expect([...note.children].map(c => c.tagName)).toEqual(['DIV', 'DIV', 'A'])
    expect([...note.children].slice(0, 2).map(c => c.textContent)).toEqual(CANNING_LINE.lines)
    const link = within(note).getByRole('link', { name: 'National Center for Home Food Preservation — opens in a new tab' })
    expect(link).toBe(screen.getByTestId('door-canning-link'))
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['https://nchfp.uga.edu/how/can', '_blank', 'noopener noreferrer'])
    expect(link.querySelector('[aria-hidden="true"]').textContent).toBe('National Center for Home Food Preservation →')
    expect(parseInt(link.style.minHeight, 10)).toBe(48)
    // No box, no tint: the preview line's ink and size.
    expect([note.style.border, note.style.background, note.style.backgroundColor]).toEqual(['', '', ''])
    // It never takes focus, and it stops nothing.
    expect(note.hasAttribute('tabindex')).toBe(false)
    expect(note.contains(document.activeElement)).toBe(false)
    typeWhat('Tomatoes'); tap('door-place-id:loc-3'); save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
  })

  it('Raw with its line for hot sauce, pesto and Other; How dry? for Dehydrate and Powder, nothing preselected', async () => {
    await openDoor()
    tap('door-method-more')
    for (const m of ['hot_sauce', 'pesto', 'other']) {
      tap(`door-method-${m}`)
      expect(screen.getByTestId('door-raw').getAttribute('aria-pressed')).toBe('false')
      expect(screen.getByTestId('door-raw-hint').textContent).toBe('Raw: fresh — not cooked, pickled or fermented.')
      expect(screen.getByRole('group', { name: 'Raw' }).contains(screen.getByTestId('door-raw'))).toBe(true)
      expect(screen.getByTestId('door-method-slot').contains(screen.queryByTestId('door-inoil'))).toBe(false)   // In oil is not in the slot
    }
    for (const m of ['dehydrate', 'powder']) {
      tap(`door-method-${m}`)
      const dry = screen.getByRole('group', { name: 'How dry?' })
      expect(within(dry).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed'), b.getAttribute('data-testid')])).toEqual([
        ['Snaps', 'false', 'door-texture-snaps'], ['Bends', 'false', 'door-texture-bends'], ['Still soft', 'false', 'door-texture-still_soft']])
      expect(screen.queryByTestId('door-raw')).toBeNull()
    }
  })

  it('sits directly under the method row and above How many; a method tap brings it into view and does not move focus', async () => {
    const seen = []
    Element.prototype.scrollIntoView = function scrollIntoView(o) { seen.push([this.getAttribute('data-testid'), o]) }
    await openDoor()
    const before = document.activeElement
    tap('door-method-can_water_bath')
    const slot = screen.getByTestId('door-method-slot')
    expect(after(screen.getByTestId('door-methods'), slot)).toBe(true)
    expect(after(slot, screen.getByTestId('door-count-count'))).toBe(true)
    expect(seen).toEqual([['door-method-slot', { block: 'nearest' }]])
    expect(document.activeElement).toBe(before)
    tap('door-method-ferment')                                                // a method with nothing to show: nothing to bring
    expect(seen).toHaveLength(1)
  })
})

describe('Raw · In oil · How dry reach the preview and the body', () => {
  it('Raw at a fridge changes the preview to no date, says why, and names the control that sets one', async () => {
    await openDoor()
    answer('hot_sauce', 'door-place-id:loc-3', 'Reaper sauce')
    expect(preview()).toBe('put up Oct 1 · discard by Apr 1, 2027 · general figure: hot sauce, fridge')
    tap('door-raw')
    expect(screen.getByTestId('door-raw').getAttribute('aria-pressed')).toBe('true')
    expect(preview()).toBe('put up Oct 1 · no date — no general figure for raw or in-oil food. Set your own under Discard by.')
    tap('door-raw')
    tap('door-more'); tap('door-inoil')
    expect(preview()).toBe('put up Oct 1 · no date — no general figure for raw or in-oil food. Set your own under Discard by.')
    expect(screen.getByRole('group', { name: 'In oil' }).contains(screen.getByTestId('door-inoil'))).toBe(true)
    // In oil sits between When and Discard by.
    const panel = screen.getByTestId('door-more-panel')
    expect(after(within(panel).getByRole('radiogroup', { name: 'When?' }), screen.getByTestId('door-inoil'))).toBe(true)
    expect(after(screen.getByTestId('door-inoil'), within(panel).getByRole('radiogroup', { name: 'Discard by' }))).toBe(true)
    expect(posts('/api/preservation')).toEqual([])                             // a tap on a chip writes nothing
  })

  it('every other no-date cause keeps the standing sentence — the new one is only for a date Raw or In oil removed', () => {
    const fridge = { kind: 'fridge', label: 'Kitchen fridge' }
    const shelf = { kind: 'pantry', label: 'Pantry shelf' }
    const standing = 'put up Oct 1 · no date — check it before using'
    // Pesto has no figure at a fridge with or without Raw: Raw removed nothing.
    expect(previewLine({ method: 'pesto', place: fridge, when: TODAY, now: NOW })).toBe(standing)
    expect(previewLine({ method: 'pesto', place: fridge, when: TODAY, isRaw: true, inOil: true, now: NOW })).toBe(standing)
    // A dried put-up that bends: the texture removed it, and stays the cause with In oil tapped as well.
    expect(previewLine({ method: 'dehydrate', place: shelf, when: TODAY, texture: 'snaps', now: NOW })).toMatch(/· discard by .+ · general figure: dehydrated, pantry shelf$/)
    expect(previewLine({ method: 'dehydrate', place: shelf, when: TODAY, texture: 'bends', now: NOW })).toBe(standing)
    expect(previewLine({ method: 'dehydrate', place: shelf, when: TODAY, texture: 'bends', inOil: true, now: NOW })).toBe(standing)
    expect(previewLine({ method: 'dehydrate', place: shelf, when: TODAY, texture: 'snaps', inOil: true, now: NOW }))
      .toBe(`put up Oct 1 · ${RAW_OIL_NO_DATE_WORDS}`)
    // A texture on a method that is not dried is not read.
    expect(previewLine({ method: 'hot_sauce', place: fridge, when: TODAY, texture: 'still_soft', now: NOW }))
      .toBe(previewLine({ method: 'hot_sauce', place: fridge, when: TODAY, now: NOW }))
    // "Not sure" of the date; a typed date; a chosen "No date".
    expect(previewLine({ method: 'hot_sauce', place: fridge, when: { date: '2026-10-01', precision: 'unknown' }, isRaw: true, now: NOW }))
      .toBe('put up: not sure · no date — check it before using')
    expect(previewLine({ method: 'hot_sauce', place: fridge, when: TODAY, isRaw: true, discard: { mode: 'none', date: '' }, now: NOW }))
      .toBe('put up Oct 1 · no date · set by hand')
    // In a freezer the date is worked out all the same.
    expect(previewLine({ method: 'hot_sauce', place: { kind: 'deep_freezer', label: 'Chest' }, when: TODAY, isRaw: true, inOil: true, now: NOW }))
      .toMatch(/· discard by .+ · general figure: hot sauce, deep freezer$/)
  })

  it('How dry?: Bends removes the worked-out date in the preview, texture is sent, and a second tap un-chooses it', async () => {
    const { onSaved } = await openDoor()
    answer('dehydrate', 'door-place-new:pantry:pantry shelf', 'Apple rings')
    expect(preview()).toMatch(/^put up Oct 1 · discard by .+ · general figure: dehydrated, pantry shelf$/)
    tap('door-texture-bends')
    expect(preview()).toBe('put up Oct 1 · no date — check it before using')
    tap('door-texture-bends')
    expect(screen.getByTestId('door-texture-bends').getAttribute('aria-pressed')).toBe('false')
    expect(preview()).toMatch(/general figure: dehydrated, pantry shelf$/)
    tap('door-texture-still_soft')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ method: 'dehydrate', texture: 'still_soft' })
  })

  it('a texture chosen, then a method that is not dried: the chips are gone and texture is not sent', async () => {
    const { onSaved } = await openDoor()
    answer('dehydrate', 'door-place-id:loc-3', 'Apple rings')
    tap('door-texture-bends')
    tap('door-method-ferment')
    expect(screen.queryByTestId('door-texture')).toBeNull()
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect('texture' in posts('/api/preservation')[0].body).toBe(false)
  })
})

describe('Size of each container', () => {
  it('one quiet 48 px link under How many opens the field in place, with focus on it', async () => {
    await openDoor()
    expect(screen.queryByTestId('door-size-open')).toBeNull()                 // no method, no How many, no link
    answer('whole_freeze')
    const link = screen.getByTestId('door-size-open')
    expect(link.textContent).toBe('＋ Size of each container')
    expect(parseInt(link.style.minHeight, 10)).toBe(48)
    expect(after(screen.getByTestId('door-count-count'), link)).toBe(true)
    expect(after(link, screen.getByTestId('door-more'))).toBe(true)
    expect(screen.queryByTestId('door-size-value')).toBeNull()
    tap('door-size-open')
    expect(screen.queryByTestId('door-size-open')).toBeNull()
    const input = screen.getByTestId('door-size-value')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getByLabelText('Size of each container')).toBe(input)
    expect([input.getAttribute('type'), input.getAttribute('inputmode'), input.getAttribute('enterkeyhint'), input.getAttribute('placeholder')])
      .toEqual(['text', 'decimal', 'done', 'e.g. 1'])
    expect(within(screen.getByTestId('door-size-units')).getAllByRole('radio').map(r => r.textContent)).toEqual(['cup', 'pint', 'qt', 'fl oz', 'lb', 'oz (weight)'])
    expect(screen.getByTestId('door-size-unit-more').textContent).toBe('More units…')
    // The block is marked to be cleared of the pinned Save WHOLE: the field and its unit chips.
    expect(screen.getByTestId('door-size').hasAttribute('data-clear-whole')).toBe(true)
    expect(screen.getByTestId('door-size').contains(screen.getByTestId('door-size-units'))).toBe(true)
  })

  it('0.5 pint × 3 sends 1.5 pint — the total, a JSON number', async () => {
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    tap('door-count-plus'); tap('door-count-plus')
    tap('door-size-open')
    typeInto('door-size-value', '0.5'); tap('door-size-unit-pint')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const body = posts('/api/preservation')[0].body
    expect([body.quantity_value, body.quantity_unit, body.package_count]).toEqual([1.5, 'pint', 3])
    expect(typeof body.quantity_value).toBe('number')
    expect(posts('/api/pantry/items')).toEqual([])
  })

  it('the echo says both numbers once How many is above 1, in a status line; the preview does not gain the amount', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-size-open')
    typeInto('door-size-value', '1'); tap('door-size-unit-qt')
    const echo = screen.getByTestId('door-size-echo')
    expect([echo.getAttribute('role'), echo.textContent]).toEqual(['status', ''])
    const line = preview()
    tap('door-count-plus'); tap('door-count-plus')
    expect(echo.textContent).toBe('3 × 1 qt = 3 qt in all')
    typeInto('door-size-value', '0,83')
    expect(echo.textContent).toBe('3 × 0.83 qt = 2.49 qt in all')
    expect(preview()).toBe(line)
    tap('door-size-clear')
    expect([echo.textContent, screen.getByTestId('door-size-value').value]).toEqual(['', ''])
  })

  it.each([
    ['a number with no unit', '2', null, 'Pick a unit for the size — or clear the size.'],
    ['a unit with no number', '', 'door-size-unit-qt', 'Type the size as a number above 0 — or clear the size.'],
    ['a unit with a 0', '0', 'door-size-unit-qt', 'Type the size as a number above 0 — or clear the size.'],
  ])('a half-filled size is refused in place — %s: its sentence, focus on the number, nothing sent', async (_n, value, unitChip, sentence) => {
    await openDoor()
    answer('whole_freeze')
    tap('door-size-open')
    typeInto('door-size-value', value)
    if (unitChip) tap(unitChip)
    screen.getByTestId('door-save').focus()
    save()
    expect(errorText()).toBe(sentence)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('door-size-value')))
    expect(screen.getByTestId('door-size-value').getAttribute('aria-invalid')).toBe('true')
    expect(fake.calls('POST')).toEqual([])
    // Cleared, it saves — with no size key at all.
    tap('door-size-clear')
    expect(errorText()).toBeNull()
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(Object.keys(posts('/api/preservation')[0].body).filter(k => k.startsWith('quantity_'))).toEqual([])
  })

  it('a total past what the column holds is refused in place, before any request', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-count-plus')
    tap('door-size-open'); tap('door-size-unit-more')
    typeInto('door-size-value', '50000000'); tap('door-size-unit-g')
    save()
    expect(errorText()).toBe(SIZE_TOTAL_TOO_BIG_TEXT)
    expect(fake.calls('POST')).toEqual([])
  })

  it('three answers and Save: exactly these eight keys, no size key, no use_by_target', async () => {
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(Object.keys(posts('/api/preservation')[0].body).sort()).toEqual([
      'idempotency_key', 'label', 'method', 'package_count', 'preserved_at', 'preserved_at_approx', 'preserved_at_precision', 'storage_location_id'])
  })
})

describe('How much — the as-is amount', () => {
  it('after As is: "＋ How much" where the size link sits, the amount\'s own units, no count and no echo', async () => {
    await openDoor()
    answer('as_is', 'door-place-id:loc-3', 'Rice')
    expect(screen.queryByTestId('door-size-open')).toBeNull()
    expect(screen.queryByTestId('door-count-count')).toBeNull()
    const link = screen.getByTestId('door-amount-open')
    expect(link.textContent).toBe('＋ How much')
    expect(parseInt(link.style.minHeight, 10)).toBe(48)
    expect(after(screen.getByTestId('door-methods'), link)).toBe(true)
    expect(after(link, screen.getByTestId('door-more'))).toBe(true)
    tap('door-amount-open')
    const input = screen.getByTestId('door-amount-value')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getByLabelText('How much')).toBe(input)
    expect(input.getAttribute('placeholder')).toBe('e.g. 2')
    expect(within(screen.getByTestId('door-amount-units')).getAllByRole('radio').map(r => r.textContent)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt'])
    expect(screen.queryByTestId('door-size-echo')).toBeNull()
    expect(screen.getByTestId('door-amount').hasAttribute('data-clear-whole')).toBe(true)
    typeInto('door-amount-value', '2'); tap('door-amount-unit-bag')
    // Nothing on this door ever says "left" after an amount: it is what was got, not what remains.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bleft\b/i)
    expect(screen.getByTestId('door-more').textContent).toBe('▸ Date, discard by')
  })

  it('Fresh, as picked is offered the amount too; it is sent as a JSON number with its unit, beside the planting and no source', async () => {
    const { onSaved } = await openDoor({ initialWhat: PLANTING })
    tap('door-place-id:loc-3')
    expect(screen.getByTestId('door-method-as_is').textContent).toBe('Fresh, as picked')
    tap('door-method-as_is')
    tap('door-amount-open')
    typeInto('door-amount-value', '2,345'); tap('door-amount-unit-lb')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect({ ...posts('/api/pantry/items')[0].body, idempotency_key: 'K' }).toEqual({
      idempotency_key: 'K', name: 'Megatron jalapeño', storage_location_id: 'loc-3', acquired_at: '2026-10-01', acquired_precision: 'day',
      plant_id: 'p1', crop_type_slug: 'pepper', quantity_value: 2.35, quantity_unit: 'lb',
    })
  })

  it.each([
    ['a number with no unit', '2', null, 'Pick a unit for the amount — or clear the amount.'],
    ['a unit with no number', '', 'door-amount-unit-lb', 'Type the amount as a number above 0 — or clear the amount.'],
  ])('a half-filled amount is refused in place — %s', async (_n, value, unitChip, sentence) => {
    await openDoor()
    answer('as_is', 'door-place-id:loc-3', 'Rice')
    tap('door-amount-open')
    typeInto('door-amount-value', value)
    if (unitChip) tap(unitChip)
    screen.getByTestId('door-save').focus()
    save()
    expect(errorText()).toBe(sentence)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('door-amount-value')))
    expect(fake.calls('POST')).toEqual([])
  })
})

describe('the size and the amount are separate cells (twin row 8)', () => {
  it('a method with How many 3, a size, Raw, In oil and where-from; then As is; Save: one item POST with exactly the item\'s keys, and no put-up POST', async () => {
    const { onSaved } = await openDoor()
    answer('hot_sauce', 'door-place-id:loc-3', 'Reaper sauce')
    tap('door-count-plus'); tap('door-count-plus')
    tap('door-size-open'); typeInto('door-size-value', '1'); tap('door-size-unit-qt')
    tap('door-raw')
    tap('door-more'); tap('door-inoil')
    tap('door-from'); tap('door-source-farm_stand'); typeInto('door-source-label', 'Warner Farms')
    tap('door-method-as_is')
    // The size did NOT become the amount: 1 qt × 3 must not read "How much: 1 qt".
    expect(screen.queryByTestId('door-size-value')).toBeNull()
    expect(screen.queryByTestId('door-amount-value')).toBeNull()
    expect(screen.getByTestId('door-amount-open')).toBeTruthy()
    expect([screen.queryByTestId('door-raw'), screen.queryByTestId('door-inoil')]).toEqual([null, null])
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/preservation')).toEqual([])
    expect(posts('/api/pantry/items')).toHaveLength(1)
    expect({ ...posts('/api/pantry/items')[0].body, idempotency_key: 'K' }).toEqual({
      idempotency_key: 'K', name: 'Reaper sauce', storage_location_id: 'loc-3', acquired_at: '2026-10-01', acquired_precision: 'day',
      source_kind: 'farm_stand', source_label: 'Warner Farms',
    })
    expect(onSaved.mock.calls[0][0].route).toBe('item')
  })

  it('each comes back when its route is chosen again', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-size-open'); typeInto('door-size-value', '1'); tap('door-size-unit-qt')
    tap('door-method-as_is')
    tap('door-amount-open'); typeInto('door-amount-value', '5'); tap('door-amount-unit-lb')
    tap('door-method-whole_freeze')
    expect([screen.getByTestId('door-size-value').value, screen.getByTestId('door-size-unit-qt').getAttribute('aria-checked')]).toEqual(['1', 'true'])
    expect(screen.queryByTestId('door-amount-value')).toBeNull()
    tap('door-method-as_is')
    expect([screen.getByTestId('door-amount-value').value, screen.getByTestId('door-amount-unit-lb').getAttribute('aria-checked')]).toEqual(['5', 'true'])
  })
})

describe('the two disclosures', () => {
  it('A is named for what it holds: in oil for a put-up method; not for As is, and not before a method', async () => {
    await openDoor()
    const more = screen.getByTestId('door-more')
    expect(more.textContent).toBe('▸ Date, discard by')
    tap('door-method-ferment')
    expect(more.textContent).toBe('▸ Date, discard by, in oil')
    tap('door-more')
    expect(more.textContent).toBe('▾ Date, discard by, in oil')
    expect(screen.getByTestId('door-inoil')).toBeTruthy()
    tap('door-method-as_is')
    expect(more.textContent).toBe('▾ Date, discard by')
    expect(screen.queryByTestId('door-inoil')).toBeNull()
  })

  it('B holds where-from, then Notes; its heading and the notes prompt follow the method', async () => {
    await openDoor()
    const from = screen.getByTestId('door-from')
    expect(after(screen.getByTestId('door-more'), from)).toBe(true)
    expect([from.textContent, from.getAttribute('aria-expanded')]).toEqual(['▸ Where from, notes', 'false'])
    expect(screen.queryByTestId('door-from-panel')).toBeNull()
    tap('door-from')
    const panel = screen.getByTestId('door-from-panel')
    expect(within(panel).getByRole('radiogroup', { name: "Where it's from" })).toBe(screen.getByTestId('door-source'))
    expect(after(screen.getByTestId('door-source'), screen.getByTestId('door-notes'))).toBe(true)
    expect(within(screen.getByTestId('door-source')).getAllByRole('radio').map(r => r.textContent)).toEqual(['My garden', 'Farm stand', 'Store', 'Gift'])
    expect(screen.getByTestId('door-notes').getAttribute('placeholder')).toBe('Anything to remember')
    tap('door-method-ferment')
    expect(within(panel).getByRole('radiogroup', { name: 'Made with produce from' })).toBe(screen.getByTestId('door-source'))
    expect(screen.getByTestId('door-notes').getAttribute('placeholder')).toBe('Recipe you followed, or anything to remember')
    tap('door-method-as_is')
    expect(within(panel).getByRole('radiogroup', { name: "Where it's from" })).toBe(screen.getByTestId('door-source'))
    expect(screen.getByTestId('door-notes').getAttribute('placeholder')).toBe('Anything to remember')
  })

  it('a put-up sends where it is from: the kind and its typed name; the garden sends the kind alone; a second tap un-chooses', async () => {
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    tap('door-from'); tap('door-source-farm_stand')
    expect(screen.getByLabelText(/^Which one\?/).getAttribute('data-testid')).toBe('door-source-label')
    typeInto('door-source-label', '  Warner Farms ')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ source_kind: 'farm_stand', source_label: 'Warner Farms' })
  })

  it('My garden sends own_garden and no name; un-chosen, neither key', async () => {
    const first = await openDoor()
    answer('whole_freeze')
    tap('door-from'); tap('door-source-own_garden')
    expect(screen.queryByTestId('door-source-label')).toBeNull()
    save()
    await waitFor(() => expect(first.onSaved).toHaveBeenCalledTimes(1))
    const sent = posts('/api/preservation')[0].body
    expect([sent.source_kind, 'source_label' in sent]).toEqual(['own_garden', false])
    first.unmount()

    const second = await openDoor()
    answer('whole_freeze')
    tap('door-from'); tap('door-source-store'); tap('door-source-store')
    save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(Object.keys(posts('/api/preservation')[1].body).filter(k => k.startsWith('source_'))).toEqual([])
  })

  it('Other with no name: its sentence, B opens, focus on the name — and nothing is sent', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-from'); tap('door-source-more'); tap('door-source-other')
    tap('door-from')                                                          // closed again, the choice kept unseen
    expect(screen.queryByTestId('door-from-panel')).toBeNull()
    screen.getByTestId('door-save').focus()
    save()
    expect(errorText()).toBe(WHERE_EXACTLY_ERROR)
    expect(errorText()).toBe('Where exactly is it from? Type it — or pick another.')
    expect(screen.getByTestId('door-from').getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('door-source-label')))
    expect(screen.getByTestId('door-source-label').getAttribute('aria-invalid')).toBe('true')
    expect(fake.calls('POST')).toEqual([])
    typeInto('door-source-label', 'a neighbour')
    expect(errorText()).toBeNull()
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ source_kind: 'other', source_label: 'a neighbour' })
  })

  it('a method change: between put-up methods the choice stays as it is; between As is and a put-up method it stays and B opens', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-from'); tap('door-source-gift'); typeInto('door-source-label', 'Aunt May')
    tap('door-from')                                                          // closed
    tap('door-method-blanch_freeze')
    expect(screen.getByTestId('door-from').getAttribute('aria-expanded')).toBe('false')     // put-up → put-up: nothing opens
    tap('door-method-as_is')
    expect(screen.getByTestId('door-from').getAttribute('aria-expanded')).toBe('true')      // put-up → As is: it opens
    expect(screen.getByRole('radiogroup', { name: "Where it's from" })).toBeTruthy()
    expect([screen.getByTestId('door-source-gift').getAttribute('aria-checked'), screen.getByTestId('door-source-label').value]).toEqual(['true', 'Aunt May'])
    tap('door-from')
    tap('door-method-blanch_freeze')
    expect(screen.getByTestId('door-from').getAttribute('aria-expanded')).toBe('true')      // As is → put-up: it opens
    expect(screen.getByRole('radiogroup', { name: 'Made with produce from' })).toBeTruthy()
    expect(screen.getByTestId('door-source-label').value).toBe('Aunt May')
  })

  it('with nothing chosen, a change between As is and a method opens nothing', async () => {
    await openDoor()
    answer('whole_freeze')
    tap('door-method-as_is')
    expect(screen.getByTestId('door-from').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a planting What has no where-from row', () => {
  it('opened from a planting: B reads "Notes" and holds notes alone; the put-up route sends plant_id, its crop and variety and own_garden', async () => {
    const { onSaved } = await openDoor({ initialWhat: PLANTING })
    expect(screen.getByTestId('door-from').textContent).toBe('▸ Notes')
    tap('door-from')
    expect(screen.queryByTestId('door-source')).toBeNull()
    expect(within(screen.getByTestId('door-from-panel')).getByRole('textbox', { name: 'Notes' })).toBeTruthy()
    tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const body = posts('/api/preservation')[0].body
    expect([body.plant_id, body.crop_type_slug, body.variety_id, body.source_kind, 'source_label' in body]).toEqual(['p1', 'pepper', 'v1', 'own_garden', false])
  })

  it('when the What becomes a planting hit the row goes and the choice is dropped — it does not come back with a typed name', async () => {
    const { onSaved } = await openDoor()
    typeWhat('mega')
    tap('door-from'); tap('door-source-farm_stand'); typeInto('door-source-label', 'Warner Farms')
    fireEvent.click(await screen.findByTestId('door-what-hit-planting:p-mj', {}, { timeout: 2000 }))
    expect(screen.getByTestId('door-from').textContent).toBe('▾ Notes')
    expect(screen.queryByTestId('door-source')).toBeNull()
    tap('door-what-change')                                                   // the hit dropped: a typed name again
    expect(screen.getByTestId('door-from').textContent).toBe('▾ Where from, notes')
    expect(within(screen.getByTestId('door-source')).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
    tap('door-place-id:loc-1'); tap('door-method-whole_freeze')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(Object.keys(posts('/api/preservation')[0].body).filter(k => k.startsWith('source_'))).toEqual([])
  })
})

describe('the six kinds of place', () => {
  it('"＋ Somewhere else" offers six kinds, a Fridge freezer and a Deep freezer among them, and none reads a bare Freezer', async () => {
    await openDoor()
    tap('door-place-new')
    const kinds = within(screen.getByRole('radiogroup', { name: 'What kind of place?' })).getAllByRole('radio')
    expect(kinds.map(k => [k.textContent, k.getAttribute('data-testid')])).toEqual([
      ['Fridge', 'door-place-new-kind-fridge'], ['Fridge freezer', 'door-place-new-kind-fridge_freezer'],
      ['Deep freezer', 'door-place-new-kind-deep_freezer'], ['Pantry shelf', 'door-place-new-kind-pantry'],
      ['Cellar', 'door-place-new-kind-cold_storage'], ['Counter or other', 'door-place-new-kind-other']])
  })

  it('the Fridge freezer chip makes a fridge_freezer, and Freeze whole there previews its own figure: 4 months, not 12', async () => {
    const { onSaved } = await openDoor()
    typeWhat('Corn')
    // The household has two deep freezers and a fridge: templates for the kinds it has none of.
    expect(within(screen.getByTestId('door-places')).getAllByRole('radio').map(r => r.textContent))
      .toEqual(['Chest Freezer 1', 'Chest Freezer 2', 'Kitchen fridge', 'Fridge freezer', 'Pantry shelf', 'Counter'])
    tap('door-place-new:fridge_freezer:fridge freezer')
    tap('door-method-whole_freeze')
    expect(preview()).toBe('put up Oct 1 · discard by Feb 1, 2027 · general figure: whole freeze, fridge freezer')
    tap('door-place-id:loc-1')
    expect(preview()).toBe('put up Oct 1 · discard by Oct 1, 2027 · general figure: whole freeze, deep freezer')
    tap('door-place-new:fridge_freezer:fridge freezer')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/storage-locations').map(c => c.body)).toEqual([{ label: 'Fridge freezer', kind: 'fridge_freezer' }])
    expect(onSaved.mock.calls[0][0].place).toMatchObject({ kind: 'fridge_freezer', label: 'Fridge freezer' })
  })

  it('a household with no place at all is offered five templates, two of them freezers by their own names', () => {
    expect(placeChips([]).map(c => [c.label, c.kind, c.key])).toEqual([
      ['Fridge', 'fridge', 'new:fridge:fridge'], ['Fridge freezer', 'fridge_freezer', 'new:fridge_freezer:fridge freezer'],
      ['Deep freezer', 'deep_freezer', 'new:deep_freezer:deep freezer'], ['Pantry shelf', 'pantry', 'new:pantry:pantry shelf'],
      ['Counter', 'other', 'new:other:counter']])
  })
})

describe('the draft carries every new field', () => {
  // A literal copy of the shape check the door shipped with at v4.169.
  const isDoorDraftV4169 = (d) => !!d && typeof d === 'object'
    && (d.key == null || typeof d.key === 'string')
    && (d.what == null || (typeof d.what === 'object' && typeof d.what.name === 'string'))
    && (d.method == null || typeof d.method === 'string')
    && typeof d.count === 'string'
    && (d.place == null || (typeof d.place === 'object' && typeof d.place.key === 'string'))

  it('size, unit, where-from, Raw, In oil and the count come back after a remount', async () => {
    const first = await openDoor()
    answer('hot_sauce', 'door-place-id:loc-3', 'Reaper sauce')
    tap('door-count-plus')
    tap('door-size-open'); typeInto('door-size-value', '8'); tap('door-size-unit-fl oz')
    tap('door-raw')
    tap('door-more'); tap('door-inoil')
    tap('door-from'); tap('door-source-store'); typeInto('door-source-label', 'Costco')
    await waitFor(() => expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)?.sourceLabel).toBe('Costco'))
    const written = readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)
    expect(written).toMatchObject({ sizeValue: '8', sizeUnit: 'fl oz', amountValue: '', amountUnit: null, sourceKind: 'store', sourceLabel: 'Costco', isRaw: true, inOil: true, texture: null })
    // A record written by R2a passes the check the door shipped with before it (a forward undo restores the subset).
    expect(isDoorDraftV4169(written)).toBe(true)
    first.unmount()

    const { onSaved } = await openDoor()
    expect(screen.getByTestId('door-size-value').value).toBe('8')              // the size block opens on a stored size
    expect(screen.getByTestId('door-size-unit-fl oz').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('door-size-echo').textContent).toBe('2 × 8 fl oz = 16 fl oz in all')
    expect(screen.getByTestId('door-raw').getAttribute('aria-pressed')).toBe('true')
    expect(preview()).toBe(`put up Oct 1 · ${RAW_OIL_NO_DATE_WORDS}`)
    tap('door-more'); tap('door-from')
    expect(screen.getByTestId('door-inoil').getAttribute('aria-pressed')).toBe('true')
    expect([screen.getByTestId('door-source-store').getAttribute('aria-checked'), screen.getByTestId('door-source-label').value]).toEqual(['true', 'Costco'])
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({
      idempotency_key: written.key, package_count: 2, quantity_value: 16, quantity_unit: 'fl oz', is_raw: true, in_oil: true,
      source_kind: 'store', source_label: 'Costco',
    })
  })

  it('the texture and the as-is amount come back too', async () => {
    const first = await openDoor()
    answer('dehydrate', 'door-place-id:loc-3', 'Apple rings')
    tap('door-texture-bends')
    tap('door-method-as_is')
    tap('door-amount-open'); typeInto('door-amount-value', '2'); tap('door-amount-unit-bag')
    await waitFor(() => expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)?.amountUnit).toBe('bag'))
    expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)).toMatchObject({ texture: 'bends', amountValue: '2', amountUnit: 'bag' })
    first.unmount()
    await openDoor()
    expect([screen.getByTestId('door-amount-value').value, screen.getByTestId('door-amount-unit-bag').getAttribute('aria-checked')]).toEqual(['2', 'true'])
    tap('door-method-more'); tap('door-method-dehydrate')
    expect(screen.getByTestId('door-texture-bends').getAttribute('aria-pressed')).toBe('true')
  })

  it('the new keys are optional and typed: a wrong type is dropped; a value outside today\'s lists is read as none chosen', async () => {
    const base = { key: null, what: { source: 'typed', name: 'Kale' }, place: null, method: 'whole_freeze', count: '1' }
    expect(isDoorDraft(base)).toBe(true)
    expect(isDoorDraft({ ...base, sizeValue: '1', sizeUnit: 'qt', amountValue: '', amountUnit: null, sourceKind: null, sourceLabel: '', isRaw: false, inOil: true, texture: null })).toBe(true)
    for (const bad of [{ sizeValue: 1 }, { sizeUnit: 3 }, { amountValue: 2 }, { amountUnit: {} }, { sourceKind: 7 }, { sourceLabel: [] }, { isRaw: 'yes' }, { inOil: 1 }, { texture: true }]) {
      expect(`${JSON.stringify(bad)}: ${isDoorDraft({ ...base, ...bad })}`).toBe(`${JSON.stringify(bad)}: false`)
    }
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, { ...base, sizeValue: '2', sizeUnit: 'quart', sourceKind: 'swap', sourceLabel: 'x', texture: 'crunchy' })
    await openDoor()
    expect(within(screen.getByTestId('door-size-units')).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
    tap('door-from')
    expect(within(screen.getByTestId('door-source')).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
  })
})

describe('the retry key — a new one only after an answered 4xx', () => {
  const keys = () => posts('/api/preservation').map(c => c.body.idempotency_key)

  it('a POST that lands and then throws with no status, the note edited, Save: the retry carries the SAME key', async () => {
    let n = 0
    wire({ overrides: { 'POST /api/preservation': ({ body }) => {
      if (++n === 1) throw new TypeError('Failed to fetch')                   // the row landed; its answer was lost
      return { id: 'jar-1', ...body, replayed: true }
    } } })
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    save()
    await waitFor(() => expect(errorText()).toBe("Couldn't save it — nothing was lost. Try again."))
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(keys()[1]).toBe(keys()[0])
  })

  it.each([[500], [503], [0]])('a %i keeps the key', async (status) => {
    let n = 0
    wire({ overrides: { 'POST /api/preservation': ({ body }) => {
      if (++n === 1) throw apiError(status, { error: 'boom' })
      return { id: 'jar-1', ...body }
    } } })
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    save()
    await waitFor(() => expect(errorText()).not.toBeNull())
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[1]).toBe(keys()[0])
  })

  it('refused with a 400, the count is changed, Save: a new key', async () => {
    let n = 0
    wire({ overrides: { 'POST /api/preservation': ({ body }) => {
      if (++n === 1) throw apiError(400, { error: 'package_count must be >= 1' })
      return { id: 'jar-1', ...body }
    } } })
    const { onSaved } = await openDoor()
    answer('whole_freeze')
    save()
    await waitFor(() => expect(errorText()).toBe('package_count must be >= 1'))  // an uncoded 400 reads the server's own sentence
    tap('door-count-plus')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(keys()[1]).not.toBe(keys()[0])
    expect(keys()[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // … and the draft holds the new key, so a reload between the refusal and the retry does not resurrect the old one.
    expect(posts('/api/preservation')[1].body.package_count).toBe(2)
  })

  it('with replayed: true the completion is built from the server\'s row — a numeric it answers as text reads right', async () => {
    const SERVER_ROW = {
      id: 'jar-9', label: 'Corn (as first saved)', method: 'whole_freeze', package_count: 3, quantity_value: '2.49', quantity_unit: 'qt',
      preserved_at: '2026-10-01', preserved_at_precision: 'day', use_by_target: '2027-10-01', use_by_basis: 'table', replayed: true,
    }
    wire({ overrides: { 'POST /api/preservation': () => SERVER_ROW } })
    const { onSaved } = await openDoor()
    answer('whole_freeze', 'door-place-id:loc-1', 'Corn, edited since')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const told = onSaved.mock.calls[0][0]
    expect(told.saved).toEqual(SERVER_ROW)
    expect(completionWords({ route: told.route, saved: told.saved, place: told.place, now: NOW }))
      .toBe('Corn (as first saved) — put up · Chest Freezer 1 · discard by Oct 1, 2027 · general figure: whole freeze, deep freezer')
    expect([qtyText(told.saved.quantity_value), sizeWords(told.saved)]).toEqual(['2.49', '2.49 qt in all'])
  })
})

describe('a restored place is re-resolved against the list read at open', () => {
  const DRAFT = (place, over = {}) => ({ key: '11111111-1111-4111-8111-111111111111', what: { source: 'typed', name: 'Kale' }, place, method: 'whole_freeze', count: '1', ...over })

  it('a draft whose place was deleted: no place chosen, no POST', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, DRAFT({ key: 'id:loc-gone', id: 'loc-gone', label: 'Garage shelf', kind: 'pantry' }))
    await openDoor()
    const places = within(screen.getByTestId('door-places')).getAllByRole('radio')
    expect(places.map(r => r.textContent)).not.toContain('Garage shelf')
    expect(places.filter(r => r.getAttribute('aria-checked') === 'true')).toEqual([])
    save()
    expect(errorText()).toBe(WHERE_REQUIRED_TEXT)
    await new Promise(r => setTimeout(r, 0))
    expect(fake.calls('POST')).toEqual([])
  })

  it('a place whose kind changed: the live kind — its method chips, and the date worked out for it', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, DRAFT({ key: 'id:loc-3', id: 'loc-3', label: 'Kitchen fridge', kind: 'deep_freezer' }, { method: 'hot_sauce' }))
    await openDoor()
    await waitFor(() => expect(preview()).toBe('put up Oct 1 · discard by Apr 1, 2027 · general figure: hot sauce, fridge'))
    expect(screen.getByTestId('door-place-id:loc-3').getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByTestId('door-methods')).getAllByRole('radio').map(r => r.getAttribute('data-testid'))).toContain('door-method-quick_pickle')
  })

  it('the old template chip is not left as a Freezer option: it maps to the current chip of the same kind', async () => {
    const OLD = { key: 'new:deep_freezer:freezer', id: null, label: 'Freezer', kind: 'deep_freezer' }
    // A household with no deep freezer: the stored chip becomes the Deep freezer template.
    wire({ places: [FRIDGE] })
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, DRAFT(OLD))
    const view = render(<PutSomethingUpSheet open now={NOW.getTime()} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByTestId('door-place-id:loc-3')
    const words = () => within(screen.getByTestId('door-places')).getAllByRole('radio').map(r => r.textContent)
    await waitFor(() => expect(screen.getByTestId('door-place-new:deep_freezer:deep freezer').getAttribute('aria-checked')).toBe('true'))
    expect(words()).toEqual(['Kitchen fridge', 'Fridge freezer', 'Deep freezer', 'Pantry shelf', 'Counter'])
    expect(words()).not.toContain('Freezer')
    view.unmount()
    // Pure: with the household's own deep freezers on the list, it is the first of them; with none of that kind, nothing.
    expect(resolveDraftPlace(OLD, placeChips(PLACES))).toMatchObject({ key: 'id:loc-1', kind: 'deep_freezer' })
    expect(resolveDraftPlace(OLD, [])).toBeNull()
  })

  it('a place typed under "＋ Somewhere else", and a template still on offer, stay as they are', () => {
    const chips = placeChips(PLACES)
    const typed = { key: 'new:fridge:garage fridge', id: null, label: 'Garage fridge', kind: 'fridge' }
    expect(resolveDraftPlace(typed, chips)).toBe(typed)
    const template = { key: 'new:pantry:pantry shelf', id: null, label: 'Pantry shelf', kind: 'pantry' }
    expect(resolveDraftPlace(template, chips)).toEqual(template)
    expect(resolveDraftPlace(null, chips)).toBeNull()
    expect(resolveDraftPlace({ key: 'id:loc-2', id: 'loc-2', label: 'Old name', kind: 'deep_freezer' }, chips)).toMatchObject({ id: 'loc-2', label: 'Chest Freezer 2' })
  })

  it('a places read that fails resolves nothing: the stored place stays, and the server judges it', async () => {
    wire({ overrides: { 'GET /api/storage-locations': () => { throw new TypeError('Failed to fetch') } } })
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, DRAFT({ key: 'id:loc-3', id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' }))
    render(<PutSomethingUpSheet open now={NOW.getTime()} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByTestId('door-place-new:fridge:fridge')
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByTestId('door-place-id:loc-3').getAttribute('aria-checked')).toBe('true')
  })
})

describe('first focus on a door opened with a What', () => {
  function deferPlaces() {
    let answerNow
    const gate = new Promise(r => { answerNow = () => r(PLACES) })
    wire({ overrides: { 'GET /api/storage-locations': () => gate } })
    return () => act(async () => { answerNow(); await gate })
  }

  it('moves to the first place chip once the places read has answered — the household\'s own first place, not a template', async () => {
    const answerPlaces = deferPlaces()
    render(<PutSomethingUpSheet open now={NOW.getTime()} onClose={vi.fn()} onSaved={vi.fn()} initialWhat={PLANTING} />)
    // Before the read answers the row holds templates only, and focus is where the sheet put it: on the name's
    // own control (whichever the name field puts first), not on a place.
    expect(screen.getByTestId('door-places').contains(document.activeElement)).toBe(false)
    expect(screen.getByTestId('door-sheet').contains(document.activeElement)).toBe(true)
    await answerPlaces()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('door-place-id:loc-1')))
  })

  it('only if focus is still where the sheet left it, and only once', async () => {
    const answerPlaces = deferPlaces()
    render(<PutSomethingUpSheet open now={NOW.getTime()} onClose={vi.fn()} onSaved={vi.fn()} initialWhat={PLANTING} />)
    screen.getByTestId('door-method-whole_freeze').focus()                    // he has already gone on to the method
    await answerPlaces()
    await screen.findByTestId('door-place-id:loc-1')
    expect(document.activeElement).toBe(screen.getByTestId('door-method-whole_freeze'))
    // Once: a later render with focus back on the name's control does not take it again.
    screen.getByTestId('door-what-change').focus()
    tap('door-method-whole_freeze')
    expect(document.activeElement).toBe(screen.getByTestId('door-what-change'))
  })

  it('a typed seed moves it too; a plain open leaves focus on the name', async () => {
    const seeded = await openDoor({ initialName: 'Garlic' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('door-place-id:loc-1')))
    seeded.unmount()
    await openDoor()
    await new Promise(r => setTimeout(r, 0))
    expect(document.activeElement).toBe(screen.getByTestId('door-what-name'))
  })
})

describe('the pinned Save band', () => {
  it('has its test id, holds Save, and follows the sheet\'s content', async () => {
    await openDoor()
    const footer = screen.getByTestId('door-footer')
    expect(footer.contains(screen.getByTestId('door-save'))).toBe(true)
    expect(footer.style.position).toBe('sticky')
    expect(after(screen.getByTestId('door-sheet'), footer)).toBe(true)
    expect(within(footer).getAllByRole('button')).toEqual([screen.getByTestId('door-save')])      // Save, and nothing beside it
  })
})

describe('no banned word on any state this lane added', () => {
  it('A open and B open on a put-up, More units open, the other four sources open, "Which one?" showing', async () => {
    await openDoor()
    answer('hot_sauce', 'door-place-id:loc-3', 'Reaper sauce')
    tap('door-raw')
    tap('door-size-open'); tap('door-size-unit-more'); typeInto('door-size-value', '8'); tap('door-size-unit-fl oz'); tap('door-count-plus')
    tap('door-more'); tap('door-inoil')
    tap('door-from'); tap('door-source-more'); tap('door-source-csa')
    expect(screen.getByLabelText(new RegExp(`^${WHICH_ONE_LABEL.replace('?', '\\?')}`))).toBeTruthy()
    expect(within(screen.getByTestId('door-source')).getAllByRole('radio')).toHaveLength(8)
    expect(within(screen.getByTestId('door-size-units')).getAllByRole('radio')).toHaveLength(16)
    expectClean('put-up, everything open')
    tap('door-source-other')
    save()
    expect(errorText()).toBe(WHERE_EXACTLY_ERROR)
    expectClean('Other with no name')
  })

  it('the As-is fields, every unit showing, and its refusals', async () => {
    await openDoor()
    answer('as_is', 'door-place-id:loc-3', 'Rice')
    tap('door-amount-open'); tap('door-amount-unit-more'); typeInto('door-amount-value', '2')
    expect(within(screen.getByTestId('door-amount-units')).getAllByRole('radio')).toHaveLength(20)
    tap('door-more'); tap('door-from')
    expectClean('as is, everything open')
    save()
    expect(errorText()).toBe('Pick a unit for the amount — or clear the amount.')
    expectClean('as is, a half amount refused')
  })

  it('the canning line, How dry?, and the size refusals', async () => {
    await openDoor()
    answer('can_water_bath', 'door-place-new:pantry:pantry shelf', 'Tomatoes')
    expectClean('canning line')
    tap('door-method-dehydrate'); tap('door-texture-bends')
    expectClean('how dry')
    tap('door-size-open'); typeInto('door-size-value', '2')
    save()
    expect(errorText()).toBe('Pick a unit for the size — or clear the size.')
    expectClean('a half size refused')
  })
})

describe('the seed rule, pure', () => {
  it('the same planting, or — with no planting on either side — the same name once trimmed and case-folded', () => {
    const p = (plant_id, name = 'Sungold cherry') => ({ source: 'planting', name, plant_id })
    const t = (name) => ({ source: 'typed', name })
    expect(sameSeed(p('p1'), p('p1', 'Sungold, renamed'))).toBe(true)
    expect(sameSeed(p('p1'), p('p2'))).toBe(false)                           // two plantings can share a name
    expect(sameSeed(p('p1'), t('Sungold cherry'))).toBe(false)               // a planting and the same words typed are different things
    expect(sameSeed(t('Sungold cherry'), p('p1'))).toBe(false)
    expect(sameSeed(t('  garlic '), t('Garlic'))).toBe(true)
    expect(sameSeed(t('Garlic'), t('Garlic scapes'))).toBe(false)
    expect(sameSeed(t(' '), t(''))).toBe(false)
    expect(sameSeed(t('Garlic'), null)).toBe(false)
  })
})
