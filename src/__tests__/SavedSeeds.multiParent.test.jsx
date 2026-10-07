// V5-SEEDMULTIPARENT-001 release 2b — the Saved seeds cards read a jar's PARENT SET.
//
// One case per card wording (one planting, two, three or more, an archived parent named from the row),
// one per chip, the three ways a row carries no readable set (undefined, null, []: all render from
// source_plant_id as before), and the stage sheet's two failure sentences (contract O-2). The mix jar
// and the 409 are read out of the contract fixture, so a renamed key fails here and not in prod.
// Flag ON (the real module); the flag-off twin is SavedSeeds.multiParent.flagOff.test.jsx.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

// SEED_MULTI_PARENT is held ON here whichever way the literal ships. These are the flag-on cases, and the
// release's forward undo is a build with the literal false (scripts/forward-undo.py), which must not
// redden them: `npm run test:flag-off:seed` is that rehearsal. featureFlags.test.js pins the literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SEED_MULTI_PARENT() { return true },
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...r }) => (
    <a href={typeof to === 'string' ? to : '#'} data-state={state ? JSON.stringify(state) : undefined} {...r}>{children}</a>
  ),
  useNavigate: () => () => {},
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { seedsReturnState, LOT_SECTION_KEY, LOT_SECTION_SOURCE_PLANT } from '../lib/seedsRoutes.js'
import {
  lotReply, refusal, PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY, PARENTS_R1,
} from './fixtures/seedMix.fixture.js'

// The picker projection: ACTIVE plantings only, which is why an archived parent used to print nothing.
const PICKER = [{
  id: 'pl-alaska', name: 'Alaska trough', quantity: 1, variety_id: 'v-alaska', project_name: null,
  variety_ref: { id: 'v-alaska', name: 'Alaska Mix Nasturtium', crop_type_slug: 'nasturtium' },
  sown_at: null, succession_order: null,
}]
const sp = (over = {}) => ({
  id: 'pl-alaska', name: 'Alaska trough', variety_id: 'v-alaska', variety_name: 'Alaska Mix Nasturtium',
  breeding_system: 'open_pollinated', variety_rank: 'cultivar', crop_slug: 'nasturtium',
  archived: false, deleted: false, ...over,
})
const JEWEL = sp({ id: 'pl-jewel', name: 'Jewel pot', variety_id: 'v-jewel', variety_name: 'Jewel Mix Nasturtium' })
const SUNGOLD = sp({ id: 'pl-sungold', name: 'Sungold cage', variety_id: 'v-sungold', variety_name: 'Sungold', breeding_system: 'f1', crop_slug: 'tomato' })
const SUNSUGAR = sp({ id: 'pl-sunsugar', name: 'Sun Sugar cage', variety_id: 'v-sunsugar', variety_name: 'Sun Sugar', breeding_system: 'f1', crop_slug: 'tomato' })
const BRANDY = sp({ id: 'pl-brandy', name: 'Brandywine row', variety_id: 'v-brandy', variety_name: 'Brandywine', crop_slug: 'tomato' })

const lot = (over = {}) => ({
  id: 'inv-1', name: 'Alaska Mix Nasturtium — saved 2026', variety_name: 'Alaska Mix Nasturtium',
  category: 'seeds', variety_id: 'v-alaska', variety_rank: 'cultivar', breeding_system: 'open_pollinated',
  seed_stage: 'drying', seed_process: null, status: 'active', source_kind: 'own_garden',
  source_plant_id: 'pl-alaska', updated_at: '2026-08-30T12:00:00Z', ...over,
})
// The same jar before its process starts: the Not started card, which has its own render path.
const unstarted = (over = {}) => lot({ seed_stage: null, created_at: '2026-08-30T12:00:00Z', ...over })

let patchReply
const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PATCH') return patchReply()
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve(PICKER)
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}
const parentLine = () => screen.getByTestId('lot-source-plant')
const stateOf = (el) => JSON.parse(el.getAttribute('data-state'))
const JAR_AT_SAVED_FROM = { ...seedsReturnState('/seeds?view=saved'), [LOT_SECTION_KEY]: LOT_SECTION_SOURCE_PLANT }

beforeEach(() => {
  fetchSpy.mockReset()
  patchReply = () => Promise.resolve({ ok: true })
})

