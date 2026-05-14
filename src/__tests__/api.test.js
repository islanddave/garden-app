// Unit tests for src/lib/api.js — routing prefix resolution.
// Longest-prefix-first is enforced by insertion order in FUNCTION_URLS.
// Pass an explicit urls map to resolveUrl so tests are env-decoupled.

import { describe, it, expect } from 'vitest'
import { resolveUrl } from '../lib/api.js'

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

  it('strips trailing slash from base URL before joining', () => {
    expect(resolveUrl('/api/events', { '/api/events': 'https://x.lambda/' }))
      .toBe('https://x.lambda/api/events')
    expect(resolveUrl('/api/events', { '/api/events': 'https://x.lambda' }))
      .toBe('https://x.lambda/api/events')
  })
})
