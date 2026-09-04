// V5-SEEDQTY-001 — the seed COUNT leaving quantity_on_hand, from the create end.
//
// THE DEFECT THIS PINS, measured on prod: a saved lot put the seed count into quantity_on_hand and
// left unit 'packet', so a jar of 185 tomato seeds reads "185.000 packet" — a column carrying
// containers on every other row and seeds on this one, with nothing constraining the two readings to
// agree. The count now goes to inventory_items.seed_count through PUT /seed-measure, its own narrow
// route, and quantity_on_hand goes back to meaning containers: one save-seed act, one jar, 1.
//
// WHY THE ASSERTIONS ARE ON THE BODY AND THE PATH rather than on "a request happened": the three
// measure columns are deliberately absent from the wide PUT's SET list (BUG-INVLOSTUPDATE-001 —
// useInventory.adjustQuantity resends an entire stale list row, so a column reachable through the
// wide PUT gets silently reverted by an unrelated save). A test that only counted requests would
// pass just as well if this sheet started sending the count on the create again, which is the exact
// regression that would reintroduce the bug.
//
// The sibling SaveSeedSheet.test.jsx owns the create payload, the stage, the event and the routing;
// this file owns only the measure. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, apiFetchSpy, toastSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(), apiFetchSpy: vi.fn(), toastSpy: vi.fn(),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => navigateSpy }
})
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../context/ToastContext.jsx', () => ({
  useOptionalToast: () => ({ show: toastSpy }),
  useToast: () => ({ show: toastSpy }),
}))
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: vi.fn(), takePendingCapture: vi.fn() }))
// Stubbed for the sibling file's reason: the real picker fetches /api/varieties on mount, which
// would put a read into the call list every "the request after the create" assertion here reads by
// index.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="variety-picker-value">{value?.id ?? 'none'}</span>,
}))

import SaveSeedSheet, { seedMeasurePayload, parseSeedWeight } from '../components/planting/SaveSeedSheet.jsx'

const PL = {
  id: 'pl1', project_id: 'proj1', name: 'Brandywine #2', status: 'fruiting',
  variety_id: 'v-brandywine',
  variety_ref: { id: 'v-brandywine', name: 'Brandywine', crop_type_slug: 'tomato' },
}

const MEASURE_PATH = '/api/inventory-items/inv-9/seed-measure'
const onClose = vi.fn()

const openSheet = () => render(
  <MemoryRouter><SaveSeedSheet planting={PL} onClose={onClose} /></MemoryRouter>,
)
const typeCount = (v) => fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: v } })
const typeWeight = (v) => fireEvent.change(screen.getByTestId('save-seed-weight'), { target: { value: v } })
const submit = () => fireEvent.click(screen.getByTestId('save-seed-submit'))

const callsTo = (path) => apiFetchSpy.mock.calls.filter(([p]) => String(p) === path)
const measureCalls = () => apiFetchSpy.mock.calls.filter(([p]) => String(p).endsWith('/seed-measure'))
const bodyOf = (call) => JSON.parse(call[1].body)

/** Resolve every path; reject only the ones named. */
const routeWith = (reject = []) => apiFetchSpy.mockImplementation((path) => {
  if (reject.some(frag => String(path).includes(frag))) return Promise.reject(new Error('boom'))
  return Promise.resolve({ id: 'inv-9' })
})

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset()
  routeWith()
})

describe('seedMeasurePayload — a blank field is not a zero', () => {
  // THE ASYMMETRY IS THE POINT. parseOpeningCount maps blank -> 0 because the CREATE needs a number
  // the CHECK will accept; seed_count is nullable and NULL means "nobody has counted this yet". So
  // blank must produce NO request, while a typed 0 must produce one — otherwise the column cannot
  // tell an empty jar from an uncounted one.
  it('returns null for a field the user never filled in', () => {
    expect(seedMeasurePayload('')).toBeNull()
    expect(seedMeasurePayload('   ')).toBeNull()
    expect(seedMeasurePayload(null)).toBeNull()
    expect(seedMeasurePayload(undefined)).toBeNull()
  })
  it('returns a payload for a typed count — the green control for the nulls above', () => {
    expect(seedMeasurePayload('185')).toEqual({ seed_count: 185, seed_count_estimated: false })
    expect(seedMeasurePayload(20)).toEqual({ seed_count: 20, seed_count_estimated: false })
  })
  it('treats a TYPED zero as a measurement, not as a blank', () => {
    // "I opened the pod and there was nothing in it" is a count. It is also the case a bare
    // Number('') === 0 would make indistinguishable from the blank above.
    expect(seedMeasurePayload('0')).toEqual({ seed_count: 0, seed_count_estimated: false })
  })
  it('returns null for input the sheet refuses upstream (never a coerced number)', () => {
    expect(seedMeasurePayload('abc')).toBeNull()
    expect(seedMeasurePayload('-1')).toBeNull()
  })
  it('never marks a count typed here as estimated', () => {
    // false, not absent and not true: a number typed while holding the seed is counted. `true` is
    // reserved for a vendor claim off the back of a packet.
    expect(seedMeasurePayload('185').seed_count_estimated).toBe(false)
  })
})

