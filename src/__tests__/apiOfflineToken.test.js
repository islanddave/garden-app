// Offline token handling in src/lib/api.js — the ~15s stall, what happens when no token is
// available, and the compose-safety property of a headerless request.
//
// ⚠ REVISED 2026-08-26 (BUG-TOKENLESS-401-001). This file used to assert that a token failure
// produced a REQUEST WITH NO Authorization HEADER, on the premise that the service worker would
// then answer it from cache. That premise was false on the day it shipped, and group D is what
// proves it: sw.js keys its cache on the JWT `sub`, so a headerless request gets a null cacheName,
// which means NO cache read — 503 offline, and a hard 401 Unauthorized online. The anonymous
// request had no success case; it only cost a Lambda invocation and mislabelled the failure.
// MEASURED in prod: 48 `Invalid JWT form` 401s across 7 Lambdas in one morning, surfacing to Dave
// as "Couldn't load your harvests — Unauthorized" while he was demonstrably online.
//
// So the policy inverted. The hook now REFUSES to send an unauthenticated request (E1), recovers a
// null or stale token with a forced mint (group F), and reports offline as offline. Group D is
// retained unchanged: it is no longer the premise that licenses a tokenless request, but it is
// still the control proving the SW cannot serve one, and it is what a future edit reintroducing
// the anonymous path would have to defeat.
//
// WHAT THIS FILE IS FOR, ORIGINALLY. `useApiFetch().fetch` did `await getToken()` bare. Offline
// with a cold token cache that THROWS, so the throw escaped the hook and no fetch() was ever
// issued. The offline pre-empt (group B) is the surviving half of that fix and still earns its
// keep — it stops an API call stalling ~15s on Clerk's retry ladder.
//
// The load-bearing test is A1. Clerk's own ClerkOfflineError.is() does NOT recognise the error this
// app actually receives, because the throw comes from the CDN-hotloaded @clerk/clerk-js rather than
// the bundled @clerk/shared. A guard written on .is() alone passes every same-realm test and is
// vacuous in production, so A1 asserts the cross-realm case explicitly and pins .is()'s failure.
//
// No jest-dom (L-182): toBe/toBeNull/toBeTruthy only, matching the sibling suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { ClerkOfflineError } from '@clerk/shared/error'
import {
  isOfflineTokenError,
  tokenForRequest,
  apiFetch,
  useApiFetch,
  OFFLINE_TOKEN_WAIT_MS,
  NO_CREDENTIAL_MESSAGE,
} from '../lib/api.js'

// Group E drives the real useApiFetch, so Clerk's hook is the only thing stubbed. Without this the
// hook body is never executed and nothing proves it WIRES tokenForRequest in — a regression to the
// old bare `await getToken()` would leave every other test in this file green.
let clerkGetToken
vi.mock('@clerk/react', () => ({ useAuth: () => ({ getToken: (...a) => clerkGetToken(...a) }) }))
import {
  loadServiceWorker,
  dispatchFetch,
  makeFakeCaches,
  readSwSource,
  apiRequest,
  LAMBDA_URL,
  offlineError,
} from './helpers/swHarness.js'

// ── The CDN realm ────────────────────────────────────────────────────────────────────────────────
// A faithful transcription of the error chain in @clerk/clerk-js@6.29.2 dist/clerk.browser.js:
// R (ClerkError, offset 2691) -> x (ClerkRuntimeError, same offset) -> W (ClerkOfflineError).
// Constructed locally rather than imported precisely BECAUSE it must be a different realm from the
// bundled @clerk/shared — importing Clerk's class would test the one case that already works.
const CdnClerkError = class e extends Error {
  static kind = 'ClerkError'
  clerkError = true
  constructor(t) { super(t.message); Object.setPrototypeOf(this, e.prototype); this.code = t.code }
}
const CdnClerkRuntimeError = class e extends CdnClerkError {
  static kind = 'ClerkRuntimeError'
  clerkRuntimeError = true
  constructor(msg, opts) { super({ ...opts, message: msg }); Object.setPrototypeOf(this, e.prototype) }
}
const CdnClerkOfflineError = class e extends CdnClerkRuntimeError {
  static kind = 'ClerkOfflineError'
  static ERROR_CODE = 'clerk_offline'
  constructor(msg) { super(msg, { code: e.ERROR_CODE }); Object.setPrototypeOf(this, e.prototype) }
}

