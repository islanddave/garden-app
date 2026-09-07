// BUG-PLANTQTYSTEP-001 — the planting Quantity box is an INTEGER box, on purpose, and this file is
// where that contract is pinned.
//
// ── WHAT THIS FILE USED TO ASSERT, AND WHY IT CHANGED ────────────────────────────────────────────
// Under BUG-INVQTYROUNDTRIP-001 this file was a REFUSAL. That lane was asked to give formFromPlant
// the same exact prefill it had just given InventoryDetail, found that a 2.5 prefill made the whole
// planting form unsubmittable, refused, and pinned the trap with three assertions:
//
//     expect(qty.getAttribute('step')).toBe(null)      // ← this one is now inverted, see below
//     expect(qty.validity.stepMismatch).toBe(true)
//     expect(qty.closest('form').noValidate).toBe(false)
//
// documented as: "If a later change adds a step to PlantForm's input (or noValidate to its form),
// these three flip and this test fails — which is the signal that the exact prefill has become safe."
//
// That signal was BACKWARDS, and the per-writer census this lane ran is what showed it. "A step
// appeared" does not mean fractions became safe. `step="any"` would mean that; `step="1"` means the
// opposite — the box is now explicitly integer-locked. The old assertion read an incidental fact
// (the attribute is absent) as a proxy for a contract (fractions are unsafe here), and the two come
// apart in exactly the direction this change moves. A future lane adding `step="1"` for good reasons
// would have been met with a red test telling it the exact prefill was now safe. It is not.
//
// So the proxy is replaced by the contract itself. NOW ASSERTED: the box declares integer-only
// input, a fraction cannot be submitted through it, whole numbers still save, and the prefill stays
// rounded. What is GONE: `step === null`. What is UNCHANGED: everything else, including both
// original prefill cases.
//
// ── WHY INTEGER RATHER THAN FRACTIONAL ───────────────────────────────────────────────────────────
// The refusal was right; its diagnosis was half of one. plants.quantity really is numeric(10,3), so
// this looked like the planting half of the inventory round-trip bug. It is a different class. An
// inventory quantity is a MEASURE — half a packet, 4.4 lb of pumice — and rounding it destroys a
// real value. A planting quantity is a COUNT, and 2.5 plants denotes nothing. Measured on live prod
// 2026-09-07: qty_initial, qty_current, qty_harvested, qty_lost, seeds_sown and seeds_germinated are
// ALL `integer`; quantity is the lone numeric in its own counter family; lambda/events casts
// `p.quantity::int` to derive qty_current from it; and 0 of the 320 rows ever written carry a
// fraction. formatQty's rounding is therefore CORRECT on this prefill, not merely tolerated.
//
// The far half of the contract is server-side and lives in lambda/plants/quantity-integer-guard.js
// tests: validateQuantity 400s a non-integer on the PUT, the POST and the merge route. It has to be
// there rather than only here, because the PUT bound body.quantity straight into its COALESCE — a
// fraction really could be stored, it had just never been.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))
// Stable identities, per PlantingEditor.dirty.test.jsx: a factory minting a fresh vi.fn per call
// re-fires useSources' effect every render and spins the worker to an OOM kill.
const { emptyFetch } = vi.hoisted(() => ({ emptyFetch: async () => [] }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: emptyFetch, getToken: async () => 'tok' }),
  apiFetch: emptyFetch,
}))

import PlantingEditor from '../components/PlantingEditor.jsx'

