// V4-HARVESTCENTER-001 — PutUp page: fast-path validation, method='other' gate, fast-path submit,
// the regroup toggle on the read surface, and the minimal decrement. Real react-router (MemoryRouter)
// so useLocation()/state.prefill work; useApiFetch + useCropTypes are mocked. a11y: query controls by
// role+name (getByRole), not label-on-roleless (L-275).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'bean', display_name: 'Beans', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'

const STORES_FIXTURE = {
  group_by: 'storage',
  groups: [{
    group_key: 'loc-1', label: 'Garage freezer', total_packages: 3, units: ['bags'], use_soon_count: 0,
    records: [{
      id: 'rec-1', crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
      preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
      quantity_value: 14, quantity_unit: 'bags', package_count: 3, storage_location_id: 'loc-1',
      use_by_target: null, remaining_count: 3, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
    }],
  }],
}

// Three waves of ONE variety + an unrelated crop. The successions are the whole point: they are
// name-identical, so only the wave ordinal / sown date tells them apart.
const PLANTS_FIXTURE = [
  { id: 'pl-w1', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-04-10',
    succession_order: 1, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-w2', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-05-12',
    succession_order: 2, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-w3', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-06-14',
    succession_order: 3, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-tom', name: 'Cherokee Purple', variety_id: 'var-cp', sown_at: '2026-03-01',
    succession_order: null, variety_ref: { id: 'var-cp', name: 'Cherokee Purple', crop_type_slug: 'tomato' } },
]

function wire({ stores = STORES_FIXTURE, plants = PLANTS_FIXTURE } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path === '/api/plants' && method === 'GET') return Promise.resolve(plants)
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(stores)
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1' })
    if (path.startsWith('/api/preservation/') && method === 'PUT') return Promise.resolve({ id: 'rec-1' })
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
function putCalls() {
  return fetchMock.mock.calls.filter(([, o]) => o?.method === 'PUT')
}

beforeEach(() => { fetchMock.mockReset(); wire() })

describe('PutUp — log form (progressive disclosure)', () => {
  it('blocks submit when neither a crop nor a variety is attributed', async () => {
    renderPutUp() // no prefill → defaults to the "what's put up" view
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Pick a crop/i)
    expect(lastPost()).toBeNull() // never POSTed
  })

  it("requires method_other_text when method is 'other'", async () => {
    renderPutUp({ crop_type_slug: 'tomato' }) // prefill → lands on the form
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Describe the method when you choose/i)
    expect(lastPost()).toBeNull()
  })

  it('fast-path submit posts crop + quantity + defaulted method/date/packages', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    const body = lastPost()
    expect(body.crop_type_slug).toBe('tomato')
    expect(body.quantity_value).toBe(14)
    expect(body.quantity_unit).toBeTruthy()
    expect(body.method).toBe('whole_freeze')
    expect(body.package_count).toBe(1)
    expect(body.preserved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // use_by_target OMITTED on 'auto' so the server applies the shelf-life default (L6).
    expect('use_by_target' in body).toBe(false)
    // Competence payoff surfaces (L10 cold-start) — no celebration, just the inventory reflection.
    await screen.findByText(/Now in/i)
  })
})

// The seed → planting → harvest → put-up spine. Before this, plant_id was prefill-only and
// immutable, so a put-up logged from More → Put-Up could never be tied to a planting at all.
describe('PutUp — planting attribution (succession spine)', () => {
  it('offers a planting picker on the direct entry path, not just off a harvest', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants'))
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(PLANTS_FIXTURE.length + 1))
  })

  it('distinguishes same-named successions by wave and sown date', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBeGreaterThan(1))
    const labels = [...sel.querySelectorAll('option')].map(o => o.textContent)
    expect(labels.some(l => /Dark Green Zucchini.*wave 1/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 2/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 3/.test(l))).toBe(true)
    // Name alone is ambiguous — the date is what actually separates them for a human.
    expect(labels.filter(l => /sown/.test(l)).length).toBeGreaterThanOrEqual(3)
  })

  it('scopes the planting list to the chosen crop', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    // Only the tomato planting survives the scope (+ the "not tied" row).
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(2))
    expect(sel.textContent).toMatch(/Cherokee Purple/)
  })

  it('submits plant_id and derives the crop from the selected planting', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(sel, { target: { value: 'pl-w2' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    const body = lastPost()
    expect(body.plant_id).toBe('pl-w2')           // the specific wave, not just the variety
    expect(body.crop_type_slug).toBe('squash')    // derived from the planting
  })

  it('accepts a planting alone as sufficient attribution (no crop picked)', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(sel, { target: { value: 'pl-w1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(lastPost().plant_id).toBe('pl-w1')
  })

  it('keeps a harvest-prefilled planting selected even when it is outside the current scope', async () => {
    // Launched off a harvest for wave 3, but the crop filter says tomato — the link must survive.
    renderPutUp({ crop_type_slug: 'tomato', plant_id: 'pl-w3' })
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.value).toBe('pl-w3'))
    expect(sel.textContent).toMatch(/wave 3/)
  })
})

describe('PutUp — "what\'s put up" read surface', () => {
  it('defaults to grouping by storage and regroups by crop on one tap', async () => {
    renderPutUp()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=storage'))
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('radio', { name: 'By crop' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=crop'))
  })

  it('regroups by planting so successions read separately', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('radio', { name: 'By planting' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=planting'))
  })

  it('shows which planting a record came from when the link exists', async () => {
    renderPutUp({}) // stores view
    wire({ stores: { group_by: 'planting', groups: [{
      group_key: 'pl-w2', label: 'Dark Green Zucchini — wave 2, sown May 12',
      total_packages: 2, units: ['bags'], use_soon_count: 0,
      records: [{ ...STORES_FIXTURE.groups[0].records[0], id: 'rec-2', plant_id: 'pl-w2',
        planting_name: 'Dark Green Zucchini', planting_succession_order: 2, planting_sown_at: '2026-05-12' }],
    }] } })
    renderPutUp()
    expect(await screen.findByText(/from Dark Green Zucchini/)).toBeTruthy()
  })

  it('numbers-first headline shows package count + the distinct units (never a cross-unit sum)', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    // Headline: "3 containers · bags" (packages counted, units listed — never a cross-unit sum).
    expect(screen.getAllByText(/3 containers/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/bags/).length).toBeGreaterThan(0)
  })

  it('"Mark used" decrements remaining_count via a full-replace PUT', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('button', { name: 'Mark used' }))
    await waitFor(() => expect(putCalls().length).toBe(1))
    const [path, opts] = putCalls()[0]
    expect(path).toBe('/api/preservation/rec-1')
    const body = JSON.parse(opts.body)
    expect(body.remaining_count).toBe(2) // 3 → 2
    // Full replace carries the row's identity fields forward.
    expect(body.crop_type_slug).toBe('tomato')
    expect(body.quantity_value).toBe(14)
  })
})
