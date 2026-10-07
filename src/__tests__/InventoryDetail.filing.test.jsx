// V5-SEEDMULTIPARENT-001 release 2b — the lot page RE-FILES the jar by itself (decision D2, contract O-3).
//
// When an add or a removal moves the set's cultivars, the SAME set PUT carries `filing`: more than one
// cultivar is filed under their named mix, which POST /api/varieties/blend { create: true } makes FIRST
// (the filing names a variety that must exist); exactly one is filed under that cultivar, with no mix
// call. The page answers with "Filed as <name>" and Undo, and Undo is ONE write: the old set, the old
// cache and a `filing` built from the `previous` the server returned.
//
// The traps pinned here are UX L-3's:
//   * the jar is renamed only while its name is still the automatic one, and it KEEPS THE YEAR already
//     in it (a 2025 jar re-filed in 2026 is still "saved 2025");
//   * a name the user typed, or is typing, is left alone and no `name` is sent;
//   * the page's own Save sends form.name on every edit, so a re-file that renamed the jar must also
//     move the name field, or the next Save writes the old name back with a 200.
//
// Mocks come from the contract-built fixture; the fetch mock routes by path and method. No jest-dom.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef, updateItemSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), itemRef: { current: null }, updateItemSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: '00000000-0000-4000-8000-000000000009' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: vi.fn().mockResolvedValue({ ok: true }) }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { lotReply, blendReply, sourcePlantsPutReply, refusal } from './fixtures/seedMix.fixture.js'

// The contract's jar: P1 and P1B are cultivar A1, P2 is cultivar A2, and MIX is the named mix of the two.
const CONTRACT_LOT = lotReply()
const [P1, P1B, P2] = CONTRACT_LOT.source_plants
const ID = CONTRACT_LOT.id
const MIX = blendReply()
const A1 = { id: P1.variety_id, name: P1.variety_name, rank: 'cultivar' }
const A2 = { id: P2.variety_id, name: P2.variety_name, rank: 'cultivar' }
// A second planting of A2, and a planting of a third cultivar of the same crop.
const P2B = { ...P2, id: '00000000-0000-4000-8000-00000000000b', name: 'p2b-second-of-a2' }
const A3 = { id: '00000000-0000-4000-8000-00000000000c', name: 'sms-variety-a3', rank: 'cultivar' }
const P4 = { ...P1, id: '00000000-0000-4000-8000-00000000000d', name: 'p4-of-a3', variety_id: A3.id, variety_name: A3.name }
const MIX3 = { id: '00000000-0000-4000-8000-00000000000e', name: `${A1.name} + ${A2.name} + ${A3.name} mix`, rank: 'blend' }
const BY_ID = Object.fromEntries([P1, P1B, P2, P2B, P4].map((p) => [p.id, p]))
const VARIETY = Object.fromEntries([A1, A2, A3, { id: MIX.id, name: MIX.name, rank: 'blend' }, MIX3].map((v) => [v.id, v]))

const auto = (variety, year) => `${variety.name} — saved ${year}`

// A jar of ONE cultivar (A1), on its automatic name from a year that is not this one.
const jarOfOne = (over = {}) => lotReply({
  category: 'seeds', type: 'consumable', quantity_on_hand: 1, unit: 'packet', status: 'active',
  name: auto(A1, 2025), variety_id: A1.id, variety_name: A1.name, variety_rank: 'cultivar',
  breeding_system: P1.breeding_system, source_plant_id: P1.id, source_plants: [P1],
  seed_parent_plant_count: null, seed_stage: null, source_kind: null,
  ...over,
})
// The same jar after a second cultivar: filed as the mix.
const jarOfTwo = (over = {}) => jarOfOne({
  name: auto(MIX, 2025), variety_id: MIX.id, variety_name: MIX.name, variety_rank: 'blend',
  breeding_system: null, source_plants: [P1, P2],
  ...over,
})

const pickerRow = (p) => ({
  id: p.id, name: p.name, quantity: 1, variety_id: p.variety_id, project_name: null,
  variety_ref: { id: p.variety_id, name: p.variety_name, crop_type_slug: p.crop_slug },
  sown_at: null, succession_order: null, status: 'harvested',
})
const PICKER = [P1, P1B, P2, P2B, P4].map(pickerRow)

