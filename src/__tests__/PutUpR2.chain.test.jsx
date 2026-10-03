// Put-Up R2a — the D12 chain (amendment D12; ruling P-4 = E-3: the integrator writes it once P and E are merged).
//
// ONE PERSON, ONE PAGE, the way it is reached: the Pantry, Edit places, the jar's own Edit, Edit places again.
//   1. A re-kind of a place holding ONE put-up with a worked-out date is refused (n: 1), in lane P's two lines.
//   2. The jar's Edit (lane E): Discard by -> From the label, the shown date left as it is, Save. The PATCH is
//      sent although the date is equal: `discard_by: <that date>`.
//   3. The jar's basis is now `typed` (a date from a person), and the list says "set by hand".
//   4. The same re-kind answers 200: "Saved." on the place, and nothing refused.
// THE SERVER HALF is answered as lanes S and E built it, through pantryFake's `overrides`: the re-kind counts a
// live put-up in the place with a stored date whose basis is table, house, recipe or NULL
// (lambda/storage-location/index.js), only when `kind` is sent and differs, and refuses with that module's own
// placeHasDatedJars(n); the jar PATCH is judged by jarRoutes.validateJarPatch and stores a sent date as basis
// `typed` (jarRoutes.js patchJar). Lane S's smoke line `s13-*` is the same chain against staging.
// MUTATION: the Edit sends nothing when the date is unchanged -> step 2 sends no PATCH, step 4 is refused again.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, apiError } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { validateJarPatch } from '../../lambda/preservation/jarRoutes.js'
import { placeHasDatedJars } from '../../lambda/storage-location/index.js'