describe('Saved seeds card — where the jar came from, off source_plants', () => {
  it('one planting: its name, and a door to that planting (unchanged)', async () => {
    await mount([lot({ source_plants: [sp()] })])
    expect(parentLine().textContent).toBe('Saved from Alaska trough →')
    expect(parentLine().getAttribute('href')).toBe('/plantings/pl-alaska')
    expect(stateOf(parentLine())).toEqual(seedsReturnState('/seeds?view=saved'))
  })

  it('two plantings: the count, and the door is the jar, arriving at its Saved from card', async () => {
    await mount([lot({ source_plants: [sp(), JEWEL] })])
    expect(parentLine().textContent).toBe('Saved from 2 plantings →')
    expect(parentLine().getAttribute('href')).toBe('/inventory/inv-1')
    expect(stateOf(parentLine())).toEqual(JAR_AT_SAVED_FROM)
    // The title still opens the jar at its top: only the parent line names the part.
    expect(stateOf(screen.getByTestId('seed-lot-title'))).toEqual(seedsReturnState('/seeds?view=saved'))
  })

  it('three or more: the real number (the contract\'s own mix jar)', async () => {
    const jar = lotReply()
    expect(jar.source_plants).toHaveLength(3)
    await mount([lot({ ...jar, name: 'Trough mix', variety_name: 'Trough mix' })])
    expect(parentLine().textContent).toBe('Saved from 3 plantings →')
    expect(parentLine().getAttribute('href')).toBe(`/inventory/${jar.id}`)
  })

  it('two plantings of ONE variety still count plantings, with no chip', async () => {
    await mount([lot({ source_plants: [sp(), sp({ id: 'pl-alaska-2', name: 'Alaska pot' })] })])
    expect(parentLine().textContent).toBe('Saved from 2 plantings →')
    expect(screen.queryByTestId('lot-mixed')).toBeNull()
  })

  it('an ARCHIVED parent is named from the row: the picker cache does not hold it', async () => {
    const gone = sp({ id: 'pl-archived', name: 'Last year\'s trough', archived: true })
    await mount([lot({ source_plant_id: 'pl-archived', source_plants: [gone] })])
    expect(parentLine().textContent).toBe('Saved from Last year\'s trough →')
    expect(parentLine().getAttribute('href')).toBe('/plantings/pl-archived')
  })

  it('a DELETED parent is named, and is not a door to a page that is gone', async () => {
    const gone = sp({ id: 'pl-deleted', name: 'Dug-up trough', deleted: true })
    await mount([lot({ source_plant_id: 'pl-deleted', source_plants: [gone] })])
    expect(screen.getByTestId('lot-source-plant-gone').textContent).toBe('Saved from Dug-up trough')
    expect(screen.queryByTestId('lot-source-plant')).toBeNull()
  })

  it('the Not started card says the same things', async () => {
    await mount([unstarted({ source_plants: [sp(), JEWEL] })])
    expect(screen.getByTestId('stage-section-unstarted')).toBeTruthy()
    expect(parentLine().textContent).toBe('Saved from 2 plantings →')
    expect(parentLine().getAttribute('href')).toBe('/inventory/inv-1')
    expect(stateOf(parentLine())).toEqual(JAR_AT_SAVED_FROM)
    expect(screen.getByTestId('lot-mixed').textContent).toBe('Mixed seed')
    expect(screen.queryByTestId('lot-origin')).toBeNull()
  })

  it('the Not started card names an archived parent too', async () => {
    const gone = sp({ id: 'pl-archived', name: 'Last year\'s trough', archived: true })
    await mount([unstarted({ source_plant_id: 'pl-archived', source_plants: [gone] })])
    expect(parentLine().textContent).toBe('Saved from Last year\'s trough →')
  })
})

describe('Saved seeds card — no readable parent set falls back to source_plant_id', () => {
  for (const [label, value] of [['undefined', PARENTS_UNDEFINED], ['null', PARENTS_NULL], ['[]', PARENTS_EMPTY]]) {
    it(`source_plants ${label}: the name comes from the picker cache, as before`, async () => {
      const row = lot()
      if (value !== undefined) row.source_plants = value
      await mount([row])
      await waitFor(() => expect(parentLine().textContent).toBe('Saved from Alaska trough →'))
      expect(parentLine().getAttribute('href')).toBe('/plantings/pl-alaska')
      expect(screen.queryByTestId('lot-mixed')).toBeNull()
    })
  }

  it('an unlinked lot with no set keeps its way in', async () => {
    await mount([lot({ source_plant_id: null, source_plants: PARENTS_EMPTY })])
    expect(screen.queryByTestId('lot-source-plant')).toBeNull()
    expect(screen.getByTestId('set-source-plant').getAttribute('href')).toBe('/inventory/inv-1')
  })

  it('the release-1 shape (one element mirroring the cache) reads like one planting', async () => {
    const row = lot({ source_plant_name: 'Alaska trough' })
    await mount([{ ...row, source_plants: PARENTS_R1(row) }])
    expect(parentLine().textContent).toBe('Saved from Alaska trough →')
  })
})

