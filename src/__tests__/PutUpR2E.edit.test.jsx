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
import { render, screen, fireEvent, act } from '@testing-library/react'
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
import { METHOD_LABELS } from '../components/putup/putItUp.js'
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

beforeEach(() => {
  fetchMock.mockReset()
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
