// V4-SEEDLINK-001 — the "Saved from" control on /inventory/:id.
//
// WHY THIS PAGE IS THE PLACEMENT UNDER TEST. /seeds/saved lists only lots that carry a seed_stage,
// and its "Track a lot" picker hard-codes `fermenting` — so attaching a parent there would mean
// writing a false stage into seed_lot_stage_log for a dry-processed lot. Every lot is reachable
// here, tracked or not, which is why this is the acceptance surface for the feature.
//
// V5-SEEDMULTIPARENT-001 release 2b — FLIPPED from the legacy PATCH to the set PUT. A jar whose parent
// SET is known (`source_plants` is an array, [] included) is written through
// PUT /:id/source-plants, which always carries the set this page last read. The legacy
// PATCH /:id/source-plant survives in exactly two places, both pinned at the bottom of this file:
// SEED_MULTI_PARENT off (the release's forward undo: today's card and today's request body, byte for
// byte), and a jar whose set is "no answer" (undefined or null), which cannot honestly say what it
// expects the set to be.
//
// The first parent of a jar is the simplest case of that route and the one this file owns; several
// parents, Remove and Undo, the 409s and the plant count are InventoryDetail.parents.test.jsx, and the
// re-file is InventoryDetail.filing.test.jsx.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef, flag } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), itemRef: { current: null }, flag: { on: true },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'inv-1' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
// The real module with one export switchable per test. A getter, because every reader takes the flag at
// call time; the shipped module declares it as a literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, get SEED_MULTI_PARENT() { return flag.on } }
})

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { sourcePlantsPutReply, refusal, PARENTS_EMPTY, PARENTS_NULL, PARENTS_UNDEFINED } from './fixtures/seedMix.fixture.js'

// The Green Flesh Honeydew case from the design, shrunk to its load-bearing parts: one seed lot,
// one planting of that cultivar, and the planting is `harvested` — which is the normal state of a
// seed parent and must not disqualify it. `source_plants: []` is a jar with NO parents, as the lot
// read has answered since release 2a.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  quantity_on_hand: 1, unit: 'packet', variety_id: 'v-melon', variety_name: 'Green Flesh',
  source_plant_id: null, source_plants: PARENTS_EMPTY,
}
const PARENT = {
  id: 'pl-melon', name: 'Green Flesh', quantity: 1, variety_id: 'v-melon', project_name: null,
  variety_ref: { id: 'v-melon', name: 'Green Flesh', crop_type_slug: 'melon' },
  sown_at: null, succession_order: null, status: 'harvested',
}
const OTHER = {
  id: 'pl-basil', name: 'Basil', quantity: 6, variety_id: 'v-basil', project_name: null,
  variety_ref: { id: 'v-basil', name: 'Genovese', crop_type_slug: 'basil' },
  sown_at: null, succession_order: null,
}
// The planting as the lot read and the set route name it (the contract element).
const PARENT_ELEMENT = {
  id: 'pl-melon', name: 'Green Flesh', variety_id: 'v-melon', variety_name: 'Green Flesh',
  breeding_system: 'open_pollinated', variety_rank: 'cultivar', crop_slug: 'melon', archived: false, deleted: false,
}

const SET_PATH = '/api/inventory-items/inv-1/source-plants'
const LEGACY_PATH = '/api/inventory-items/inv-1/source-plant'
const callsTo = (path, method) => fetchSpy.mock.calls.filter(([p, o]) => String(p) === path && o?.method === method)
const setPuts = () => callsTo(SET_PATH, 'PUT')
const patchCalls = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PATCH')
const lotReads = () => fetchSpy.mock.calls.filter(([p, o]) => String(p) === '/api/inventory-items/inv-1' && !o?.method)
const bodyOf = (call) => JSON.parse(call[1].body)
// A refusal as api.js throws it: the contract's status and body, the sentence as the message.
const refusedAs = (code) => {
  const r = refusal(code)
  return Object.assign(new Error(r.body.error), { status: r.status, body: r.body })
}

