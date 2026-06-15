import { describe, it, expect } from 'vitest'
import { formatQty } from '../lib/format.js'

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
