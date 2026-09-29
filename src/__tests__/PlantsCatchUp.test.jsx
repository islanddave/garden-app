// V5-PLANTSTARTDATES-001 — /plants/catch-up renders, saves, holds its rows still, and fails honestly.
//
// Assertions are about OUTPUT — the rows on screen, the PUT on the wire — following
// ArchivedPlantings.test.jsx and for the reason it gives: a feature in this repo once shipped inert
// because its tests checked that modules imported each other. The fixture names are real: they are
// plantings from the V5-PLANTSTARTDATES-001 ledger row that carry neither start date on prod.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'

const { fetchSpy, invalidateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  invalidateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../lib/dataCache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invalidatePrefix: invalidateSpy,
}))

import PlantsCatchUp, {
  CATCH_UP_PLANTS_PATH, CATCH_UP_LOCATIONS_PATH, plantPutPath, headerLine,
} from '../pages/PlantsCatchUp.jsx'

const LOCATIONS = [
  { id: 'loc-drive', name: 'Drive', parent_id: null, sort_order: 1 },
  { id: 'loc-bed', name: 'Raised bed 2', parent_id: 'loc-drive', sort_order: 0 },
  { id: 'loc-stable', name: 'Stable', parent_id: null, sort_order: 2 },
]

const plant = (over) => ({
  status: 'fruiting', sown_at: null, sown_at_approx: null, planted_out_at: null, planted_out_at_approx: null,
  created_at: '2026-03-01T15:00:00Z', location_id: null,
  featured_photo_id: null, featured_photo_view_url: null, featured_photo_thumb_url: null,
  variety_ref: { name: over.name, crop_type_slug: 'pepper' },
  ...over,
})

const PLANTS = [
  plant({ id: 'p-kotn', name: 'King of the North', location_id: 'loc-bed' }),
  plant({
    id: 'p-tiger', name: 'Purple Tiger', location_id: 'loc-stable', featured_photo_id: 'ph-1',
    featured_photo_view_url: 'https://cdn.test/full/tiger.jpg', featured_photo_thumb_url: 'https://cdn.test/thumbs/tiger.jpg',
  }),
  plant({ id: 'p-krim', name: 'Black Krim', status: 'ended', variety_ref: { name: 'Black Krim', crop_type_slug: 'tomato' } }),
  plant({ id: 'p-piquin', name: 'Piquin', location_id: 'loc-bed' }),
  // Not listed: each has one of the two dates, or is not live.
  plant({ id: 'p-sown', name: 'Has a sown date', location_id: 'loc-bed', sown_at: '2026-02-20' }),
  plant({ id: 'p-out', name: 'Has a planted-out date', location_id: 'loc-bed', planted_out_at: '2026-05-18' }),
  plant({ id: 'p-deleted', name: 'Deleted one', location_id: 'loc-bed', deleted_at: '2026-08-01T00:00:00Z' }),
  plant({ id: 'p-archived', name: 'Archived one', location_id: 'loc-bed', archived_at: '2026-08-01T00:00:00Z' }),
]

let plantsBody
let putImpl

beforeEach(() => {
  // Only Date is faked: the page reads "today" once per load, and real timers keep waitFor honest.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T16:00:00Z'))
  fetchSpy.mockReset()
  invalidateSpy.mockReset()
  plantsBody = PLANTS
  putImpl = () => Promise.resolve({ id: 'ok' })
  fetchSpy.mockImplementation((path, options) => {
    if (options?.method === 'PUT') return putImpl(path, options)
    if (path === CATCH_UP_PLANTS_PATH) return Promise.resolve(plantsBody)
    if (path === CATCH_UP_LOCATIONS_PATH) return Promise.resolve(LOCATIONS)
    return Promise.reject(new Error(`unexpected path ${path}`))
  })
})

afterEach(() => { vi.useRealTimers() })

async function renderLoaded() {
  render(<PlantsCatchUp />)
  await screen.findByTestId('catchup-header')
}
const rowOf = (name) => screen.getByText(name, { selector: 'div' }).closest('[data-testid="catchup-row"]')
const rowNames = () => screen.getAllByTestId('catchup-row').map(r => r.getAttribute('data-planting-id'))
const puts = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PUT')
const pick = (row, which, ym) => fireEvent.change(within(row).getByLabelText(which), { target: { value: ym } })
const saveBtn = (row) => within(row).getByRole('button')