// Routed by path and method, never by call order. The set route answers with the contract's reply shape.
function wire({ put, patch } = {}) {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (p === SET_PATH && opts?.method === 'PUT') {
      if (put) return put(JSON.parse(opts.body))
      const ids = JSON.parse(opts.body).source_plant_ids
      return Promise.resolve(sourcePlantsPutReply({
        id: 'inv-1', source_plant_id: ids[0] ?? null,
        source_plants: ids.map(() => ({ ...PARENT_ELEMENT })),
      }))
    }
    if (opts?.method === 'PATCH') return patch ? patch() : Promise.resolve({ id: 'inv-1', source_plant_id: null })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([PARENT, OTHER])
    if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
}

beforeEach(() => {
  fetchSpy.mockReset()
  flag.on = true
  itemRef.current = { ...LOT }
  wire()
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText(itemRef.current.name)).toBeTruthy())
}

const pick = async (planting) => {
  fireEvent.focus(screen.getByTestId('source-plant-select'))
  await waitFor(() => expect(screen.getByTestId(`ps-opt-${planting.id}`)).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByTestId(`ps-opt-${planting.id}`)) })
}

describe('InventoryDetail — Saved from (V4-SEEDLINK-001; the set route since V5-SEEDMULTIPARENT-001 2b)', () => {
  it('renders the control for a seed packet', async () => {
    await renderPage()
    expect(screen.getByTestId('seed-source-plant')).toBeTruthy()
    expect(screen.getByTestId('source-plant-select')).toBeTruthy()
  })

  it('does NOT render it for a non-seed item', async () => {
    // Gated exactly like the Plant-from-packet CTA. A provenance field on a shovel is not merely
    // clutter: the route asserts category='seeds', so anything set there could never be saved.
    itemRef.current = { ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable', variety_id: null }
    await renderPage()
    expect(screen.queryByTestId('seed-source-plant')).toBeNull()
  })

  it('scopes a jar’s FIRST plant to the lot’s own cultivar', async () => {
    // varietyId is what turns ~239 plantings into the one that could plausibly have made this seed.
    // A jar with no parents has no shared crop to scope by, and a first parent of another cultivar
    // would leave the jar filed under a variety none of its plants are.
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${PARENT.id}`)).toBeTruthy())
    expect(screen.queryByTestId(`ps-opt-${OTHER.id}`)).toBeNull()
  })

  it('PUTs the chosen planting to /source-plants with the set it expects, and confirms', async () => {
    await renderPage()
    await pick(PARENT)

    const puts = setPuts()
    expect(puts).toHaveLength(1)
    // The whole set, and the set this page last read ([] is a real expectation: "no parents").
    expect(bodyOf(puts[0])).toEqual({ source_plant_ids: ['pl-melon'], expected_source_plant_ids: [] })
    // A jar that had no parents is never sent a filing, and no mix is made for one cultivar.
    expect(callsTo('/api/varieties/blend', 'POST')).toHaveLength(0)
    // It saves on selection, not behind the page's Save button — so a confirmation is owed.
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    // The planting is now a row, and a door to that planting.
    const row = screen.getByTestId('saved-from-row')
    expect(row.textContent).toContain('Green Flesh')
    expect(row.querySelector('a').getAttribute('href')).toBe('/plantings/pl-melon')
    // …the legacy PATCH is not involved, and neither is the wide PUT. Routing this through the wide
    // PUT would null the provenance on every later unrelated edit.
    expect(patchCalls()).toHaveLength(0)
    expect(callsTo('/api/inventory-items/inv-1', 'PUT')).toHaveLength(0)
  })

  it('CLEARS by sending the EMPTY set, never an omitted key', async () => {
    // The set route requires source_plant_ids: `[]` is "no parents" and a body without the key is a
    // 400. Sending the wrong one fails silently from the user's side — the row goes and nothing is
    // saved — which is why the body shape is asserted rather than just the request happening.
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon', source_plants: [{ ...PARENT_ELEMENT }] }
    await renderPage()
    await act(async () => { fireEvent.click(screen.getByTestId('saved-from-remove')) })

    const puts = setPuts()
    expect(puts).toHaveLength(1)
    const body = bodyOf(puts[0])
    expect(Object.prototype.hasOwnProperty.call(body, 'source_plant_ids')).toBe(true)
    expect(body).toEqual({ source_plant_ids: [], expected_source_plant_ids: ['pl-melon'] })
    expect(patchCalls()).toHaveLength(0)
  })

  it('reverts and says so in its own words when the write fails', async () => {
    // Leaving the card showing a parent the server never accepted is the silent-failure shape:
    // the page would read as "saved" for the rest of the session and be wrong after a reload.
    wire({ put: () => Promise.reject(new Error('Network unreachable')) })
    await renderPage()
    await pick(PARENT)

    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toBe("Couldn't save that. Nothing was changed."))
    // Never the server's (or the network's) own sentence.
    expect(screen.getByTestId('seed-source-plant').textContent).not.toContain('Network unreachable')
    expect(screen.queryByTestId('saved-from-row')).toBeNull()
    expect(screen.getByTestId('source-plant-select')).toBeTruthy()
  })

  it('says the plantings failed to load rather than reading as "you have none"', async () => {
    // BUG-PLANTFETCHSILENT-001: an unfillable field that looks like a legitimately empty garden.
    fetchSpy.mockImplementation((path) => {
      const p = String(path)
      if (p.startsWith('/api/plants?view=picker')) return Promise.reject(new Error('boom'))
      if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
      return Promise.resolve([])
    })
    await renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toContain('load your plantings'))
  })
})

// ── The legacy PATCH, where it still stands ───────────────────────────────────────────────────────────
describe('InventoryDetail — Saved from with SEED_MULTI_PARENT off: today’s card and today’s request', () => {
  beforeEach(() => { flag.on = false })

  it('draws the single picker and nothing of release 2b, even for a jar whose set names two plantings', async () => {
    itemRef.current = {
      ...LOT, source_plant_id: 'pl-melon', seed_parent_plant_count: 4,
      source_plants: [{ ...PARENT_ELEMENT }, { ...PARENT_ELEMENT, id: 'pl-melon-2', name: 'Green Flesh 2' }],
    }
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy())
    for (const id of ['saved-from-row', 'saved-from-remove', 'saved-from-undo', 'saved-from-add',
      'saved-from-filed', 'saved-from-plant-count', 'saved-from-mixed']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.getByTestId('source-plant-help').textContent)
      .toBe('The plant this seed was saved from. Leave it empty for bought seed.')
  })

  it('PATCHes { source_plant_id } to /source-plant: the pinned legacy body, no set PUT', async () => {
    await renderPage()
    await pick(PARENT)

    const calls = patchCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(LEGACY_PATH)
    expect(calls[0][1].body).toBe('{"source_plant_id":"pl-melon"}')
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    expect(fetchSpy.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false)
    expect(callsTo('/api/varieties/blend', 'POST')).toHaveLength(0)
  })

  it('CLEARS with an explicit null, never an omitted key', async () => {
    // The legacy route reads this by presence: `{}` is a 400 and `{source_plant_id: null}` is the clear.
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon', source_plants: [{ ...PARENT_ELEMENT }] }
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByLabelText('Clear planting selection')) })

    const calls = patchCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(LEGACY_PATH)
    expect(calls[0][1].body).toBe('{"source_plant_id":null}')
    expect(setPuts()).toHaveLength(0)
  })

  it('prints the server’s sentence on a failed write, as it does today', async () => {
    wire({ patch: () => Promise.reject(new Error('Network unreachable')) })
    await renderPage()
    await pick(PARENT)
    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toContain('Network unreachable'))
    expect(screen.queryByTestId('source-plant-select-chip')).toBeNull()
  })

  it('a coded 409 is today’s too: the server’s sentence, and the jar is not read again', async () => {
    wire({ patch: () => Promise.reject(refusedAs('multi_parent_lot')) })
    await renderPage()
    await pick(PARENT)
    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toBe(refusal('multi_parent_lot').body.error))
    expect(lotReads()).toHaveLength(1)
  })
})

describe('InventoryDetail — Saved from for a jar whose parent set is no answer (flag on)', () => {
  it.each([
    ['undefined: a row from before release 1', PARENTS_UNDEFINED],
    ['null: the parents read failed', PARENTS_NULL],
  ])('%s keeps the single picker and the legacy PATCH', async (_, parents) => {
    // "No answer" is not "no parents": the set route would have to claim an expected set this page
    // never read. The legacy route refuses a jar with more than one plant on the server.
    itemRef.current = { ...LOT, source_plants: parents }
    await renderPage()
    expect(screen.queryByTestId('saved-from-row')).toBeNull()
    await pick(PARENT)

    const calls = patchCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(LEGACY_PATH)
    expect(bodyOf(calls[0])).toEqual({ source_plant_id: 'pl-melon' })
    expect(setPuts()).toHaveLength(0)
  })

  it.each(['multi_parent_lot', 'lot_changed', 'parents_changed'])(
    'a %s 409 on that legacy write reads the jar again in place and never prints the server’s "Reload"', async (code) => {
      // The read that failed has since recovered: the jar turns out to have two plantings.
      itemRef.current = { ...LOT, source_plant_id: 'pl-melon', source_plants: PARENTS_NULL }
      const twoPlantings = [{ ...PARENT_ELEMENT }, { ...PARENT_ELEMENT, id: 'pl-melon-2', name: 'Green Flesh 2' }]
      wire({
        patch: () => {
          itemRef.current = { ...itemRef.current, source_plants: twoPlantings }
          return Promise.reject(refusedAs(code))
        },
      })
      await renderPage()
      await waitFor(() => expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy())
      await act(async () => { fireEvent.click(screen.getByLabelText('Clear planting selection')) })

      await waitFor(() => expect(screen.getByTestId('source-plant-help').textContent)
        .toBe('This jar changed somewhere else just now. This is the latest. Try again if it still needs changing.'))
      expect(lotReads()).toHaveLength(2)
      // With the set in hand the card lists it.
      expect(screen.getAllByTestId('saved-from-row')).toHaveLength(2)
      const text = screen.getByTestId('seed-source-plant').textContent
      expect(text).not.toContain(refusal(code).body.error)
      expect(text).not.toMatch(/reload/i)

      // The line was about the jar as it was: the card's next write that lands takes it away.
      await act(async () => { fireEvent.click(screen.getAllByTestId('saved-from-remove')[1]) })
      expect(setPuts()).toHaveLength(1)
      expect(bodyOf(setPuts()[0])).toEqual({
        source_plant_ids: ['pl-melon'], expected_source_plant_ids: ['pl-melon', 'pl-melon-2'],
      })
      await waitFor(() => expect(screen.queryByTestId('source-plant-help')).toBeNull())
    })

  it('when the set STILL cannot be read, a coded 409 says only that nothing was saved', async () => {
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon', source_plants: PARENTS_NULL }
    wire({ patch: () => Promise.reject(refusedAs('multi_parent_lot')) })
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByLabelText('Clear planting selection')) })

    await waitFor(() => expect(screen.getByTestId('source-plant-help').textContent)
      .toBe("Couldn't save that. Nothing was changed."))
    expect(screen.queryByTestId('saved-from-row')).toBeNull()
    // The picker is still the single one, back on the planting the server still has.
    expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy()
    expect(screen.getByTestId('seed-source-plant').textContent).not.toContain(refusal('multi_parent_lot').body.error)
  })
})
