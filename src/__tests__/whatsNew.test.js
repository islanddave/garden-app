import { describe, it, expect } from 'vitest'
import { cmpVersion, isUnseen } from '../lib/whatsNew.js'

describe('cmpVersion', () => {
  it('compares dotted integer versions', () => {
    expect(cmpVersion('3.24.0', '3.23.9')).toBe(1)
    expect(cmpVersion('3.23.0', '3.24.0')).toBe(-1)
    expect(cmpVersion('3.24.0', '3.24.0')).toBe(0)
    expect(cmpVersion('3.24', '3.24.0')).toBe(0)
  })
})

describe('isUnseen', () => {
  it('is FALSE on first run (no stored seen) — no cold-start dot', () => {
    expect(isUnseen('3.24.0', null)).toBe(false)
    expect(isUnseen('3.24.0', '')).toBe(false)
  })
  it('is TRUE only when latest is newer than seen', () => {
    expect(isUnseen('3.24.0', '3.23.0')).toBe(true)
    expect(isUnseen('3.24.0', '3.24.0')).toBe(false)
    expect(isUnseen('3.23.0', '3.24.0')).toBe(false)
  })
  it('is FALSE with no latest', () => {
    expect(isUnseen(null, '3.0.0')).toBe(false)
  })
})
