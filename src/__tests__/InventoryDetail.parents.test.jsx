// V5-SEEDMULTIPARENT-001 release 2b — the lot page's "Saved from" card for a jar gathered off SEVERAL
// plantings (src/components/seed/SavedFromCard.jsx, driven through the real page).
//
// What is pinned here is what goes wrong quietly:
//   * the BODY of every set write — the whole set, and always the set this page last read
//     (`expected_source_plant_ids`), because a write without it overwrites a change made elsewhere;
//   * Remove and Undo as two bodies: the set without the planting, then the set with it back and the
//     cache the jar had before;
//   * one set write in flight — "Undo pressed before Remove answered" has a stated outcome: it is
//     IGNORED (no second request, the row stays struck), and Undo answers once Remove has;
//   * a struck row lasts only until the page is left, and leaving is what withdraws that plant's
//     `seed_saved` timeline entry for this jar (contract O-11);
//   * the two 409 codes, with and without `lot_changed`'s extra keys: the jar is read again in place,
//     and neither the server's sentence nor a Reload button ever shows.
//
// A one-cultivar jar throughout, so no write here carries a filing; the re-file is
// InventoryDetail.filing.test.jsx. Mocks come from the contract-built fixture. The fetch mock routes by
// path and method, never by call order, and no test uses a timer: the 400 ms Undo guard reads Date.now,
// which the suite owns. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: '00000000-0000-4000-8000-000000000009' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { lotReply, sourcePlantsPutReply, measureReply, refusal } from './fixtures/seedMix.fixture.js'

// The contract's jar: three plantings of two cultivars. P1 and P1B are one cultivar (A1), P2 another.
const CONTRACT_LOT = lotReply()
const [P1, P1B, P2] = CONTRACT_LOT.source_plants
const CROP = P1.crop_slug
const ID = CONTRACT_LOT.id
// A third planting of A1, in the garden but not on the jar, and a planting of another crop.
const P3 = { ...P1, id: '00000000-0000-4000-8000-00000000000a', name: 'p1c-third-planting' }
const BY_ID = Object.fromEntries([P1, P1B, P2, P3].map((p) => [p.id, p]))

// The jar under test: two plantings of ONE cultivar, filed under it. No write here moves the cultivars.
const jar = (over = {}) => lotReply({
  category: 'seeds', type: 'consumable', quantity_on_hand: 1, unit: 'packet', status: 'active',
  name: 'Saved A1 jar', variety_id: P1.variety_id, variety_name: P1.variety_name, variety_rank: 'cultivar',
  breeding_system: P1.breeding_system, source_plant_id: P1.id, source_plants: [P1, P1B],
  seed_parent_plant_count: null, seed_stage: null, source_kind: null,
  ...over,
})

const pickerRow = (p, over = {}) => ({
  id: p.id, name: p.name, quantity: 1, variety_id: p.variety_id, project_name: null,
  variety_ref: { id: p.variety_id, name: p.variety_name, crop_type_slug: p.crop_slug },
  sown_at: null, succession_order: null, status: 'harvested', ...over,
})
const BASIL = {
  id: 'pl-basil', name: 'Basil', quantity: 6, variety_id: 'v-basil', project_name: null,
  variety_ref: { id: 'v-basil', name: 'Genovese', crop_type_slug: 'basil' }, sown_at: null, succession_order: null,
}
const PICKER = [pickerRow(P1), pickerRow(P1B), pickerRow(P3), BASIL]

const SET_PATH = `/api/inventory-items/${ID}/source-plants`
const MEASURE_PATH = `/api/inventory-items/${ID}/seed-measure`
const LOT_PATH = `/api/inventory-items/${ID}`
const callsTo = (path, method = 'GET') =>
  fetchSpy.mock.calls.filter(([p, o]) => String(p) === path && (o?.method ?? 'GET') === method)
