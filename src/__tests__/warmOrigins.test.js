// V4-PERFCLERK-001 Option A — guard on the tokenless boot warm-ping.
//
// THREE PROPERTIES, and they are not interchangeable:
//   1. TOKENLESS. This is the auth-safety property and the only reason the ping is allowed to exist
//      at all. A future edit that "helpfully" threads getToken() through here turns a request that
//      structurally cannot return data into one that can, on a path that runs before the identity
//      gate has resolved. Asserted on the real request init, not on intent.
//   2. TARGETED. Exactly the four above-the-fold origins, deduped, and nothing else — the cost is
//      one Lambda invocation per origin per cold boot, so "warm everything" is not free.
//   3. INERT. It cannot block boot and cannot fail boot. Synchronous, non-throwing on every failure
//      shape, and it never leaves a rejection unhandled.
//
// Injected fetch throughout: the point is to observe what WOULD be sent, and a suite that hit the
// network would be measuring AWS. Injected `urls` too, because import.meta.env.VITE_API_* is unset
// under vitest, which is itself one of the cases under test (see "skips an unconfigured origin").
import { describe, it, expect, vi } from 'vitest'
import { warmApiOrigins, WARM_PATHS } from '../lib/warmOrigins.js'
import { FUNCTION_URLS } from '../lib/api.js'

// One distinct Function URL per prefix, shaped like the real ones. Only the four warm prefixes plus
// two decoys — the decoys are what makes "targets ONLY the intended origins" a real assertion.
const URLS = {
  '/api/plants': 'https://plants000.lambda-url.us-east-1.on.aws',
  '/api/daily-plan': 'https://dailyplan0.lambda-url.us-east-1.on.aws',
  '/api/locations': 'https://locations0.lambda-url.us-east-1.on.aws',
  '/api/inventory-items': 'https://inventory0.lambda-url.us-east-1.on.aws',
  '/api/harvests': 'https://harvests00.lambda-url.us-east-1.on.aws',
  '/api/photos': 'https://photos0000.lambda-url.us-east-1.on.aws',
}

const ok = () => Promise.resolve({ ok: false, status: 401 })
const spy = (impl = ok) => vi.fn(impl)

describe('warm-ping is TOKENLESS (V4-PERFCLERK-001 Option A)', () => {
  it('sends no Authorization header on any request', () => {
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    expect(f).toHaveBeenCalled()
    for (const [, init] of f.mock.calls) {
      const headers = init?.headers ?? {}
      const names = (headers instanceof Headers ? [...headers.keys()] : Object.keys(headers)).map((h) => h.toLowerCase())
      expect(names).not.toContain('authorization')
    }
  })

  it('sends no headers at all — an empty token is what guarantees the 401', () => {
    // Stronger than the negative above and deliberately so: `headers` being absent means there is
    // no object for a later edit to add a credential to, and it keeps the request CORS-simple.
    // A custom header would trigger a preflight, and OPTIONS returns at lambda/plants/index.js:98
    // BEFORE getSecrets() — i.e. it would warm nothing while still looking like it worked.
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    for (const [, init] of f.mock.calls) expect(init?.headers).toBeUndefined()
  })

  it("opts credentials OUT explicitly rather than inheriting fetch's default", () => {
    // 'same-origin' (the default) already sends nothing to a cross-origin Function URL, so this is
    // belt-and-braces — but it is the difference between an invariant that is enforced and one that
    // is relied upon, and it survives someone later moving the API behind a same-origin proxy.
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    for (const [, init] of f.mock.calls) expect(init.credentials).toBe('omit')
  })

  it('uses GET, never OPTIONS — a preflight returns before getSecrets() and warms nothing', () => {
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    for (const [, init] of f.mock.calls) expect(init.method).toBe('GET')
  })

  it('never reads the response — no .json(), no .text(), no body access', async () => {
    // ASYNC ON PURPOSE. The resolution handler runs on a later microtask, so a synchronous version
    // of this test asserts before any body access could have happened and passes against an
    // implementation that does read the body. Verified: it survived exactly that mutation.
    const body = { json: vi.fn(), text: vi.fn(), clone: vi.fn() }
    const f = spy(() => Promise.resolve({ ok: false, status: 401, ...body }))
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    await new Promise((r) => setTimeout(r, 0))
    expect(body.json).not.toHaveBeenCalled()
    expect(body.text).not.toHaveBeenCalled()
    expect(body.clone).not.toHaveBeenCalled()
  })
})