describe('who is listed, and how', () => {
  // KILLING MUTATION: needsStartDates drops the planted_out_at half, or the deleted/archived refusal.
  // RESULT: RED — "Has a planted-out date" / "Deleted one" / "Archived one" appear.
  it('lists only live plantings with neither start date, any status', async () => {
    await renderLoaded()
    expect(screen.getByTestId('catchup-header').textContent).toBe('4 plantings have no start dates.')
    expect([...rowNames()].sort()).toEqual(['p-kotn', 'p-krim', 'p-piquin', 'p-tiger'])
    for (const gone of ['Has a sown date', 'Has a planted-out date', 'Deleted one', 'Archived one']) {
      expect(screen.queryByText(gone), gone).toBeNull()
    }
    // The ended tomato is listed: a start date is part of the record whether or not it is growing.
    expect(rowOf('Black Krim')).not.toBeNull()
  })

  it('groups by location — path headers, Garden order, empty locations dropped, no-location last', async () => {
    await renderLoaded()
    const groups = screen.getAllByTestId('catchup-group')
    expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Drive › Raised bed 2', 'Stable', 'Unsorted'])
    expect(within(groups[0]).getAllByTestId('catchup-row').map(r => r.getAttribute('data-planting-id')))
      .toEqual(['p-kotn', 'p-piquin'])
    expect(within(rowOf('King of the North')).getByText('Pepper · Raised bed 2')).toBeDefined()
    expect(within(rowOf('Black Krim')).getByText('Tomato · No location')).toBeDefined()
  })

  it('shows the photo thumb at THUMB tier, and a plain tile when there is no photo', async () => {
    await renderLoaded()
    const img = within(rowOf('Purple Tiger')).getByTestId('catchup-thumb')
    expect(img.getAttribute('src')).toBe('https://cdn.test/thumbs/tiger.jpg')
    expect(within(rowOf('King of the North')).queryByTestId('catchup-thumb')).toBeNull()
  })

  it('offers month-level pickers limited to the grow year, none in the future, 48px tall', async () => {
    await renderLoaded()
    const row = rowOf('King of the North')
    for (const which of ['Sown ~', 'Planted out ~']) {
      const select = within(row).getByLabelText(which)
      const labels = [...select.options].map(o => o.textContent)
      expect(labels[0]).toBe('—')
      expect(labels[1]).toBe('Nov 2025')
      expect(labels.at(-1)).toBe('Sep 2026')
      expect(labels).toHaveLength(12)
      expect(select.style.minHeight).toBe('48px')
    }
    expect(saveBtn(row).style.minHeight).toBe('48px')
  })

  it('empty state when every planting has a start date', async () => {
    plantsBody = PLANTS.filter(p => p.sown_at || p.planted_out_at)
    render(<PlantsCatchUp />)
    expect(await screen.findByText('Every planting has a start date.')).toBeDefined()
    expect(screen.queryByTestId('catchup-row')).toBeNull()
    expect(screen.queryByTestId('catchup-header')).toBeNull()
  })

  it('shows a loading state, then a load failure with Try again that reloads', async () => {
    let failNext = true
    fetchSpy.mockImplementation((path) => {
      if (path === CATCH_UP_PLANTS_PATH) {
        if (failNext) { failNext = false; return Promise.reject(new Error('Network down')) }
        return Promise.resolve(PLANTS)
      }
      if (path === CATCH_UP_LOCATIONS_PATH) return Promise.resolve(LOCATIONS)
      return Promise.reject(new Error(`unexpected path ${path}`))
    })
    render(<PlantsCatchUp />)
    expect(screen.getByText('Loading plantings…')).toBeDefined()
    expect(await screen.findByText('Network down')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('catchup-header')).toBeDefined()
    expect(rowNames()).toHaveLength(4)
  })

  it('headerLine says "1 planting has"', () => {
    expect(headerLine(1)).toBe('1 planting has no start dates.')
    expect(headerLine(8)).toBe('8 plantings have no start dates.')
  })
})