describe('Saved seeds card — the chips, in words', () => {
  const chips = () => ['lot-mixed', 'lot-f2', 'lot-part-f2']
    .filter((id) => screen.queryByTestId(id)).map((id) => screen.getByTestId(id).textContent)

  it('"Mixed seed" when the plantings span more than one variety', async () => {
    await mount([lot({ source_plants: [sp(), JEWEL] })])
    expect(chips()).toEqual(['Mixed seed'])
  })

  it('"Part F2" beside it when some parents are F1 hybrids', async () => {
    await mount([lot({ source_plants: [SUNGOLD, BRANDY] })])
    expect(chips()).toEqual(['Mixed seed', 'Part F2'])
  })

  it('the existing F2 chip beside it when every parent is an F1 hybrid', async () => {
    await mount([lot({ source_plants: [SUNGOLD, SUNSUGAR] })])
    expect(chips()).toEqual(['Mixed seed', 'F2 — won’t come true'])
  })

  it('one F1 parent: the F2 chip alone, as today', async () => {
    await mount([lot({ breeding_system: 'f1', source_plant_id: 'pl-sungold', source_plants: [SUNGOLD] })])
    expect(chips()).toEqual(['F2 — won’t come true'])
  })

  it('one open-pollinated parent: no chip', async () => {
    await mount([lot({ source_plants: [sp()] })])
    expect(chips()).toEqual([])
  })
})

describe('the stage sheet\'s parent write — two failure sentences (contract O-2)', () => {
  const failed = ({ status, body }) => () => Promise.reject(Object.assign(new Error(body.error), { status, body }))
  // An unlinked lot, so the sheet asks for a parent; the picked one goes out through the legacy PATCH.
  const saveWithParent = async () => {
    await mount([lot({ source_plant_id: null })])
    await act(async () => { fireEvent.click(screen.getByTestId('advance-stage')) })
    fireEvent.focus(screen.getByTestId('stage-source-plant-select'))
    await waitFor(() => expect(screen.getByTestId('ps-opt-pl-alaska')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('ps-opt-pl-alaska')) })
    await act(async () => {
      fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '12' } })
    })
    await act(async () => { fireEvent.click(screen.getByTestId('stage-save')) })
  }
  const patches = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PATCH')

  it('still the legacy PATCH, with today\'s body', async () => {
    await saveWithParent()
    expect(patches().map(([p]) => p)).toEqual(['/api/inventory-items/inv-1/source-plant'])
    expect(JSON.parse(patches()[0][1].body)).toEqual({ source_plant_id: 'pl-alaska' })
  })

  it('409 multi_parent_lot: the client\'s own sentence, pointing at the jar', async () => {
    const no = refusal('multi_parent_lot')
    expect(no.status).toBe(409)
    patchReply = failed(no)
    await saveWithParent()
    await waitFor(() => expect(document.body.textContent)
      .toContain('This jar already has more than one plant. Open the jar to change its plants.'))
    expect(document.body.textContent).not.toContain(no.body.error)
  })

  it('any other failure: the fallback sentence, never the server\'s string', async () => {
    patchReply = failed({ status: 500, body: { error: 'relation "seed_lot_parent_planting" does not exist' } })
    await saveWithParent()
    await waitFor(() => expect(document.body.textContent).toContain('Stage saved, but the parent plant did not.'))
    expect(document.body.textContent).not.toContain('seed_lot_parent_planting')
  })

  it('a 409 with another code is "any other failure"', async () => {
    patchReply = failed({ status: 409, body: { error: 'lot changed underneath', code: 'lot_changed' } })
    await saveWithParent()
    await waitFor(() => expect(document.body.textContent).toContain('Stage saved, but the parent plant did not.'))
    expect(document.body.textContent).not.toContain('lot changed underneath')
  })
})
