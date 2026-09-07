// BUG-SRCIDLEAK-001 — every edit to a planting silently erased its source_id and
// acquired_from_source_id. This file is the behavioural assertion that would have caught it.
//
// ── THE BUG, AND WHY A GREEN SUITE MISSED IT ─────────────────────────────────────────────────────
// The two source FKs are cleared by a PRESENCE sentinel on the server (lambda/plants/index.js:874):
// the key appearing in the PUT body IS the clear, because COALESCE cannot express "set to NULL". All
// five GET projections selected source_type/source_ref/source_generation and NOT these two, so
// formFromPlant seeded '' from an absent key, PLANT_FORM_FIELDS submitted it anyway, and
// `form.source_id || null` sent an explicit, PRESENT null. The sentinel obeyed it and nulled the
// column. First edit of any planting, silently, 200 OK. MEASURED on prod: 7 rows in audit_events
// with a non-null before.source_id and a null after — four of them inside 15 minutes on 2026-09-07 —
// and 160 of 271 live plantings still carrying a source_id when this was written.
//
// select-columns.test.js was green through the whole lifetime of that bug because it enumerated the
// three TEXT source columns and stopped. It now asserts both FKs, which is the STATIC half. This
// file is the BEHAVIOURAL half, and the two are deliberately independent: the ratchet proves the
// columns are read, this proves the client only ever asserts an opinion it actually holds. Neither
// suppresses the other's mutant — remove a column from a projection and the ratchet reds; delete
// sourceSentinelPatch and case 3 below reds.
//
// ── WHAT IS ASSERTED, AND WHY EACH CASE EXISTS ───────────────────────────────────────────────────
//   1. round trip     — the bug itself. Edit an UNRELATED field; both ids must survive.
//   2. clear works    — the guard costs no legitimate edit. This is the case a write-side server
//                       check would have broken, and the reason this lane put no such check in.
//   3. omit when unknown — a row that arrived without the key (a narrow payload, or a projection
//                       that regresses again) must send NO key, so the server preserves the column.
//                       Presence is asserted with hasOwnProperty, not `=== undefined`: `{}.source_id`
//                       and `{source_id: null}` both read undefined-ish through a value check and
//                       they mean OPPOSITE things to the sentinel.
//   4. set when unknown — the non-regression for case 3. A guard that also refused a deliberate SET
//                       would pass 1-3 and break the picker.
//
// Fixture ids are the real catalogue rows named in the V4-SOURCEREG-001 contract, so 'Fedco Seeds'
// and 'Greenfield Farmers Co-op' are unique needles in the rendered tree. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))

// STABLE identities, per PlantingEditor.dirty.test.jsx and qtyRoundTripPlanting.test.jsx: a factory
// minting a fresh vi.fn per call re-fires useSources' effect every render and spins the worker to an
// OOM kill. One hoisted function, and it serves the SourcePicker's own vocabulary fetch — which goes
// through useApiFetch, not through the `fetch` prop the editor is handed.
const { SOURCES, apiMock } = vi.hoisted(() => {
  const SOURCES = [
    { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
    { id: 'src-coop', name: 'Greenfield Farmers Co-op', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null },
  ]
  return {
    SOURCES,
    apiMock: async (path) => (String(path).startsWith('/api/varieties/sources') ? SOURCES : []),
  }
})
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiMock, getToken: async () => 'tok' }),
  apiFetch: apiMock,
}))

import PlantingEditor from '../components/PlantingEditor.jsx'

const PROJECTS = [{ id: 'proj1', name: 'Beds' }]

// The shape a FIXED projection returns: both FKs present. `acquired_from_source_id` is a different
// source from `source_id` on purpose — chk_plants_source_distinct rejects a row naming one source
// twice, so a fixture with them equal would be asserting an impossible row.
const PLANT = {
  id: 'p1', name: 'Black Krim', project_id: 'proj1', variety_ref: null,
  quantity: '2.000', qty_initial: 5, notes: 'leggy', status: 'seed',
  source_type: 'seed_packet', source_ref: 'Lot 4421', source_generation: 'F1',
  source_id: 'src-fedco', acquired_from_source_id: 'src-coop',
}

