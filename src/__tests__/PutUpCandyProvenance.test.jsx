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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

// The claim, spelled out. Duplicated from PutUp.jsx deliberately: a constant imported from the file
// under test would assert only that a string equals itself, and this string is the mitigation the
// ruling accepted, not an implementation detail.
const CLAIM =
  'There’s no published guidance on how long candied fruit keeps, so this use-by is ours rather than ' +
  'a tested one — the automatic date comes from our own candying guide.'
const FORM_NOTE = `No published shelf life for this one. ${CLAIM} Set Use by below to Pick a date if you know the real one.`
const ROW_NOTE = `${CLAIM} Tap Edit to set the real date.`

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
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants?') && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(stores)
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

describe('the saved row carries the provenance beside its date', () => {
  it('labels a candy row that has a use-by, verbatim', async () => {
    renderPutUp()
    await screen.findByText('Pantry shelf')
    expect(screen.getByText(/use by Oct 1, 2026/)).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe(ROW_NOTE)
  })

  it('leaves a row with a published shelf life exactly as it renders today', async () => {
    wire(storesFixture({ method: 'jam_preserve' }))
    renderPutUp()
    await screen.findByText('Pantry shelf')
    expect(screen.getByText(/use by Oct 1, 2026/)).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says nothing when there is no date on screen to attribute', async () => {
    // No use_by_target means no estimate was applied and no chip renders, so there is no claim for a
    // provenance line to qualify — and an unprompted disclaimer over nothing is just noise.
    wire(storesFixture({ use_by_target: null }))
    renderPutUp()
    await screen.findByText('Pantry shelf')
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('and the cook can set the real date', () => {
  it('offers a use-by control on a candy row and sends what was typed', async () => {
    // Without this the provenance line's "tap Edit to set the real date" is a dead instruction:
    // use_by_target has always been per-row and overridable at CREATE time, but this editor never
    // exposed it, so an existing row could not be corrected at all.
    renderPutUp()
    await screen.findByText('Pantry shelf')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // getByLabelText, not getByRole: an <input type="date"> has no implicit ARIA role to query by.
    const input = screen.getByLabelText('Use-by date')
    expect(input.value, 'the control must open on the stored date, not empty').toBe('2026-10-01')
    expect(screen.getByText(CLAIM), 'the claim follows the number into the editor').toBeTruthy()

    fireEvent.change(input, { target: { value: '2026-09-18' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastPut()).not.toBeNull())
    expect(lastPut().use_by_target).toBe('2026-09-18')
    expect(lastPut().method).toBe('candy')
  })

  it('leaves the editor untouched for every other method, and round-trips the stored date', async () => {
    // The regression this change could have caused: RowEditor now sends use_by_target on EVERY save.
    // Seeded from the same expression buildFullPayload uses, so a row whose control never appeared
    // must send back exactly what it was given.
    wire(storesFixture({ method: 'jam_preserve' }))
    renderPutUp()
    await screen.findByText('Pantry shelf')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByLabelText('Use-by date')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastPut()).not.toBeNull())
    expect(lastPut().use_by_target).toBe('2026-10-01')
  })

  it('a Mark-used tap on a candy row still carries its use-by through the full-replace PUT', async () => {
    // The one-tap decrement goes through buildFullPayload, not the editor. A total-replace PUT that
    // dropped the column would silently clear the date and take the jar out of use-soon.
    renderPutUp()
    await screen.findByText('Pantry shelf')
    fireEvent.click(screen.getByRole('button', { name: 'Mark used' }))
    await waitFor(() => expect(lastPut()).not.toBeNull())
    expect(lastPut().use_by_target).toBe('2026-10-01')
    expect(lastPut().remaining_count).toBe(1)
  })
})