// getToken's two real offline escapes, per clerk.browser.js Session.getToken @132530.
const cdnOffline = () =>
  new CdnClerkOfflineError('Network request failed while offline. The browser appears to be disconnected.')
// The INNER error, which escapes via `throw e` when navigator.onLine flipped back to true during
// the retry ladder — i.e. a connectivity flap, the normal condition in a dead zone.
const cdnFlap = () =>
  new CdnClerkRuntimeError('Browser is offline, skipping token fetch', { code: 'network_error' })

const setOnLine = (value) =>
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true })

describe('isOfflineTokenError — the guard', () => {
  it('A1: accepts a CROSS-REALM ClerkOfflineError, which Clerk\'s own .is() rejects', () => {
    const err = cdnOffline()
    // Pin the reason this test exists. If a future @clerk/shared fixes the guard this flips to
    // true and the assertion below should be relaxed — but until then, .is() alone is vacuous.
    expect(ClerkOfflineError.is(err)).toBe(false)
    expect(isOfflineTokenError(err)).toBe(true)
  })

  it('A2: accepts a same-realm ClerkOfflineError (the case .is() does handle)', () => {
    const err = new ClerkOfflineError('Network request failed while offline.')
    expect(ClerkOfflineError.is(err)).toBe(true)
    expect(isOfflineTokenError(err)).toBe(true)
  })

  it('A3: accepts code network_error — the connectivity FLAP escape', () => {
    expect(isOfflineTokenError(cdnFlap())).toBe(true)
  })

  it('A4: REJECTS a 4xx-bearing Clerk error — a real auth failure must surface', () => {
    const revoked = new CdnClerkRuntimeError('Session revoked', { code: 'network_error' })
    revoked.status = 401
    // Even wearing an offline-looking code, a 4xx is Clerk's API answering. It must not be
    // laundered into "no token", which would silently downgrade the request to anonymous.
    expect(isOfflineTokenError(revoked)).toBe(false)

    const notFound = cdnOffline()
    notFound.status = 403
    expect(isOfflineTokenError(notFound)).toBe(false)
  })

  it('A5: rejects non-Clerk errors and non-objects', () => {
    expect(isOfflineTokenError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isOfflineTokenError(new Error('boom'))).toBe(false)
    expect(isOfflineTokenError(null)).toBe(false)
    expect(isOfflineTokenError(undefined)).toBe(false)
    expect(isOfflineTokenError('clerk_offline')).toBe(false)
  })
})

describe('tokenForRequest — degrade to null, and only when offline', () => {
  afterEach(() => { setOnLine(true); vi.useRealTimers() })

  it('B1: offline + offline-throw resolves to null instead of throwing', async () => {
    setOnLine(false)
    const getToken = vi.fn(async () => { throw cdnOffline() })
    expect(await tokenForRequest(getToken)).toBeNull()
  })

  it('B2: ONLINE + a 401 from getToken PROPAGATES — never swallowed', async () => {
    setOnLine(true)
    const err = new CdnClerkRuntimeError('Unauthorized', { code: 'authentication_invalid' })
    err.status = 401
    const getToken = vi.fn(async () => { throw err })
    await expect(tokenForRequest(getToken)).rejects.toThrow('Unauthorized')
  })

  it('B3: ONLINE + a slow getToken is NOT raced — the wait is armed only when offline', async () => {
    setOnLine(true)
    vi.useFakeTimers()
    // 4s, well past OFFLINE_TOKEN_WAIT_MS. Online this is a legitimate token round trip on a slow
    // rural link; truncating it would break normal operation, which is why onLine gates the race.
    const getToken = vi.fn(() => new Promise((r) => setTimeout(() => r('tok_slow'), 4000)))
    const p = tokenForRequest(getToken)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await p).toBe('tok_slow')
  })

  it('B4: offline + a warm cache HIT is not truncated — the ≤60s window survives', async () => {
    setOnLine(false)
    // Clerk's retry() runs attempt 1 with no preceding delay, so a cache hit resolves on a
    // microtask. If OFFLINE_TOKEN_WAIT_MS ever dropped below that, this is what would break.
    const getToken = vi.fn(async () => 'tok_cached')
    expect(await tokenForRequest(getToken)).toBe('tok_cached')
  })

  it('B5: offline + a getToken that NEVER settles resolves null at the wait', async () => {
    setOnLine(false)
    vi.useFakeTimers()
    // This is the offline cold-start shape: clerkLoaded() never settles because Clerk's status goes
    // to `error` and its promise has no reject branch. The wait is what stops an API call hanging
    // forever — it does NOT fix the app-level cold-start spinner, which lives in AuthContext.
    const getToken = vi.fn(() => new Promise(() => {}))
    const p = tokenForRequest(getToken)
    await vi.advanceTimersByTimeAsync(OFFLINE_TOKEN_WAIT_MS)
    expect(await p).toBeNull()
  })

  it('B6: offline resolves at the wait, NOT at the end of Clerk\'s ~14.9s ladder', async () => {
    setOnLine(false)
    vi.useFakeTimers()
    const getToken = vi.fn(() => new Promise((_, reject) =>
      setTimeout(() => reject(cdnOffline()), 14858)))
    const p = tokenForRequest(getToken)
    let settled = false
    p.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(OFFLINE_TOKEN_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await p).toBeNull()
    // Let the abandoned ladder reject. Promise.race already attached a reaction, so this must not
    // surface as an unhandled rejection.
    await vi.advanceTimersByTimeAsync(20000)
  })

  it('B7: a non-Clerk failure still propagates offline', async () => {
    setOnLine(false)
    const getToken = vi.fn(async () => { throw new TypeError('something else entirely') })
    await expect(tokenForRequest(getToken)).rejects.toThrow('something else entirely')
  })
})

