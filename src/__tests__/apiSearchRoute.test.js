// V4-SEARCH-002 — /api/search routes through VITE_API_DASHBOARD (routing-map glue).
// resolveUrl prefix-matches FUNCTION_URLS; without the '/api/search' entry this
// path would throw "No Lambda URL configured".
import { describe, it, expect } from 'vitest'
import { resolveUrl } from '../lib/api.js'

describe('api routing map — /api/search (V4-SEARCH-002)', () => {
  it('resolves /api/search?q=... without throwing and preserves the path', () => {
    const url = resolveUrl('/api/search?q=tomato')
    expect(url.endsWith('/api/search?q=tomato')).toBe(true)
  })
  it('existing routes still resolve', () => {
    expect(resolveUrl('/api/dashboard').endsWith('/api/dashboard')).toBe(true)
    expect(resolveUrl('/api/plants').endsWith('/api/plants')).toBe(true)
  })
})
