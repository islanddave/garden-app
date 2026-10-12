// V4-HARVESTCENTER-001 — PutUp page: the regroup toggle on the read surface, the minimal decrement, and
// what a jar's row sheet says. Real react-router (MemoryRouter); useApiFetch is mocked. a11y: query
// controls by role+name (getByRole), not label-on-roleless (L-275).
// Put-Up R2b: the "Log a put-up" form's tests that lived here (its validation, its create body, its
// planting picker, its photo, its place creator's retry) left with the form; what the Put something up
// door carries of them is pinned in PutUpR2Df.door / .createParity and PutUpR2Dn.nameSearch.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  // Lazy wrapper, NOT a bare `fetchMock` reference: vi.mock is hoisted above the const, so an
  // eager reference throws "Cannot access 'fetchMock' before initialization" at collect time.
  apiFetch: (...args) => fetchMock(...args),
}))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'

const STORES_FIXTURE = {
  group_by: 'storage',
  groups: [{
    group_key: 'loc-1', label: 'Garage freezer', total_packages: 3, units: ['bags'], use_soon_count: 0,
    records: [{
      id: 'rec-1', crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
      preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
      quantity_value: 14, quantity_unit: 'bags', package_count: 3, storage_location_id: 'loc-1',
      use_by_target: null, remaining_count: 3, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
      // V4-PUTUPPROV-001 — DELIBERATELY NOT own_garden. If this fixture said own_garden, the
      // decrement test below would pass whether buildFullPayload carries the field through OR drops
      // it and something re-defaults it, because the observable value is identical either way. A
      // non-default value is what makes the assertion able to fail.
      source_kind: 'farm_stand', source_label: 'Warner Farms',
    }],
  }],
}

// B′ release 2: the list is GET /api/pantry (the pinned contract's rows) and a jar's sheet reads the jar
// by id; `record` is that jar.
function wire({ record = STORES_FIXTURE.groups[0].records[0] } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(record, { id: 'loc-1', label: 'Garage freezer', kind: 'deep_freezer' })] })
    if (path === `/api/preservation/${record.id}` && method === 'GET') return Promise.resolve(record)
    if (path.startsWith('/api/preservation/') && method === 'PUT') return Promise.resolve({ id: 'rec-1' })
    return Promise.resolve(null)
  })
}

function renderPutUp() {
  return render(<MemoryRouter initialEntries={[{ pathname: '/put-up' }]}><PutUp /></MemoryRouter>)
}

function putCalls() {
  return fetchMock.mock.calls.filter(([, o]) => o?.method === 'PUT')
}

beforeEach(() => {
  fetchMock.mockReset(); wire()
  sessionStorage.clear()
})