const PROJECTS = [{ id: 'proj1', name: 'Beds' }]
// numeric(10,3) arrives as a string through the pg driver; qty_initial is an integer column.
const PLANT = {
  id: 'p1', name: 'Black Krim', project_id: 'proj1', variety_ref: null,
  quantity: '2.000', qty_initial: 5, notes: 'leggy', status: 'seed',
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

const findPut = () => fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')

describe('BUG-PLANTQTYSTEP-001 — PlantingEditor prefills', () => {
  it('shows whole quantities as bare integers, never "2.000" (V3-QTYINT-001 still holds)', async () => {
    await renderEditor()
    expect(screen.getByLabelText('Quantity').value).toBe('2')
    // Regex, not the literal: Field appends an "optional" affordance to the accessible name of every
    // non-required control. qty_initial is the seed that moved to formatQtyExact under the previous
    // ticket; it is an integer column, so this pins the trailing-zero half — there has never been a
    // fraction here to lose.
    expect(screen.getByLabelText(/^Initial quantity/).value).toBe('5')
  })

  it('saves an unrelated edit without disturbing the quantity', async () => {
    await renderEditor()
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: 'staked' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    const body = putBody()
    expect(body.notes).toBe('staked')
    expect(body.quantity).toBe(2)
    expect(body.qty_initial).toBe(5)
  })
})

describe('BUG-PLANTQTYSTEP-001 — the Quantity box declares an integer contract', () => {
  it('declares step="1" and a numeric inputMode, not an absent step', async () => {
    // The replacement for the old `step === null`. Asserted as the LITERAL "1" so that loosening it
    // to "any" — the change that would actually make fractions reachable — reds this test. That is
    // the signal the old assertion was trying to give and gave backwards.
    await renderEditor()
    const qty = screen.getByLabelText('Quantity')
    expect(qty.getAttribute('step')).toBe('1')
    expect(qty.getAttribute('inputmode')).toBe('numeric')
    expect(qty.getAttribute('min')).toBe('1')
  })

  it('refuses a typed fraction: it stepMismatches and no PUT is issued', async () => {
    // Same mechanism the old refusal measured, same measurement — but it is now the guard working
    // rather than a trap being avoided. A count box that will not accept 2.5 is doing its job.
    await renderEditor()
    const qty = screen.getByLabelText('Quantity')
    fireEvent.change(qty, { target: { value: '2.5' } })

    expect(qty.validity.stepMismatch).toBe(true)
    // Still no noValidate, and this is load-bearing: it is what makes the browser refuse the submit
    // rather than letting the fraction reach the wire. If a later change adds noValidate here, this
    // reds — and the server-side validateQuantity 400 becomes the only thing holding the line.
    expect(qty.closest('form').noValidate).toBe(false)

    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(findPut()).toBeUndefined()
  })

  it('still saves a WHOLE-number quantity change — the guard costs no legitimate edit', async () => {
    // The non-regression that matters most about adding step="1": an integer box that also refuses
    // integers would pass every assertion above and break the feature. 7 is chosen over 3 so it
    // cannot be confused with the prefill or with qty_initial.
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '7' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(putBody().quantity).toBe(7)
  })

  it('DEGRADES SAFELY on a legacy fractional row: rounds it, and the form still saves', async () => {
    // The one residual risk this branch carries. validateQuantity stops NEW fractions; it cannot
    // un-store an old one, and prod holds 0 of them in 320 rows only as of 2026-09-07. If one ever
    // did exist, formatQty rounds 2.500 to "3" — a submittable integer — and the rest of the form
    // stays usable, which is the whole reason the prefill was NOT moved to formatQtyExact. An exact
    // "2.5" prefill would stepMismatch on load and hold name, notes and status hostage with it.
    //
    // This is also what makes the prefill choice non-vacuous: with the whole-number fixture above,
    // formatQty and formatQtyExact agree, so swapping them reds nothing. Here they diverge.
    //
    // The rounding IS a silent write on save, and it is the intended repair for a value that was
    // never legitimate — flagged for a human in the lane report rather than hidden here.
    await renderEditor({ ...PLANT, quantity: '2.500' })
    const qty = screen.getByLabelText('Quantity')
    expect(qty.value).toBe('3')
    expect(qty.validity.stepMismatch).toBe(false)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(putBody().quantity).toBe(3)
  })

  it('sends an integer on the wire, not the typed string', async () => {
    // handleEdit's parseInt stays, and stays correct under this branch. Pinned because the brief's
    // other branch would have replaced it with parseFloat; if that ever happens without the rest of
    // the integer contract moving with it, this is the tripwire.
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '4' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(putBody().quantity).toBe(4)
    expect(Number.isInteger(putBody().quantity)).toBe(true)
  })
})
