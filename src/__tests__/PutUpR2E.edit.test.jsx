// Put-Up R2a, lane E — the jar's Edit panel (RowEditor in src/pages/PutUp.jsx) says what the door says.
//
// REACHED AS A PERSON REACHES IT: the real page, a Pantry row, its sheet, Edit. The editor is not exported
// (it is handed to the row sheet as `JarEditor`), so nothing here mounts it alone.
//
// EVERY PATCH IS JUDGED BY THE LAMBDA'S OWN validateJarPatch before the fake answers it, so a body the
// route would answer 400 to is a refused save here too — a key the route does not take, half of a pair,
// a discard_by that is not a date, "none" or "clear".
//
// Each assertion names the mutation that reds it (brief-lane-e.md, E-M1 to E-M9).
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'
import { METHOD_LABELS, DISCARD_LABELS } from '../components/putup/putItUp.js'
import { DISCARD_DATE_TEXT } from '../components/pantry/putSomethingUp.js'
import { HOUSE_DETAIL_TEXT } from '../components/pantry/PantryRowSheet.jsx'
import { whereFromError, WHERE_EXACTLY_ERROR } from '../components/pantry/WhereFromField.jsx'
import { PUTUP_SOURCE_LABELS as WHERE_FROM_WORDS } from '../lib/dropdownRegistry.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { validateJarPatch } from '../../lambda/preservation/jarRoutes.js'

const CF1 = { id: 'loc-cf1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
// A jar as GET /api/preservation/:id answers it: the amount is the driver's text for a numeric(10,2)
// ("3.00"), the TOTAL of the three containers; a worked-out date with its stored basis; no planting.
const JAR = {
  id: 'rec-e', crop_type_slug: 'zucchini', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-08-10', preserved_at_precision: 'day', preserved_at_approx: null,
  method: 'whole_freeze', method_other_text: null, quantity_value: '3.00', quantity_unit: 'qt', container_label: null,
  package_count: 3, storage_location_id: 'loc-cf1', storage_kind: 'deep_freezer',
  use_by_target: '2027-08-10', use_by_basis: 'table', remaining_count: 3, consumed_at: null, notes: null, photo_id: null,
  use_by_status: 'ok', label: 'Zucchini, shredded', source_kind: null, source_label: null, is_raw: null, in_oil: null,
}

function wire(rec) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([CF1])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ batches: [] })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(rec, CF1)] })
    if (path === `/api/preservation/${rec.id}` && method === 'GET') return Promise.resolve(rec)
    if (path === `/api/preservation/${rec.id}` && method === 'PATCH') {
      const refused = validateJarPatch(JSON.parse(options.body))
      if (refused) return Promise.reject(Object.assign(new Error(refused), { status: 400, body: { error: refused } }))
      return Promise.resolve({ id: rec.id })
    }
    return Promise.resolve(null)
  })
}
// Every write to the jar, of any method: [method, body]. An Edit is ONE PATCH or nothing.
const writes = () => fetchMock.mock.calls
  .filter(([p, o]) => p.startsWith('/api/preservation/') && o?.method && o.method !== 'GET')
  .map(([, o]) => [o.method, JSON.parse(o.body)])

async function openEditor(rec = JAR) {
  wire(rec)
  render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
  fireEvent.click(await screen.findByTestId(`pantry-row-open-put_up:${rec.id}`))
  fireEvent.click(await screen.findByTestId('row-edit'))
  await screen.findByRole('button', { name: 'Save' })
  return screen.getByTestId('jar-edit-panel')
}
// The words a person SEES for a field: its <label>'s text.
const seenLabel = (control) => document.querySelector(`label[for="${control.id}"]`)?.textContent ?? null
// What is seen and what is said, together: one assertion per field, so one cannot change without the other.
const seenAndSaid = (control) => [seenLabel(control), control.getAttribute('aria-label')]

const save = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
// The methods a put-up can be given in Edit (every one but "Bought already preserved").
const METHODS = Object.keys(METHOD_LABELS).filter(m => m !== 'purchased_preserved')

beforeEach(() => {
  fetchMock.mockReset()
  clearReloadBlocks()
  sessionStorage.clear(); localStorage.clear()
})

