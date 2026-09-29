/**
 * src/__tests__/SeasonEnd.test.jsx — the End of season page, driven the way a thumb drives it.
 *
 * The rule itself is proved in seasonEnd.test.js; this file proves the page never widens it: nothing
 * pre-ticked, a group's Select acts on that group only and only once it is open, the still-growing
 * group has no group select, the confirm tells the truth about what is ticked, the writes are a status
 * and nothing else, and Undo puts back exactly the rows that landed, each to its own prior status.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

const { fetchSpy, invalidateSpy, toastApi } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  invalidateSpy: vi.fn(),
  // ONE object for the whole file: the page's unmount effect depends on the toast api's identity,
  // exactly as it depends on the provider's memoised value in the app.
  toastApi: { show: vi.fn(), showUndo: vi.fn(() => 77), dismiss: vi.fn() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../lib/dataCache.js', () => ({ invalidatePrefix: invalidateSpy }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastApi }))

import SeasonEnd from '../pages/SeasonEnd.jsx'
import { MORE_ROWS } from '../lib/moreRegistry.js'

const LOCS = [
  { id: 'bag', name: 'Bag Area', parent_id: 'pasture', covered: false, heated: false },
  { id: 'pasture', name: 'Pasture', parent_id: null, covered: false, heated: false },
  { id: 'trough', name: 'Trough', parent_id: null, covered: false, heated: false },
  { id: 'stable', name: 'Stable', parent_id: null, covered: true, heated: false },
  { id: 'rack', name: 'Indoor Rack', parent_id: 'stable', covered: false, heated: false },
]
const row = (id, name, slug, status, location_id, lifecycle = null) => ({
  id, name, status, kind: 'planting', location_id, project_id: null,
  variety_ref: { name, crop_type_slug: slug, default_lifecycle: lifecycle },
  last_logged_at: '2026-09-26T16:00:00.000Z',
})
const ROWS = [
  row('t1', 'Sungold', 'tomato', 'fruiting', 'bag'),
  row('p1', 'Aji Amarillo', 'pepper', 'harvested', 'bag'),
  row('b1', 'Genovese', 'basil', 'vegetative', 'trough'),
  row('k1', 'Lacinato', 'kale', 'vegetative', 'bag', 'biennial'),
  row('s1', 'Shelf Tomato', 'tomato', 'fruiting', 'rack'),          // covered PARENT: never listed
  row('v1', 'Lemon Verbena', 'lemon_verbena', 'vegetative', 'bag'),  // tropical: never listed
  row('c1', 'Chives', 'chives', 'vegetative', 'bag', 'perennial'),   // hardy perennial: never listed
]

let plantsBody
let locBody
let putImpl
const puts = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PUT')
  .map(([p, o]) => ({ path: p, body: JSON.parse(o.body) }))

beforeEach(() => {
  fetchSpy.mockReset()
  invalidateSpy.mockReset()
  toastApi.show.mockReset(); toastApi.dismiss.mockReset()
  toastApi.showUndo.mockReset(); toastApi.showUndo.mockImplementation(() => 77)
  localStorage.clear()
  plantsBody = { plants: ROWS.map((r) => ({ ...r })) }
  locBody = { locations: LOCS, locations_with_path: [] }
  putImpl = () => Promise.resolve({})
  fetchSpy.mockImplementation((p, o) => {
    if (o?.method === 'PUT') return putImpl(p, JSON.parse(o.body))
    if (p === '/api/plants/season-end') return Promise.resolve(plantsBody)
    if (p === '/api/locations') return Promise.resolve(locBody)
    return Promise.reject(new Error(`unexpected ${p}`))
  })
})

const renderPage = async () => {
  const view = render(<SeasonEnd />)
  await screen.findByTestId('season-end-list')
  return view
}
const group = (label) => screen.getAllByTestId('season-end-group').find((g) => g.getAttribute('data-group') === label)
const openGroup = (label) => fireEvent.click(within(group(label)).getByRole('button', { name: new RegExp(`^${label}`) }))
const rowNamed = (name) => screen.queryAllByTestId('season-end-row').find((r) => r.textContent.includes(name))
const stillGrowing = () => screen.getByTestId('season-end-still-growing-group')
const openStillGrowing = () => fireEvent.click(within(stillGrowing()).getByRole('button', { name: /^Still growing through frost/ }))
const openConfirm = () => fireEvent.click(screen.getByTestId('season-end-open-confirm'))
const confirmEnd = async () => { await act(async () => { fireEvent.click(screen.getByTestId('season-end-confirm')) }) }

describe('the list', () => {
  it('shows skeletons while loading, then collapsed groups with nothing ticked and no bar', async () => {
    render(<SeasonEnd />)
    expect(screen.getByTestId('season-end-loading')).toBeTruthy()
    await screen.findByTestId('season-end-list')
    expect(screen.getByText('End of season')).toBeTruthy()
    expect(screen.getByText('Tick what’s done for the year.')).toBeTruthy()
    expect(screen.getByText('Plants that go dormant or live indoors aren’t listed.')).toBeTruthy()
    expect(screen.getAllByTestId('season-end-group').map((g) => g.getAttribute('data-group'))).toEqual(['Bag Area', 'Trough'])
    expect(screen.queryAllByTestId('season-end-row')).toEqual([])
    expect(screen.queryByTestId('season-end-group-select')).toBeNull()
    expect(screen.queryByTestId('season-end-bar')).toBeNull()
  })

  // KILLING MUTATION: pre-tick a group's rows on open. RESULT: RED.
  it('never lists a covered-parent, tropical or perennial planting, and opens with every row unticked', async () => {
    await renderPage()
    openGroup('Bag Area'); openGroup('Trough'); openStillGrowing()
    const names = screen.getAllByTestId('season-end-row').map((r) => r.textContent)
    expect(names.some((t) => t.includes('Shelf Tomato') || t.includes('Lemon Verbena') || t.includes('Chives'))).toBe(false)
    expect(screen.getAllByTestId('season-end-row')).toHaveLength(4)
    for (const r of screen.getAllByTestId('season-end-row')) expect(r.getAttribute('aria-checked')).toBe('false')
    expect(rowNamed('Sungold').textContent).toContain('Last logged Sep 26')
  })

  it('a whole row toggles its tick', async () => {
    await renderPage()
    openGroup('Bag Area')
    fireEvent.click(rowNamed('Sungold'))
    expect(rowNamed('Sungold').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(rowNamed('Sungold'))
    expect(rowNamed('Sungold').getAttribute('aria-checked')).toBe('false')
  })
})

describe('group select', () => {
  // KILLING MUTATION: render the Select button while the group is collapsed, or select every listed
  // row instead of the group's. RESULT: RED.
  it('appears only on an open group and ticks that group\'s rows only', async () => {
    await renderPage()
    expect(within(group('Bag Area')).queryByTestId('season-end-group-select')).toBeNull()
    openGroup('Bag Area')
    const select = within(group('Bag Area')).getByTestId('season-end-group-select')
    expect(select.textContent).toBe('Select 2')
    fireEvent.click(select)
    expect(rowNamed('Sungold').getAttribute('aria-checked')).toBe('true')
    expect(rowNamed('Aji Amarillo').getAttribute('aria-checked')).toBe('true')
    openGroup('Trough')
    expect(rowNamed('Genovese').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('season-end-count').textContent).toBe('2 selected')
    expect(within(group('Bag Area')).getByTestId('season-end-group-select').textContent).toBe('Clear 2')
    fireEvent.click(within(group('Bag Area')).getByTestId('season-end-group-select'))
    expect(screen.queryByTestId('season-end-bar')).toBeNull()
  })

  // KILLING MUTATION: give the still-growing section a group Select. RESULT: RED.
  it('the still-growing group has no group select; its rows are tagged and tick one at a time', async () => {
    await renderPage()
    openStillGrowing()
    expect(within(stillGrowing()).queryByTestId('season-end-group-select')).toBeNull()
    const kale = rowNamed('Lacinato')
    expect(within(kale).getByTestId('season-end-tag').textContent).toBe('Takes frost')
    expect(kale.textContent).toContain('Bag Area')
    fireEvent.click(kale)
    expect(rowNamed('Lacinato').getAttribute('aria-checked')).toBe('true')
  })

  // KILLING MUTATION: gate light_frost_tolerant on the crop lifecycle again. RESULT: RED — the petunia
  // (a tender-perennial crop) is listed nowhere, which is the defect this pins.
  it('a light-frost crop that is not an annual shows under still growing; a hardy perennial still does not', async () => {
    plantsBody = { plants: [
      row('t1', 'Sungold', 'tomato', 'fruiting', 'bag'),
      row('pt1', 'Wave Purple', 'petunia', 'flowering', 'trough', 'tender_perennial'),
      row('c1', 'Chives', 'chives', 'vegetative', 'bag', 'perennial'),
    ] }
    await renderPage()
    expect(screen.getAllByTestId('season-end-group').map((g) => g.getAttribute('data-group'))).toEqual(['Bag Area'])
    openStillGrowing()
    const petunia = rowNamed('Wave Purple')
    expect(within(petunia).getByTestId('season-end-tag').textContent).toBe('Takes light frost')
    expect(petunia.textContent).toContain('Trough')
    expect(rowNamed('Chives')).toBeUndefined()
  })
})

describe('the confirm', () => {
  it('counts by location, names the still-growing ticks, offers ONE outcome, Cancel bottom-most', async () => {
    await renderPage()
    openGroup('Bag Area'); openGroup('Trough'); openStillGrowing()
    fireEvent.click(rowNamed('Sungold')); fireEvent.click(rowNamed('Genovese')); fireEvent.click(rowNamed('Lacinato'))
    openConfirm()
    const dialog = screen.getByRole('dialog', { name: 'End 3 plantings?' })
    expect(within(dialog).getByTestId('season-end-counts').textContent).toBe('Bag Area: 2 · Trough: 1')
    expect(within(dialog).getByTestId('season-end-still-growing').textContent).toBe('Includes 1 still growing through frost: Lacinato.')
    expect(dialog.textContent).not.toMatch(/didn.t make it|archive|reason/i)
    const confirm = within(dialog).getByTestId('season-end-confirm')
    const cancel = within(dialog).getByTestId('season-end-cancel')
    expect(confirm.textContent).toBe('End 3 plantings')
    expect(confirm.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(cancel)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(puts()).toEqual([])
  })
})

describe('the writes', () => {
  // KILLING MUTATIONS: send a loss reason or an archive flag in the body; lift the pool to all at once.
  // RESULT: RED.
  it('one PUT per planting, { status: "ended" } only, at most 3 in flight, sheet held busy with progress', async () => {
    const pending = []
    let live = 0
    let peak = 0
    putImpl = () => new Promise((resolve) => {
      live++; peak = Math.max(peak, live)
      pending.push(() => { live--; resolve({}) })
    })
    await renderPage()
    openGroup('Bag Area'); openGroup('Trough'); openStillGrowing()
    for (const n of ['Sungold', 'Aji Amarillo', 'Genovese', 'Lacinato']) fireEvent.click(rowNamed(n))
    openConfirm()
    await confirmEnd()
    const dialog = screen.getByRole('dialog', { name: 'End 4 plantings?' })
    expect(within(dialog).getByTestId('season-end-progress').textContent).toBe('Ending 1 of 4…')
    expect(within(dialog).getByTestId('season-end-cancel').disabled).toBe(true)
    expect(peak).toBe(3)
    while (pending.length) await act(async () => { pending.shift()() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(peak).toBe(3)
    const sent = puts()
    expect(sent.map((c) => c.path).sort()).toEqual(['/api/plants/b1', '/api/plants/k1', '/api/plants/p1', '/api/plants/t1'])
    for (const c of sent) expect(c.body).toEqual({ status: 'ended' })
    expect(fetchSpy.mock.calls.some(([p]) => /\/archive$/.test(p))).toBe(false)
    // Saved rows leave the list; the toast and the bar say so without claiming Today already changed.
    expect(screen.queryAllByTestId('season-end-row')).toEqual([])
    expect(toastApi.showUndo).toHaveBeenCalledTimes(1)
    // The plan runs hourly only by day (up to 4 h apart overnight), so the copy promises the next update.
    expect(toastApi.showUndo.mock.calls[0][0]).toMatchObject({ message: 'Ended 4 plantings', detail: "They leave Today's list at its next update, within a few hours." })
    expect(screen.getByTestId('season-end-result').textContent).toContain('Ended 4 plantings.')
    expect(screen.getByTestId('season-end-result').textContent).toContain("They leave Today's list at its next update, within a few hours.")
    expect(screen.getByTestId('season-end-undo')).toBeTruthy()
    expect(invalidateSpy).toHaveBeenCalledWith('/api/plants')
  })

  it('a failed row stays ticked, tagged "Didn\'t save", with Try again; a retry joins the same undo', async () => {
    let failAji = true
    putImpl = (p) => (p === '/api/plants/p1' && failAji ? Promise.reject(new Error('offline')) : Promise.resolve({}))
    await renderPage()
    openGroup('Bag Area')
    fireEvent.click(within(group('Bag Area')).getByTestId('season-end-group-select'))
    openConfirm()
    await confirmEnd()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rowNamed('Sungold')).toBeUndefined()
    expect(rowNamed('Aji Amarillo').getAttribute('aria-checked')).toBe('true')
    expect(within(rowNamed('Aji Amarillo')).getByTestId('season-end-failed').textContent).toBe('Didn’t save')
    expect(screen.getByTestId('season-end-result').textContent).toContain("Ended 1. 1 didn't save.")
    failAji = false
    await act(async () => { fireEvent.click(screen.getByTestId('season-end-retry')) })
    await waitFor(() => expect(rowNamed('Aji Amarillo')).toBeUndefined())
    expect(screen.getByTestId('season-end-result').textContent).toContain('Ended 2 plantings.')
    expect(toastApi.showUndo.mock.calls.at(-1)[0].message).toBe('Ended 2 plantings')
  })

  // Both taps land before React re-renders, so the disabled button cannot stop the second one; the ref
  // guard in endItems does (BUG-RUNBULKPARTIALUNDO-001). KILLING MUTATION: drop the inFlightRef check.
  // RESULT: RED — 4 PUTs for 2 rows.
  it('two taps on the confirm inside one act send one PUT per row', async () => {
    await renderPage()
    openGroup('Bag Area')
    fireEvent.click(within(group('Bag Area')).getByTestId('season-end-group-select'))
    openConfirm()
    const confirm = screen.getByTestId('season-end-confirm')
    await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(puts().map((c) => c.path).sort()).toEqual(['/api/plants/p1', '/api/plants/t1'])
    expect(screen.getByTestId('season-end-result').textContent).toContain('Ended 2 plantings.')
  })

  // Lie-fi: every write hangs until api.js aborts it at API_TIMEOUT_MS. KILLING MUTATIONS: keep sending
  // after 3 failures in a row; or stop, but send the next row as soon as one write fails. RESULT: RED —
  // either way more writes go out and the sheet is still held once the first three have timed out.
  it('lie-fi: once 3 writes time out in a row nothing new is sent, the sheet lets go, and every row not sent is Try again', async () => {
    const { API_TIMEOUT_MS } = await vi.importActual('../lib/api.js')
    expect(API_TIMEOUT_MS).toBe(15000)
    plantsBody = { plants: Array.from({ length: 8 }, (_, i) => row(`h${i}`, `Hung ${i}`, 'tomato', 'fruiting', 'bag')) }
    await renderPage()
    openGroup('Bag Area')
    fireEvent.click(within(group('Bag Area')).getByTestId('season-end-group-select'))
    openConfirm()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      putImpl = () => new Promise((_, reject) => { setTimeout(() => reject(new Error('Request timed out')), API_TIMEOUT_MS) })
      await confirmEnd()
      expect(puts()).toHaveLength(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS - 1) })
      expect(screen.getByRole('dialog', { name: 'End 8 plantings?' })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    expect(puts()).toHaveLength(3)
    expect(screen.getAllByTestId('season-end-failed')).toHaveLength(8)
    expect(screen.getByTestId('season-end-result').textContent).toContain("Couldn't end these. Check your signal and try again.")
    // The signal is back: Try again sends all 8, the 5 never sent included, into one undo.
    putImpl = () => Promise.resolve({})
    await act(async () => { fireEvent.click(screen.getByTestId('season-end-retry')) })
    await waitFor(() => expect(screen.getByTestId('season-end-result').textContent).toContain('Ended 8 plantings.'))
    expect(puts()).toHaveLength(11)
  })

  it('nothing saved: the ticks are kept and the bar says so', async () => {
    putImpl = () => Promise.reject(new Error('offline'))
    await renderPage()
    openGroup('Trough')
    fireEvent.click(rowNamed('Genovese'))
    openConfirm()
    await confirmEnd()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rowNamed('Genovese').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('season-end-result').textContent).toContain("Couldn't end these. Check your signal and try again.")
    expect(screen.queryByTestId('season-end-undo')).toBeNull()
    expect(toastApi.showUndo).not.toHaveBeenCalled()
  })
})

describe('undo', () => {
  const endThree = async (failIds = []) => {
    putImpl = (p, body) => (body.status === 'ended' && failIds.some((id) => p.endsWith(`/${id}`)) ? Promise.reject(new Error('x')) : Promise.resolve({}))
    await renderPage()
    openGroup('Bag Area'); openGroup('Trough')
    for (const n of ['Sungold', 'Aji Amarillo', 'Genovese']) fireEvent.click(rowNamed(n))
    openConfirm()
    await confirmEnd()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  // KILLING MUTATIONS: restore every row to one status; include the failed rows; take each prior status
  // by index AFTER the failed rows are filtered out. The FIRST tick fails here so that the last one
  // shifts every landed row's index — failing the last tick left the indices aligned and the index
  // mutation green. RESULT: RED.
  it('puts each landed row back to ITS OWN prior status, skips the failed one, and says so on a partial undo', async () => {
    await endThree(['t1'])
    fetchSpy.mockClear()
    putImpl = (p, body) => (p === '/api/plants/p1' ? Promise.reject(new Error('x')) : Promise.resolve({ body }))
    await act(async () => { fireEvent.click(screen.getByTestId('season-end-undo')) })
    await waitFor(() => expect(screen.getByTestId('season-end-result').textContent).toContain('Put back 1 of 2. 1 is still ended: Aji Amarillo.'))
    expect(puts()).toEqual(expect.arrayContaining([
      { path: '/api/plants/p1', body: { status: 'harvested' } },
      { path: '/api/plants/b1', body: { status: 'vegetative' } },
    ]))
    expect(puts()).toHaveLength(2)
    expect(puts().some((c) => c.path === '/api/plants/t1')).toBe(false)
    // The put-back row returns ticked; the one still ended stays gone, named, with Undo still offered.
    expect(rowNamed('Genovese').getAttribute('aria-checked')).toBe('true')
    expect(rowNamed('Aji Amarillo')).toBeUndefined()
    expect(screen.getByTestId('season-end-undo')).toBeTruthy()
    expect(toastApi.dismiss).toHaveBeenCalledWith(77)
  })

  // KILLING MUTATION: spend the whole offer on a partial undo (undo() nulled it before the pool ran).
  // RESULT: RED — no Undo is left for the rows still ended, and nothing names them.
  it('a partial undo keeps Undo for exactly the put-backs that failed, names them, and a second Undo puts back only those', async () => {
    const STATUSES = ['fruiting', 'harvested', 'vegetative', 'flowering']
    plantsBody = { plants: Array.from({ length: 80 }, (_, i) => row(`r${i}`, `Plant ${String(i).padStart(2, '0')}`, i % 2 ? 'pepper' : 'tomato', STATUSES[i % 4], 'bag')) }
    const failEnd = new Set(['r0', 'r10', 'r33', 'r50', 'r79'])
    const idOf = (p) => p.split('/').pop()
    putImpl = (p, body) => (body.status === 'ended' && failEnd.has(idOf(p)) ? Promise.reject(new Error('x')) : Promise.resolve({}))
    await renderPage()
    openGroup('Bag Area')
    fireEvent.click(within(group('Bag Area')).getByTestId('season-end-group-select'))
    openConfirm()
    await confirmEnd()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 })
    expect(screen.getByTestId('season-end-result').textContent).toContain("Ended 75. 5 didn't save.")

    fetchSpy.mockClear()
    putImpl = (p) => (['r1', 'r2'].includes(idOf(p)) ? Promise.reject(new Error('x')) : Promise.resolve({}))
    await act(async () => { fireEvent.click(screen.getByTestId('season-end-undo')) })
    await waitFor(() => expect(screen.getByTestId('season-end-result').textContent)
      .toContain('Put back 73 of 75. 2 are still ended: Plant 01, Plant 02.'), { timeout: 5000 })
    expect(puts()).toHaveLength(75)
    for (const c of puts()) expect(c.body, c.path).toEqual({ status: STATUSES[Number(idOf(c.path).slice(1)) % 4] })
    expect(rowNamed('Plant 01')).toBeUndefined()

    fetchSpy.mockClear()
    putImpl = () => Promise.resolve({})
    await act(async () => { fireEvent.click(screen.getByTestId('season-end-undo')) })
    await waitFor(() => expect(screen.getByTestId('season-end-result').textContent).toContain('Put back 2 plantings.'), { timeout: 5000 })
    expect(puts()).toHaveLength(2)
    expect(Object.fromEntries(puts().map((c) => [c.path, c.body]))).toEqual({
      '/api/plants/r1': { status: 'harvested' },
      '/api/plants/r2': { status: 'vegetative' },
    })
    expect(rowNamed('Plant 01').getAttribute('aria-checked')).toBe('true')
    expect(rowNamed('Plant 02').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('season-end-undo')).toBeNull()
  }, 20000)

  // KILLING MUTATION: every row put back to one status. RESULT: RED — a sorted list of statuses could not
  // see which row got which, so this pins the row → status map.
  it('the toast\'s Undo is the same undo, each row to its own prior status', async () => {
    await endThree()
    fetchSpy.mockClear()
    await act(async () => { toastApi.showUndo.mock.calls[0][0].onUndo() })
    await waitFor(() => expect(screen.getByTestId('season-end-result').textContent).toContain('Put back 3 plantings.'))
    expect(puts()).toHaveLength(3)
    expect(Object.fromEntries(puts().map((c) => [c.path, c.body]))).toEqual({
      '/api/plants/t1': { status: 'fruiting' },
      '/api/plants/p1': { status: 'harvested' },
      '/api/plants/b1': { status: 'vegetative' },
    })
  })

  // KILLING MUTATION: drop the page's unmount effect. RESULT: RED — the toast would go on offering an
  // Undo for a page that is gone.
  it('leaving the page withdraws the toast\'s Undo', async () => {
    const view = await renderPage()
    openGroup('Bag Area')
    fireEvent.click(rowNamed('Sungold'))
    openConfirm()
    await confirmEnd()
    await waitFor(() => expect(toastApi.showUndo).toHaveBeenCalledTimes(1))
    toastApi.dismiss.mockClear()
    view.unmount()
    expect(toastApi.dismiss).toHaveBeenCalledWith(77)
  })

  // KILLING MUTATION: keep the offer when a new row is ticked. RESULT: RED.
  it('ticking again ends the undo offer, in the bar and on the toast', async () => {
    await endThree()
    expect(screen.getByTestId('season-end-undo')).toBeTruthy()
    openStillGrowing()
    fireEvent.click(rowNamed('Lacinato'))
    expect(screen.queryByTestId('season-end-undo')).toBeNull()
    expect(toastApi.dismiss).toHaveBeenCalledWith(77)
  })
})

describe('states', () => {
  it('load failed: says so, and Try again loads', async () => {
    let first = true
    fetchSpy.mockImplementation((p) => {
      if (p === '/api/plants/season-end' && first) { first = false; return Promise.reject(new Error('offline')) }
      if (p === '/api/plants/season-end') return Promise.resolve(plantsBody)
      if (p === '/api/locations') return Promise.resolve(locBody)
      return Promise.reject(new Error(`unexpected ${p}`))
    })
    render(<SeasonEnd />)
    expect(await screen.findByText('Couldn’t load your plantings.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('season-end-list')
    expect(screen.getAllByTestId('season-end-group')).toHaveLength(2)
  })

  // An old Lambda answers this path from its by-id arm; a list of the wrong shape must not be read as
  // "nothing to end". KILLING MUTATION: drop the shape check in load(). RESULT: RED.
  it('a response of the wrong shape is a load failure, never an empty list', async () => {
    plantsBody = ROWS
    render(<SeasonEnd />)
    expect(await screen.findByText('Couldn’t load your plantings.')).toBeTruthy()
    expect(screen.queryByText('Nothing left to end.')).toBeNull()
  })

  it('empty: "Nothing left to end."', async () => {
    plantsBody = { plants: [row('e1', 'Done', 'tomato', 'ended', 'bag')] }
    render(<SeasonEnd />)
    expect(await screen.findByText('Nothing left to end.')).toBeTruthy()
  })
})

describe('the door ships with the route', () => {
  it('a More row "End of season" leads to /season-end, and App.jsx declares it', () => {
    const row = MORE_ROWS.find((r) => r.id === 'season-end')
    expect(row).toMatchObject({ to: '/season-end', label: 'End of season', sub: 'Close out finished plantings', section: 'garden' })
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/App.jsx'), 'utf8')
    expect(app).toMatch(/path: '\/season-end',\s+element: <Protected><ErrorBoundary scope="route" fallback=\{<RouteFallback \/>\}><SeasonEnd \/>/)
  })
})