// C describes the PRIMITIVE apiFetch(path, options, token), not the hook's policy. Retained because
// group D drives exactly this shape through the real service worker, so its behaviour has to be
// pinned somewhere. The hook no longer composes it this way — see E1.
describe('apiFetch — the primitive still omits the header when handed a null token', () => {
  afterEach(() => { setOnLine(true); vi.restoreAllMocks() })

  it('C1: a null token yields a real fetch with NO Authorization header', async () => {
    setOnLine(false)
    const fetchSpy = vi.fn(async () => new Response('[]', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    // The exact composition useApiFetch performs.
    const getToken = vi.fn(async () => { throw cdnOffline() })
    const token = await tokenForRequest(getToken)
    const body = await apiFetch('/api/plants', {}, token)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const sent = fetchSpy.mock.calls[0][1]
    expect('Authorization' in sent.headers).toBe(false)
    expect(Array.isArray(body)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('C2: an ONLINE 401 RESPONSE still throws — the catch does not swallow real auth failures', async () => {
    setOnLine(true)
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const token = await tokenForRequest(vi.fn(async () => 'tok_live'))
    expect(token).toBe('tok_live')
    await expect(apiFetch('/api/plants', {}, token)).rejects.toMatchObject({ status: 401 })
    vi.unstubAllGlobals()
  })
})

describe('useApiFetch wires the offline policy in (not just the helpers)', () => {
  afterEach(() => { setOnLine(true); vi.unstubAllGlobals() })

  it('E1: BUG-TOKENLESS-401-001 — the HOOK issues NO request when it has no token', async () => {
    // INVERTED 2026-08-26. This test previously asserted the opposite (a headerless request WAS
    // issued) on the premise that the SW would answer it from cache. D1 below proves it cannot: a
    // headerless request gets 503 offline and a hard 401 online. The anonymous request had no
    // success case, so the hook must not make it.
    setOnLine(false)
    clerkGetToken = vi.fn(async () => { throw cdnOffline() })
    const fetchSpy = vi.fn(async () => new Response('[]', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    await expect(result.current.fetch('/api/plants')).rejects.toMatchObject({ offline: true })
    // The whole point: no invocation is burned, and the user is told they are offline rather than
    // being shown the word "Unauthorized".
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })

  it('E2: the getToken the hook RETURNS is the offline-safe wrapper, not Clerk\'s raw one', async () => {
    setOnLine(false)
    clerkGetToken = vi.fn(async () => { throw cdnOffline() })
    const { result } = renderHook(() => useApiFetch())
    // Telemetry callers (notificationPrefsClient et al) do `if (!token) return null`, so null lets
    // them bail immediately; the raw hook would make them hold a promise for the whole ladder.
    expect(await result.current.getToken()).toBeNull()
  })

  it('E3: the hook still surfaces a real ONLINE auth failure from getToken', async () => {
    setOnLine(true)
    const err = new CdnClerkRuntimeError('Unauthorized', { code: 'authentication_invalid' })
    err.status = 401
    clerkGetToken = vi.fn(async () => { throw err })
    const { result } = renderHook(() => useApiFetch())
    await expect(result.current.fetch('/api/plants')).rejects.toThrow('Unauthorized')
  })
})

// ── F: BUG-TOKENLESS-401-001 — recovery from a null/stale token ──────────────────────────────────
// The defect these pin: getToken() returning null, or returning a token the Lambda rejects, used to
// produce a user-visible "Unauthorized" that persisted until the app was force-reloaded. MEASURED in
// prod on 2026-08-26 (48 `Invalid JWT form` 401s across 7 Lambdas in one morning). Recovery is a
// forced mint (skipCache bypasses Clerk's in-memory cache and re-establishes the session), which is
// exactly what the manual app restart was achieving by hand.
describe('recovery — a null or stale token heals without an app restart', () => {
  afterEach(() => { setOnLine(true); vi.unstubAllGlobals() })

  const okJson = (body = '[]') => new Response(body, {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  const unauthorized = () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  })

  it('F1: ONLINE + getToken resolves null -> forced mint supplies the token', async () => {
    setOnLine(true)
    // The sticky shape: an intact, signed-in-looking client whose cached token is gone. The bare
    // call keeps answering null; only skipCache goes to the network.
    clerkGetToken = vi.fn(async (opts) => (opts?.skipCache ? 'tok_minted' : null))
    const fetchSpy = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    await result.current.fetch('/api/plants')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer tok_minted')
  })

  it('F2: ONLINE + both attempts null -> a typed authPending error and NO request', async () => {
    setOnLine(true)
    clerkGetToken = vi.fn(async () => null)
    const fetchSpy = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    const err = await result.current.fetch('/api/plants').catch((e) => e)

    expect(err.authPending).toBe(true)
    // NOT the string "Unauthorized" — that copy reads as an account problem and is what sent Dave
    // looking for a sign-in bug that did not exist.
    expect(err.message).toBe(NO_CREDENTIAL_MESSAGE)
    expect(fetchSpy).toHaveBeenCalledTimes(0)
    expect(clerkGetToken).toHaveBeenCalledTimes(2)
  })

  it('F3: a 401 RESPONSE is retried once with a freshly minted token', async () => {
    setOnLine(true)
    clerkGetToken = vi.fn(async (opts) => (opts?.skipCache ? 'tok_fresh' : 'tok_stale'))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(okJson('[{"id":1}]'))
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    const body = await result.current.fetch('/api/harvests')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer tok_stale')
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer tok_fresh')
    expect(body.length).toBe(1)
  })

  it('F4: a POST is replayed too — the Lambda 401s before it writes, so this cannot double-write', async () => {
    // Not a theoretical claim: verifyToken runs ahead of every sql call in lambda/harvests and
    // lambda/photos (the two surfaces this was reported on), so the rejected request had no effect.
    setOnLine(true)
    clerkGetToken = vi.fn(async (opts) => (opts?.skipCache ? 'tok_fresh' : 'tok_stale'))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(okJson('{"id":"p1"}'))
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    const body = await result.current.fetch('/api/photos/abc', {
      method: 'PUT', body: JSON.stringify({ plant_id: 'x' }),
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // The replay carries the SAME body, not a dropped or re-serialised one.
    expect(fetchSpy.mock.calls[1][1].body).toBe(JSON.stringify({ plant_id: 'x' }))
    expect(fetchSpy.mock.calls[1][1].method).toBe('PUT')
    expect(body.id).toBe('p1')
  })

  it('F5: the retry is bounded — a second 401 surfaces, it does not loop', async () => {
    setOnLine(true)
    clerkGetToken = vi.fn(async (opts) => (opts?.skipCache ? 'tok_fresh' : 'tok_stale'))
    const fetchSpy = vi.fn(async () => unauthorized())
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    await expect(result.current.fetch('/api/harvests')).rejects.toMatchObject({ status: 401 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('F6: no retry when the mint returns the SAME token — a wasted round trip is not a recovery', async () => {
    setOnLine(true)
    clerkGetToken = vi.fn(async () => 'tok_same')
    const fetchSpy = vi.fn(async () => unauthorized())
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    await expect(result.current.fetch('/api/harvests')).rejects.toMatchObject({ status: 401 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('F7: a non-401 failure is NOT retried', async () => {
    setOnLine(true)
    clerkGetToken = vi.fn(async () => 'tok_live')
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: 'Boom' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    await expect(result.current.fetch('/api/harvests')).rejects.toMatchObject({ status: 500 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('F8: OFFLINE does not spend a second wait on a mint that cannot succeed', async () => {
    setOnLine(false)
    vi.useFakeTimers()
    clerkGetToken = vi.fn(() => new Promise(() => {}))
    const fetchSpy = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useApiFetch())
    const p = result.current.fetch('/api/plants').catch((e) => e)
    // ONE OFFLINE_TOKEN_WAIT_MS, not two. A forced mint needs the network, so arming it offline
    // would double the stall to reach the identical null.
    await vi.advanceTimersByTimeAsync(OFFLINE_TOKEN_WAIT_MS)
    const err = await p

    expect(err.offline).toBe(true)
    expect(clerkGetToken).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(0)
    vi.useRealTimers()
  })
})

// ── D: compose-safety against the REAL public/sw.js ──────────────────────────────────────────────
// The claim under test is the one that makes group C acceptable: the tokenless request C1 issues
// must NOT be answerable out of another subject's cache partition. This drives the real SW source
// through the vm harness rather than restating its logic.
describe('compose-safety — a tokenless request cannot read another subject\'s partition', () => {
  // Derived from the source, not hardcoded: deploy.yml rewrites CACHE_VERSION at build time.
  const CACHE_VERSION = readSwSource().match(/const CACHE_VERSION = '([^']+)'/)[1]
  const SUB_A = 'user_2daveAAAAAAAAAAAAAAAAAAAA'
  const DAVES_BODY = JSON.stringify([{ id: 'p1', name: "Dave's tomato" }])
  const partition = (sub) => `api-${CACHE_VERSION}-u-${sub}`

  const davesResponse = () => new Response(DAVES_BODY, {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

  // TWO buckets are seeded, and the second is what makes D1 non-vacuous. Seeding only the per-sub
  // partition would let a regression to a single shared `api-${version}` cache — the actual
  // pre-Slice-1 defect — still return 503, because the mutated SW would look in a bucket the test
  // never filled. Seeding the bare legacy name too means a shared-cache regression finds Dave's
  // body and D1 fails, which is the whole point. The real SW never reads it (null cacheName).
  const seededCaches = () => makeFakeCaches({
    [partition(SUB_A)]: { [LAMBDA_URL('/api/plants')]: davesResponse() },
    [`api-${CACHE_VERSION}`]: { [LAMBDA_URL('/api/plants')]: davesResponse() },
  })

  beforeEach(() => { setOnLine(false) })
  afterEach(() => { setOnLine(true) })

  it('D1: the headerless request gets 503 and never Dave\'s body', async () => {
    const caches = seededCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => { throw offlineError() }) })

    // apiRequest(null) is byte-for-byte what apiFetch builds from a null token: no header at all.
    const { responded } = dispatchFetch(sw, apiRequest(null))
    const res = await responded

    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Offline')
    // The partition still holds the body — it was not consumed, it was unreachable.
    expect(caches.store.has(partition(SUB_A))).toBe(true)
  })

  it('D2: POSITIVE CONTROL — the same URL WITH sub A\'s token IS served from A\'s partition', async () => {
    // Without this the 503 above proves nothing: a harness that can never serve a cache hit would
    // return 503 for every input. This is what makes D1 a real assertion.
    const caches = seededCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => { throw offlineError() }) })

    const { responded } = dispatchFetch(sw, apiRequest(SUB_A))
    const res = await responded

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(DAVES_BODY)
  })

  it('D3: the tokenless request writes NOTHING, so it cannot seed a shared partition', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({
      caches,
      fetchImpl: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    })

    const { responded, waits } = dispatchFetch(sw, apiRequest(null))
    await responded
    await Promise.all(waits)

    // No cache was opened for the write, so no `api-*` bucket exists for a later signed-in read to
    // collide with. A fail-OPEN 'anon' partition would show up here as a created key.
    expect([...caches.store.keys()].filter((k) => k.startsWith('api-')).length).toBe(0)
  })
})
