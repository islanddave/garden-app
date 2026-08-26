// V4-LAZYRETRY-001 — a failed /collection chunk fetch must stay INSIDE the route and be RECOVERABLE.
//
// THE BUG THIS PINS. React.lazy caches a REJECTED payload PERMANENTLY. From the installed React
// 18.3.1 source (node_modules/react/cjs/react.development.js:1354-1409, `lazyInitializer`): the
// ctor — the `() => import(…)` — is called only inside `if (payload._status === Uninitialized)`.
// A failed load sets `_status = Rejected` (:1374) and stores the error, and every later render
// falls straight past that guard to `throw payload._result` (:1407). No new request is ever made.
// The payload lives on the MODULE-SCOPE lazy object, so it outlives any remount: re-keying or
// re-mounting the component reuses the same poisoned payload and cannot get a fresh import either.
//
// That gave /collection — the app's only split route — two compounding failures. It had no
// ErrorBoundary of its own, so the throw reached the APP-level boundary and replaced the entire PWA,
// shell and bottom nav included; and that boundary's "Try again", which only clears `hasError` and
// re-renders the same lazy object, was inert by construction. Dave is Android-only and gardens
// outdoors: one dead spot mid-tap, or a STATIC_CACHE purged by a deploy, is the expected case, and
// because the service worker serves the bundle cache-first a reload does not get you out of it.
//
// The fix is two-part and this file gates both halves separately, because they fail independently:
//   (a) App.jsx loads the page through src/lib/collectionChunk.js — the sanctioned pattern from
//       critterFactsLoader.js, an import() whose failure branch is a VALUE. A retry is a fresh
//       import() call, which is the only thing that can defeat the cached rejection.
//   (b) the route carries its own <ErrorBoundary scope="route">, like every sibling route.
//
// The first test is a CHARACTERISATION test of React itself, not a gate: it passes before and after
// the fix, and is the evidence for the paragraph above. It goes red only if a React upgrade changes
// the caching semantics — at which point this file's rationale needs re-reading, not deleting.
//
// MOCK MECHANICS. vitest re-runs a vi.mock factory that THREW on a later import() of the same
// specifier, and caches it once it succeeds (verified in this worktree, 2026-08-26). So a throwing
// factory models a chunk fetch that fails and can be retried — which is also what a browser does now
// that module-map fetch errors are no longer memoised. `probe.imports` is therefore a faithful
// stand-in for "a request for the chunk went out", and is what the recovery test asserts on. Because
// a SUCCESSFUL import is cached for the rest of the file, the tests below are ordered so only the
// last one lets the chunk resolve.
//
// MUTATION-PROVEN 2026-08-26 — App.jsx reverted to `React.lazy(() => import('./pages/Collection.jsx'))`
// under <React.Suspense> with no route boundary, collectionChunk.js left in place: both gates RED
// (route-scoping: the app-level fallback tripped and the shell was gone; recovery: import count
// stuck at 1), characterisation test still green. Re-verify the same way if you touch this file.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes } from 'react-router-dom'
import ErrorBoundary from '../components/ErrorBoundary.jsx'

// vi.hoisted: the vi.mock below is hoisted above these imports, so the state it mutates has to be
// hoisted too. The FACTORY still runs lazily, once per import() attempt.
const probe = vi.hoisted(() => ({ imports: 0, failCount: 0 }))

vi.mock('../pages/Collection.jsx', () => {
  probe.imports += 1
  if (probe.imports <= probe.failCount) throw new Error('Failed to fetch dynamically imported module')
  return { default: () => <div data-testid="collection-chunk-reached">critters</div> }
})

// Provider-free, matching App.collectionSplit.test.jsx: Protected only needs useAuth, and the real
// AuthProvider would drag Clerk into a test about module loading.
vi.mock('../context/AuthContext.jsx', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'u1' }, loading: false }),
  useAuthOptional: () => ({ user: { id: 'u1' }, loading: false }),
}))

import { renderRoutes } from '../App.jsx'
import { __resetCollectionChunkCache } from '../lib/collectionChunk.js'