describe('saving a row', () => {
  // KILLING MUTATION (each): send approx false; add a key (e.g. status); send the unchosen date.
  // RESULT: RED on the exact-body equality below.
  it('sown only → only sown_at + sown_at_approx, to that planting', async () => {
    await renderLoaded()
    const row = rowOf('King of the North')
    pick(row, 'Sown ~', '2026-02')
    fireEvent.click(saveBtn(row))
    await waitFor(() => expect(puts()).toHaveLength(1))
    const [path, options] = puts()[0]
    expect(path).toBe(plantPutPath('p-kotn'))
    expect(JSON.parse(options.body)).toEqual({ sown_at: '2026-02-15', sown_at_approx: true })
  })

  it('planted out only → only planted_out_at + planted_out_at_approx', async () => {
    await renderLoaded()
    const row = rowOf('Piquin')
    pick(row, 'Planted out ~', '2026-05')
    fireEvent.click(saveBtn(row))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0][0]).toBe(plantPutPath('p-piquin'))
    expect(JSON.parse(puts()[0][1].body)).toEqual({ planted_out_at: '2026-05-15', planted_out_at_approx: true })
  })

  it('both → both dates and both flags, nothing else', async () => {
    await renderLoaded()
    const row = rowOf('Purple Tiger')
    pick(row, 'Sown ~', '2026-01')
    pick(row, 'Planted out ~', '2026-05')
    fireEvent.click(saveBtn(row))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(JSON.parse(puts()[0][1].body)).toEqual({
      sown_at: '2026-01-15', sown_at_approx: true, planted_out_at: '2026-05-15', planted_out_at_approx: true,
    })
    expect(invalidateSpy).toHaveBeenCalledWith('/api/plants')
  })

  it('Save stays off until a month is picked', async () => {
    await renderLoaded()
    expect(saveBtn(rowOf('King of the North')).disabled).toBe(true)
  })

  // KILLING MUTATION: drop the outBeforeSown check. RESULT: RED (Save enabled, PUT sent).
  it('refuses a planted-out month before the sown month', async () => {
    await renderLoaded()
    const row = rowOf('King of the North')
    pick(row, 'Sown ~', '2026-05')
    pick(row, 'Planted out ~', '2026-04')
    expect(within(row).getByText('Planted out can’t be before sown.')).toBeDefined()
    expect(saveBtn(row).disabled).toBe(true)
    fireEvent.click(saveBtn(row))
    expect(puts()).toHaveLength(0)
  })

  // KILLING MUTATION: re-derive the list after a save (drop rows that now have a date), or tick the
  // header count down. RESULT: RED — the row leaves, the rows below shift, the count changes.
  it('a saved row stays exactly where it was, says Saved, and can be edited again', async () => {
    await renderLoaded()
    const before = rowNames()
    const row = rowOf('King of the North')
    pick(row, 'Sown ~', '2026-03')
    fireEvent.click(saveBtn(row))
    await waitFor(() => expect(within(rowOf('King of the North')).getByText('Saved')).toBeDefined())
    expect(rowNames()).toEqual(before)
    expect(screen.getByTestId('catchup-header').textContent).toBe('4 plantings have no start dates.')
    // A saved month cannot be blanked (the PUT cannot unset it), but it can be changed.
    const sown = within(rowOf('King of the North')).getByLabelText('Sown ~')
    expect([...sown.options].map(o => o.value)).not.toContain('')
    expect(saveBtn(rowOf('King of the North')).disabled).toBe(true)
    pick(rowOf('King of the North'), 'Sown ~', '2026-04')
    expect(within(rowOf('King of the North')).queryByText('Saved')).toBeNull()
    fireEvent.click(saveBtn(rowOf('King of the North')))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(JSON.parse(puts()[1][1].body)).toEqual({ sown_at: '2026-04-15', sown_at_approx: true })
    expect(rowNames()).toEqual(before)
  })

  // KILLING MUTATION: treat a failed PUT as saved (or blank the list on failure). RESULT: RED.
  it('a failed save says Didn’t save on that row only, and Try again resends the same body', async () => {
    let fail = true
    putImpl = () => (fail ? Promise.reject(new Error('500')) : Promise.resolve({ id: 'ok' }))
    await renderLoaded()
    const row = rowOf('Piquin')
    pick(row, 'Sown ~', '2026-02')
    fireEvent.click(saveBtn(row))
    await waitFor(() => expect(within(rowOf('Piquin')).getByText('Didn’t save')).toBeDefined())
    expect(saveBtn(rowOf('Piquin')).textContent).toBe('Try again')
    expect(within(rowOf('King of the North')).queryByText('Didn’t save')).toBeNull()
    expect(rowNames()).toHaveLength(4)
    fail = false
    fireEvent.click(saveBtn(rowOf('Piquin')))
    await waitFor(() => expect(within(rowOf('Piquin')).getByText('Saved')).toBeDefined())
    expect(puts()).toHaveLength(2)
    expect(puts()[1][1].body).toBe(puts()[0][1].body)
  })

  // KILLING MUTATION: drop `loading={saving}` from Save. RESULT: RED (two PUTs).
  it('a double tap sends one PUT', async () => {
    let resolvePut
    putImpl = () => new Promise(r => { resolvePut = r })
    await renderLoaded()
    const row = rowOf('Piquin')
    pick(row, 'Sown ~', '2026-02')
    const btn = saveBtn(row)
    fireEvent.click(btn)
    fireEvent.click(btn)
    await act(async () => { resolvePut({ id: 'ok' }) })
    expect(puts()).toHaveLength(1)
  })
})