describe('warm-ping is TARGETED (V4-PERFCLERK-001 Option A)', () => {
  it('hits exactly the four above-the-fold origins and no other', () => {
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    expect(f.mock.calls.map((c) => c[0]).sort()).toEqual([
      'https://dailyplan0.lambda-url.us-east-1.on.aws/api/daily-plan',
      'https://inventory0.lambda-url.us-east-1.on.aws/api/inventory-items',
      'https://locations0.lambda-url.us-east-1.on.aws/api/locations',
      'https://plants000.lambda-url.us-east-1.on.aws/api/plants',
    ])
  })

  it('leaves the below-the-fold origins in the table untouched', () => {
    // The decoys. Every extra origin is an extra invocation on every cold boot, so widening the set
    // is a decision, not a tidy-up.
    const f = spy()
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    const hit = f.mock.calls.map((c) => c[0]).join(' ')
    expect(hit).not.toContain('harvests00')
    expect(hit).not.toContain('photos0000')
  })

  it('warms an origin ONCE even when two warm paths resolve to it', () => {
    // A cold start is per container; two prefixes on one Function URL are one container.
    const shared = { ...URLS, '/api/locations': URLS['/api/plants'] }
    const f = spy()
    const pinged = warmApiOrigins({ urls: shared, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(3)
    expect(pinged.filter((u) => u.startsWith(URLS['/api/plants']))).toHaveLength(1)
  })

  it('dedupes on ORIGIN, so a trailing-slash variant is not a second ping', () => {
    const shared = { ...URLS, '/api/locations': `${URLS['/api/plants']}/` }
    const f = spy()
    warmApiOrigins({ urls: shared, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('skips an unconfigured origin without dropping the configured ones', () => {
    // The real shape of a staging build (or this vitest run) missing one VITE_API_* var: the base is
    // '', resolveUrl yields a relative path, and there is no origin to warm. Skip that one, keep the
    // rest — an early return here would silently disable the whole optimisation.
    const partial = { ...URLS, '/api/locations': '' }
    const f = spy()
    warmApiOrigins({ urls: partial, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(3)
    expect(f.mock.calls.map((c) => c[0]).join(' ')).not.toContain('/api/locations')
  })

  it('is a total no-op when nothing is configured — the default vitest env', () => {
    const f = spy()
    expect(warmApiOrigins({ urls: {}, fetchImpl: f })).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('every WARM_PATH is a real key of the shipped routing table', () => {
    // Guards the one way this file can rot silently: rename a prefix in api.js and every ping starts
    // throwing inside the swallow, leaving a green suite and a dead optimisation.
    for (const p of WARM_PATHS) expect(Object.keys(FUNCTION_URLS)).toContain(p)
  })
})

describe('warm-ping is INERT — it cannot block or fail boot (V4-PERFCLERK-001 Option A)', () => {
  it('returns synchronously, not a promise', () => {
    // Anything awaitable here invites a caller to await it, which would put the cold start back on
    // the critical path pointing the wrong way.
    const out = warmApiOrigins({ urls: URLS, fetchImpl: spy() })
    expect(Array.isArray(out)).toBe(true)
    expect(out).not.toHaveProperty('then')
  })

  it('does not throw when fetch throws synchronously, and still warms the rest', () => {
    let n = 0
    const f = vi.fn(() => { n += 1; if (n === 1) throw new Error('boom'); return ok() })
    expect(() => warmApiOrigins({ urls: URLS, fetchImpl: f })).not.toThrow()
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('does not throw when fetch is absent entirely (SSR / a stripped environment)', () => {
    expect(() => warmApiOrigins({ urls: URLS, fetchImpl: null })).not.toThrow()
  })

  it('attaches a REJECTION handler to every dispatched request', () => {
    // The direct, deterministic form of "no unhandled rejection". An earlier version of this guard
    // listened for the unhandledrejection event instead; it never fired in jsdom, so it passed
    // against an implementation with the handler deleted while vitest failed the RUN on the loose
    // rejections. A guard whose kill comes from the harness rather than from itself is vacuous.
    // Offline is the ordinary case for this app, so these promises reject in normal use.
    const then = vi.fn()
    const f = vi.fn(() => ({ then }))
    warmApiOrigins({ urls: URLS, fetchImpl: f })
    expect(then).toHaveBeenCalledTimes(4)
    for (const [onFulfilled, onRejected] of then.mock.calls) {
      expect(typeof onFulfilled).toBe('function')
      expect(typeof onRejected).toBe('function')
    }
  })

  it('survives a genuinely rejecting fetch — all four still dispatched, nothing thrown', async () => {
    const f = spy(() => Promise.reject(new Error('offline')))
    expect(() => warmApiOrigins({ urls: URLS, fetchImpl: f })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('tolerates a fetch that returns a non-promise, without dropping the later origins', () => {
    const f = vi.fn(() => undefined)
    expect(warmApiOrigins({ urls: URLS, fetchImpl: f })).toHaveLength(4)
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('SELF-TEST: the throw-tolerance assertions can actually fail', () => {
    // Without this, "does not throw" is satisfied by a function that never calls fetch at all.
    const bare = (fetchImpl) => { for (const p of WARM_PATHS) fetchImpl(p) }
    expect(() => bare(() => { throw new Error('boom') })).toThrow()
  })
})
