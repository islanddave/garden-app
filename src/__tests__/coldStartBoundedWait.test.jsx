// V4-COLDSTART-001 — the bounded wait on Clerk load, and the third identity state it produces.
//
// THE DEFECT. Launch the installed PWA offline after a force-stop: clerk-js hot-loads from Clerk's
// CDN, that load fails, IsomorphicClerk emits status 'error' and returns WITHOUT calling emitLoaded,
// so useUser() keeps reporting isLoaded:false forever. `loading = !isLoaded` never goes false and
// the render gate paints a boot skeleton indefinitely — no error, no recovery. Dave gardens in rural
// dead zones on Chrome Android; this is a routine condition, not an edge case.
//
// What this file proves, in the order it can fail:
//   A. a Clerk that never settles DOES reach `unknown` — and not before the bound
//   B. a Clerk that resolves normally is NOT truncated by the bound, at any point inside it
//   C. `unknown` is a strict SUBSET of `loading` (the fail-safe that stops it leaking by omission)
//   D. `unknown` is never `signed-out`, in either direction
//
// The LEAK half of this change — what the unknown state is allowed to render — is not here. It is in
// authRenderGate.test.jsx §6, against the real App tree, because that is where the five properties
// this state touches already live.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The seam: @clerk/react, driven directly. Mocked at the LIBRARY rather than at AuthContext because
// AuthContext's translation of Clerk into app terms is the entire subject — faking the app context
// would test the fixture.
const clerk = vi.hoisted(() => ({ user: undefined, isSignedIn: undefined, isLoaded: false, status: 'loading' }))
vi.mock('@clerk/react', () => ({
  useUser: () => ({ user: clerk.user, isSignedIn: clerk.isSignedIn, isLoaded: clerk.isLoaded }),
  useClerk: () => ({ status: clerk.status, client: { signIn: {} }, signOut: () => Promise.resolve() }),
}))
vi.mock('../lib/dataCache.js', () => ({ invalidateAll: vi.fn() }))
vi.mock('../hooks/useCacheLifecycle.js', () => ({ useCacheLifecycle: () => {} }))

const { AuthProvider, useAuth, CLERK_LOAD_TIMEOUT_MS } = await import('../context/AuthContext.jsx')

const DAVE = { id: 'user_dave', fullName: 'Dave Nichols', emailAddresses: [] }

// Every value the provider has published, in order. The HISTORY is what several assertions below
// need: "ended up signed-in" is a weaker claim than "was never unknown on the way there".
let seen = []
const last = () => seen[seen.length - 1]
const identities = () => seen.map((s) => s.identity)

function Probe() { seen.push(useAuth()); return null }

function unresolved() { Object.assign(clerk, { user: undefined, isSignedIn: undefined, isLoaded: false, status: 'loading' }) }
function signedIn()  { Object.assign(clerk, { user: DAVE, isSignedIn: true,  isLoaded: true, status: 'ready' }) }
function signedOut() { Object.assign(clerk, { user: null, isSignedIn: false, isLoaded: true, status: 'ready' }) }

function mount() {
  const utils = render(<AuthProvider><Probe /></AuthProvider>)
  // Re-render on demand: the mock reads `clerk` at call time, so flipping it + rerender is exactly
  // what Clerk's own status listener does to a real tree.
  return { ...utils, flush: () => act(() => { utils.rerender(<AuthProvider><Probe /></AuthProvider>) }) }
}

beforeEach(() => { seen = []; unresolved(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ── A. The wait is bounded, and it is a WAIT ─────────────────────────────────────────────────────
describe('V4-COLDSTART-001 A — a Clerk that never settles reaches `unknown`, at the bound', () => {
  it('is `pending` on the first commit — the give-up is not immediate', () => {
    mount()
    expect(last().identity).toBe('pending')
    expect(last().loading).toBe(true)
  })

  it('is STILL `pending` one millisecond before the bound', () => {
    mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS - 1) })
    // The half that stops "unknown" from being the answer to every slow boot: a 3.4s cold start
    // (the measured healthy figure) must sit inside this window untouched.
    expect(last().identity).toBe('pending')
  })

  it('flips to `unknown` once the bound elapses — the hang is over', () => {
    mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS + 1) })
    expect(last().identity).toBe('unknown')
  })

  it('reaches `unknown` IMMEDIATELY on Clerk status `error`, with no timer at all', () => {
    // The real offline path, and the fast one: a failed hot-load emits 'error' in about a second.
    // The timer above is only the backstop for a connection that never settles and never throws.
    clerk.status = 'error'
    mount()
    expect(last().identity).toBe('unknown')
    expect(vi.getTimerCount()).toBeGreaterThan(0)   // the backstop is still armed, just not needed
  })

  it('does NOT treat a healthy boot status as failure — only `error` counts', () => {
    // Guards the predicate against widening to `status !== 'ready'`, which would fire on every cold
    // start: 'loading' IS the healthy state while clerk-js downloads.
    for (const status of ['loading', 'ready', 'degraded', undefined]) {
      seen = []
      clerk.status = status
      mount()
      expect(last().identity, `status ${String(status)} must not read as failure`).toBe('pending')
    }
  })
})