const bodyOf = (call) => JSON.parse(call[1].body)
const setBodies = () => callsTo(SET_PATH, 'PUT').map(bodyOf)
const eventReads = () => fetchSpy.mock.calls.filter(([p, o]) => String(p).startsWith('/api/events?') && !o?.method)
const eventDeletes = () => fetchSpy.mock.calls.filter(([p, o]) => String(p).startsWith('/api/events/') && o?.method === 'DELETE')

const refused = (code, extra = {}) => {
  const r = refusal(code)
  return Object.assign(new Error(r.body.error), { status: r.status, body: { ...r.body, ...extra } })
}
const deferred = () => {
  let resolve; let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// The set route as the server answers it: the set written, a cache that is the hint when one was sent
// and otherwise stays while it is still a member, and the stored jar moved to match.
function storeSet(body) {
  const ids = body.source_plant_ids
  const plants = ids.map((id) => ({ ...BY_ID[id] }))
  const cache = body.source_plant_id ?? (ids.includes(itemRef.current.source_plant_id) ? itemRef.current.source_plant_id : ids[0] ?? null)
  itemRef.current = { ...itemRef.current, source_plant_id: cache, source_plants: plants }
  return sourcePlantsPutReply({ id: ID, source_plant_id: cache, source_plants: plants })
}

// Each handler is replaceable per test. `events` is keyed by plant_id.
let routes
function wire() {
  routes = {
    put: (body) => Promise.resolve(storeSet(body)),
    measure: (body) => Promise.resolve(measureReply(body)),
    events: {},
    kind: () => Promise.resolve({ id: ID }),
  }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    const method = opts?.method ?? 'GET'
    if (p === SET_PATH && method === 'PUT') return routes.put(JSON.parse(opts.body))
    if (p === MEASURE_PATH && method === 'PUT') return routes.measure(JSON.parse(opts.body))
    if (p === `${LOT_PATH}/source-kind` && method === 'PATCH') return routes.kind()
    if (p === LOT_PATH && method === 'GET') return Promise.resolve(itemRef.current)
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PICKER)
    if (p.startsWith('/api/events?')) {
      const plantId = new URLSearchParams(p.split('?')[1]).get('plant_id')
      return Promise.resolve(routes.events[plantId] ?? [])
    }
    if (p.startsWith('/api/events/') && method === 'DELETE') return Promise.resolve(null)
    return Promise.resolve([])
  })
}

