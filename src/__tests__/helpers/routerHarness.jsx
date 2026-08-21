// src/__tests__/helpers/routerHarness.jsx — the REAL router for page tests (OPS-GARDENROUTERMOCK-001).
//
// WHY THIS EXISTS — one measured number. Drop the pre-fix `src/pages/Garden.jsx` (32e9473^) into the
// tree and run `Garden.editor.test.jsx` as it stood at v4.43.0: **27 of 27 tests pass** against a
// deep link that was 100% dead in production for four days and nine releases
// (BUG-EDITDEEPLINKRACE-001). `Garden.editDeepLink.test.jsx`, which uses MemoryRouter and no router
// mock, fails 5 of 7 on that same source. The only difference between the two files is the router.
//
// THE MECHANISM, precisely. Sixty-six test files hand `useSearchParams` a hand-built tuple:
//
//     const searchParamsRef = { current: new URLSearchParams() }
//     useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy]   // ← non-reactive
//
// `setSearchParams` mutates a plain object and re-renders NOTHING. Under the real router it changes
// `location.search`; `useSearchParams` memoises on exactly that (`useMemo(..., [location.search])`)
// and returns a `setSearchParams` that is a `useCallback` keyed on the result, so a param strip
// changes BOTH deps of any effect that lists them, and React runs that effect's CLEANUP on the same
// synchronous flush. Garden's ?edit= effect stripped the param and then awaited a by-id GET behind an
// effect-local `let on = true`; the cleanup set it false before the response landed, every time.
// A frozen ref cannot express any of that — no re-render, so no cleanup, so no cancel, so green.
//
// Three separate blind spots follow from the same root, and only the first was the shipped bug:
//   (a) an effect CLEANUP triggered by a param write never runs;
//   (b) a component never observes a URL change made by anything other than its own initial render;
//   (c) `useSearchParams: () => [new URLSearchParams(), vi.fn()]` (3 files) is the inverse defect —
//       a fresh object identity every render, so an effect keyed on it re-runs on EVERY render.
//       LogMany.jsx:223 (`}, [fetch, params]`) is live under exactly that mock.
//
// WHY A REAL ROUTER AND NOT A BETTER MOCK. The brief for this lane asked for a *reactive* mock. A
// reactive mock is a second implementation of react-router's memo/callback keying that has to be
// kept correct against react-router 7.18 by hand — and getting that keying subtly wrong is the
// entire bug above. MemoryRouter is the same code the app ships, costs one wrapper element, and was
// already measured (above) to catch the regression the mock hid. So this helper does not simulate the
// router; it mounts it.
//
// USAGE — replaces both the `vi.mock('react-router-dom', …)` block and the bare `render()`:
//
//     import { renderWithRouter, currentParams, navigateTo, resetRouterHarness } from './helpers/routerHarness.jsx'
//     beforeEach(resetRouterHarness)
//     const view = await renderWithRouter(<Garden />, { route: '/garden?edit=plant-2' })
//     expect(currentParams().get('edit')).toBeNull()      // ← what setSearchParamsSpy used to "prove"
//
// A page that reads `useParams` mounts under its route pattern instead of needing a hook mock:
//
//     await renderWithRouter(<PlantingDetail />, { route: '/plantings/p1', path: '/plantings/:id' })
import React from 'react'
import { act, render } from '@testing-library/react'
import {
  MemoryRouter, Routes, Route, parsePath,
  useLocation, useNavigate, useNavigationType, useParams,
} from 'react-router-dom'

// Written during the probe's RENDER, not from an effect, so `currentSearch()` inside a `waitFor`
// poll observes the location of the render being asserted rather than lagging it by an effect tick.
const live = { location: null, navigate: null, navigationType: null, params: null }

function LocationProbe() {
  live.location = useLocation()
  live.navigate = useNavigate()
  live.navigationType = useNavigationType()
  live.params = useParams()
  return null
}

/** Clear the captured location between tests. Call from `beforeEach` — a stale `currentSearch()`
 *  leaking across tests reads as a pass. */
export function resetRouterHarness() {
  live.location = null
  live.navigate = null
  live.navigationType = null
  live.params = null
}

/**
 * Render `ui` inside a real MemoryRouter at `route`.
 * @param {React.ReactElement} ui
 * @param {{route?: string, path?: string, state?: any}} [opts] `path` mounts `ui` under a route
 *   PATTERN so the component's own `useParams` resolves; omit it to mount `ui` directly. `state` is
 *   the history entry's location state (what an overlay's `background` rides on).
 * @returns {Promise<import('@testing-library/react').RenderResult>} the RTL result (`unmount`,
 *   `rerender`, … all intact).
 */
export async function renderWithRouter(ui, { route = '/', path, state } = {}) {
  const entry = state === undefined ? route : { ...parsePath(route), state }
  let result
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={[entry]}>
        {path ? <Routes><Route path={path} element={ui} /></Routes> : ui}
        <LocationProbe />
      </MemoryRouter>,
    )
  })
  return result
}

/** The live `location` object. Null before the first `renderWithRouter`. */
export function currentLocation() {
  return live.location
}

/** The live query string, leading `?` included — `''` when there is none. */
export function currentSearch() {
  return live.location?.search ?? ''
}

/** The live query as a `URLSearchParams`. This is the honest replacement for asserting on a
 *  `setSearchParams` spy: it reads what the URL actually became, not that a function was called. */
export function currentParams() {
  return new URLSearchParams(currentSearch())
}

/**
 * How the router got to the current entry: `'POP'` | `'PUSH'` | `'REPLACE'`.
 *
 * This is the honest observable for "the page REPLACED rather than pushed". The tempting
 * alternative — go Back and assert the old query is gone — is VACUOUS on a self-healing page and
 * was measured so: flipping Garden's `?add=1` strip to `{ replace: false }` left that test green,
 * because popping back to `?add=1` re-runs the very effect that strips it, so the observable is
 * destroyed by the correct behaviour of the page under test. This reads the router's own record of
 * the operation, which the caller's argument object cannot fake.
 */
export function currentNavigationType() {
  return live.navigationType
}

/** The live path params (populated only when `renderWithRouter` was given a `path`). */
export function currentRouteParams() {
  return live.params ?? {}
}

/** Navigate the mounted router, act-wrapped. Use this to assert a component reacts to a URL change
 *  it did not initiate — the case (b) blind spot above. */
export async function navigateTo(to, opts) {
  if (!live.navigate) throw new Error('navigateTo: nothing rendered — call renderWithRouter first')
  const go = live.navigate
  await act(async () => { go(to, opts) })
}