// ── B. A normal resolve is not truncated ─────────────────────────────────────────────────────────
describe('V4-COLDSTART-001 B — a Clerk that resolves normally is never truncated by the bound', () => {
  it('an already-resolved Clerk stays `signed-in` past ten times the bound', () => {
    signedIn()
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS * 10) })
    flush()
    expect(identities().includes('unknown')).toBe(false)
    expect(last().identity).toBe('signed-in')
    expect(last().loading).toBe(false)
  })

  it('a SLOW resolve, landing one millisecond inside the bound, never passes through `unknown`', () => {
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS - 1) })
    signedIn()
    flush()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS * 2) })
    flush()
    // Both halves matter: the timer must be CLEARED when isLoaded flips, and `unknown` must never
    // have been published even for one render — a one-frame flash of the offline notice on a slow
    // rural link would be a visible regression on the working path.
    expect(identities().includes('unknown')).toBe(false)
    expect(last().identity).toBe('signed-in')
  })

  it('a LATE resolve CLEARS `unknown` — the state is not sticky, so the notice self-heals', () => {
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS + 1) })
    expect(last().identity).toBe('unknown')
    signedIn()
    flush()
    expect(last().identity).toBe('signed-in')
    expect(last().loading).toBe(false)
  })

  it('the app-level bound is never SHORTER than the one Clerk applies to itself', () => {
    // Sourced, not tuned: @clerk/shared races its ready-promise against TIMEOUT_MS and rejects with
    // clerk_runtime_load_timeout. Giving up before the library does would mean showing the offline
    // notice while Clerk was still legitimately trying. If Clerk raises theirs, this fails and we look.
    const src = readFileSync(resolve(process.cwd(), 'node_modules/@clerk/shared/dist/getToken.mjs'), 'utf8')
    const m = src.match(/const TIMEOUT_MS = ([0-9.e+]+);/)
    expect(m, 'Clerk no longer declares TIMEOUT_MS in getToken.mjs — re-derive the bound by hand').toBeTruthy()
    expect(Number(m[1])).toBeGreaterThan(0)
    expect(CLERK_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(Number(m[1]))
  })
})

// ── C. `unknown` is a subset of `loading` ────────────────────────────────────────────────────────
describe('V4-COLDSTART-001 C — `unknown` is a strict SUBSET of `loading`', () => {
  it('publishes loading:true and user:null in the unknown state', () => {
    // THE FAIL-SAFE. Every consumer that only knows the boolean — <Protected>, getRouteClass,
    // TopChrome, AppShell's padding — keeps withholding exactly as it does today. If `loading` went
    // false here, <Protected> would send an UNRESOLVED identity down the signed-OUT branch and
    // redirect to /login: useless offline, and it reads as "you got signed out", which is false.
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS + 1) })
    flush()
    expect(last().identity).toBe('unknown')
    expect(last().loading).toBe(true)
    expect(last().user).toBe(null)
    expect(last().profile).toBe(null)
  })

  it('holds across EVERY published value, not just the last one', () => {
    clerk.status = 'error'
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS * 3) })
    flush()
    expect(seen.length).toBeGreaterThan(1)
    for (const s of seen) {
      if (s.identity === 'unknown') { expect(s.loading).toBe(true); expect(s.user).toBe(null) }
      if (s.loading === false) expect(s.identity).not.toBe('unknown')
    }
  })
})

// ── D. `unknown` and `signed-out` are different things ───────────────────────────────────────────
describe('V4-COLDSTART-001 D — an unresolved identity is never a signed-OUT one', () => {
  it('a genuinely signed-out Clerk is `signed-out`, however long we wait', () => {
    signedOut()
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS * 5) })
    flush()
    expect(identities().includes('unknown')).toBe(false)
    expect(last().identity).toBe('signed-out')
  })

  it('a signed-out Clerk reporting status `error` is still `signed-out`, not `unknown`', () => {
    // Ordering guard: the resolved branch must be decided BEFORE the failure arms are consulted, or
    // a transient error status would erase a perfectly good signed-out answer.
    signedOut()
    clerk.status = 'error'
    mount()
    expect(last().identity).toBe('signed-out')
  })

  it('a signed-IN Clerk reporting status `error` is still `signed-in`', () => {
    // The degraded/flapping case: clerk-js loaded, emitted resources, and only then failed. The
    // identity is already known, so the failure arms must not reach back and erase it.
    signedIn()
    clerk.status = 'error'
    mount()
    expect(last().identity).toBe('signed-in')
  })

  it('the unknown state resolves to the `pending` header class, never to `unauth`', async () => {
    // routeClass is the other consumer that could conflate the two. It reads `loading`, which stays
    // true — so this is a consequence of the subset invariant rather than a second mechanism, and
    // this test is what would catch it if that ever stopped being true.
    const { getRouteClass } = await import('../lib/routeClass.js')
    const { flush } = mount()
    act(() => { vi.advanceTimersByTime(CLERK_LOAD_TIMEOUT_MS + 1) })
    flush()
    const s = last()
    expect(s.identity).toBe('unknown')
    expect(getRouteClass('/today', s)).toBe('pending')
    expect(getRouteClass('/today', s)).not.toBe('unauth')
  })
})

// ── E. The retry mechanism itself ────────────────────────────────────────────────────────────────
// The button's wiring is asserted against the real App tree in authRenderGate §6 (where the module
// is mocked to observe the call). Here the module is REAL, so this is the other half: that the thing
// being called actually reloads.
describe('V4-COLDSTART-001 E — reloadApp', () => {
  it('reloads the document', async () => {
    const { reloadApp } = await import('../lib/bootReload.js')
    const reload = vi.fn()
    reloadApp({ location: { reload } })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('swallows a throwing location and a missing window rather than breaking the notice', async () => {
    // The notice is the LAST screen standing on a failed boot; a throw here takes the app's only
    // remaining recovery affordance with it. Same try/catch idiom as registerSW/useAppUpdate.
    const { reloadApp } = await import('../lib/bootReload.js')
    expect(() => reloadApp({ get location() { throw new Error('cross-origin') } })).not.toThrow()
    expect(() => reloadApp(null)).not.toThrow()
  })
})