const CF1 = { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const SHELF = { id: 'loc-4', label: 'Garage shelf', kind: 'pantry' }
// The one put-up in Chest Freezer 1, as GET /api/preservation/:id answers it: a date worked out from a
// general figure for whole freeze in a deep freezer.
const JAR = {
  id: 'jar-corn', label: 'Sweet corn', crop_type_slug: 'corn', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-08-10', preserved_at_precision: 'day', preserved_at_approx: null,
  method: 'whole_freeze', method_other_text: null, quantity_value: null, quantity_unit: null, container_label: null,
  package_count: 4, remaining_count: 4, consumed_at: null, removed_at: null, storage_location_id: CF1.id,
  use_by_target: '2027-08-10', use_by_basis: 'table', use_by_status: 'ok', notes: null, photo_id: null,
  source_kind: null, source_label: null, is_raw: null, in_oil: null, texture: null,
}
const DATE = JAR.use_by_target
const TABLE_LIKE = new Set(['table', 'house', 'recipe'])

// The household as the two servers hold it: the places, and the put-ups by id. Every read answers COPIES.
function world() {
  const places = [{ ...CF1 }, { ...SHELF }]
  const jars = new Map([[JAR.id, { ...JAR }]])
  const placeOf = (id) => places.find(p => p.id === id) ?? null
  const live = (j) => j.removed_at == null && j.consumed_at == null && (j.remaining_count ?? j.package_count) > 0
  const asRow = (j) => {
    const p = placeOf(j.storage_location_id)
    return jarRow({ stock_id: j.id, name: j.label, method: j.method, crop_type_slug: j.crop_type_slug,
      place: p && { id: p.id, label: p.label, kind: p.kind }, group_key: p?.id ?? 'none', group_label: p?.label ?? 'No place',
      count_left: j.remaining_count, count_made: j.package_count,
      discard: { date: j.use_by_target, basis: j.use_by_basis, status: j.use_by_target ? 'ok' : null } })
  }
  return pantryFetch({ places, overrides: {
    'GET /api/pantry': () => ({ rows: [...jars.values()].filter(live).map(asRow) }),
    'GET /api/storage-locations': () => places.map(p => ({ ...p })),
    // storage-location PUT (lane S): a re-kind only when `kind` is sent AND differs; refused while the place
    // holds a live put-up with a stored date whose basis is table, house, recipe or unrecorded. A refused PUT
    // writes nothing.
    'PUT /api/storage-locations/*': ({ path, body }) => {
      const p = placeOf(decodeURIComponent(path.split('/').pop()))
      if (body.kind != null && body.kind !== p.kind) {
        const n = [...jars.values()].filter(j => j.storage_location_id === p.id && live(j) && j.use_by_target != null
          && (j.use_by_basis == null || TABLE_LIKE.has(j.use_by_basis))).length
        if (n > 0) throw apiError(409, placeHasDatedJars(n))
      }
      if (body.label != null) p.label = String(body.label).trim()
      if (body.kind != null) p.kind = body.kind
      return { ...p }
    },
    'GET /api/preservation/*': ({ path }) => {
      const j = jars.get(decodeURIComponent(path.split('/').pop()))
      return j ? { ...j, storage_kind: placeOf(j.storage_location_id)?.kind ?? null } : null
    },
    // jar PATCH (lane E's keys, lane S's route): judged by the route's own validator; `discard_by` a date stores
    // that date as basis `typed`, "none" stores no date as `typed`. ("clear" works the date out again on the
    // server; nothing in this chain sends it.)
    'PATCH /api/preservation/*': ({ path, body }) => {
      const refused = validateJarPatch(body)
      if (refused) throw apiError(400, { error: refused })
      const j = jars.get(decodeURIComponent(path.split('/').pop()))
      if ('discard_by' in body) {
        if (body.discard_by === 'clear') throw new Error('not modelled: discard_by "clear"')
        j.use_by_target = body.discard_by === 'none' ? null : body.discard_by
        j.use_by_basis = 'typed'
      }
      return { ...j }
    },
  } })
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const puts = () => fake.calls('PUT', '/api/storage-locations/')
const patches = () => fake.calls('PATCH', '/api/preservation/')
const jarStored = async () => fake(`/api/preservation/${JAR.id}`)
const placeRow = (id) => screen.getAllByTestId('pu-location-row').find(r => r.getAttribute('data-loc-id') === id)

async function openPlaces() {
  fireEvent.click(await screen.findByTestId('pantry-edit-places'))
  await screen.findAllByTestId('pu-location-row')
  await settle()
}
async function rekind(placeId, kind) {
  fireEvent.click(within(placeRow(placeId)).getByTestId('pu-location-rename'))
  fireEvent.click(screen.getByTestId(`pu-location-kind-${kind}`))
  fireEvent.click(screen.getByTestId('pu-location-save'))
  await waitFor(() => expect(screen.queryByTestId('pu-location-refusal') ?? screen.queryByTestId('pu-location-saved')).toBeTruthy())
  await settle()
}
// Escape steps out of an open editor first, then closes the sheet.
async function closeSheet(testId) {
  for (let i = 0; i < 3 && screen.queryByTestId(testId); i++) {
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
  }
  expect(screen.queryByTestId(testId)).toBeNull()
}

beforeEach(() => {
  fake = world()
  stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('D12 — a re-kind refused for one worked-out date, the date set by hand from Edit, the same re-kind saved', () => {
  it('refused (n: 1) → Edit: From the label, the shown date unchanged, Save → basis typed → the re-kind answers 200', async () => {
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByTestId(`pantry-row-open-put_up:${JAR.id}`)

    // 1. Refused, n: 1, in the sheet's own two lines; nothing written.
    await openPlaces()
    await rekind(CF1.id, 'fridge')
    expect(puts().map(c => c.body)).toEqual([{ kind: 'fridge' }])
    expect(screen.getByRole('alert').textContent)
      .toBe("Can't change the kind: 1 put-up here has a date worked out for this kind of place (deep freezer).")
    expect(screen.getByTestId('pu-location-refusal-next').textContent)
      .toBe('Set its date by hand from Edit, or move it somewhere else, then change the kind.')
    expect(screen.queryByTestId('pu-location-saved')).toBeNull()
    await closeSheet('places-sheet')

    // 2. The jar's Edit: it opens on Work it out; From the label shows the stored date; Save as it stands.
    fireEvent.click(screen.getByTestId(`pantry-row-open-put_up:${JAR.id}`))
    fireEvent.click(await screen.findByTestId('row-edit'))
    await screen.findByRole('button', { name: 'Save' })
    expect(screen.getByTestId(`ed-discard-auto-${JAR.id}`).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId(`ed-discard-date-${JAR.id}`))
    expect(screen.getByLabelText('Discard date from the label').value).toBe(DATE)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0].path).toBe(`/api/preservation/${JAR.id}`)
    expect(patches()[0].body).toEqual({ discard_by: DATE })
    await waitFor(() => expect(screen.queryByTestId('jar-edit-panel')).toBeNull())

    // 3. The same date, now his: basis typed, and the list says so.
    expect(await jarStored()).toMatchObject({ use_by_target: DATE, use_by_basis: 'typed' })
    await waitFor(() => expect(screen.getByTestId(`pantry-row-put_up:${JAR.id}`).textContent).toContain('set by hand'))
    await closeSheet('row-sheet')

    // 4. The same re-kind: 200, saved in place, nothing refused.
    await openPlaces()
    await rekind(CF1.id, 'fridge')
    expect(puts().map(c => c.body)).toEqual([{ kind: 'fridge' }, { kind: 'fridge' }])
    expect(screen.getByTestId('pu-location-saved')).toBeTruthy()
    expect(screen.queryByTestId('pu-location-refusal')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect((await fake('/api/storage-locations')).find(p => p.id === CF1.id).kind).toBe('fridge')
  })
})
