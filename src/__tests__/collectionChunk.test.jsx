// V4-LAZYRETRY-001 — the /collection chunk loader and, more importantly, its FAILURE branch.
//
// Sibling of critterFactsLoader.test.jsx, and it exists for the same reason one level up: sw.js
// precaches only '/' and the manifest and serves JS cache-first from a STATIC_CACHE that is purged
// every deploy, so after a deploy the first offline visit to /collection finds no chunk and no
// network. The route USED to be React.lazy, which caches a rejected payload permanently on a
// module-scope object (react/cjs/react.development.js:1354-1409) — the failure was unrecoverable
// for the whole session and it blanked the entire app, because /collection carried no boundary of
// its own. So "the import rejects, the promise SETTLES to a value, and the cache is left clean for
// a retry" is not an edge case here; it is the load-bearing property, and it is what these pin.
//
// The route-level behaviour that sits on top of this — route-scoped fallback, and a retry that
// issues a genuinely new import — is App.collectionChunkRetry.test.jsx.
//
// No jest-dom (L-182): toBeTruthy/toBe(null).
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { loadCollectionChunk, peekCollectionChunk, __resetCollectionChunkCache } from '../lib/collectionChunk.js'

beforeEach(() => { __resetCollectionChunkCache() })

describe('collectionChunk — cache and concurrency', () => {
  it('peek() is null before anything has loaded', () => {
    expect(peekCollectionChunk()).toBe(null)
  })

  it('load() resolves the page component and peek() then answers synchronously', async () => {
    const Page = await loadCollectionChunk()
    expect(typeof Page).toBe('function')
    // The synchronous seam is what stops a return visit to /collection re-flashing its loading state.
    expect(peekCollectionChunk()).toBe(Page)
  })

  it('two concurrent callers share ONE resolution — no duplicate chunk fetch', async () => {
    // This is also what absorbs StrictMode's double-invoked effect in dev: without the inflight
    // guard, every mount of CollectionRoute would fire two requests for the same chunk.
    const [a, b] = await Promise.all([loadCollectionChunk(), loadCollectionChunk()])
    expect(a).toBe(b)
  })

  it('a second call after resolution returns the cached component identity', async () => {
    const first = await loadCollectionChunk()
    expect(await loadCollectionChunk()).toBe(first)
  })
})

// THE OFFLINE BRANCH. Driven through the real module by stubbing the dynamic import target, so the
// assertion is about loadCollectionChunk()'s contract rather than about a hand-rolled fake.
describe('collectionChunk — a chunk miss degrades to a VALUE, never a throw', () => {
  it('resolves null instead of rejecting when the chunk cannot be fetched', async () => {
    vi.doMock('../pages/Collection.jsx', () => { throw new Error('Failed to fetch dynamically imported module') })
    vi.resetModules()
    const mod = await import('../lib/collectionChunk.js')
    mod.__resetCollectionChunkCache()
    // The promise must SETTLE, and settle to null. An unhandled rejection here is the bug — it is
    // what would reach an error boundary and take the page (or, before this fix, the app) down.
    await expect(mod.loadCollectionChunk()).resolves.toBe(null)
    expect(mod.peekCollectionChunk()).toBe(null)
    vi.doUnmock('../pages/Collection.jsx')
    vi.resetModules()
  })

  it('a failed load leaves the cache empty so a later retry can still succeed', async () => {
    // THE REGRESSION GUARD, and the exact thing React.lazy got wrong. An implementation that
    // memoized the FAILURE — as lazy() does by parking _status at Rejected — would permanently
    // poison /collection for the rest of the session once Dave opened it in a dead spot.
    expect(peekCollectionChunk()).toBe(null)
    const Page = await loadCollectionChunk()
    expect(typeof Page).toBe('function')
  })
})