const SET_PATH = `/api/inventory-items/${ID}/source-plants`
const BLEND_PATH = '/api/varieties/blend'
const LOT_PATH = `/api/inventory-items/${ID}`
const indexesOf = (path, method) => fetchSpy.mock.calls
  .map(([p, o], i) => (String(p) === path && (o?.method ?? 'GET') === method ? i : -1)).filter((i) => i >= 0)
const bodiesOf = (path, method) => indexesOf(path, method).map((i) => JSON.parse(fetchSpy.mock.calls[i][1].body))
const setBodies = () => bodiesOf(SET_PATH, 'PUT')
const blendBodies = () => bodiesOf(BLEND_PATH, 'POST')

const refused = (code) => {
  const r = refusal(code)
  return Object.assign(new Error(r.body.error), { status: r.status, body: r.body })
}

// The set route as the server answers it, filing included: one transaction, and `previous` is the jar
// as it was stored. An unchanged target writes nothing, the name included (R1 contract, PUT /filing).
function storeSet(body) {
  const before = itemRef.current
  const ids = body.source_plant_ids
  const plants = ids.map((id) => ({ ...BY_ID[id] }))
  const cache = body.source_plant_id ?? (ids.includes(before.source_plant_id) ? before.source_plant_id : ids[0] ?? null)
  let next = { ...before, source_plant_id: cache, source_plants: plants }
  let filing
  if (body.filing) {
    const changed = before.variety_id !== body.filing.variety_id
    const to = VARIETY[changed ? body.filing.variety_id : before.variety_id]
    const name = changed ? (body.filing.name ?? before.name) : before.name
    next = { ...next, variety_id: to.id, variety_name: to.name, variety_rank: to.rank, name }
    filing = {
      variety_id: to.id, variety_name: to.name, variety_rank: to.rank, name, changed,
      previous: { variety_id: before.variety_id, name: before.name },
    }
  }
  itemRef.current = next
  return sourcePlantsPutReply({ id: ID, source_plant_id: cache, source_plants: plants, filing })
}

let routes
function wire() {
  routes = {
    put: (body) => Promise.resolve(storeSet(body)),
    blend: (body) => Promise.resolve(body.component_variety_ids.length === 2
      ? blendReply()
      : blendReply({ id: MIX3.id, name: MIX3.name })),
  }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    const method = opts?.method ?? 'GET'
    if (p === SET_PATH && method === 'PUT') return routes.put(JSON.parse(opts.body))
    if (p === BLEND_PATH && method === 'POST') return routes.blend(JSON.parse(opts.body))
    if (p === LOT_PATH && method === 'GET') return Promise.resolve(itemRef.current)
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PICKER)
    return Promise.resolve([])
  })
}

let now
beforeEach(() => {
  fetchSpy.mockReset()
  updateItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: {} })
  itemRef.current = jarOfOne()
  wire()
  now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => { vi.restoreAllMocks() })

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByTestId('seed-source-plant')).toBeTruthy())
}

const rows = () => screen.queryAllByTestId('saved-from-row')
const rowOf = (plant) => rows().find((r) => r.textContent.includes(plant.name))
const liveRows = () => rows().filter((r) => r.getAttribute('data-struck') !== 'true')
const removeButton = (plant) => rowOf(plant).querySelector('[data-testid="saved-from-remove"]')
const undoButton = (plant) => rowOf(plant).querySelector('[data-testid="saved-from-undo"]')
const filedLine = () => screen.queryByTestId('saved-from-filed')
const filedUndo = () => screen.getByTestId('saved-from-filed-undo')
const nameField = () => screen.getByLabelText('Name')
const heading = () => screen.getByRole('heading', { level: 1 }).textContent
const help = () => screen.queryByTestId('source-plant-help')?.textContent ?? ''
const click = (el) => act(async () => { fireEvent.click(el) })

// After a refused add the picker stays open for another choice; otherwise the adder is a button.
const addFromPicker = async (plant) => {
  if (screen.queryByTestId('saved-from-add')) await click(screen.getByTestId('saved-from-add'))
  fireEvent.focus(screen.getByTestId('saved-from-add-select'))
  await waitFor(() => expect(screen.getByTestId(`ps-opt-${plant.id}`)).toBeTruthy())
  await click(screen.getByTestId(`ps-opt-${plant.id}`))
}