// AMENDED for B′ release 2 (V4 §2.5, §10.1): "What's put up" is the Pantry — ONE list over GET
// /api/pantry, grouped By place (default) or By what it is (By planting is dropped), with ONE inline
// action per row; the jar's words the list used to carry (size, put-up date, provenance, planting) are
// said in its row sheet, which reads the jar once. The editor and the use route are unchanged, so their
// wire literals are too. Retired with the old surface: the per-group "N containers · units" headline.
describe('PutUp — the Pantry read surface', () => {
  const ROW_ID = 'put_up:rec-1'
  const REC = STORES_FIXTURE.groups[0].records[0]
  const openSheet = async () => {
    fireEvent.click(await screen.findByTestId(`pantry-row-open-${ROW_ID}`))
    return screen.findByTestId('row-sheet')
  }

  it('defaults to grouping by place and regroups by what it is on one tap', async () => {
    renderPutUp()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pantry?group=place'))
    await screen.findByRole('heading', { name: 'Garage freezer' })
    fireEvent.click(screen.getByRole('radio', { name: 'By what it is' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pantry?group=kind'))
    expect(screen.queryByRole('radio', { name: 'By planting' })).toBeNull()
  })

  it('the row sheet says which planting a jar came from when the link exists', async () => {
    wire({ record: { ...REC, plant_id: 'pl-w2', planting_name: 'Dark Green Zucchini', planting_succession_order: 2 } })
    renderPutUp()
    await openSheet()
    expect(await screen.findByText(/from Dark Green Zucchini · wave 2/)).toBeTruthy()
  })

  // Amended for release F, and again for B′: the one-tap use is ONE use on POST /api/pantry/uses and no
  // PUT at all. Three left → the row offers "Used one".
  it('"Used one" is one use on the use route, and sends no PUT', async () => {
    renderPutUp()
    fireEvent.click(await screen.findByRole('button', { name: /^Used one — / }))
    const uses = () => fetchMock.mock.calls.filter(([p, o]) => p === '/api/pantry/uses' && o?.method === 'POST')
    await waitFor(() => expect(uses().length).toBe(1))
    const use = JSON.parse(uses()[0][1].body)
    expect(use.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect({ ...use, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', preservation_log_id: 'rec-1', count_used: 1 })
    expect(putCalls().length).toBe(0)
  })

  // Release F (amended again in the same commit as the change): an Edit is ONE PATCH carrying only what
  // changed — so nothing on the row (provenance, date, place) is echoed at all.
  it('a count edit is one PATCH of the count alone — nothing else on the row is sent', async () => {
    renderPutUp()
    await openSheet()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const patches = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH')
    await waitFor(() => expect(patches().length).toBe(1))
    expect(patches()[0][0]).toBe('/api/preservation/rec-1')
    expect(JSON.parse(patches()[0][1].body)).toEqual({ package_count: 4 })
    expect(putCalls().length).toBe(0)
  })

  it('the row sheet says where a bought jar came from, and nothing for a garden jar', async () => {
    renderPutUp()
    await openSheet()
    expect(await screen.findByText(/from Warner Farms/)).toBeTruthy()
  })

  it('says NO provenance for an own-garden jar (or a NULL, pre-migration one)', async () => {
    for (const source_kind of ['own_garden', null]) {
      wire({ record: { ...REC, source_kind, source_label: null } })
      const view = renderPutUp()
      await openSheet()
      await screen.findByTestId('row-sheet-record')
      expect(screen.getByTestId('row-sheet-record').textContent).not.toMatch(/from /)
      view.unmount()
    }
  })
})

// V4-PUTUPSESSION-001 slice 1. The read half of the slice: a stored estimate has to read back as an
// estimate. B′: said in the jar's row sheet (the Pantry row carries no date).
describe('PutUp — an estimated date does not read as a date you picked', () => {
  const REC = STORES_FIXTURE.groups[0].records[0]
  const sheetWords = async () => {
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-1'))
    return (await screen.findByTestId('row-sheet-record')).textContent
  }

  it('marks a TRUE row', async () => {
    wire({ record: { ...REC, preserved_at_approx: true } })
    renderPutUp()
    expect(await sheetWords()).toContain('put up around Jul 1')
  })

  it('leaves a FALSE row plain', async () => {
    wire({ record: { ...REC, preserved_at_approx: false } })
    renderPutUp()
    const w = await sheetWords()
    expect(w).toContain('put up Jul 1')
    expect(w).not.toContain('around')
  })

  it('leaves a NULL row plain — unrecorded is not a claim that the date is approximate', async () => {
    wire({ record: { ...REC, preserved_at_approx: null } })
    renderPutUp()
    const w = await sheetWords()
    expect(w).toContain('put up Jul 1')
    expect(w).not.toContain('around')
  })

  it('an Edit of a row with an estimated date does not send the date or the flag', async () => {
    wire({ record: { ...REC, preserved_at_approx: true } })
    renderPutUp()
    await sheetWords()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const patches = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH')
    await waitFor(() => expect(patches().length).toBe(1))
    const body = JSON.parse(patches()[0][1].body)
    expect('preserved_at_approx' in body).toBe(false)
    expect('preserved_at' in body).toBe(false)
  })
})