describe('parseSeedWeight — a bare number is GRAMS', () => {
  // THE 1000x DECISION. Reading a bare number as milligrams instead would be silently wrong on
  // every packet and undetectable downstream: 28 g of beans and 28 mg of lettuce seed are both
  // ordinary rows, so nothing in the data could ever flag the mistake. The suffix changes the unit;
  // the magnitude of a bare number never moves.
  it('takes a bare number as grams', () => {
    expect(parseSeedWeight('2.5')).toEqual({ value: 2.5, error: null })
    expect(parseSeedWeight('28.35')).toEqual({ value: 28.35, error: null })
  })
  it('takes a g suffix as grams, spaced or not, in either case', () => {
    for (const raw of ['2.5 g', '2.5g', '2.5 G']) {
      expect(parseSeedWeight(raw)).toEqual({ value: 2.5, error: null })
    }
  })
  it('converts a mg suffix to grams by dividing by 1000', () => {
    expect(parseSeedWeight('250 mg')).toEqual({ value: 0.25, error: null })
    expect(parseSeedWeight('250mg')).toEqual({ value: 0.25, error: null })
    expect(parseSeedWeight('5 MG')).toEqual({ value: 0.005, error: null })
    // The pair that proves the unit did the work rather than the number: same digits, 1000x apart.
    expect(parseSeedWeight('250').value).toBe(250)
  })
  it('rounds to the column’s 3dp rather than leaving Postgres to do it', () => {
    // numeric(10,3). Rounding here means what we send is exactly what comes back.
    expect(parseSeedWeight('1.23456')).toEqual({ value: 1.235, error: null })
    expect(parseSeedWeight('28.3495')).toEqual({ value: 28.35, error: null })
  })
  it('keeps a weighed zero, and an empty field is not one', () => {
    expect(parseSeedWeight('0')).toEqual({ value: 0, error: null })
    expect(parseSeedWeight('0 g')).toEqual({ value: 0, error: null })
    // Blank is "never weighed" and contributes no key at all — the error is null, so nothing is
    // reported to the user either.
    expect(parseSeedWeight('')).toEqual({ value: null, error: null })
    expect(parseSeedWeight('   ')).toEqual({ value: null, error: null })
    expect(parseSeedWeight(null)).toEqual({ value: null, error: null })
  })
  it('refuses a positive weight that would round to a stored zero', () => {
    // The one rounding that changes the sentence rather than its precision: 0 g means "weighed it,
    // it is empty". Green control below — a real 1 mg still lands.
    expect(parseSeedWeight('0.0004').value).toBeNull()
    expect(parseSeedWeight('0.0004').error).toMatch(/finer than a milligram/i)
    expect(parseSeedWeight('0.001')).toEqual({ value: 0.001, error: null })
  })
  it('refuses a negative, a unit it does not stock, and junk', () => {
    expect(parseSeedWeight('-1').error).toMatch(/cannot be negative/i)
    expect(parseSeedWeight('2.5 oz').error).toMatch(/not a weight/i)
    expect(parseSeedWeight('2.5 kg').error).toMatch(/not a weight/i)
    expect(parseSeedWeight('abc').error).toMatch(/not a weight/i)
    for (const raw of ['-1', '2.5 oz', 'abc']) expect(parseSeedWeight(raw).value).toBeNull()
  })
})