describe('the labels: what is seen and what is said are one string (UX 3.4)', () => {
  // MUTATION E-M7: change the visible label and not the aria-label (or the reverse) -> the pair differs.
  it('the count reads "How many were put up?", seen and said', async () => {
    await openEditor()
    const count = screen.getByRole('spinbutton', { name: 'How many were put up?' })
    expect(seenAndSaid(count)).toEqual(['How many were put up?', 'How many were put up?'])
    expect(count.value).toBe('3')
  })

  it('the method reads "How was it put up?", seen and said', async () => {
    await openEditor()
    const method = screen.getByRole('combobox', { name: 'How was it put up?' })
    expect(seenAndSaid(method)).toEqual(['How was it put up?', 'How was it put up?'])
    expect(method.value).toBe('whole_freeze')
  })

  // The count sits above the amount: the label says what the number is, and the amount under it is the
  // total of them. The Name stays the panel's first field (the render tool finds the panel by it).
  it('the fields come in the order the panel is read: name, count, amount, unit, method, notes', async () => {
    const panel = await openEditor()
    const ids = [...panel.querySelectorAll('input, select, textarea')].map(el => el.id.replace(`-${JAR.id}`, ''))
    expect(ids).toEqual(['ed-name', 'ed-pkg', 'ed-qty', 'ed-unit', 'ed-method', 'ed-notes'])
  })

  it('the fields that keep their words keep their names', async () => {
    await openEditor({ ...JAR, method: 'other', method_other_text: 'Salt-cured' })
    expect(seenLabel(screen.getByRole('textbox', { name: 'Name' }))).toBe('Nameoptional')
    expect(seenLabel(screen.getByRole('textbox', { name: 'Quantity' }))).toBe('How much in all')
    expect(seenLabel(screen.getByRole('combobox', { name: 'Unit' }))).toBe('Unit')
    expect(seenLabel(screen.getByRole('textbox', { name: 'Method description' }))).toBe('What method?')
    expect(seenLabel(screen.getByRole('textbox', { name: 'Notes' }))).toBe('Notesoptional')
  })
})

