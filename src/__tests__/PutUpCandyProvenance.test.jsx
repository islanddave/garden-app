// V5-PUTUPCANDY-001 — `candy`'s picker option and the VISIBLE provenance line that is the condition
// of it shipping at all.
//
// FOODSAFETY-RULING-V101 §8.2, which this file encodes: a house-sourced shelf life is either
// "distinguishable on the surface — a provenance line the user can see — or it takes default: null".
// `candy` is the first and only SHELF_LIFE_MONTHS entry with no published source; a 2026-09-04
// search of NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and NC State found no home-preservation
// guidance on candied-fruit endpoints, storage or shelf life at all. The figure comes from the
// household's own candying guide, and the ruling's point is that a migration header is read by
// NOBODY USING THE APP: the number reaches every viewer as a use-by date and a warn-coloured chip,
// and the second person in the household has no way to learn a header exists.
//
// WHY THESE ASSERTIONS AND NOT A STATIC PARSE. putUpMethodParity.test.js already binds the Lambda's
// HOUSE_SOURCED_SHELF_LIFE to the page's, but no static parse can tell a used constant from a dead
// one — a set that drives no rendered element would satisfy every assertion there. Only the DOM can
// say whether a person is actually told, so the copy is asserted here as a FULL LITERAL rather than
// a substring: a reworded claim must break this file, because the wording IS the mitigation.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [{ slug: 'watermelon', display_name: 'Watermelon', category: 'fruit' }],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'

// The claim, spelled out. Duplicated from PutUp.jsx deliberately: a constant imported from the file
// under test would assert only that a string equals itself, and this string is the mitigation the
// ruling accepted, not an implementation detail.
const CLAIM =
  'There’s no published guidance on how long candied fruit keeps, so this use-by is ours rather than ' +
  'a tested one — the automatic date comes from our own candying guide.'
const FORM_NOTE = `No published shelf life for this one. ${CLAIM} Set Use by below to Pick a date if you know the real one.`
// B′ release 2: the Pantry row's chip carries the basis words and its sheet the detail line, both
// stated once in V4 §3.2 ("house estimate"; "No published figure exists for candied fruit. This date is
// a house estimate, not a tested one. Set your own.").
const SHEET_NOTE = 'No published figure exists for candied fruit. This date is a house estimate, not a tested one. Set your own.'

// A candied batch that HAS a use-by, because the use-by is what the ruling is about. `method` and
// `use_by_target` are the two fields every assertion below turns on; the rest mirrors the shape the
// whats-put-up route returns.
function storesFixture({ method = 'candy', use_by_target = '2026-10-01' } = {}) {
  return {
    group_by: 'storage',
    groups: [{
      group_key: 'loc-1', label: 'Pantry shelf', total_packages: 2, units: ['jars'], use_soon_count: 1,
      records: [{
        id: 'rec-candy', crop_type_slug: 'watermelon', variety_id: null, plant_id: null, harvest_log_id: null,
        preserved_at: '2026-09-01', method, method_other_text: null,
        quantity_value: 1.25, quantity_unit: 'lbs', package_count: 2, storage_location_id: 'loc-1',
        use_by_target, remaining_count: 2, consumed_at: null, notes: null, photo_id: null,
        use_by_status: 'use_soon', source_kind: 'own_garden', source_label: null,
      }],
    }],
  }
}

function wire(stores) {
  const rec = stores.groups[0].records[0]
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants?') && method === 'GET') return Promise.resolve([])
    // B′ release 2: the list is the Pantry; a jar's sheet reads it by id.
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(rec, { id: 'loc-1', label: 'Pantry shelf', kind: 'pantry' })] })
    if (path === `/api/preservation/${rec.id}` && method === 'GET') return Promise.resolve(rec)
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1' })
    if (path.startsWith('/api/preservation/') && method === 'PUT') return Promise.resolve({ id: 'rec-candy' })
    return Promise.resolve(null)
  })
}

function renderPutUp(prefill) {
  const entry = prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}

function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => (o?.method === 'POST'))
  return call ? JSON.parse(call[1].body) : null
}
function lastPut() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => (o?.method === 'PUT'))
  return call ? JSON.parse(call[1].body) : null
}
function lastPatch() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => (o?.method === 'PATCH'))
  return call ? JSON.parse(call[1].body) : null
}

beforeEach(() => {
  fetchMock.mockReset()
  wire(storesFixture())
  sessionStorage.clear()
})

describe('the picker offers candy', () => {
  it('lists it by its label and posts the slug the DB CHECK spells', async () => {
    renderPutUp({ crop_type_slug: 'watermelon' })
    const select = screen.getByRole('combobox', { name: 'Method' })
    const option = [...select.options].find(o => o.value === 'candy')
    expect(option, 'candy is missing from METHOD_GROUPS — the picker is the only way to log one').toBeTruthy()
    expect(option.textContent).toBe('Candied')

    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '1.25' } })
    fireEvent.change(select, { target: { value: 'candy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(lastPost().method).toBe('candy')
  })
})