describe('seedMeasurePayload — count and weight contribute keys independently', () => {
  it('sends the weight alone when that is all the packet says', () => {
    const p = seedMeasurePayload('', '2.5')
    expect(p).toEqual({ seed_weight_g: 2.5 })
    // seed_count_estimated is a statement about a COUNT. With no count it would assert something
    // about a number that was never given.
    expect(Object.prototype.hasOwnProperty.call(p, 'seed_count_estimated')).toBe(false)
  })
  it('sends both when both were typed', () => {
    expect(seedMeasurePayload('185', '2.5'))
      .toEqual({ seed_count: 185, seed_count_estimated: false, seed_weight_g: 2.5 })
  })
  it('sends nothing at all when both are blank', () => {
    expect(seedMeasurePayload('', '')).toBeNull()
    expect(seedMeasurePayload('')).toBeNull()
  })
  it('keeps a weighed zero as a key, the same way a counted zero is one', () => {
    expect(seedMeasurePayload('', '0')).toEqual({ seed_weight_g: 0 })
  })
  it('drops a weight the parser refused rather than coercing it', () => {
    expect(seedMeasurePayload('', '2.5 oz')).toBeNull()
    expect(seedMeasurePayload('185', '2.5 oz')).toEqual({ seed_count: 185, seed_count_estimated: false })
  })
})

describe('V5-SEEDQTY-001 — the count goes to /seed-measure, never to quantity_on_hand', () => {
  it('sends the typed count on its own route, on the lot the create just returned', async () => {
    openSheet()
    typeCount('185')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    const [path, opts] = measureCalls()[0]
    expect(path).toBe(MEASURE_PATH)
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ seed_count: 185, seed_count_estimated: false })
    // Immediately after the create, so the id it addresses is the one that came back rather than
    // anything read off component state.
    expect(String(apiFetchSpy.mock.calls[0][0])).toBe('/api/inventory-items')
    expect(String(apiFetchSpy.mock.calls[1][0])).toBe(MEASURE_PATH)
  })

  it('keeps the count OFF the create — one container, and no seed columns in the wide body', async () => {
    openSheet()
    typeCount('185')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    const body = bodyOf(callsTo('/api/inventory-items')[0])
    expect(body.quantity_on_hand).toBe(1)
    expect(body.unit).toBe('packet')
    for (const k of ['seed_count', 'seed_weight_g', 'seed_count_estimated']) {
      expect(Object.prototype.hasOwnProperty.call(body, k)).toBe(false)
    }
  })

  it('a BLANK count sends no measure request at all', async () => {
    // Paired with the typed case above: this assertion alone is satisfied by a sheet that never
    // calls the route, and that one is satisfied by a sheet that always does.
    openSheet()
    submit()
    await waitFor(() => expect(callsTo('/api/events')).toHaveLength(1))
    expect(measureCalls()).toHaveLength(0)
    // Positive evidence the save ran at all, so "no measure request" cannot be read off a save that
    // never happened.
    expect(callsTo('/api/inventory-items')).toHaveLength(1)
  })

  it('a negative count never reaches the route — it is refused before the create', async () => {
    // seedMeasurePayload returns null for a value parseOpeningCount rejects, but that arm is
    // unreachable through the UI precisely because this guard fires first, and this is where that
    // is proved. Nothing at all is written: not the lot, not the measure.
    openSheet()
    typeCount('-5')
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/cannot be negative/i)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('a DECIMAL count is refused here, not by the route after the lot exists', async () => {
    // The destination column changed under this field: the count used to land in quantity_on_hand,
    // numeric(10,3), where 20.5 was legal. seed_count is an integer and PUT /seed-measure 400s on a
    // non-integer, so without the client guard the lot is created and the typed number is lost with
    // only a toast. The input is inputMode="decimal", so a decimal point is one tap away on Android.
    openSheet()
    typeCount('20.5')
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/whole number/i)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('a typed ZERO does send one — the counted-empty jar', async () => {
    openSheet()
    typeCount('0')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    expect(JSON.parse(measureCalls()[0][1].body)).toEqual({ seed_count: 0, seed_count_estimated: false })
  })
})