describe('the method list says the door\'s words', () => {
  const optionWords = () => Object.fromEntries(
    [...screen.getByRole('combobox', { name: 'How was it put up?' }).options].map(o => [o.value, o.textContent]))

  // MUTATION: read the form's own label (o.label) -> "Freeze (raw / whole)", "Candied", "Other…" come back.
  it('every option reads as putItUp.METHOD_LABELS reads it, and "Bought already preserved" is not offered', async () => {
    await openEditor()
    const { purchased_preserved: bought, ...offered } = METHOD_LABELS
    expect(bought).toBe('Bought already preserved')
    expect(optionWords()).toEqual(offered)
    expect(optionWords().whole_freeze).toBe('Freeze whole')
    expect(optionWords().candy).toBe('Candied (pieces or sweets)')
  })

  // MUTATION: drop it for every row -> a bought row's own method is not in its list and the select
  // shows another one. MUTATION: offer it on every row -> the test above reds.
  it('a row that IS bought already preserved keeps that option, chosen', async () => {
    await openEditor({ ...JAR, method: 'purchased_preserved' })
    expect(optionWords()).toEqual({ ...METHOD_LABELS })
    expect(screen.getByRole('combobox', { name: 'How was it put up?' }).value).toBe('purchased_preserved')
  })

  it('a method change is still one PATCH of the method', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('combobox', { name: 'How was it put up?' }), { target: { value: 'blanch_freeze' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(writes()).toEqual([['PATCH', { method: 'blanch_freeze' }]])
  })
})

// UX F3: the door asks the size of EACH container, Edit asks how much IN ALL, in the same unit. Each
// screen says the other number, so "1 qt" typed for three bags is seen to be a third of a quart each.
describe('the echo under the amount', () => {
  const echo = (id = JAR.id) => screen.getByTestId(`ed-each-${id}`)
  const amount = () => screen.getByRole('textbox', { name: 'Quantity' })
  const count = () => screen.getByRole('spinbutton', { name: 'How many were put up?' })
  const unit = () => screen.getByRole('combobox', { name: 'Unit' })
  const type = (control, value) => fireEvent.change(control, { target: { value } })

  // MUTATION E-M6: drop "about" on a division that is not even -> "0.83 qt each" is said as if exact.
  it('2.5 qt in 3 containers reads about 0.83 qt each; 3 qt in 3 reads 1 qt each', async () => {
    await openEditor()
    expect(echo().textContent).toBe('3 containers · 1 qt each')
    type(amount(), '2.5')
    expect(echo().textContent).toBe('3 containers · about 0.83 qt each')
    // Exact at the column's two places is exact: no "about".
    type(amount(), '3.75')
    expect(echo().textContent).toBe('3 containers · 1.25 qt each')
    // Half a hundredth rounds up, as the column's own rounding does.
    type(amount(), '2.125')
    type(count(), '2')
    expect(echo().textContent).toBe('2 containers · about 1.06 qt each')
  })

  // MUTATION E-M6b: work the echo out from the stored row (the seed) -> it does not move as he types.
  it('change the count: the echo changes before Save', async () => {
    await openEditor()
    type(count(), '2')
    expect(echo().textContent).toBe('2 containers · 1.5 qt each')
    type(unit(), 'quarts')
    expect(echo().textContent).toBe('2 containers · 1.5 quarts each')
    type(amount(), '5')
    expect(echo().textContent).toBe('2 containers · 2.5 quarts each')
    // Nothing was saved, and nothing he did not touch was changed for him.
    expect(writes()).toEqual([])
    type(unit(), 'qt'); type(amount(), '3.00')
    expect(amount().value).toBe('3.00')
    expect(count().value).toBe('2')
  })

  // MUTATION E-M6c: say it with no size, or for one container -> "3 containers ·  each", "1 containers".
  it('no size: no echo', async () => {
    const NO_SIZE = { ...JAR, id: 'rec-nosize', quantity_value: null, quantity_unit: null }
    await openEditor(NO_SIZE)
    expect(echo('rec-nosize').textContent).toBe('')
    // An amount with no unit yet is still no size.
    type(amount(), '3')
    expect(echo('rec-nosize').textContent).toBe('')
    type(unit(), 'quarts')
    expect(echo('rec-nosize').textContent).toBe('3 containers · 1 quarts each')
    // No count, and an amount that is not a number: nothing to say, never "NaN".
    type(count(), '')
    expect(echo('rec-nosize').textContent).toBe('')
    type(count(), '3'); type(amount(), 'a few')
    expect(echo('rec-nosize').textContent).toBe('')
  })

  it('one container: no echo (the amount is that container)', async () => {
    await openEditor({ ...JAR, package_count: 1, remaining_count: 1 })
    expect(echo().textContent).toBe('')
    type(count(), '4')
    expect(echo().textContent).toBe('4 containers · 0.75 qt each')
  })

  // MUTATION: drop the "rounds to nothing" arm -> "3 containers · about 0 qt each".
  it('a share too small to say is not said as 0', async () => {
    await openEditor()
    type(amount(), '0.01')
    expect(echo().textContent).toBe('')
  })

  it('is a status, in place under the amount, mounted before it has anything to say', async () => {
    const panel = await openEditor({ ...JAR, package_count: 1, remaining_count: 1 })
    expect(echo().getAttribute('role')).toBe('status')
    const order = [...panel.querySelectorAll('input, select, textarea, [role="status"]')].map(el => el.id || el.getAttribute('data-testid'))
    expect(order.slice(0, 5)).toEqual(['ed-name-rec-e', 'ed-pkg-rec-e', 'ed-qty-rec-e', 'ed-unit-rec-e', 'ed-each-rec-e'])
  })
})

// Amendment D12: a place cannot be re-kinded while its put-ups carry dates worked out for its kind, and
// the refusal says "set those dates by hand from Edit". So Edit sets a date by hand on EVERY method.
// What the server stores is its own rule (lambda/preservation/jarRoutes.js patchJar): a date or "none"
// stores basis `typed`; "clear" works the date out again.
describe('Discard by, on every method, set by hand', () => {
  const group = (id = JAR.id) => screen.getByTestId(`ed-discard-${id}`)
  const chip = (words, id = JAR.id) => within(group(id)).getByRole('radio', { name: words })
  const chosen = (id = JAR.id) => within(group(id)).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.textContent)
  const dateField = (id = JAR.id) => document.getElementById(`ed-useby-${id}`)
  // Seen and said, in one assertion: the words above the chips and the group's accessible name.
  const groupSeenAndSaid = (id = JAR.id) => [group(id).previousElementSibling.textContent, group(id).getAttribute('aria-label')]

  // MUTATION E-M1: show the date only for a house-sourced method (the base) -> a frozen row has no chips.
  it('Freeze whole shows Discard by', async () => {
    await openEditor()
    expect(screen.getByRole('combobox', { name: 'How was it put up?' }).value).toBe('whole_freeze')
    expect(groupSeenAndSaid()).toEqual(['Discard by', 'Discard by'])
    expect(within(group()).getAllByRole('radio').map(r => r.textContent)).toEqual([DISCARD_LABELS.auto, DISCARD_LABELS.date, DISCARD_LABELS.none])
    expect(within(group()).getAllByRole('radio').map(r => r.textContent)).toEqual(['Work it out', 'From the label', 'No date'])
    expect(chosen()).toEqual(['Work it out'])
    expect(dateField()).toBeNull()
  })

  // MUTATION E-M2: one label for every method -> cure and cold store read "Discard by" (or all read "Use by").
  it('Cure & store and Cold store read Use by; every other method reads Discard by', async () => {
    await openEditor()
    fireEvent.click(chip('From the label'))
    const read = {}
    for (const m of METHODS) {
      fireEvent.change(screen.getByRole('combobox', { name: 'How was it put up?' }), { target: { value: m } })
      read[m] = [...groupSeenAndSaid(), dateField().getAttribute('aria-label')]
    }
    const USE_BY = ['Use by', 'Use by', 'Use-by date from the label']
    const DISCARD = ['Discard by', 'Discard by', 'Discard date from the label']
    expect(read).toEqual(Object.fromEntries(METHODS.map(m => [m, m === 'cure_store' || m === 'cold_store' ? USE_BY : DISCARD])))
    cleanup()
    // A row stored as cured opens reading it.
    await openEditor({ ...JAR, method: 'cure_store' })
    expect(groupSeenAndSaid()).toEqual(['Use by', 'Use by'])
  })

  // Ruling E-2: the chip a stored row opens on is the server's own rule for what it stored.
  // MUTATION: seed every row on "Work it out" -> a date set by hand opens as if it were worked out.
  it.each([
    ['a date set by hand', { use_by_basis: 'typed', use_by_target: '2027-03-01' }, 'From the label', '2027-03-01'],
    ['no date, set by hand', { use_by_basis: 'typed', use_by_target: null }, 'No date', null],
    ['a general figure', { use_by_basis: 'table' }, 'Work it out', null],
    ['the house estimate', { method: 'candy', use_by_basis: 'house' }, 'Work it out', null],
    ['from the recipe', { use_by_basis: 'recipe' }, 'Work it out', null],
    ['no date after a move', { use_by_basis: 'none', use_by_target: null }, 'Work it out', null],
    ['an older row that stored no basis', { use_by_basis: null }, 'Work it out', null],
  ])('opens on its own chip — %s — and an untouched Save sends nothing', async (_what, stored, opensOn, shownDate) => {
    await openEditor({ ...JAR, ...stored })
    expect(chosen()).toEqual([opensOn])
    expect(dateField()?.value ?? null).toBe(shownDate)
    expect(isReloadBlocked()).toBe(false)
    await save()
    expect(writes()).toEqual([])
  })

  // MUTATION E-M8: send the date only when it differs from the stored one -> nothing is sent, the basis
  // stays worked-out, and the re-kind that asked for this is still refused.
  it('the shown worked-out date, saved as it stands, sends discard_by', async () => {
    await openEditor()
    fireEvent.click(chip('From the label'))
    expect(chosen()).toEqual(['From the label'])
    expect(dateField().value).toBe('2027-08-10')
    expect(isReloadBlocked()).toBe(true)
    await save()
    expect(writes()).toEqual([['PATCH', { discard_by: '2027-08-10' }]])
  })

  // MUTATION: offer "No date" only where the base offered a date (candy) -> 18 methods cannot choose it.
  it('No date is choosable on every method, and sends "none"', async () => {
    const sent = {}
    for (const m of METHODS) {
      await openEditor({ ...JAR, method: m, method_other_text: m === 'other' ? 'Salt-cured' : null })
      fireEvent.click(chip('No date'))
      await save()
      sent[m] = writes()
      cleanup(); fetchMock.mockReset()
    }
    expect(sent).toEqual(Object.fromEntries(METHODS.map(m => [m, [['PATCH', { discard_by: 'none' }]]])))
  })

  // MUTATION: map "Work it out" to nothing (or to "none") -> a date set by hand can never be given back.
  it('Work it out, over a date set by hand, sends "clear"', async () => {
    await openEditor({ ...JAR, use_by_basis: 'typed', use_by_target: '2027-03-01' })
    fireEvent.click(chip('Work it out'))
    expect(dateField()).toBeNull()
    await save()
    expect(writes()).toEqual([['PATCH', { discard_by: 'clear' }]])
  })

  it('a date changed under From the label sends the new date, and nothing else', async () => {
    await openEditor({ ...JAR, use_by_basis: 'typed', use_by_target: '2027-03-01' })
    fireEvent.change(dateField(), { target: { value: '2027-04-15' } })
    await save()
    expect(writes()).toEqual([['PATCH', { discard_by: '2027-04-15' }]])
  })

  // The door's rule and the door's sentence: From the label needs a date. Nothing is sent, nothing is lost.
  // MUTATION: send it anyway -> the PATCH carries discard_by: "" and the route answers 400.
  it('From the label with no date picked says so in place and sends nothing; a date picked sends', async () => {
    await openEditor({ ...JAR, use_by_basis: 'none', use_by_target: null })
    fireEvent.click(chip('From the label'))
    expect(dateField().value).toBe('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'top shelf' } })
    await save()
    expect(writes()).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(DISCARD_DATE_TEXT)
    expect(DISCARD_DATE_TEXT).toBe('Pick the date from the label — or tap Work it out.')
    expect(dateField().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('top shelf')
    // Picking a date takes the line away; so does another chip.
    fireEvent.change(dateField(), { target: { value: '2027-01-05' } })
    expect(screen.queryByRole('alert')).toBeNull()
    await save()
    expect(writes()).toEqual([['PATCH', { notes: 'top shelf', discard_by: '2027-01-05' }]])
  })

  // What counts as a change is the chip, or the date while From the label is the chip.
  // MUTATION E-M5's sibling: leave the chip out of `dirty` -> a deploy's reload takes the choice with it.
  it('a chip change alone holds the reload gate; a chip put back, or a date typed and then abandoned, sends nothing', async () => {
    await openEditor()
    expect(isReloadBlocked()).toBe(false)
    fireEvent.click(chip('No date'))
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(chip('Work it out'))
    expect(isReloadBlocked()).toBe(false)
    fireEvent.click(chip('From the label'))
    fireEvent.change(dateField(), { target: { value: '2028-01-01' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(chip('Work it out'))
    expect(isReloadBlocked()).toBe(false)
    await save()
    expect(writes()).toEqual([])
  })

  describe('candied: the row sheet\'s sentence, while the date is the house\'s', () => {
    const CANDY = { ...JAR, id: 'rec-candy', method: 'candy', use_by_basis: 'house', use_by_target: '2027-02-10' }
    const note = () => screen.queryByTestId('ed-house-rec-candy')

    it('says the row sheet\'s sentence, word for word, under Work it out', async () => {
      await openEditor(CANDY)
      expect(note().textContent).toBe(HOUSE_DETAIL_TEXT)
      expect(HOUSE_DETAIL_TEXT).toBe('No published figure exists for candied fruit. This date is a house estimate, not a tested one. Set your own.')
      expect(note().getAttribute('role')).toBe('note')
      // Under the chips, inside the date's own block.
      expect(group('rec-candy').parentElement.contains(note())).toBe(true)
      // The claim the base editor carried (it held a banned word) has left the panel.
      expect(screen.getByTestId('jar-edit-panel').textContent).not.toContain('published guidance')
    })

    // MUTATION: say it under every chip -> "This date is a house estimate" under a date he set himself.
    it('stops saying "This date is a house estimate" once the date is his own, or there is none', async () => {
      await openEditor(CANDY)
      fireEvent.click(chip('From the label', 'rec-candy'))
      expect(note()).toBeNull()
      fireEvent.click(chip('No date', 'rec-candy'))
      expect(note()).toBeNull()
      fireEvent.click(chip('Work it out', 'rec-candy'))
      expect(note().textContent).toBe(HOUSE_DETAIL_TEXT)
    })

    it('is not said for a method with a published figure, and follows the method as it is changed', async () => {
      await openEditor()
      expect(screen.queryByTestId('ed-house-rec-e')).toBeNull()
      fireEvent.change(screen.getByRole('combobox', { name: 'How was it put up?' }), { target: { value: 'candy' } })
      expect(screen.getByTestId('ed-house-rec-e').textContent).toBe(HOUSE_DETAIL_TEXT)
    })
  })
})

// UX 3.4: "All fields 48 px". The shared Input and Select stop at the app-wide 44 px floor; a Put-Up
// surface takes 48. jsdom lays nothing out, so this reads the floor each control is given (the render
// tool measures the boxes).
describe('48 px targets', () => {
  // MUTATION: drop the panel's field style from any one field -> that field reads 44px.
  it('every field, select and chip in the panel is given a 48 px floor', async () => {
    const panel = await openEditor({ ...JAR, method: 'other', method_other_text: 'Salt-cured', use_by_basis: 'typed' })
    const floors = Object.fromEntries([...panel.querySelectorAll('input, select, [role="radio"]')]
      .map(el => [el.id || el.getAttribute('data-testid'), el.style.minHeight]))
    expect(Object.keys(floors)).toEqual(expect.arrayContaining([
      'ed-name-rec-e', 'ed-pkg-rec-e', 'ed-qty-rec-e', 'ed-unit-rec-e', 'ed-method-rec-e', 'ed-method-other-rec-e', 'ed-useby-rec-e',
      'ed-discard-auto-rec-e', 'ed-discard-date-rec-e', 'ed-discard-none-rec-e',
    ]))
    expect(floors).toEqual(Object.fromEntries(Object.keys(floors).map(k => [k, '48px'])))
    // The notes box is taller than the floor; the two buttons are the Button primitive's 48.
    expect(parseInt(screen.getByRole('textbox', { name: 'Notes' }).style.height, 10)).toBeGreaterThanOrEqual(48)
    for (const name of ['Save', 'Cancel']) expect(screen.getByRole('button', { name }).style.minHeight).toBe('48px')
  })
})

// Contract 4 as amendment C1 and as lane S built it: source_kind and source_label travel as a PAIR, always
// both; `null, null` un-chooses; the garden carries no name; the server judges the pair against the STORED
// planting and harvest link, so a row tied to either has no control here.
describe('where it is from: "Made with produce from", corrected in Edit', () => {
  const FROM_FARM = { ...JAR, source_kind: 'farm_stand', source_label: 'Warner Farms' }
  const group = () => screen.queryByRole('radiogroup', { name: 'Made with produce from' })
  const chip = (kind) => screen.getByTestId(`ed-rec-e-source-${kind}`)
  const chosen = () => within(group()).getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.textContent)
  const nameField = () => screen.queryByTestId('ed-rec-e-source-label')

  // MUTATION E-M3b: hide it on every row -> a row with no planting cannot be corrected.
  it('a row with no planting has it, seeded from the record', async () => {
    await openEditor(FROM_FARM)
    // Seen and said, in one assertion: the heading above the chips and the group's accessible name.
    expect([group().previousElementSibling.textContent, group().getAttribute('aria-label')])
      .toEqual(['Made with produce from', 'Made with produce from'])
    expect(chosen()).toEqual([WHERE_FROM_WORDS.farm_stand])
    expect(nameField().value).toBe('Warner Farms')
    // It sits with the notes, as the door's does: after the date, before Notes.
    const panel = screen.getByTestId('jar-edit-panel')
    const order = [...panel.querySelectorAll('[role="radiogroup"], textarea')].map(el => el.getAttribute('data-testid') ?? el.id)
    expect(order).toEqual(['ed-discard-rec-e', 'ed-rec-e-source', 'ed-notes-rec-e'])
    cleanup()
    // A row that never recorded one opens with nothing chosen and no name field.
    await openEditor()
    expect(chosen()).toEqual([])
    expect(nameField()).toBeNull()
  })

  // MUTATION E-M3: show it on a planting-linked row -> any choice but the garden is a 400 from the route.
  it('a row with a planting has no where-from control', async () => {
    await openEditor({ ...JAR, plant_id: 'plant-1', source_kind: 'own_garden' })
    expect(screen.getByRole('radiogroup', { name: 'Discard by' })).toBeTruthy()      // the panel is open
    expect(group()).toBeNull()
    expect(screen.queryByTestId('ed-rec-e-source')).toBeNull()
  })

  // The server judges the pair against the stored harvest link too (lambda/preservation/jarRoutes.js).
  // MUTATION: key the absence on the planting alone -> a row tied to a pick offers what the route refuses.
  it('a row tied to a pick has none either', async () => {
    await openEditor({ ...JAR, harvest_log_id: 'harvest-1', source_kind: 'own_garden' })
    expect(screen.getByRole('radiogroup', { name: 'Discard by' })).toBeTruthy()
    expect(group()).toBeNull()
  })

  // MUTATION E-M4 (first half): send the source when it was not touched -> every Edit rewrites it.
  // (PutUp.formGuard's "an untouched Save writes nothing" reds on the same mutant, unedited.)
  it('untouched, neither key is sent', async () => {
    await openEditor(FROM_FARM)
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'for the chili' } })
    await save()
    expect(writes()).toEqual([['PATCH', { notes: 'for the chili' }]])
  })

  // MUTATION E-M4 (second half): send the typed name with the garden -> the garden carries a vendor's name.
  it('garden sends the kind alone', async () => {
    await openEditor(FROM_FARM)
    fireEvent.click(chip('own_garden'))
    expect(nameField()).toBeNull()
    await save()
    expect(writes()).toEqual([['PATCH', { source_kind: 'own_garden', source_label: null }]])
  })

  // MUTATION E-M9's sibling: send one half alone -> validateJarPatch answers "…are edited together" (400).
  it('the pair travels together', async () => {
    // Only the NAME changed: the kind it belongs to goes with it.
    await openEditor(FROM_FARM)
    fireEvent.change(nameField(), { target: { value: '  Kimball Fruit Farm ' } })
    await save()
    expect(writes()).toEqual([['PATCH', { source_kind: 'farm_stand', source_label: 'Kimball Fruit Farm' }]])
    cleanup(); fetchMock.mockReset()
    // Only the KIND changed, and no name was typed: the name goes as null, not as a missing key.
    await openEditor()
    fireEvent.click(chip('store'))
    await save()
    expect(writes()).toEqual([['PATCH', { source_kind: 'store', source_label: null }]])
    cleanup(); fetchMock.mockReset()
    // A second tap un-chooses: null, null.
    await openEditor(FROM_FARM)
    fireEvent.click(chip('farm_stand'))
    expect(chosen()).toEqual([])
    await save()
    expect(writes()).toEqual([['PATCH', { source_kind: null, source_label: null }]])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // MUTATION: send Other with no name -> the route's 400, in words written for a developer.
  it('Other with no name: the control\'s own sentence, and no PATCH', async () => {
    await openEditor()
    fireEvent.click(screen.getByTestId('ed-rec-e-source-more'))
    fireEvent.click(chip('other'))
    await save()
    expect(writes()).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(WHERE_EXACTLY_ERROR)
    expect(whereFromError({ kind: 'other', label: ' ' })).toBe(WHERE_EXACTLY_ERROR)
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    // Typing the name takes the line away, and the save goes.
    fireEvent.change(nameField(), { target: { value: 'the neighbour' } })
    expect(screen.queryByRole('alert')).toBeNull()
    await save()
    expect(writes()).toEqual([['PATCH', { source_kind: 'other', source_label: 'the neighbour' }]])
  })

  // MUTATION E-M5: leave the source out of `dirty` -> a deploy's reload takes the correction with it.
  it('a where-from change alone holds the reload gate; put back, it releases', async () => {
    await openEditor(FROM_FARM)
    expect(isReloadBlocked()).toBe(false)
    fireEvent.change(nameField(), { target: { value: 'Kimball Fruit Farm' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(nameField(), { target: { value: 'Warner Farms' } })
    expect(isReloadBlocked()).toBe(false)
    fireEvent.click(chip('gift'))
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(chip('farm_stand'))
    expect(isReloadBlocked()).toBe(false)
  })
})