// The Undo guard's clock. Frozen unless a test moves it.
let now
beforeEach(() => {
  fetchSpy.mockReset()
  itemRef.current = jar()
  wire()
  now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => { vi.restoreAllMocks() })

const renderPage = async () => {
  let view
  await act(async () => { view = render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByTestId('seed-source-plant')).toBeTruthy())
  return view
}

const rows = () => screen.queryAllByTestId('saved-from-row')
const rowOf = (plant) => rows().find((r) => r.textContent.includes(plant.name))
const liveRows = () => rows().filter((r) => r.getAttribute('data-struck') !== 'true')
const removeButton = (plant) => rowOf(plant).querySelector('[data-testid="saved-from-remove"]')
const undoButton = (plant) => rowOf(plant).querySelector('[data-testid="saved-from-undo"]')
const help = () => screen.queryByTestId('source-plant-help')?.textContent ?? ''
const card = () => screen.getByTestId('seed-source-plant')
const click = (el) => act(async () => { fireEvent.click(el) })
const pastTheGuard = () => { now += 401 }

// After a refused add the picker stays open for another choice; otherwise the adder is a button.
const addFromPicker = async (plant) => {
  if (screen.queryByTestId('saved-from-add')) await click(screen.getByTestId('saved-from-add'))
  fireEvent.focus(screen.getByTestId('saved-from-add-select'))
  await waitFor(() => expect(screen.getByTestId(`ps-opt-${plant.id}`)).toBeTruthy())
  await click(screen.getByTestId(`ps-opt-${plant.id}`))
}

describe('Saved from — the rows', () => {
  it('lists a row per planting, each a door to that planting, with its own remove control', async () => {
    await renderPage()
    expect(rows()).toHaveLength(2)
    expect(rowOf(P1).querySelector('a').getAttribute('href')).toBe(`/plantings/${P1.id}`)
    expect(rowOf(P1B).querySelector('a').getAttribute('href')).toBe(`/plantings/${P1B.id}`)
    expect(removeButton(P1).getAttribute('aria-label')).toBe(`Remove ${P1.name}`)
    // The single picker of release 1 is gone: a jar with plantings shows them.
    expect(screen.queryByTestId('source-plant-select')).toBeNull()
    // The processing chain counts the plantings instead of naming one of several.
    await waitFor(() =>
      expect(screen.getByTestId('seed-history-origin').textContent).toBe('Saved from 2 plantings'))
  })

  it.each([
    [1, null],
    [2, 'Mixed together. A seed from this jar could be from either planting.'],
    [3, 'Mixed together. A seed from this jar could be from any of these plantings.'],
  ])('with %i planting(s) the mixed-together line reads %j', async (n, line) => {
    itemRef.current = jar({ source_plants: [P1, P1B, P3].slice(0, n) })
    await renderPage()
    expect(rows()).toHaveLength(n)
    expect(screen.queryByTestId('saved-from-mixed')?.textContent ?? null).toBe(line)
  })

  it('names a DELETED planting without a door, and gives its removal no Undo', async () => {
    itemRef.current = jar({ source_plants: [P1, { ...P1B, deleted: true }] })
    await renderPage()
    expect(rowOf(P1B).querySelector('a')).toBeNull()
    await click(removeButton(P1B))
    await waitFor(() => expect(rowOf(P1B).textContent).toContain(`${P1B.name} · Removed`))
    // Putting a deleted planting back could only be refused.
    expect(undoButton(P1B)).toBeNull()
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
  })
})

describe('Saved from — adding a planting', () => {
  it('offers the set’s own crop only, and never a planting already on the jar', async () => {
    await renderPage()
    await click(screen.getByTestId('saved-from-add'))
    fireEvent.focus(screen.getByTestId('saved-from-add-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${P3.id}`)).toBeTruthy())
    expect(screen.queryByTestId(`ps-opt-${P1.id}`)).toBeNull()
    expect(screen.queryByTestId(`ps-opt-${P1B.id}`)).toBeNull()
    expect(screen.queryByTestId('ps-opt-pl-basil')).toBeNull()
    // Scoped by the crop the set shares.
    expect(CROP).toBeTruthy()
  })

  it('writes at once through the set route, with the set it last read', async () => {
    await renderPage()
    await addFromPicker(P3)

    expect(setBodies()).toEqual([
      { source_plant_ids: [P1.id, P1B.id, P3.id], expected_source_plant_ids: [P1.id, P1B.id] },
    ])
    await waitFor(() => expect(liveRows()).toHaveLength(3))
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    // One cultivar before and after: no mix is made and no filing rides along.
    expect(callsTo('/api/varieties/blend', 'POST')).toHaveLength(0)
    // The adder is a button again, and the next write expects the set as it now stands.
    await click(removeButton(P3))
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P1B.id], expected_source_plant_ids: [P1.id, P1B.id, P3.id],
    })
  })

  it.each([
    ['mixed_crop_parents', "That planting is a different crop, so it wasn't added."],
    ['parent_without_variety', "That planting has no variety recorded, so it wasn't added."],
    ['blend_required', "Couldn't save that. Nothing was changed."],
  ])('a %s refusal rolls the add back and prints the client’s own sentence', async (code, sentence) => {
    routes.put = () => Promise.reject(refused(code))
    await renderPage()
    await addFromPicker(P3)

    await waitFor(() => expect(help()).toBe(sentence))
    expect(liveRows()).toHaveLength(2)
    expect(rowOf(P3)).toBeUndefined()
    // Never the server's sentence, and nothing was read again: a rule's refusal is not a stale jar.
    expect(card().textContent).not.toContain(refusal(code).body.error)
    expect(callsTo(LOT_PATH)).toHaveLength(1)
  })

  it('an uncoded 400 prints the same plain sentence, not the server’s', async () => {
    routes.put = () => Promise.reject(Object.assign(new Error('source_plant_ids must be an array of ids'),
      { status: 400, body: { error: 'source_plant_ids must be an array of ids' } }))
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
    expect(card().textContent).not.toContain('source_plant_ids')
    expect(liveRows()).toHaveLength(2)
  })

  it.each([
    ['has no variety', { variety_id: null, variety_name: null, crop_slug: null }],
    ['is of a variety since deleted (an id with no name, contract O-4)', { variety_name: null, crop_slug: null }],
  ])('hides the adder when a planting on the jar %s, and says why', async (_, gone) => {
    itemRef.current = jar({ source_plants: [{ ...P1, ...gone }] })
    await renderPage()
    expect(rows()).toHaveLength(1)
    expect(screen.queryByTestId('saved-from-add')).toBeNull()
    expect(screen.getByTestId('saved-from-no-variety').textContent)
      .toBe(`${P1.name} has no variety recorded, so another planting can't be added to this jar.`)
  })
})

