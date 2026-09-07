import { describe, it, expect } from 'vitest'
import { formatQty, formatQtyExact, formatMoney, formatDate, formatSeedWeight } from '../lib/format.js'

describe('formatQty', () => {
  it('drops trailing zeros from string decimals (numeric column source)', () => {
    expect(formatQty('3.000')).toBe('3')
    expect(formatQty('10.000')).toBe('10')
    expect(formatQty('100.000')).toBe('100')
  })
  it('rounds decimals to nearest integer (Dave directive: integers everywhere)', () => {
    expect(formatQty('3.500')).toBe('4')
    expect(formatQty('3.125')).toBe('3')
    expect(formatQty(2.4)).toBe('2')
    expect(formatQty(2.5)).toBe('3')
  })
  it('handles integers cleanly', () => {
    expect(formatQty(0)).toBe('0')
    expect(formatQty(1)).toBe('1')
    expect(formatQty('0')).toBe('0')
  })
  it('returns empty string for null/undefined/empty', () => {
    expect(formatQty(null)).toBe('')
    expect(formatQty(undefined)).toBe('')
    expect(formatQty('')).toBe('')
  })
  it('returns input as-is for non-finite values (defensive)', () => {
    expect(formatQty('abc')).toBe('abc')
  })
  it('handles negative numbers', () => {
    expect(formatQty(-3.4)).toBe('-3')
    expect(formatQty('-3.000')).toBe('-3')
  })
})

describe('formatMoney', () => {
  it('formats to exactly 2 decimals with $ prefix', () => {
    expect(formatMoney(12.99)).toBe('$12.99')
    expect(formatMoney('12.990')).toBe('$12.99')
    expect(formatMoney(5)).toBe('$5.00')
    expect(formatMoney('3.000')).toBe('$3.00')
    expect(formatMoney(0)).toBe('$0.00')
  })
  it('rounds to 2 decimals', () => {
    expect(formatMoney('1.999')).toBe('$2.00')
    expect(formatMoney(2.5)).toBe('$2.50')
    expect(formatMoney('12.345')).toBe('$12.35')
  })
  it('returns empty string for null/undefined/empty', () => {
    expect(formatMoney(null)).toBe('')
    expect(formatMoney(undefined)).toBe('')
    expect(formatMoney('')).toBe('')
  })
  it('returns input as-is for non-finite values (defensive)', () => {
    expect(formatMoney('abc')).toBe('abc')
  })
})

describe('formatDate', () => {
  it('formats a full ISO timestamp without TZ off-by-one (L-107)', () => {
    expect(formatDate('2026-06-01T00:00:00.000Z')).toBe('Jun 1, 2026')
    expect(formatDate('2026-12-31T23:59:59Z')).toBe('Dec 31, 2026')
  })
  it('formats a date-only string', () => {
    expect(formatDate('2026-06-09')).toBe('Jun 9, 2026')
    expect(formatDate('2026-01-15')).toBe('Jan 15, 2026')
  })
  it('returns empty string for null/undefined/empty', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDate(undefined)).toBe('')
    expect(formatDate('')).toBe('')
  })
  it('passes through non-ISO/free-text untouched (defensive)', () => {
    expect(formatDate('sometime in spring')).toBe('sometime in spring')
    expect(formatDate('06/01/2026')).toBe('06/01/2026')
  })
  it('returns input untouched for an out-of-range month', () => {
    expect(formatDate('2026-13-01')).toBe('2026-13-01')
  })
})

describe('formatSeedWeight (V5-SEEDQTY-001)', () => {
  // THE BOUNDARY PAIR IS THE POINT OF THIS SUITE. Every other case below passes under either a `>`
  // or a `>=` at 0.1, so without these two lines the branch that decides grams-vs-milligrams is
  // untested at the only input that can tell them apart.
  //
  // BOTH SHAPES, and the string one is the shape the app actually gets: seed_weight_g is
  // numeric(10,3) and the pg driver serializes numeric as a STRING ("0.100"), never a number. A
  // boundary suite fed only number literals would be green while every live render went through an
  // untested path — the same reason formatQty's own suite leads with '3.000'.
  it('is closed on the gram side at 0.1 — 0.1 is grams, 0.099 is milligrams', () => {
    expect(formatSeedWeight(0.1)).toBe('0.1 g')
    expect(formatSeedWeight(0.099)).toBe('99 mg')
    expect(formatSeedWeight('0.100')).toBe('0.1 g')
    expect(formatSeedWeight('0.099')).toBe('99 mg')
  })
  it('renders grams at or above a decigram, trailing zeros trimmed', () => {
    expect(formatSeedWeight(0.5)).toBe('0.5 g')
    expect(formatSeedWeight(1)).toBe('1 g')
    expect(formatSeedWeight(28.35)).toBe('28.35 g')
    // 1 oz, the unit the live 'Pinto Beans (Quincy)' packet is stocked in.
    expect(formatSeedWeight(28.3495)).toBe('28.35 g')
    expect(formatSeedWeight(100)).toBe('100 g')
  })
  it('reads numeric(10,3) strings straight off the column', () => {
    expect(formatSeedWeight('28.350')).toBe('28.35 g')
    expect(formatSeedWeight('0.500')).toBe('0.5 g')
    expect(formatSeedWeight('0.050')).toBe('50 mg')
  })
  it('renders milligrams below a decigram, as an integer', () => {
    expect(formatSeedWeight(0.05)).toBe('50 mg')
    expect(formatSeedWeight(0.001)).toBe('1 mg')
    expect(formatSeedWeight('0.012')).toBe('12 mg')
  })
  it('keeps a measured zero distinguishable from an unrecorded weight', () => {
    // "0 g" is a reading somebody took; '' is a column nobody has written. Collapsing them would
    // make an empty field and an empty jar the same claim. 0 must NOT land in the mg branch.
    expect(formatSeedWeight(0)).toBe('0 g')
    expect(formatSeedWeight('0.000')).toBe('0 g')
    expect(formatSeedWeight(null)).toBe('')
    expect(formatSeedWeight(undefined)).toBe('')
    expect(formatSeedWeight('')).toBe('')
  })
  it('returns input as-is for non-finite values (defensive)', () => {
    expect(formatSeedWeight('abc')).toBe('abc')
  })
  it('never routes seed weight through formatQty, which would round a real weight to a bare integer', () => {
    // The regression this function exists to prevent, stated as a comparison: same input, and the
    // wrong helper answers "1" with no unit for half a gram of lettuce seed.
    expect(formatQty(0.5)).toBe('1')
    expect(formatSeedWeight(0.5)).toBe('0.5 g')
  })
})

