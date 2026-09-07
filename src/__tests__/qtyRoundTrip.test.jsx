// BUG-INVQTYROUNDTRIP-001 — what an inventory item's quantity is worth after somebody opens the page
// and saves something else.
//
// The defect was not in a formatter and not in the Lambda: it was a DISPLAY formatter used as an EDIT
// prefill. itemToForm() seeded five editable boxes with formatQty (String(Math.round(n))), and
// buildChanges() reads those same boxes back with parseFloat and PUTs them. So the rounding was never
// display-only for these five — every save wrote the rounded number over the stored one, with a 200
// and no message. Prod held five fractional rows when this was found (3 quantity_on_hand: the
// 0.500-packet okra, 4.400 lb of pumice, 3.200 lb of mykos; plus 2 quantity_purchased).
//
// MEASURED AT THE WIRE, deliberately, and through the REAL useInventory. Asserting itemToForm's output
// would prove the prefill and miss the question, because updateItem() merges {...listRow, ...changes}
// before sending — so "what leaves the app" depends on that merge, and the rounded value wins it (it
// is in `changes`). Both the merged and the degraded path are covered below for exactly that reason:
// the fix must hold where the list saved us AND where it never loaded.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => ({ id: 'inv-pumice' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// The live pumice row, in the shape GET /api/inventory-items/:id returns it. Quantities are STRINGS
// with three decimals because that is how the pg driver serializes numeric(10,3) — a fixture built
// from number literals would exercise a path the app never takes. Not a seed packet on purpose: the
// seeds category drags in variety/stage machinery that has nothing to do with this contract.
const PUMICE = {
  id: 'inv-pumice', name: 'Horticultural Lava Pebbles / Pumice Soil Amendment',
  type: 'consumable', category: 'growing_media', status: 'active',
  quantity_on_hand: '4.400', unit: 'lb',
  reorder_threshold: null, reorder_quantity: null,
  quantity_purchased: '1.500', unit_cost: '19.990',
  notes: 'bottom shelf', source: null, source_url: null,
  source_id: null, acquired_from_source_id: null, source_plant_id: null,
}

function wire(item, { listLoads = true } = {}) {
  fetchSpy.mockImplementation((path, opts) => {
    if (path === `/api/inventory-items/${item.id}` && !opts) return Promise.resolve(item)
    if (path === '/api/inventory-items') {
      return listLoads ? Promise.resolve([item]) : Promise.reject(new Error('offline'))
    }
    if (path === `/api/inventory-items/${item.id}` && opts?.method === 'PUT') {
      return Promise.resolve({ ...item, ...JSON.parse(opts.body) })
    }
    return Promise.resolve(null)
  })
}

const putBody = () => {
  const call = fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')
  expect(call, 'no PUT was issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

// Edits ONE unrelated field and saves. The unrelated edit is the whole scenario: nobody set out to
// change the quantity, which is why the old behaviour was invisible until a row was compared to its
// backup.
async function openEditSomethingElseAndSave() {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'moved to the top shelf' } })
  await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
}

beforeEach(() => { fetchSpy.mockReset(); navigateSpy.mockReset() })

describe('BUG-INVQTYROUNDTRIP-001 — a save must not rewrite a quantity nobody touched', () => {
  it('PUTs 4.4 back after an unrelated edit, with the list loaded', async () => {
    wire(PUMICE)
    await openEditSomethingElseAndSave()
    const body = putBody()
    expect(body.notes).toBe('moved to the top shelf')
    // The assertion the bug fails: it sent 4.
    expect(body.quantity_on_hand).toBe(4.4)
  })

  it('PUTs 4.4 back with the list UNAVAILABLE — the merge is not what saves it', async () => {
    // buildChanges() reaches the wire raw here (offline, expired token, or a Save pressed before the
    // list lands). Same expectation, and it has to come from the prefill rather than from a list row
    // that happens to still hold the true value.
    wire(PUMICE, { listLoads: false })
    await openEditSomethingElseAndSave()
    expect(putBody().quantity_on_hand).toBe(4.4)
  })

  it('preserves the OTHER numeric(10,3) fields on the same save', async () => {
    // quantity_purchased is the second column with live fractional rows (2 of them). reorder_* are
    // integer-only in prod today, which is exactly why they need pinning: nothing else would notice
    // them regressing.
    wire({ ...PUMICE, reorder_threshold: '2.500', reorder_quantity: '7.250' })
    await openEditSomethingElseAndSave()
    const body = putBody()
    expect(body.quantity_purchased).toBe(1.5)
    expect(body.reorder_threshold).toBe(2.5)
    expect(body.reorder_quantity).toBe(7.25)
  })

  it('shows the stored value in the box, so a clamp could never be silent again', async () => {
    // The visible half. A round trip that is correct on the wire while the input reads "4" would
    // still be a page that lies about what it holds — and it is the box, not the payload, that a
    // person is deciding from when they type over it.
    wire(PUMICE)
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
    expect(screen.getByLabelText('Qty on hand').value).toBe('4.4')
    expect(screen.getByLabelText('Qty purchased').value).toBe('1.5')
  })

  it('and the FORM accepts that box — step="any" plus noValidate, both halves', async () => {
    // Not decoration. type="number" defaults to step=1, so 4.4 reports validity.stepMismatch and an
    // ordinarily-validated form refuses to submit AT ALL — every other field held hostage by the
    // quantity. That is not hypothetical: it is measured happening on PlantForm in
    // qtyRoundTripPlanting.test.jsx, which is why the same prefill fix was refused there. Here BOTH
    // halves are asserted, because either one alone would leave the page one attribute from wedged.
    wire(PUMICE)
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
    const qty = screen.getByLabelText('Qty on hand')
    expect(qty.getAttribute('step')).toBe('any')
    expect(qty.validity.stepMismatch).toBe(false)
    expect(qty.closest('form').noValidate).toBe(true)
  })

  it('still collapses a whole numeric(N,3) value to a bare integer (V3-QTYINT-001 holds)', async () => {
    // The requirement the old code was reaching for when it grabbed formatQty. Kept end-to-end, not
    // just at the formatter: an edit box must never show "4.000", and the wire must carry 4, not
    // "4.000" as a string.
    wire({ ...PUMICE, quantity_on_hand: '4.000', quantity_purchased: '12.000' })
    await openEditSomethingElseAndSave()
    expect(screen.getByLabelText('Qty on hand').value).toBe('4')
    const body = putBody()
    expect(body.quantity_on_hand).toBe(4)
    expect(body.quantity_purchased).toBe(12)
  })
})