describe('Re-file by itself — a second cultivar files the jar as their mix', () => {
  it('makes the mix FIRST, then one PUT carries the set and the filing', async () => {
    await renderPage()
    await addFromPicker(P2)

    // The mix: the set's distinct variety ids in uuid order, and `create: true`.
    expect(blendBodies()).toEqual([{ component_variety_ids: [A1.id, A2.id], create: true }])
    expect(setBodies()).toEqual([{
      source_plant_ids: [P1.id, P2.id],
      expected_source_plant_ids: [P1.id],
      // The mix the route just returned, expecting the variety the jar is stored under, and the name
      // re-made around the mix with the year the jar ALREADY carried (2025, not this year).
      filing: { variety_id: MIX.id, expect_variety_id: A1.id, name: auto(MIX, 2025) },
    }])
    // One write for the add and its re-file; the mix came before it.
    expect(indexesOf(BLEND_PATH, 'POST')[0]).toBeLessThan(indexesOf(SET_PATH, 'PUT')[0])

    await waitFor(() => expect(filedLine().textContent).toContain(`Filed as ${MIX.name}`))
    expect(filedUndo()).toBeTruthy()
    expect(liveRows()).toHaveLength(2)
  })

  it('moves the page’s name field and heading, so the page’s own Save cannot write the old name back', async () => {
    await renderPage()
    expect(nameField().value).toBe(auto(A1, 2025))
    await addFromPicker(P2)

    await waitFor(() => expect(nameField().value).toBe(auto(MIX, 2025)))
    expect(heading()).toBe(auto(MIX, 2025))
    // The page's Save sends form.name on every edit (UX L-3 c). It must be the new one.
    await click(screen.getByText('Save changes'))
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(updateItemSpy.mock.calls[0][1].name).toBe(auto(MIX, 2025))
  })

  it('Undo is ONE write: the old set, the old cache, and the filing built from `previous`', async () => {
    await renderPage()
    await addFromPicker(P2)
    await waitFor(() => expect(filedLine()).toBeTruthy())
    await click(filedUndo())

    expect(setBodies()).toHaveLength(2)
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id],
      expected_source_plant_ids: [P1.id, P2.id],
      source_plant_id: P1.id,
      // previous.variety_id and previous.name as the server returned them; expecting the mix it is on now.
      filing: { variety_id: A1.id, expect_variety_id: MIX.id, name: auto(A1, 2025) },
    })
    // No second mix call: an Undo names a variety that already exists.
    expect(blendBodies()).toHaveLength(1)
    await waitFor(() => expect(filedLine()).toBeNull())
    // The planting the add put on the jar is simply gone again: it was never "removed" by the user.
    expect(rows()).toHaveLength(1)
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    expect(nameField().value).toBe(auto(A1, 2025))
    expect(heading()).toBe(auto(A1, 2025))
    await click(screen.getByText('Save changes'))
    expect(updateItemSpy.mock.calls[0][1].name).toBe(auto(A1, 2025))
  })

  it('Undo never files the jar back under one cultivar while another planting still makes it a mix', async () => {
    // P2 made the jar a mix; then P2B, a second planting of that same cultivar, joined it. Undoing the
    // first add takes P2 off, but the jar still holds two cultivars: `previous` no longer describes the
    // set this write leaves, so no filing rides along and the jar stays the mix.
    await renderPage()
    await addFromPicker(P2)
    await waitFor(() => expect(filedLine()).toBeTruthy())
    await addFromPicker(P2B)
    await waitFor(() => expect(liveRows()).toHaveLength(3))
    await click(filedUndo())

    expect(setBodies()[2]).toEqual({
      source_plant_ids: [P1.id, P2B.id], expected_source_plant_ids: [P1.id, P2.id, P2B.id], source_plant_id: P1.id,
    })
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    expect(filedLine()).toBeNull()
    expect(itemRef.current.variety_id).toBe(MIX.id)
    expect(nameField().value).toBe(auto(MIX, 2025))
  })

  it('a third cultivar files the jar under the mix of all three', async () => {
    itemRef.current = jarOfTwo()
    await renderPage()
    await addFromPicker(P4)

    expect(blendBodies()).toEqual([{ component_variety_ids: [A1.id, A2.id, A3.id].sort(), create: true }])
    expect(setBodies()[0].filing).toEqual({ variety_id: MIX3.id, expect_variety_id: MIX.id, name: auto(MIX3, 2025) })
    await waitFor(() => expect(filedLine().textContent).toContain(`Filed as ${MIX3.name}`))
  })

  it('another planting of a cultivar already on the jar sends no filing and makes no mix', async () => {
    itemRef.current = jarOfTwo()
    await renderPage()
    await addFromPicker(P2B)
    expect(setBodies()).toEqual([{ source_plant_ids: [P1.id, P2.id, P2B.id], expected_source_plant_ids: [P1.id, P2.id] }])
    expect(blendBodies()).toHaveLength(0)
    expect(filedLine()).toBeNull()
    expect(nameField().value).toBe(auto(MIX, 2025))
  })
})