describe('Saved from — Remove and Undo', () => {
  it('sends the set without the planting, then the set with it back and the old cache', async () => {
    // P1B is removed; P1 is the cache before and after, so the hint is a member of the set Undo writes.
    await renderPage()
    await click(removeButton(P1B))

    expect(setBodies()).toEqual([
      { source_plant_ids: [P1.id], expected_source_plant_ids: [P1.id, P1B.id] },
    ])
    // Struck in place: still the second row, the word "Removed" as text, Undo where the ✕ was.
    expect(rows()).toHaveLength(2)
    expect(rows()[1].textContent).toContain(`${P1B.name} · Removed`)
    expect(rows()[1].getAttribute('data-struck')).toBe('true')
    expect(rowOf(P1B).querySelector('[data-testid="saved-from-remove"]')).toBeNull()
    expect(undoButton(P1B)).toBeTruthy()
    // Said politely, once, by a region that was on the page before the row changed.
    const live = screen.getByTestId('saved-from-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe(`${P1B.name} · Removed`)

    pastTheGuard()
    await click(undoButton(P1B))
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P1B.id], expected_source_plant_ids: [P1.id], source_plant_id: P1.id,
    })
    // QA I11: Undo means the set of live parents equals the set before Remove.
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
  })

  it('Undo asks for the cache the jar had, when the removed planting WAS the cache', async () => {
    await renderPage()
    await click(removeButton(P1))
    expect(setBodies()[0]).toEqual({ source_plant_ids: [P1B.id], expected_source_plant_ids: [P1.id, P1B.id] })
    // The server moved the cache to the planting that is left.
    expect(itemRef.current.source_plant_id).toBe(P1B.id)

    pastTheGuard()
    await click(undoButton(P1))
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P1B.id], expected_source_plant_ids: [P1B.id], source_plant_id: P1.id,
    })
  })

  it('Undo ignores taps for 400 ms, so a double tap on ✕ does not undo itself', async () => {
    await renderPage()
    await click(removeButton(P1B))
    await click(undoButton(P1B))
    now += 399
    await click(undoButton(P1B))
    expect(setBodies()).toHaveLength(1)
    expect(rowOf(P1B).getAttribute('data-struck')).toBe('true')

    now += 2
    await click(undoButton(P1B))
    expect(setBodies()).toHaveLength(2)
  })

  it('Undo pressed BEFORE Remove answered is ignored: one write in flight, and Undo works once it lands', async () => {
    const first = deferred()
    routes.put = () => first.promise
    await renderPage()
    await click(removeButton(P1B))
    // Struck at the tap, not at the answer.
    expect(rowOf(P1B).textContent).toContain(`${P1B.name} · Removed`)
    expect(help()).toBe('Saving…')

    // Well past the 400 ms guard, so the only thing holding Undo back is the write in flight.
    pastTheGuard()
    await click(undoButton(P1B))
    // …and no other row control answers either.
    await click(removeButton(P1))
    expect(setBodies()).toHaveLength(1)
    expect(undoButton(P1B).getAttribute('aria-disabled')).toBe('true')

    routes.put = (body) => Promise.resolve(storeSet(body))
    await act(async () => { first.resolve(storeSet({ source_plant_ids: [P1.id] })) })
    // The stated outcome: the ignored Undo was not queued. The row is still struck and nothing else went.
    expect(setBodies()).toHaveLength(1)
    expect(rowOf(P1B).getAttribute('data-struck')).toBe('true')
    expect(liveRows()).toHaveLength(1)

    await click(undoButton(P1B))
    expect(setBodies()).toHaveLength(2)
    expect(setBodies()[1].source_plant_ids).toEqual([P1.id, P1B.id])
    await waitFor(() => expect(liveRows()).toHaveLength(2))
  })

  it('a Remove the server did not take puts the row back, in the client’s own words', async () => {
    routes.put = () => Promise.reject(Object.assign(new Error('Internal error'), { status: 500, body: { error: 'Internal error' } }))
    await renderPage()
    await click(removeButton(P1B))
    await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
    expect(liveRows()).toHaveLength(2)
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    expect(card().textContent).not.toContain('Internal error')
  })

  // api.js's two shapes for a request that went out and was never answered.
  const timedOut = () => Object.assign(new Error('Request timed out'), { status: 0, timeout: true })
  const dropped = () => new TypeError('Failed to fetch')

  it.each([
    ['timed out', timedOut],
    ['lost its reply to a dropped connection', dropped],
  ])('a Remove that %s claims nothing: the jar is read again and drawn as stored', async (_, errorOf) => {
    // The write landed; only its reply was lost.
    routes.put = (body) => { storeSet(body); return Promise.reject(errorOf()) }
    await renderPage()
    expect(callsTo(LOT_PATH)).toHaveLength(1)
    await click(removeButton(P1B))

    await waitFor(() => expect(help())
      .toBe('This jar changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
    expect(callsTo(LOT_PATH)).toHaveLength(2)
    // The planting is off the jar, as stored. Not struck: this page never heard that it was removed.
    expect(rows()).toHaveLength(1)
    expect(rowOf(P1B)).toBeUndefined()
    expect(card().textContent).not.toContain('Nothing was changed')
    expect(card().textContent).not.toContain(errorOf().message)
  })

  it.each([
    ['cannot be read again', () => Promise.reject(new Error('offline'))],
    // The service worker answers a read from its own copy when there is no network, and marks it.
    ['is answered from the copy kept for offline use', () => Promise.resolve(
      Object.defineProperty({ ...itemRef.current }, Symbol.for('garden-app.fromCache'), { value: true }))],
  ])('an unanswered Remove whose jar %s still does not say nothing was changed', async (_, readAgain) => {
    routes.put = () => Promise.reject(timedOut())
    await renderPage()
    const original = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) =>
      (String(path) === LOT_PATH && !opts?.method ? readAgain() : original(path, opts)))
    await click(removeButton(P1B))

    await waitFor(() => expect(help())
      .toBe("That didn't finish, so the change may or may not have saved. Open this jar again to check before you try again."))
    // The row is back as it was: nothing is struck on a guess.
    expect(liveRows()).toHaveLength(2)
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    expect(card().textContent).not.toContain('Nothing was changed')
  })
})

