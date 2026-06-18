import { describe, it, expect } from 'vitest'
import { formatQty, formatMoney, formatDate } from '../lib/format.js'

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

describe('integer-quantity prefill contract (V3-QTYINT-001)', () => {
  // Edit-form prefills (PlantingEditor.formFromPlant, InventoryDetail.itemToForm)
  // route numeric(N,3) DB strings through formatQty so inputs never show "1.000".
  it('collapses numeric(N,3) DB strings to integers for edit prefills', () => {
    expect(formatQty('1.000')).toBe('1')   // the planting-edit Quantity bug
    expect(formatQty('5.000')).toBe('5')   // qty_initial
    expect(formatQty('12.000')).toBe('12') // reorder/purchased
  })
  it('leaves a null quantity prefill empty (drops the != null guards cleanly)', () => {
    expect(formatQty(null)).toBe('')
  })
  it('preserves free-text quantities (integer even when free text)', () => {
    expect(formatQty('500ml')).toBe('500ml')
  })
})