describe('Re-file by itself — the jar’s name (UX L-3)', () => {
  it('keeps the year of a "Saved seed <year>" default too', async () => {
    itemRef.current = jarOfOne({ name: 'Saved seed 2024' })
    await renderPage()
    await addFromPicker(P2)
    expect(setBodies()[0].filing).toEqual({ variety_id: MIX.id, expect_variety_id: A1.id, name: auto(MIX, 2024) })
    await waitFor(() => expect(nameField().value).toBe(auto(MIX, 2024)))
  })

  it('leaves a hand-typed name alone: no `name` is sent and the field does not move', async () => {
    itemRef.current = jarOfOne({ name: 'Grandma’s nasturtiums' })
    await renderPage()
    await addFromPicker(P2)

    expect(setBodies()[0].filing).toEqual({ variety_id: MIX.id, expect_variety_id: A1.id })
    await waitFor(() => expect(filedLine().textContent).toContain(`Filed as ${MIX.name}`))
    expect(nameField().value).toBe('Grandma’s nasturtiums')
    expect(heading()).toBe('Grandma’s nasturtiums')

    // …and its Undo sends no name either: there is no rename to take back.
    await click(filedUndo())
    expect(setBodies()[1].filing).toEqual({ variety_id: A1.id, expect_variety_id: MIX.id })
    expect(nameField().value).toBe('Grandma’s nasturtiums')
  })

  it('leaves a name that is BEING typed alone, judged on what the field shows now', async () => {
    // Stored on the automatic name, but the field no longer shows it.
    await renderPage()
    await act(async () => { fireEvent.change(nameField(), { target: { value: 'Front bed mix, for Jen' } }) })
    await addFromPicker(P2)

    expect(setBodies()[0].filing).toEqual({ variety_id: MIX.id, expect_variety_id: A1.id })
    await waitFor(() => expect(filedLine()).toBeTruthy())
    expect(nameField().value).toBe('Front bed mix, for Jen')
  })

  it('Undo leaves the name alone when the field has been retyped since the re-file', async () => {
    await renderPage()
    await addFromPicker(P2)
    await waitFor(() => expect(nameField().value).toBe(auto(MIX, 2025)))
    await act(async () => { fireEvent.change(nameField(), { target: { value: 'My own name now' } }) })
    await click(filedUndo())

    expect(setBodies()[1].filing).toEqual({ variety_id: A1.id, expect_variety_id: MIX.id })
    await waitFor(() => expect(filedLine()).toBeNull())
    expect(nameField().value).toBe('My own name now')
  })
})