const collectionRoute = () =>
  renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === '/collection')

// Mirrors AppRoutes' real structure — <ErrorBoundary scope="app"> wrapping the router — so a throw
// that escapes the route lands where it lands in production. The shell marker sits INSIDE that
// boundary, exactly like the real AppShell does, so "did the app-level boundary trip" is readable
// from the DOM: if it did, the shell is gone.
function renderCollectionInApp() {
  return render(
    <ErrorBoundary scope="app" fallback={() => <div role="alert" data-testid="app-fallback-tripped">app-level failure</div>}>
      <MemoryRouter initialEntries={['/collection']}>
        <div data-testid="app-shell">
          <Routes>{collectionRoute()}</Routes>
        </div>
      </MemoryRouter>
    </ErrorBoundary>,
  )
}

beforeEach(() => {
  probe.imports = 0
  probe.failCount = 0
  __resetCollectionChunkCache()
})

describe('V4-LAZYRETRY-001 — a failed /collection chunk fetch is scoped and recoverable', () => {
  it('React.lazy never retries a rejected payload — the mechanism, proven against installed React', async () => {
    // No app modules here on purpose: this is React's own semantics, isolated. `load` stands in for
    // the dynamic import; it counts calls and always fails.
    const load = vi.fn(() => Promise.reject(new Error('chunk gone')))
    const Lazy = React.lazy(load)

    render(
      <ErrorBoundary scope="test" fallback={(error, retry) => <button onClick={retry}>Try again</button>}>
        <React.Suspense fallback={<div>loading</div>}>
          <Lazy />
        </React.Suspense>
      </ErrorBoundary>,
    )

    await screen.findByRole('button', { name: /try again/i })
    expect(load).toHaveBeenCalledTimes(1)

    // The retry clears `hasError` and re-renders the SAME lazy object. lazyInitializer skips the
    // ctor (status is Rejected, not Uninitialized) and re-throws the stored error. The count never
    // moves, however many times the user taps.
    for (let tap = 0; tap < 3; tap += 1) {
      fireEvent.click(await screen.findByRole('button', { name: /try again/i }))
      await screen.findByRole('button', { name: /try again/i })
      expect(load).toHaveBeenCalledTimes(1)
    }
  })

  it('a dead chunk degrades to a ROUTE-scoped failure — the app shell survives', async () => {
    probe.failCount = 99 // never succeeds: this test is about where the failure lands, not recovery
    renderCollectionInApp()

    // RouteFallback's copy, which is distinct from AppFallback's "Something went wrong loading this
    // page." — so this asserts WHICH surface handled it, not merely that something did.
    expect(await screen.findByText('This page failed to load.')).toBeDefined()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeDefined()

    // The two halves of "scoped": the app-level boundary never tripped, and the shell is still
    // mounted around the failed route. Pre-fix the throw took both.
    expect(screen.queryByTestId('app-fallback-tripped')).toBeNull()
    expect(screen.getByTestId('app-shell')).toBeDefined()
    expect(probe.imports).toBe(1)
  })

  it('the retry issues a genuinely NEW import and the route recovers', async () => {
    probe.failCount = 1 // transient: the first fetch fails, a later one succeeds
    renderCollectionInApp()

    const btn = await screen.findByRole('button', { name: /try again/i })
    expect(probe.imports).toBe(1)
    expect(screen.queryByTestId('collection-chunk-reached')).toBeNull()

    fireEvent.click(btn)

    // THE GATE. A retry has to reach the network again — asserted on the import count, not on the
    // UI, because a UI that merely re-renders is exactly the pre-fix behaviour. Pre-fix this stays
    // at 1 forever, since the rejected payload short-circuits before the ctor.
    await waitFor(() => expect(probe.imports).toBe(2))

    // And the RECOVERY has to complete: the second attempt resolved and the route renders the page.
    expect(await screen.findByTestId('collection-chunk-reached')).toBeDefined()
    expect(screen.queryByText('This page failed to load.')).toBeNull()
    expect(screen.queryByTestId('app-fallback-tripped')).toBeNull()
  })
})
