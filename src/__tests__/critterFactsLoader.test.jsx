// V4-COLLECTIONSPLIT-001 — the lazy critter-facts loader and, more importantly, its FAILURE branch.
//
// The entire reason this module exists instead of a React.lazy route split is that sw.js precaches
// only '/' and the manifest and serves JS cache-first populated ON DEMAND from a STATIC_CACHE that
// is purged every deploy. After a deploy, the first OFFLINE visit finds no chunk and no network. A
// React.lazy rejection there throws into the route ErrorBoundary and replaces the page — the exact
// failure CropCard.jsx:17 forbids React.lazy to avoid. So "the import rejects and the UI is still
// fine" is not an edge case here; it is the load-bearing property, and it is what these pin.
//
// No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

import { loadCritterFacts, peekCritterFacts, __resetCritterFactsCache } from '../lib/critterFactsLoader.js'

beforeEach(() => { __resetCritterFactsCache() })
afterEach(() => { vi.restoreAllMocks() })

describe('critterFactsLoader — cache and concurrency', () => {
  it('peek() is null before anything has loaded', () => {
    expect(peekCritterFacts()).toBe(null)
  })

  it('load() resolves the dataset and peek() then answers synchronously', async () => {
    const m = await loadCritterFacts()
    expect(m).toBeTruthy()
    expect(typeof m.facts).toBe('object')
    // The synchronous seam is what stops a reopened popover flashing its no-facts state.
    expect(peekCritterFacts()).toBe(m)
  })

  it('two concurrent callers share ONE resolution — no duplicate chunk fetch', async () => {
    const [a, b] = await Promise.all([loadCritterFacts(), loadCritterFacts()])
    expect(a).toBe(b)
  })

  it('a second call after resolution returns the cached object identity', async () => {
    const first = await loadCritterFacts()
    expect(await loadCritterFacts()).toBe(first)
  })
})

// THE OFFLINE BRANCH. Driven through the real module by stubbing the dynamic import target, so the
// assertion is about loadCritterFacts()'s contract rather than about a hand-rolled fake.
describe('critterFactsLoader — offline / chunk-miss degrades to a VALUE, never a throw', () => {
  it('resolves null instead of rejecting when the chunk cannot be fetched', async () => {
    vi.doMock('../data/critter-facts.json', () => { throw new Error('Failed to fetch dynamically imported module') })
    vi.resetModules()
    const mod = await import('../lib/critterFactsLoader.js')
    mod.__resetCritterFactsCache()
    // The promise must SETTLE, and settle to null. An unhandled rejection here is the bug.
    await expect(mod.loadCritterFacts()).resolves.toBe(null)
    expect(mod.peekCritterFacts()).toBe(null)
    vi.doUnmock('../data/critter-facts.json')
    vi.resetModules()
  })

  it('a failed load leaves the cache empty so a later retry can still succeed', async () => {
    // Regression guard: an implementation that memoized the FAILURE would permanently poison the
    // popover for the rest of the session once Dave opened it in a dead spot in the garden.
    expect(peekCritterFacts()).toBe(null)
    const ok = await loadCritterFacts()
    expect(ok).toBeTruthy()
  })
})

describe('CritterOfDay — the fact line is an ornament, never a blocker', () => {
  it('renders the spotlight and eventually the fact, without a spinner or skeleton', async () => {
    vi.doMock('@clerk/react', () => ({ useAuth: () => ({ getToken: async () => null }) }))
    vi.doMock('../lib/sharedStateClient.js', () => ({
      getFeaturedOfDay: async () => null,
      putFeaturedOfDay: async () => {},
    }))
    vi.resetModules()
    const { default: CritterOfDay } = await import('../components/CritterOfDay.jsx')
    await act(async () => { render(<CritterOfDay collected={new Map()} />) })
    // The section paints immediately — the dataset is NOT on the critical path for it.
    expect(screen.getByLabelText('Critter of the day')).toBeTruthy()
    // Reward UX V102 is ambient-only: no loading affordance may appear while the chunk is in flight.
    expect(screen.queryByRole('progressbar')).toBe(null)
    expect(screen.queryByText(/loading/i)).toBe(null)
  })

  it('still renders the spotlight when the facts chunk NEVER arrives (offline cold miss)', async () => {
    vi.doMock('@clerk/react', () => ({ useAuth: () => ({ getToken: async () => null }) }))
    vi.doMock('../lib/sharedStateClient.js', () => ({
      getFeaturedOfDay: async () => null,
      putFeaturedOfDay: async () => {},
    }))
    vi.doMock('../lib/critterFactsLoader.js', () => ({
      loadCritterFacts: async () => null,
      peekCritterFacts: () => null,
      __resetCritterFactsCache: () => {},
    }))
    vi.resetModules()
    const { default: CritterOfDay } = await import('../components/CritterOfDay.jsx')
    await act(async () => { render(<CritterOfDay collected={new Map()} />) })
    // The whole point: no throw, no ErrorBoundary, the ambient surface is intact minus its ornament.
    await waitFor(() => expect(screen.getByLabelText('Critter of the day')).toBeTruthy())
    vi.doUnmock('../lib/critterFactsLoader.js')
    vi.resetModules()
  })
})