describe('Re-file by itself — a removal that leaves one cultivar files the jar under it', () => {
  beforeEach(() => { itemRef.current = jarOfTwo() })

  it('names the cultivar in the same PUT, with no mix call', async () => {
    await renderPage()
    await click(removeButton(P2))

    expect(blendBodies()).toHaveLength(0)
    expect(setBodies()).toEqual([{
      source_plant_ids: [P1.id],
      expected_source_plant_ids: [P1.id, P2.id],
      filing: { variety_id: A1.id, expect_variety_id: MIX.id, name: auto(A1, 2025) },
    }])
    await waitFor(() => expect(filedLine().textContent).toContain(`Filed as ${A1.name}`))
    expect(rowOf(P2).textContent).toContain(`${P2.name} · Removed`)
    expect(nameField().value).toBe(auto(A1, 2025))
  })

  it('the struck row’s Undo puts the planting AND the mix back in one write, from `previous`', async () => {
    await renderPage()
    await click(removeButton(P2))
    await waitFor(() => expect(filedLine()).toBeTruthy())
    now += 401
    await click(undoButton(P2))

    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P2.id],
      expected_source_plant_ids: [P1.id],
      source_plant_id: P1.id,
      filing: { variety_id: MIX.id, expect_variety_id: A1.id, name: auto(MIX, 2025) },
    })
    // The mix is named from `previous`, not made again.
    expect(blendBodies()).toHaveLength(0)
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    expect(filedLine()).toBeNull()
    expect(nameField().value).toBe(auto(MIX, 2025))
  })

  it('the "Filed as" line’s Undo is that same one write, and takes the struck row with it', async () => {
    await renderPage()
    await click(removeButton(P2))
    await waitFor(() => expect(filedLine()).toBeTruthy())
    await click(filedUndo())

    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P2.id],
      expected_source_plant_ids: [P1.id],
      source_plant_id: P1.id,
      filing: { variety_id: MIX.id, expect_variety_id: A1.id, name: auto(MIX, 2025) },
    })
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    expect(filedLine()).toBeNull()
  })

  it('removing one of two plantings of the SAME cultivar files nothing', async () => {
    itemRef.current = jarOfTwo({ source_plants: [P1, P2, P2B] })
    await renderPage()
    await click(removeButton(P2B))
    expect(setBodies()).toEqual([{ source_plant_ids: [P1.id, P2.id], expected_source_plant_ids: [P1.id, P2.id, P2B.id] }])
    expect(filedLine()).toBeNull()
  })

  it('sends the removal ALONE when the one cultivar left is a variety since deleted (an id with no name, O-4)', async () => {
    // The server refuses a filing under a deleted variety, and it would refuse the whole edit with it,
    // every time. The planting comes off; the jar stays filed, and named, as it was.
    itemRef.current = jarOfTwo({ source_plants: [P1, { ...P2, variety_name: null, crop_slug: null }] })
    await renderPage()
    await click(removeButton(P1))

    expect(setBodies()).toEqual([{ source_plant_ids: [P2.id], expected_source_plant_ids: [P1.id, P2.id] }])
    expect(blendBodies()).toHaveLength(0)
    await waitFor(() => expect(rowOf(P1).textContent).toContain(`${P1.name} · Removed`))
    expect(filedLine()).toBeNull()
    expect(itemRef.current.variety_id).toBe(MIX.id)
    expect(nameField().value).toBe(auto(MIX, 2025))
  })

  it('Undo into a jar this visit EMPTIED files it under the planting put back, not the one removed last', async () => {
    // Remove P2: the jar is re-filed under A1. Remove P1: no parents, so no filing (PP-11) and the jar
    // is still A1's. Undo P2: the server does not judge a one-plant set, so without a filing in this
    // write the jar would hold a planting of A2 and stay filed, and named, as A1.
    await renderPage()
    await click(removeButton(P2))
    await waitFor(() => expect(filedLine()).toBeTruthy())
    await click(removeButton(P1))
    expect(setBodies()[1]).toEqual({ source_plant_ids: [], expected_source_plant_ids: [P1.id] })
    expect(itemRef.current.variety_id).toBe(A1.id)
    now += 401
    await click(undoButton(P2))

    expect(setBodies()).toHaveLength(3)
    expect(setBodies()[2]).toEqual({
      source_plant_ids: [P2.id],
      expected_source_plant_ids: [],
      // No cache hint: the cache this row remembers (P1) is not a member of the set being written.
      filing: { variety_id: A2.id, expect_variety_id: A1.id, name: auto(A2, 2025) },
    })
    // One cultivar: named, never made as a mix.
    expect(blendBodies()).toHaveLength(0)
    await waitFor(() => expect(liveRows()).toHaveLength(1))
    expect(itemRef.current.variety_id).toBe(A2.id)
    expect(nameField().value).toBe(auto(A2, 2025))
  })
})