let fetchSpy

beforeEach(() => {
  fetchSpy = vi.fn((path, opts = {}) => {
    if ((opts.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'p1', name: 'Black Krim' })
    if (path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve(null)
  })
})

async function renderEditor(plant = PLANT) {
  await act(async () => {
    render(<PlantingEditor mode="edit" plant={plant} plants={[]} projects={PROJECTS} fetch={fetchSpy} />)
  })
}

const putBody = () => {
  const call = fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')
  expect(call, 'no PUT was issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save')) }) }
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key)

describe('BUG-SRCIDLEAK-001 — an unrelated edit must not erase a planting source', () => {
  it('keeps BOTH source ids on the wire when only the notes changed', async () => {
    // THE assertion. Before the fix this body carried `source_id: null` and the sentinel nulled the
    // column — a data-loss write that answered 200 and looked like a successful save.
    await renderEditor()
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: 'staked' } })
    await save()

    const body = putBody()
    expect(body.notes).toBe('staked')
    expect(body.source_id).toBe('src-fedco')
    expect(body.acquired_from_source_id).toBe('src-coop')
    // The free text is COALESCE-merged rather than sentinel-gated, which is why it survived the bug
    // and left the row in the "text present, pointer gone" shape the backfill gate detects. Pinned
    // so the fix cannot be mistaken for having changed this half.
    expect(body.source_ref).toBe('Lot 4421')
  })

  it('still lets the picker CLEAR an origin — a present null, which is what the sentinel wants', async () => {
    // The case that rules out a server-side guard. To the Lambda this request is byte-identical to
    // the bug's request: `{source_id: null}`. Nothing in it distinguishes "the user removed the
    // source" from "the client never had it", so any server heuristic that refused the null would
    // break THIS. The client is the only side that can tell them apart, which is where the guard is.
    await renderEditor()
    await act(async () => { fireEvent.click(screen.getByLabelText('Clear origin')) })
    await save()

    const body = putBody()
    expect(has(body, 'source_id'), 'the key must be PRESENT — presence is the clear channel').toBe(true)
    expect(body.source_id).toBe(null)
    // PlantForm clears the venue with the originator (acquired_from is "the shop when it DIFFERS",
    // so it is meaningless alone). Both keys must therefore be present nulls, not just the one.
    expect(has(body, 'acquired_from_source_id')).toBe(true)
    expect(body.acquired_from_source_id).toBe(null)
  })
})

describe('BUG-SRCIDLEAK-001 — the editor asserts no opinion it does not hold', () => {
  // The second layer. Independent of the projection fix on purpose: this is what makes a FUTURE
  // read that drops the columns merely inert instead of destructive.
  const NARROW = (() => {
    const { source_id, acquired_from_source_id, ...rest } = PLANT
    return rest
  })()

  it('OMITS both keys when the loaded row never carried them', async () => {
    await renderEditor(NARROW)
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: 'staked' } })
    await save()

    const body = putBody()
    expect(body.notes).toBe('staked')
    // hasOwnProperty, not a value check: `{source_id: null}` would pass `toBeUndefined()` in spirit
    // and would still erase the column, which is the entire bug.
    expect(has(body, 'source_id'), 'an unloaded key must not be sent at all').toBe(false)
    expect(has(body, 'acquired_from_source_id')).toBe(false)
  })

  it('still SETS an origin picked on a row that arrived without the key', async () => {
    // Non-regression for the omission above. A guard that suppressed the key unconditionally would
    // satisfy every assertion in this file except this one, and would silently break the picker on
    // any surface whose payload is narrow.
    await renderEditor(NARROW)
    const input = screen.getByTestId('plant-origin')
    fireEvent.change(input, { target: { value: 'Fedco' } })
    await act(async () => { fireEvent.click(await screen.findByTestId('plant-origin-opt-src-fedco')) })
    await save()

    const body = putBody()
    expect(body.source_id).toBe('src-fedco')
  })
})