describe('Saved from — leaving the page', () => {
  it('a struck row does not survive leaving, and leaving withdraws that plant’s seed_saved entry for THIS jar', async () => {
    routes.events[P1B.id] = [
      { id: 'ev-this-jar', event_type: 'seed_saved', metadata: { seed_lot_id: ID } },
      { id: 'ev-other-jar', event_type: 'seed_saved', metadata: { seed_lot_id: 'another-lot' } },
      { id: 'ev-harvest', event_type: 'harvest', metadata: { seed_lot_id: ID } },
      { id: 'ev-no-meta', event_type: 'seed_saved', metadata: null },
    ]
    const view = await renderPage()
    await click(removeButton(P1B))
    await waitFor(() => expect(undoButton(P1B)).toBeTruthy())
    // Nothing is withdrawn while Undo is still on offer.
    expect(eventReads()).toHaveLength(0)

    view.unmount()
    await waitFor(() => expect(eventDeletes()).toHaveLength(1))
    expect(eventReads().map(([p]) => p)).toEqual([`/api/events?plant_id=${P1B.id}&limit=200`])
    expect(eventDeletes()[0][0]).toBe('/api/events/ev-this-jar')

    // Back on the page: the jar as stored, no struck row, nothing to undo.
    await renderPage()
    expect(rows()).toHaveLength(1)
    expect(rowOf(P1B)).toBeUndefined()
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    expect(card().textContent).not.toContain('Removed')
  })

  it('finding no entry is a success, and a failed read is silent', async () => {
    const view = await renderPage()
    await click(removeButton(P1B))
    await waitFor(() => expect(undoButton(P1B)).toBeTruthy())
    const original = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) =>
      (String(path).startsWith('/api/events?') ? Promise.reject(new Error('offline')) : original(path, opts)))
    view.unmount()
    await waitFor(() => expect(eventReads()).toHaveLength(1))
    expect(eventDeletes()).toHaveLength(0)
  })

  it('withdraws nothing for a planting put back with Undo', async () => {
    routes.events[P1B.id] = [{ id: 'ev-this-jar', event_type: 'seed_saved', metadata: { seed_lot_id: ID } }]
    const view = await renderPage()
    await click(removeButton(P1B))
    pastTheGuard()
    await click(undoButton(P1B))
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(eventReads()).toHaveLength(0)
    expect(eventDeletes()).toHaveLength(0)
  })

  it('choosing an origin that refuses a parent takes the struck rows with it (UX L-5)', async () => {
    // With the last planting struck the origin select is offered. A shop-bought origin hides the parent
    // card, so the struck row's Undo, which could only be refused, goes too; that is a leaving.
    itemRef.current = jar({ source_plants: [P1] })
    await renderPage()
    await click(removeButton(P1))
    await waitFor(() => expect(undoButton(P1)).toBeTruthy())
    const origin = await screen.findByTestId('source-kind-select')
    await act(async () => { fireEvent.change(origin, { target: { value: 'store' } }) })
    await waitFor(() => expect(rows()).toHaveLength(0))
    await waitFor(() =>
      expect(eventReads().map(([p]) => p)).toEqual([`/api/events?plant_id=${P1.id}&limit=200`]))
  })
})