describe('Re-file by itself — what it never does', () => {
  it('never sends a filing for a jar left with NO parents (PP-11), whatever it is filed under', async () => {
    itemRef.current = jarOfTwo({ source_plants: [P2], source_plant_id: P2.id })
    await renderPage()
    await click(removeButton(P2))
    expect(setBodies()).toEqual([{ source_plant_ids: [], expected_source_plant_ids: [P2.id] }])
    expect(blendBodies()).toHaveLength(0)
    expect(filedLine()).toBeNull()
  })

  it('never sends a filing for a FIRST planting on a jar with no parents, even one of another cultivar', async () => {
    // The no-parent picker is pinned to the jar's own cultivar, so this cannot be reached by hand. The
    // row is made to pass that filter (`variety_id` is the jar's) while its `variety_ref`, which is
    // what the card reads, names A2: the rule holds by itself and not only because of the pin.
    itemRef.current = jarOfOne({ source_plant_id: null, source_plants: [] })
    const stray = { ...pickerRow(P2), variety_id: A1.id }
    const original = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) =>
      (String(path).startsWith('/api/plants?view=picker') ? Promise.resolve([stray]) : original(path, opts)))
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${P2.id}`)).toBeTruthy())
    await click(screen.getByTestId(`ps-opt-${P2.id}`))

    expect(setBodies()).toEqual([{ source_plant_ids: [P2.id], expected_source_plant_ids: [] }])
    expect(blendBodies()).toHaveLength(0)
    expect(filedLine()).toBeNull()
    expect(nameField().value).toBe(auto(A1, 2025))
  })

  it('a mix that cannot be made writes nothing: no PUT, the add rolled back, the client’s sentence', async () => {
    routes.blend = () => Promise.reject(Object.assign(new Error('Too many mixes this hour'), { status: 429, body: { error: 'Too many mixes this hour' } }))
    await renderPage()
    await addFromPicker(P2)

    await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
    expect(setBodies()).toHaveLength(0)
    expect(liveRows()).toHaveLength(1)
    expect(filedLine()).toBeNull()
    expect(nameField().value).toBe(auto(A1, 2025))
    expect(screen.getByTestId('seed-source-plant').textContent).not.toContain('Too many mixes')
  })

  it('a mix call that timed out left the jar alone, and the page may say so: no PUT went, no re-read', async () => {
    // Only the set write can change the jar. The mix route writes no jar and is idempotent, so a
    // timeout here is still "nothing was changed"; the unanswered-write sentence is the PUT's alone.
    routes.blend = () => Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true }))
    await renderPage()
    await addFromPicker(P2)

    await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
    expect(setBodies()).toHaveLength(0)
    expect(indexesOf(LOT_PATH, 'GET')).toHaveLength(1)
    expect(liveRows()).toHaveLength(1)
  })

  it.each(['blend_required', 'variety_unusable', 'filing_crop_mismatch'])(
    'a PUT refused with %s refuses the whole edit: nothing is filed, and the next try reuses the mix', async (code) => {
      routes.put = () => Promise.reject(refused(code))
      await renderPage()
      await addFromPicker(P2)

      await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
      expect(liveRows()).toHaveLength(1)
      expect(filedLine()).toBeNull()
      expect(nameField().value).toBe(auto(A1, 2025))
      expect(heading()).toBe(auto(A1, 2025))

      // The second try asks for the same mix (the route is idempotent) and files under it.
      routes.put = (body) => Promise.resolve(storeSet(body))
      await addFromPicker(P2)
      expect(blendBodies()).toHaveLength(2)
      expect(blendBodies()[1]).toEqual(blendBodies()[0])
      await waitFor(() => expect(filedLine().textContent).toContain(`Filed as ${MIX.name}`))
    })

  it('says nothing when the server reports the filing unchanged', async () => {
    // Another device filed the jar under the mix a moment ago: `changed: false`, and nothing was written.
    routes.put = (body) => {
      const reply = storeSet(body)
      reply.filing = { ...reply.filing, changed: false, name: auto(A1, 2025), previous: { variety_id: MIX.id, name: auto(A1, 2025) } }
      return Promise.resolve(reply)
    }
    await renderPage()
    await addFromPicker(P2)
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    expect(filedLine()).toBeNull()
    expect(nameField().value).toBe(auto(A1, 2025))
  })

  it('a stale filing answers lot_changed like any other: the jar is read again and nothing is claimed', async () => {
    routes.put = () => {
      itemRef.current = jarOfTwo()
      return Promise.reject(Object.assign(refused('lot_changed'), {}))
    }
    await renderPage()
    await addFromPicker(P2B)

    await waitFor(() => expect(help())
      .toBe('This jar changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
    expect(liveRows()).toHaveLength(2)
    expect(filedLine()).toBeNull()
    // The jar was renamed elsewhere, and the field still showed the automatic name: it follows.
    expect(nameField().value).toBe(auto(MIX, 2025))
    expect(heading()).toBe(auto(MIX, 2025))
  })
})