describe('formatQtyExact (BUG-INVQTYROUNDTRIP-001)', () => {
  // THE REVERSIBILITY PAIR IS THE POINT OF THIS SUITE, in the same way the 0.1 boundary is the point
  // of formatSeedWeight's. Everything else here would also pass under a formatter that quietly
  // re-rounded at some decimal place; only parseFloat(out) === Number(in) states the actual contract,
  // because parseFloat IS the read-back in InventoryDetail.parseNum and the whole defect was a
  // prefill that did not survive it.
  it('survives the parseFloat read-back that buildChanges() performs', () => {
    for (const v of ['0.500', '4.400', '3.200', '3.000', 0.5, 12, 0, '9999999.999', '0.001']) {
      expect(parseFloat(formatQtyExact(v))).toBe(Number(v))
    }
  })
  // The three live prod rows this was found on, by their stored values: the okra packet, the pumice,
  // and the mykos. Written as the DB serializes them (numeric(10,3) arrives as a STRING through the
  // pg driver, never a number) — a suite fed only number literals would be green while every real
  // render went through an untested path.
  it('renders the fractional rows prod actually holds, exactly', () => {
    expect(formatQtyExact('0.500')).toBe('0.5')   // Clemson Spineless 80 Okra, 0.5 packet
    expect(formatQtyExact('4.400')).toBe('4.4')   // Horticultural Lava Pebbles, 4.4 lb
    expect(formatQtyExact('3.200')).toBe('3.2')   // Xtreme Gardening Mykos, 3.2 lb
  })
  it('trims trailing zeros off whole values — the readable-input half V3-QTYINT-001 wanted', () => {
    expect(formatQtyExact('1.000')).toBe('1')
    expect(formatQtyExact('5.000')).toBe('5')
    expect(formatQtyExact('12.000')).toBe('12')
    expect(formatQtyExact(20)).toBe('20')
  })
  it('shares its siblings edge contract: blank in, blank out; non-finite passes through', () => {
    expect(formatQtyExact(null)).toBe('')
    expect(formatQtyExact(undefined)).toBe('')
    expect(formatQtyExact('')).toBe('')
    expect(formatQtyExact('500ml')).toBe('500ml')
    expect(formatQtyExact(0)).toBe('0')           // a counted zero is not a blank
  })
  it('keeps negatives as stored (no rounding toward or away from zero)', () => {
    expect(formatQtyExact(-3.4)).toBe('-3.4')
    expect(formatQtyExact('-3.000')).toBe('-3')
  })
  it('differs from formatQty exactly where the defect lived', () => {
    // Same input, two answers. The left one is a legitimate DISPLAY of "about 4 lb of pumice"; the
    // right one is the only acceptable answer for a box whose contents get written back.
    expect(formatQty('4.400')).toBe('4')
    expect(formatQtyExact('4.400')).toBe('4.4')
  })
})

describe('integer-quantity prefill contract (V3-QTYINT-001)', () => {
  // RE-POINTED, not deleted (BUG-INVQTYROUNDTRIP-001). This block used to assert the prefill contract
  // against formatQty, and its comment said edit prefills route through it — that WAS the defect:
  // formatQty was reached for because it trims trailing zeros, and its rounding came along unnoticed
  // and rewrote data on save. The requirement V3-QTYINT-001 encoded is real and still holds (an edit
  // box must never show "1.000"), so it is re-pointed at the formatter that now serves it. formatQty's
  // own rounding contract is unchanged and stays proved in its own describe above, where the callers
  // are renders.
  it('collapses numeric(N,3) DB strings to integers for edit prefills', () => {
    expect(formatQtyExact('1.000')).toBe('1')   // the planting-edit Quantity bug
    expect(formatQtyExact('5.000')).toBe('5')   // qty_initial
    expect(formatQtyExact('12.000')).toBe('12') // reorder/purchased
  })
  it('leaves a null quantity prefill empty (drops the != null guards cleanly)', () => {
    expect(formatQtyExact(null)).toBe('')
  })
  it('preserves free-text quantities (integer even when free text)', () => {
    expect(formatQtyExact('500ml')).toBe('500ml')
  })
})