describe('V5-SEEDQTY-001 — the weight, the other half of "count or grams"', () => {
  it('sends a weight-only packet as grams, with no count key', async () => {
    openSheet()
    typeWeight('2.5 g')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    const body = JSON.parse(measureCalls()[0][1].body)
    expect(body).toEqual({ seed_weight_g: 2.5 })
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_count')).toBe(false)
  })

  it('converts mg to grams on the way out — the stored unit is always grams', async () => {
    openSheet()
    typeWeight('250 mg')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    expect(JSON.parse(measureCalls()[0][1].body)).toEqual({ seed_weight_g: 0.25 })
  })

  it('takes a bare number as grams through the UI, not milligrams', async () => {
    // Same digits as the mg case above and 1000x the value: the suffix is what changes the unit.
    openSheet()
    typeWeight('250')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    expect(JSON.parse(measureCalls()[0][1].body)).toEqual({ seed_weight_g: 250 })
  })

  it('carries both when the packet states both', async () => {
    openSheet()
    typeCount('185')
    typeWeight('2.5')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    expect(JSON.parse(measureCalls()[0][1].body))
      .toEqual({ seed_count: 185, seed_count_estimated: false, seed_weight_g: 2.5 })
  })

  it('a blank weight beside a typed count sends no weight key', async () => {
    // The green control for the weight assertions above: an always-present key would pass them all.
    openSheet()
    typeCount('185')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    const body = JSON.parse(measureCalls()[0][1].body)
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_weight_g')).toBe(false)
  })

  it('a weight it cannot read is refused before anything is written', async () => {
    openSheet()
    typeWeight('2.5 oz')
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/not a weight/i)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('accepts a DECIMAL weight where the count refuses one', async () => {
    // The two fields are deliberately not symmetrical: seed_count is an integer column, seed_weight_g
    // is numeric(10,3), and 0.5 g is an ordinary packet.
    openSheet()
    typeWeight('0.5')
    submit()
    await waitFor(() => expect(measureCalls()).toHaveLength(1))
    expect(JSON.parse(measureCalls()[0][1].body)).toEqual({ seed_weight_g: 0.5 })
  })

  it('names the field on screen as an alternative and says a bare number is grams', () => {
    openSheet()
    expect(screen.getByTestId('save-seed-weight')).toBeTruthy()
    expect(screen.getByTestId('save-seed-weight-note').textContent).toMatch(/GRAMS/)
    expect(screen.getByTestId('save-seed-weight-note').textContent).toMatch(/mg/)
    // type="text", not type="number": a number input hands back '' for "2.5 g" and would erase the
    // suffix this field documents.
    expect(screen.getByTestId('save-seed-weight').getAttribute('type')).toBe('text')
    // The count keypad is the integer one; the weight keypad is the decimal one.
    expect(screen.getByTestId('save-seed-count').getAttribute('inputmode')).toBe('numeric')
    expect(screen.getByTestId('save-seed-weight').getAttribute('inputmode')).toBe('decimal')
  })
})

describe('V5-SEEDQTY-001 — a failed measure does not fail the save', () => {
  it('finishes the save and says which part missed', async () => {
    routeWith(['/seed-measure'])
    openSheet()
    typeCount('185')
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    // The lot exists — the user asked for a lot, not for a count — so everything downstream still
    // runs and the sheet closes exactly as it would have.
    expect(callsTo('/api/events')).toHaveLength(1)
    expect(navigateSpy.mock.calls[0][0]).toBe('/inventory/inv-9')
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('save-seed-error')).toBeNull()
    // Retoned, and it names the count rather than claiming a clean save.
    expect(toastSpy.mock.calls[0][0].tone).toBe('error')
    expect(toastSpy.mock.calls[0][0].message).toMatch(/record the count/)
  })

  it('a measure that LANDS leaves the toast byte-identical to a clean save', async () => {
    // The green control for the retone above: without it, an error tone on every save would pass.
    openSheet()
    typeCount('185')
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
  })

  it('a measure failure does not stop the stage write beside it', async () => {
    routeWith(['/seed-measure'])
    openSheet()
    typeCount('185')
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(apiFetchSpy.mock.calls.filter(([p]) => String(p).endsWith('/seed-stage'))).toHaveLength(1)
    // The stage landed, so the lot joined a queue and the routing follows the stage, not the count.
    expect(navigateSpy.mock.calls[0][0]).toBe('/seeds/saved')
  })

  it('when BOTH follow-ups miss, the message names both', async () => {
    // A message naming one of two failures is a false all-clear on the other.
    routeWith(['/seed-measure', '/seed-stage'])
    openSheet()
    typeCount('185')
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0].message).toMatch(/record the count/)
    expect(toastSpy.mock.calls[0][0].message).toMatch(/start tracking it/)
  })

  it('names the WEIGHT when that is what the user typed', async () => {
    // "couldn't record the count" on a save where no count was entered is a message about something
    // that never happened.
    routeWith(['/seed-measure'])
    openSheet()
    typeWeight('2.5')
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0].message).toMatch(/record the weight/)
    expect(toastSpy.mock.calls[0][0].message).not.toMatch(/record the count/)
  })

  it('names both when both were typed', async () => {
    routeWith(['/seed-measure'])
    openSheet()
    typeCount('185')
    typeWeight('2.5')
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0].message).toMatch(/record the count and weight/)
  })

  it('a stage-only failure keeps the wording that shipped', async () => {
    routeWith(['/seed-stage'])
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0])
      .toEqual({ message: "Seed lot saved — couldn't start tracking it", tone: 'error' })
  })
})