describe('the log form says where the number came from', () => {
  it('shows the provenance note, verbatim, when candy is chosen', () => {
    renderPutUp({ crop_type_slug: 'watermelon' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'candy' } })
    expect(screen.getByRole('note').textContent).toBe(FORM_NOTE)
  })

  it('shows nothing of the kind for a method with a published figure', () => {
    // The note must be CONDITIONAL, not ambient. A line that appeared on every method would say
    // nothing about candy and would train the user to read past it.
    renderPutUp({ crop_type_slug: 'watermelon' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'whole_freeze' } })
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('never attributes the figure to a published body', () => {
    // The one thing the ruling forbids outright. Named sources appear nowhere in this copy because
    // none of them says anything about candied fruit — claiming one would be the defect inverted.
    renderPutUp({ crop_type_slug: 'watermelon' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'candy' } })
    expect(screen.getByRole('note').textContent).not.toMatch(/NCHFP|USDA|Extension/i)
  })

  it('stops the Use-by control claiming a tested shelf life for a candy row', () => {
    // The help text under that control was an unconditional claim, and over a candy row it would
    // attribute an uncitable number to a tested source in the very place the number is set.
    renderPutUp({ crop_type_slug: 'watermelon' })
    expect(screen.getByText('Auto uses tested shelf-life for the method and storage.')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'candy' } })
    expect(screen.queryByText('Auto uses tested shelf-life for the method and storage.')).toBeNull()
    expect(screen.getByText('Auto uses our own house estimate for this one — see the note above.')).toBeTruthy()
  })
})

// AMENDED for B′ release 2: the list is the Pantry. The row's discard chip names the house estimate in
// its basis words — also for a jar written before 1b stored a basis — and the row sheet carries V4
// §3.2's detail line; Edit (the same editor) is reached through the sheet.
describe('the saved row carries the provenance beside its date', () => {
  const openSheet = async () => {
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-candy'))
    return screen.findByTestId('row-sheet')
  }

  it('labels a candy row that has a date: "house estimate" on the chip, the detail line in its sheet, verbatim', async () => {
    renderPutUp()
    expect(await screen.findByText(/discard by Oct 1 · house estimate/)).toBeTruthy()
    await openSheet()
    expect(screen.getByTestId('row-sheet-house').textContent).toBe(SHEET_NOTE)
  })

  it('leaves a row with a published figure without the house words', async () => {
    wire(storesFixture({ method: 'jam_preserve' }))
    renderPutUp()
    expect(await screen.findByText(/discard by Oct 1/)).toBeTruthy()
    expect(screen.queryByText(/house estimate/)).toBeNull()
    await openSheet()
    expect(screen.queryByTestId('row-sheet-house')).toBeNull()
  })

  it('says nothing when there is no date on screen to attribute', async () => {
    // No use_by_target means no estimate was applied and no chip renders, so there is no claim for a
    // provenance line to qualify — and an unprompted disclaimer over nothing is just noise.
    wire(storesFixture({ use_by_target: null }))
    renderPutUp()
    await openSheet()
    expect(screen.queryByTestId('row-sheet-house')).toBeNull()
    expect(screen.queryByText(/house estimate/)).toBeNull()
  })
})

describe('and the cook can set the real date', () => {
  const openEditor = async () => {
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-candy'))
    fireEvent.click(await screen.findByTestId('row-edit'))
    await screen.findByRole('button', { name: 'Save' })
  }

  it('offers a use-by control on a candy row and sends what was typed', async () => {
    // Without this the provenance line's "Set your own" is a dead instruction.
    renderPutUp()
    await openEditor()

    // AMENDED for R2a (lane E; UX 3.4 row 6): the note in the editor is the row sheet's sentence, word for
    // word. The sheet prints the same sentence above the panel, so it is read INSIDE the editor here.
    const editor = within(screen.getByTestId('jar-edit-panel'))
    expect(editor.getByText(SHEET_NOTE), 'the claim follows the number into the editor').toBeTruthy()

    // AMENDED for R2a: the date is one of three chips on every method; "From the label" shows the field.
    fireEvent.click(editor.getByRole('radio', { name: 'From the label' }))
    // getByLabelText, not getByRole: an <input type="date"> has no implicit ARIA role to query by.
    const input = screen.getByLabelText('Discard date from the label')
    expect(input.value, 'the control must open on the stored date, not empty').toBe('2026-10-01')

    // Release 1b (V4 §5.4, §8.3): the date goes through the PATCH as `discard_by`.
    fireEvent.change(input, { target: { value: '2026-09-18' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastPatch()).not.toBeNull())
    expect(lastPatch()).toEqual({ discard_by: '2026-09-18' })
    expect(lastPut()).toBeNull()
  })

  // AMENDED for R2a (lane E, amendment D12) — REVERSED: the date control IS there for every other method
  // too (a date has to be settable by hand on any put-up), without the house sentence. What still holds,
  // unchanged below: an untouched Save sends nothing, so the stored date cannot move.
  it('offers the date control for every other method too, and round-trips the stored date', async () => {
    wire(storesFixture({ method: 'jam_preserve' }))
    renderPutUp()
    await openEditor()
    const editor = within(screen.getByTestId('jar-edit-panel'))
    expect(within(editor.getByRole('radiogroup', { name: 'Discard by' })).getAllByRole('radio').map(r => r.textContent))
      .toEqual(['Work it out', 'From the label', 'No date'])
    expect(editor.queryByText(SHEET_NOTE)).toBeNull()

    // Release 1b: an untouched Save sends nothing at all, so the stored date cannot move.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(lastPut()).toBeNull()
    expect(lastPatch()).toBeNull()
  })

  it('a count edit on a candy row is one PATCH of the count, and never touches its use-by', async () => {
    renderPutUp()
    await openEditor()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastPatch()).not.toBeNull())
    expect(lastPatch()).toEqual({ package_count: 3 })
    expect(lastPut()).toBeNull()
  })

  it('a Used-one tap on a candy row sends no PUT at all', async () => {
    renderPutUp()
    fireEvent.click(await screen.findByRole('button', { name: /^Used one — / }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([p]) => p === '/api/pantry/uses')).toBe(true))
    expect(lastPut()).toBeNull()
  })
})
