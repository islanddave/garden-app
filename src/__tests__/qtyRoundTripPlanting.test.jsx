// BUG-INVQTYROUNDTRIP-001, the PlantingEditor half — a REFUSAL, measured.
//
// The brief for this lane called for the same exact-prefill fix here as in InventoryDetail:
// formFromPlant() seeds Quantity from formatQty (String(Math.round)), and plants.quantity is
// numeric(10,3), so the box can show a number the row does not hold. That reasoning is correct. The
// change is still wrong, for a reason that only shows up downstream, and this file is the evidence.
//
// PlantForm renders Quantity as <input type="number" min="1"> with NO step attribute, so the HTML
// default step=1 applies, and its <form> carries NO noValidate (InventoryDetail's does — that is the
// whole reason the exact prefix is safe over there). A 2.5 prefill therefore reports
// validity.stepMismatch, the form is invalid, and the submit event never fires: the entire planting
// form — name, notes, status, source, everything — becomes unsavable. That is a strictly worse
// failure than the rounding it would replace, and an entirely new one.
//
// The honest fix is three coordinated parts: a step on PlantForm's input, the exact prefill here, and
// parseFloat instead of parseInt in handleAdd/handleEdit. PlantForm.jsx is outside this lane's write
// partition and the write side is a product question (is a planting ever ×2.5?), so the prefill stays
// on formatQty and the trap is pinned instead. Nothing is losing data meanwhile: prod holds ZERO
// fractional plants.quantity rows. qty_initial DID move to formatQtyExact and is covered below — it
// is an integer column, so that change cannot reach the same trap.
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

describe('BUG-INVQTYROUNDTRIP-001 — PlantingEditor prefills', () => {
  it('shows whole quantities as bare integers, never "2.000" (V3-QTYINT-001 still holds)', async () => {
    await renderEditor()
    expect(screen.getByLabelText('Quantity').value).toBe('2')
    // Regex, not the literal: Field appends an "optional" affordance to the accessible name of every
    // non-required control. qty_initial is the seed that DID move to formatQtyExact; it is an integer
    // column, so this pins the trailing-zero half — there has never been a fraction here to lose.
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

  it('THE REFUSAL, pinned: a fractional prefill would make the whole form unsubmittable', async () => {
    // Drives the trap through the real DOM rather than describing it. The value is typed rather than
    // prefilled precisely because the prefill was NOT changed — this is the state the exact prefill
    // would have put the form into on load, reached the only other way it is reachable today.
    await renderEditor()
    const qty = screen.getByLabelText('Quantity')
    fireEvent.change(qty, { target: { value: '2.5' } })

    // The mechanism, named. If a later change adds a step to PlantForm's input (or noValidate to its
    // form), these three flip and this test fails — which is the signal that the exact prefill has
    // become safe and formFromPlant should be revisited.
    expect(qty.getAttribute('step')).toBe(null)
    expect(qty.validity.stepMismatch).toBe(true)
    expect(qty.closest('form').noValidate).toBe(false)

    // The consequence, measured: no submit event, so no PUT — for a form where only the quantity is
    // in question but every other field is held hostage with it.
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')).toBeUndefined()
    // The opposite outcome for the same class of box is pinned in qtyRoundTrip.test.jsx, on the
    // InventoryDetail form that declares both halves. Two attributes are the whole difference.
  })
})
