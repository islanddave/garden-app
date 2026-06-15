import { describe, it, expect } from 'vitest'
import { formatQty, formatMoney } from '../lib/format.js'

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
