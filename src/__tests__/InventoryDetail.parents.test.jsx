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
//     and neither the server's sentence nor a Reload button ever shows;
//   * the `seed_saved` entry a fresh add writes that plant (V5-SEEDLOTADDENTRY-001): its body, the
//     cases that write none, and that a later change to the plant waits for it.
//
// A one-cultivar jar throughout, so no write here carries a filing; the re-file is
// InventoryDetail.filing.test.jsx. Mocks come from the contract-built fixture. The fetch mock routes by
// path and method, never by call order, and no test uses a timer: the 400 ms Undo guard reads Date.now,
// which the suite owns. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

// SEED_MULTI_PARENT is held ON here whichever way the literal ships. These are the flag-on cases, and the
// release's forward undo is a build with the literal false (scripts/forward-undo.py), which must not
// redden them: `npm run test:flag-off:seed` is that rehearsal. featureFlags.test.js pins the literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SEED_MULTI_PARENT() { return true },
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
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { lotReply, sourcePlantsPutReply, measureReply, refusal } from './fixtures/seedMix.fixture.js'
import { todayLocalISO } from '../lib/dateLocal.js'

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
const eventPosts = () => callsTo('/api/events', 'POST')

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

// Each handler is replaceable per test. `events` is keyed by plant_id and behaves as the server's list
// does: a POST adds the row it answers with, a DELETE takes a row out.
let routes
function wire() {
  let made = 0
  routes = {
    put: (body) => Promise.resolve(storeSet(body)),
    measure: (body) => Promise.resolve(measureReply(body)),
    events: {},
    post: (body) => {
      const row = { id: `ev-new-${(made += 1)}`, ...body }
      routes.events[body.plant_id] = [row, ...(routes.events[body.plant_id] ?? [])]
      return Promise.resolve(row)
    },
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
    if (p === '/api/events' && method === 'POST') return routes.post(JSON.parse(opts.body))
    if (p.startsWith('/api/events/') && method === 'DELETE') {
      const id = p.slice('/api/events/'.length)
      for (const k of Object.keys(routes.events)) routes.events[k] = routes.events[k].filter((e) => e.id !== id)
      return Promise.resolve(null)
    }
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
    [2, 'Mixed together. A seed from this lot could be from either planting.'],
    [3, 'Mixed together. A seed from this lot could be from any of these plantings.'],
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
      .toBe(`${P1.name} has no variety recorded, so another planting can't be added to this lot.`)
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
      .toBe('This lot changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
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
      .toBe("That didn't finish, so the change may or may not have saved. Open this lot again to check before you try again."))
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

  it('leaving while the Remove is still in flight withdraws nothing: the server has not said it took it', async () => {
    routes.events[P1B.id] = [{ id: 'ev-this-jar', event_type: 'seed_saved', metadata: { seed_lot_id: ID } }]
    const held = deferred()
    routes.put = () => held.promise
    const view = await renderPage()
    await click(removeButton(P1B))
    // Struck at the tap, and the write is still out.
    expect(rowOf(P1B).getAttribute('data-struck')).toBe('true')
    expect(setBodies()).toHaveLength(1)

    view.unmount()
    await act(async () => { await Promise.resolve() })
    // A removal the server may yet refuse must not take the plant's timeline entry with it.
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

// V5-SEEDLOTADDENTRY-001 (re-review RR-04; Dave 2026-10-07: "Write the line on add"). The Save seed sheet
// writes one `seed_saved` entry per parent; a plant added on this page got none, so remove, leave and
// add again left it a parent with no line and its date gone.
describe('Saved from — the timeline entry an add writes', () => {
  // 16:00Z is the same local day in both CI zones (UTC and America/New_York) and on the author's Mac.
  // It is the next day from UTC+8 eastward; the evening case below is the one that tells zones apart.
  const STARTED = '2026-10-06T16:00:00.000Z'
  const CHANGED = 'This lot changed somewhere else just now. This is the latest. Try again if it still needs changing.'
  const thisJars = (id = 'ev-first') => ({ id, event_type: 'seed_saved', event_date: '2026-10-06', metadata: { seed_lot_id: ID } })
  const nameField = () => screen.getByLabelText('Name')

  it('a fresh add writes that plant ONE entry for this jar, after the set write, dated the day the jar was started', async () => {
    itemRef.current = jar({ created_at: STARTED })
    await renderPage()
    await addFromPicker(P3)

    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(eventReads().map(([p]) => p)).toEqual([`/api/events?plant_id=${P3.id}&limit=200`])
    expect(bodyOf(eventPosts()[0])).toEqual({
      plant_id: P3.id,
      event_type: 'seed_saved',
      event_date: '2026-10-06',
      notes: 'Seed lot "Saved A1 jar".',
      metadata: { seed_lot_id: ID },
    })
    const at = (path, method) => fetchSpy.mock.calls.findIndex(([p, o]) => String(p) === path && (o?.method ?? 'GET') === method)
    expect(at(SET_PATH, 'PUT')).toBeLessThan(at('/api/events', 'POST'))
    // Nothing more follows it.
    await act(async () => { await Promise.resolve() })
    expect(eventPosts()).toHaveLength(1)
    expect(eventDeletes()).toHaveLength(0)
  })

  it('a jar with no readable start day dates the entry today', async () => {
    itemRef.current = jar({ created_at: null })
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0]).event_date).toBe(todayLocalISO())
  })

  it('the note quotes the name as SAVED, never one that is only typed', async () => {
    itemRef.current = jar({ created_at: STARTED })
    await renderPage()
    await act(async () => { fireEvent.change(nameField(), { target: { value: 'half a new na' } }) })
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0]).notes).toBe('Seed lot "Saved A1 jar".')
  })

  // Review RF-01 / Q1: the page's Save moves its baseline, not `item`, so the name as loaded is stale
  // once a rename has been saved.
  it('a name SAVED on this visit, then an add: the note quotes the name as saved', async () => {
    itemRef.current = jar({ created_at: STARTED })
    await renderPage()
    await act(async () => { fireEvent.change(nameField(), { target: { value: 'Renamed and saved' } }) })
    await click(screen.getByText('Save changes'))
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    expect(nameField().value).toBe('Renamed and saved')
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0]).notes).toBe('Seed lot "Renamed and saved".')
  })

  // Delta review RD-02: a name changed elsewhere reaches `item` through the re-read, not the baseline.
  it('a name changed elsewhere, read again after a 409, is the one the note quotes', async () => {
    itemRef.current = jar({ created_at: STARTED, name: 'My own jar name' })
    await renderPage()
    let n = 0
    const realPut = routes.put
    routes.put = (body) => {
      n += 1
      if (n > 1) return realPut(body)
      itemRef.current = { ...itemRef.current, name: 'Renamed elsewhere' }
      return Promise.reject(refused('lot_changed'))
    }
    await addFromPicker(P3)
    await waitFor(() => expect(help()).toBe(CHANGED))
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0]).notes).toBe('Seed lot "Renamed elsewhere".')
  })

  // Q4: a one-plant lot whose parent is corrected goes through the FIRST picker, onto an empty set.
  it('the first picker on a lot with no parents writes the entry too', async () => {
    itemRef.current = jar({ created_at: STARTED, source_plants: [], source_plant_id: null })
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${P1.id}`)).toBeTruthy())
    await click(screen.getByTestId(`ps-opt-${P1.id}`))
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(setBodies()[0]).toMatchObject({ source_plant_ids: [P1.id], expected_source_plant_ids: [] })
    expect(bodyOf(eventPosts()[0])).toEqual({
      plant_id: P1.id, event_type: 'seed_saved', event_date: '2026-10-06',
      notes: 'Seed lot "Saved A1 jar".', metadata: { seed_lot_id: ID },
    })
  })

  // Q2: 01:30Z is the evening before in America/New_York (the unit-ny job) and the same day in UTC, so
  // dating by the UTC day turns this red there.
  it('a lot started late in the evening is dated its LOCAL day', async () => {
    const LATE = '2026-10-07T01:30:00.000Z'
    const d = new Date(LATE)
    const pad = (n) => String(n).padStart(2, '0')
    const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    itemRef.current = jar({ created_at: LATE })
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0]).event_date).toBe(localDay)
  })

  // Q3: the entry goes when the page is LEFT with the row still struck, never at the remove tap.
  it('add, remove, Undo, leave: the plant is on the lot and keeps the entry the add wrote', async () => {
    const view = await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    await click(removeButton(P3))
    await waitFor(() => expect(undoButton(P3)).toBeTruthy())
    pastTheGuard()
    await click(undoButton(P3))
    await waitFor(() => expect(liveRows()).toHaveLength(3))
    view.unmount()
    await act(async () => { await Promise.resolve() })
    await new Promise((r) => setTimeout(r, 20))
    expect(eventDeletes()).toHaveLength(0)
    expect(routes.events[P3.id]).toHaveLength(1)
  })

  // Q9(a), contract O-11a: known and filed (V5-SEEDR2BFOLLOWUPS-001). Stated so a change either way shows.
  it('an add that landed with its reply lost: the plant is on the lot and gets no entry', async () => {
    routes.put = (body) => { storeSet(body); return Promise.reject(Object.assign(new Error('Request timed out'), { status: 0, timeout: true })) }
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(help()).toBe(CHANGED))
    await act(async () => { await Promise.resolve() })
    await new Promise((r) => setTimeout(r, 20))
    expect(rowOf(P3)).toBeTruthy()
    expect(eventPosts()).toHaveLength(0)
  })

  // Review RF-02 / Q11. The route answers the newest 200 by entry date; an entry dated the jar's start
  // day sits past them on a busy planting (prod 2026-10-08: two plantings over 200).
  describe('a planting with more than 200 entries', () => {
    const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: `ev-w-${i}`, event_type: 'watering', event_date: '2026-10-07' }))
    // The route as the server answers it: a bare newest-200 with no offset, the envelope with one.
    const paged = (all) => {
      const original = fetchSpy.getMockImplementation()
      fetchSpy.mockImplementation((path, opts) => {
        const p = String(path)
        if (!p.startsWith('/api/events?') || opts?.method) return original(path, opts)
        const q = new URLSearchParams(p.split('?')[1])
        const rows = all()
        if (!q.has('offset')) return Promise.resolve(rows.slice(0, 200))
        const at = Number(q.get('offset'))
        const page = rows.slice(at, at + 200)
        return Promise.resolve({ events: page, limit: 200, offset: at, has_more: page.length === 200 })
      })
    }

    it('an add reads on past the first page and writes none when the entry is there', async () => {
      await renderPage()
      paged(() => [...filler(200), ...filler(200).map((e) => ({ ...e, id: `b-${e.id}` })), thisJars('ev-old')])
      await addFromPicker(P3)
      await waitFor(() => expect(eventReads().map(([p]) => p)).toEqual([
        `/api/events?plant_id=${P3.id}&limit=200`,
        `/api/events?plant_id=${P3.id}&limit=200&offset=200`,
        `/api/events?plant_id=${P3.id}&limit=200&offset=400`,
      ]))
      await act(async () => { await Promise.resolve() })
      await new Promise((r) => setTimeout(r, 20))
      expect(eventPosts()).toHaveLength(0)
    })

    it('an add writes the entry when no page holds one', async () => {
      await renderPage()
      paged(() => [...filler(200), ...filler(40).map((e) => ({ ...e, id: `b-${e.id}` }))])
      await addFromPicker(P3)
      await waitFor(() => expect(eventPosts()).toHaveLength(1))
      expect(eventReads()).toHaveLength(2)
    })

    it('a later page that fails writes nothing: a list it could not finish cannot say', async () => {
      await renderPage()
      const original = fetchSpy.getMockImplementation()
      fetchSpy.mockImplementation((path, opts) => {
        const p = String(path)
        if (p.startsWith('/api/events?') && !opts?.method) {
          return p.includes('offset=') ? Promise.reject(new Error('offline')) : Promise.resolve(filler(200))
        }
        return original(path, opts)
      })
      await addFromPicker(P3)
      await waitFor(() => expect(eventReads()).toHaveLength(2))
      await act(async () => { await Promise.resolve() })
      await new Promise((r) => setTimeout(r, 20))
      expect(eventPosts()).toHaveLength(0)
      expect(liveRows()).toHaveLength(3)
      expect(help()).toBe('')
    })

    // Delta review RD-01: what was read is still acted on when a later page fails.
    it('leaving withdraws a first-page entry even when the next page fails', async () => {
      const view = await renderPage()
      const original = fetchSpy.getMockImplementation()
      fetchSpy.mockImplementation((path, opts) => {
        const p = String(path)
        if (p.startsWith('/api/events?') && !opts?.method) {
          return p.includes('offset=') ? Promise.reject(new Error('offline')) : Promise.resolve([thisJars('ev-top'), ...filler(199)])
        }
        return original(path, opts)
      })
      await click(removeButton(P1B))
      await waitFor(() => expect(undoButton(P1B)).toBeTruthy())
      view.unmount()
      await waitFor(() => expect(eventDeletes()).toHaveLength(1))
      expect(eventDeletes()[0][0]).toBe('/api/events/ev-top')
    })

    // RD-03: the offline copy cannot say, on any page.
    it('a later page answered from the offline copy writes nothing', async () => {
      await renderPage()
      const original = fetchSpy.getMockImplementation()
      fetchSpy.mockImplementation((path, opts) => {
        const p = String(path)
        if (p.startsWith('/api/events?') && !opts?.method) {
          return Promise.resolve(p.includes('offset=')
            ? Object.defineProperty({ events: [], has_more: false }, Symbol.for('garden-app.fromCache'), { value: true })
            : filler(200))
        }
        return original(path, opts)
      })
      await addFromPicker(P3)
      await waitFor(() => expect(eventReads()).toHaveLength(2))
      await act(async () => { await Promise.resolve() })
      await new Promise((r) => setTimeout(r, 20))
      expect(eventPosts()).toHaveLength(0)
    })

    // RD-05: a route that always has more stops at the cap, and a list that did not end cannot say.
    it('a route that never ends is read 25 times and nothing is written', async () => {
      await renderPage()
      const original = fetchSpy.getMockImplementation()
      fetchSpy.mockImplementation((path, opts) => {
        const p = String(path)
        if (p.startsWith('/api/events?') && !opts?.method) {
          return Promise.resolve(p.includes('offset=') ? { events: filler(200), has_more: true } : filler(200))
        }
        return original(path, opts)
      })
      await addFromPicker(P3)
      await waitFor(() => expect(eventReads()).toHaveLength(25))
      await act(async () => { await Promise.resolve() })
      await new Promise((r) => setTimeout(r, 30))
      expect(eventReads()).toHaveLength(25)
      expect(eventPosts()).toHaveLength(0)
    })

    it('leaving with the row struck withdraws an entry that sits past the first page', async () => {
      const view = await renderPage()
      paged(() => [...filler(200), thisJars('ev-deep')])
      await click(removeButton(P1B))
      await waitFor(() => expect(undoButton(P1B)).toBeTruthy())
      view.unmount()
      await waitFor(() => expect(eventDeletes()).toHaveLength(1))
      expect(eventDeletes()[0][0]).toBe('/api/events/ev-deep')
      expect(eventReads().map(([p]) => p)).toEqual([
        `/api/events?plant_id=${P1B.id}&limit=200`,
        `/api/events?plant_id=${P1B.id}&limit=200&offset=200`,
      ])
    })
  })

  it('writes none when the plant still has a live entry for this jar', async () => {
    routes.events[P3.id] = [thisJars()]
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventReads()).toHaveLength(1))
    await act(async () => { await Promise.resolve() })
    expect(eventPosts()).toHaveLength(0)
  })

  it('an entry for another jar, or another kind of entry naming this one, is not this plant’s entry', async () => {
    routes.events[P3.id] = [
      { id: 'ev-other-jar', event_type: 'seed_saved', metadata: { seed_lot_id: 'another-lot' } },
      { id: 'ev-harvest', event_type: 'harvest', metadata: { seed_lot_id: ID } },
      { id: 'ev-no-meta', event_type: 'seed_saved', metadata: null },
    ]
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
  })

  it.each([
    ['cannot be read', () => Promise.reject(new Error('offline'))],
    // The service worker's offline copy cannot say what is on the timeline now.
    ['is answered from the copy kept for offline use', () => Promise.resolve(
      Object.defineProperty([], Symbol.for('garden-app.fromCache'), { value: true }))],
  ])('when the plant’s list %s nothing is written, and the add is still saved', async (_, list) => {
    await renderPage()
    const original = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, opts) =>
      (String(path).startsWith('/api/events?') ? list() : original(path, opts)))
    await addFromPicker(P3)

    await waitFor(() => expect(eventReads()).toHaveLength(1))
    await act(async () => { await Promise.resolve() })
    expect(eventPosts()).toHaveLength(0)
    expect(liveRows()).toHaveLength(3)
    expect(screen.getByText('✓ Saved')).toBeTruthy()
    expect(help()).toBe('')
  })

  it('an entry that could not be written is silent: the plant is on the jar either way', async () => {
    routes.post = () => Promise.reject(Object.assign(new Error('Internal error'), { status: 500 }))
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    await act(async () => { await Promise.resolve() })
    expect(liveRows()).toHaveLength(3)
    expect(help()).toBe('')
    expect(card().textContent).not.toContain('Internal error')
  })

  it('an add the server refused reads and writes nothing', async () => {
    routes.put = () => Promise.reject(refused('mixed_crop_parents'))
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(help()).toBe("That planting is a different crop, so it wasn't added."))
    expect(eventReads()).toHaveLength(0)
    expect(eventPosts()).toHaveLength(0)
  })

  it('Undo of a removal writes none: that plant’s entry was never withdrawn', async () => {
    routes.events[P1B.id] = [thisJars()]
    await renderPage()
    await click(removeButton(P1B))
    pastTheGuard()
    await click(undoButton(P1B))
    await waitFor(() => expect(liveRows()).toHaveLength(2))
    await act(async () => { await Promise.resolve() })
    expect(eventReads()).toHaveLength(0)
    expect(eventPosts()).toHaveLength(0)
  })

  it('remove, leave, come back and add it again: the plant has its entry again, on its first date', async () => {
    itemRef.current = jar({ created_at: STARTED })
    routes.events[P1B.id] = [thisJars()]
    const view = await renderPage()
    await click(removeButton(P1B))
    await waitFor(() => expect(undoButton(P1B)).toBeTruthy())
    view.unmount()
    await waitFor(() => expect(eventDeletes()).toHaveLength(1))
    expect(routes.events[P1B.id]).toEqual([])

    await renderPage()
    expect(rowOf(P1B)).toBeUndefined()
    await addFromPicker(P1B)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(bodyOf(eventPosts()[0])).toEqual({
      plant_id: P1B.id, event_type: 'seed_saved', event_date: '2026-10-06',
      notes: 'Seed lot "Saved A1 jar".', metadata: { seed_lot_id: ID },
    })
    expect(routes.events[P1B.id]).toHaveLength(1)
  })

  it('a plant added and then removed on the same visit: leaving withdraws the entry the add wrote', async () => {
    const view = await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    await click(removeButton(P3))
    await waitFor(() => expect(undoButton(P3)).toBeTruthy())
    view.unmount()
    await waitFor(() => expect(eventDeletes()).toHaveLength(1))
    expect(eventDeletes()[0][0]).toBe('/api/events/ev-new-1')
    expect(routes.events[P3.id]).toEqual([])
  })

  it('a change to that plant WAITS for its entry write: the set never moves under an entry still going out', async () => {
    const held = deferred()
    routes.post = () => held.promise
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    expect(setBodies()).toHaveLength(1)

    await click(removeButton(P3))
    // Struck at the tap; its set write is held back, and so is every other row control.
    expect(rowOf(P3).getAttribute('data-struck')).toBe('true')
    expect(help()).toBe('Saving…')
    await click(removeButton(P1))
    expect(setBodies()).toHaveLength(1)

    await act(async () => { held.resolve({ id: 'ev-held' }) })
    await waitFor(() => expect(setBodies()).toHaveLength(2))
    expect(setBodies()[1]).toEqual({
      source_plant_ids: [P1.id, P1B.id], expected_source_plant_ids: [P1.id, P1B.id, P3.id],
    })
  })

  it('a change to ANOTHER plant does not wait for it', async () => {
    routes.post = () => deferred().promise
    await renderPage()
    await addFromPicker(P3)
    await waitFor(() => expect(eventPosts()).toHaveLength(1))
    await click(removeButton(P1B))
    expect(setBodies()).toHaveLength(2)
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
      .toBe('This lot changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
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
