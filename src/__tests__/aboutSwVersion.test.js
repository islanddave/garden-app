// BUG-STALECLIENT-001 — About's SW-version diagnostic derives the active deploy tag from
// versioned cache names (static-v{version}-{sha}).
import { describe, it, expect } from 'vitest'
import { swVersionFromCacheKeys } from '../pages/About.jsx'

describe('swVersionFromCacheKeys', () => {
  it('extracts the tag from the static-* cache name', () => {
    expect(swVersionFromCacheKeys(['api-v3.69.0-f673a44', 'static-v3.69.0-f673a44', 'images-v3.69.0-f673a44']))
      .toBe('v3.69.0-f673a44')
  })
  it('returns null when no static-* cache exists', () => {
    expect(swVersionFromCacheKeys(['images-v3.69.0-f673a44'])).toBe(null)
    expect(swVersionFromCacheKeys([])).toBe(null)
  })
  it('tolerates non-array input', () => {
    for (const v of [null, undefined, {}, 5]) expect(swVersionFromCacheKeys(v)).toBe(null)
  })
})
