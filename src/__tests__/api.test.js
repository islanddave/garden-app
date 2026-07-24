// Unit tests for src/lib/api.js — routing prefix resolution.
// Longest-prefix-first is enforced by insertion order in FUNCTION_URLS.
// Pass an explicit urls map to resolveUrl so tests are env-decoupled.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveUrl, apiFetch, API_TIMEOUT_MS } from '../lib/api.js'

// Mirror of FUNCTION_URLS insertion order from src/lib/api.js. Order matters:
// /api/projects/inactive MUST precede /api/projects so the longer prefix wins.
const URLS = {
  '/api/projects/inactive': 'https://dashboard.lambda/',
  '/api/projects':          'https://projects.lambda/',
  '/api/plants':            'https://plants.lambda/',
  '/api/locations':         'https://locations.lambda/',
  '/api/notifications':     'https://events.lambda/',
  '/api/events':            'https://events.lambda/',
  '/api/favorites':         'https://favorites.lambda/',
  '/api/photos':            'https://photos.lambda/',
  '/api/dashboard':         'https://dashboard.lambda/',
  '/api/inventory-items':   'https://inventory.lambda/',
  '/api/varieties':         'https://varieties.lambda/',
  '/api/achievements':      'https://achievements.lambda/',
  '/api/tags':              'https://tags.lambda/',
  '/api/entity-tags':       'https://tags.lambda/',
}

describe('resolveUrl — prefix routing', () => {
  it('routes /api/projects to VITE_API_PROJECTS', () => {
    expect(resolveUrl('/api/projects', URLS)).toBe('https://projects.lambda/api/projects')
  })

  it('routes /api/projects/inactive to VITE_API_DASHBOARD (longest-prefix-first)', () => {
    const result = resolveUrl('/api/projects/inactive', URLS)
    expect(result).toBe('https://dashboard.lambda/api/projects/inactive')
    expect(result).not.toContain('projects.lambda')
  })

  it('routes /api/projects/inactive/{id}/dismiss to VITE_API_DASHBOARD', () => {
    const result = resolveUrl('/api/projects/inactive/abc-123/dismiss', URLS)
    expect(result).toBe('https://dashboard.lambda/api/projects/inactive/abc-123/dismiss')
    expect(result).not.toContain('projects.lambda')
  })

  it('routes /api/notifications/subscribe to VITE_API_EVENTS', () => {
    expect(resolveUrl('/api/notifications/subscribe', URLS))
      .toBe('https://events.lambda/api/notifications/subscribe')
  })

  it('routes /api/inventory-items to VITE_API_INVENTORY (regression)', () => {
    expect(resolveUrl('/api/inventory-items', URLS))
      .toBe('https://inventory.lambda/api/inventory-items')
  })

  it('routes /api/inventory-items/abc to VITE_API_INVENTORY', () => {
    expect(resolveUrl('/api/inventory-items/abc', URLS))
      .toBe('https://inventory.lambda/api/inventory-items/abc')
  })

  it('throws when no prefix matches', () => {
    expect(() => resolveUrl('/api/foo', URLS)).toThrow(/No Lambda URL configured/)
  })

  it('throws when prefix-less path provided', () => {
    expect(() => resolveUrl('/random', URLS)).toThrow(/No Lambda URL configured/)
  })

  it('routes /api/tags to VITE_API_TAGS', () => {
    expect(resolveUrl('/api/tags', URLS)).toBe('https://tags.lambda/api/tags')
  })

  it('routes /api/tags/:id/merge to VITE_API_TAGS', () => {
    expect(resolveUrl('/api/tags/abc/merge', URLS)).toBe('https://tags.lambda/api/tags/abc/merge')
  })

  it('routes /api/entity-tags to VITE_API_TAGS (not /api/tags)', () => {
    expect(resolveUrl('/api/entity-tags?entity_type=plant&entity_id=1', URLS))
      .toBe('https://tags.lambda/api/entity-tags?entity_type=plant&entity_id=1')
  })

  it('strips trailing slash from base URL before joining', () => {
    expect(resolveUrl('/api/events', { '/api/events': 'https://x.lambda/' }))
      .toBe('https://x.lambda/api/events')
    expect(resolveUrl('/api/events', { '/api/events': 'https://x.lambda' }))
      .toBe('https://x.lambda/api/events')
  })
})

describe('apiFetch — timeout + abort (WS-A6)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('returns parsed json on success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) })))
    expect(await apiFetch('/api/events', {}, 't')).toEqual({ ok: 1 })
  })

  it('aborts and throws a timeout error when the request hangs past API_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })))
    const p = apiFetch('/api/events', {}, 't')
    const assertion = expect(p).rejects.toMatchObject({ status: 0, timeout: true })
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 10)
    await assertion
  })

  it('re-throws (does not mask) an abort from a caller-provided signal', async () => {
    const ac = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })))
    const p = apiFetch('/api/events', { signal: ac.signal }, 't')
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' })
    ac.abort()
    await assertion
  })
})