describe('Saved from — the jar changed somewhere else (both 409 codes)', () => {
  // What another device left behind: a third planting on the jar.
  const elsewhere = () => jar({ source_plants: [P1, P1B, P3] })

  it.each([
    ['lot_changed with its extra keys', () => refused('lot_changed', { source_plant_id: P1.id, source_plants: [P1, P1B, P3] })],
    ['lot_changed with NO extra keys (a rolled-back transaction has no read-back)', () => refused('lot_changed')],
    ['parents_changed', () => refused('parents_changed')],
  ])('%s: reads the jar again in place, redraws, and says so in one line', async (_, refusalOf) => {
    const err = refusalOf()
    routes.put = () => { itemRef.current = elsewhere(); return Promise.reject(err) }
    await renderPage()
    expect(callsTo(LOT_PATH)).toHaveLength(1)
    await click(removeButton(P1B))

    await waitFor(() => expect(help())
      .toBe('This jar changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
    // Read again, once, in place: the rows are the jar as stored now, and the failed strike is undone.
    expect(callsTo(LOT_PATH)).toHaveLength(2)
    expect(liveRows()).toHaveLength(3)
    expect(rowOf(P3)).toBeTruthy()
    expect(screen.queryByTestId('saved-from-undo')).toBeNull()
    // No Reload button, and never the server's sentence.
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull()
    expect(card().textContent).not.toMatch(/reload/i)
    expect(card().textContent).not.toContain(err.body.error)

    // Trying again expects the set just read.
    routes.put = (body) => Promise.resolve(storeSet(body))
    await click(removeButton(P1B))
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P3.id], expected_source_plant_ids: [P1.id, P1B.id, P3.id],
    })
  })

  it('when the jar cannot be read again either, the plain sentence shows and the rows stay', async () => {
    routes.put = () => Promise.reject(refused('lot_changed'))
    await renderPage()
    const original = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) =>
      (String(path) === LOT_PATH && !opts?.method ? Promise.reject(new Error('offline')) : original(path, opts)))
    await click(removeButton(P1B))
    await waitFor(() => expect(help()).toBe("Couldn't save that. Nothing was changed."))
    expect(liveRows()).toHaveLength(2)
  })
})

describe('Saved from — the plant count', () => {
  const field = () => screen.getByTestId('saved-from-plant-count')
  const typeAndLeave = async (text) => {
    await act(async () => { fireEvent.change(field(), { target: { value: text } }) })
    await act(async () => { fireEvent.blur(field()) })
  }

  it('reads "Seed off about N plants", with the stored number in the field', async () => {
    itemRef.current = jar({ seed_parent_plant_count: 12 })
    await renderPage()
    expect(field().value).toBe('12')
    expect(field().closest('label').textContent).toBe('Seed off aboutplants')
  })

  it('writes through /seed-measure when the field is left, and only that key', async () => {
    await renderPage()
    expect(field().value).toBe('')
    await typeAndLeave('7')
    expect(callsTo(MEASURE_PATH, 'PUT').map(bodyOf)).toEqual([{ seed_parent_plant_count: 7 }])
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    expect(field().value).toBe('7')
    // Never through the set route or the page's own Save.
    expect(setBodies()).toHaveLength(0)
    // Leaving the field again with the same number sends nothing.
    await act(async () => { fireEvent.blur(field()) })
    expect(callsTo(MEASURE_PATH, 'PUT')).toHaveLength(1)
  })

  it('a blank field clears the stored count with an explicit null', async () => {
    itemRef.current = jar({ seed_parent_plant_count: 12 })
    await renderPage()
    await typeAndLeave('')
    expect(callsTo(MEASURE_PATH, 'PUT').map(bodyOf)).toEqual([{ seed_parent_plant_count: null }])
  })

  it('a 200 WITHOUT the key means not saved (a Lambda from before the column)', async () => {
    routes.measure = () => Promise.resolve({ id: ID, seed_count: null, seed_weight_g: null, seed_count_estimated: null })
    await renderPage()
    await typeAndLeave('7')
    await waitFor(() => expect(help()).toBe("Couldn't record the plant count."))
    expect(screen.queryByText('✓ Saved')).toBeNull()
  })

  it.each(['0', '2.5', '-3', 'lots'])('refuses "%s" before any request', async (text) => {
    await renderPage()
    await typeAndLeave(text)
    expect(help()).toBe('A plant count is a whole number, 1 or more.')
    expect(callsTo(MEASURE_PATH, 'PUT')).toHaveLength(0)
  })

  it('is not offered on a jar with no plantings and no count', async () => {
    itemRef.current = jar({ source_plant_id: null, source_plants: [] })
    await renderPage()
    expect(screen.queryByTestId('saved-from-plant-count')).toBeNull()
  })
})
