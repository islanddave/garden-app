// V4-PERFCLERK-001 C — the render gate is split from the fetch gate.
//
// WHAT THIS FILE IS FOR. The old gate (`if (loading) return null`) was crude but safe by
// construction: nothing rendered, so nothing could be wrong. Splitting it trades that for a window
// in which the app is on screen while it still does not know who the user is. Two real users share
// one installed PWA (Dave and Jen), so the failure this file exists to prevent is not cosmetic —
// it is one household member's garden appearing under the other's session.
//
// The five properties guarded here, in the order they can fail:
//   1. the shell MOUNTS before isLoaded                      (the win — otherwise this ships nothing)
//   2. NO user-scoped data renders before isLoaded            (the leak)
//   3. no tokenless request reaches a token-requiring endpoint (the fetch gate, unchanged)
//   4. the signed-OUT path still lands on /login
//   5. the resolves-to-signed-out-AFTER-mount transition
//
// V4-COLDSTART-001 added a THIRD unresolved state — `unknown`, for a Clerk that will never resolve
// (offline cold start) — which renders a terminal notice instead of the shell. That is exactly the
// kind of "renders something before identity resolves" change the header above warns about, so §6
// re-proves all five properties against it rather than assuming they carry over. The mechanics of
// the bound that produces the state live in coldStartBoundedWait.test.jsx; §6 is the leak half.
//
// No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null), same as the sibling chrome suites.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── The seam ─────────────────────────────────────────────────────────────────────────────────────
// AuthContext is mocked so the three identity states can be driven directly. It is mocked at the
// APP's context, not at @clerk/react, deliberately: `loading = !isLoaded` is the one line that
// translates Clerk into app terms and it is asserted separately below, so faking Clerk itself would
// only add a second place for the translation to be wrong.
let authState
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => authState,
  useAuthOptional: () => authState,
  AuthProvider: ({ children }) => children,
}))

// Every network seam in the shell, spied. useApiFetch is THE token-bearing path (api.js:154-164
// mints a JWT via Clerk's getToken and hands it to apiFetch), so a call to it during the pending
// window is precisely the "tokenless request to a token-requiring endpoint" failure.
// The returned object is a module-level SINGLETON, not a fresh literal per call. The real
// useApiFetch memoises `fetch` with useCallback, and FavoritesProvider has it in an effect
// dependency array — a mock that hands back a new identity each render re-runs that effect on every
// render and spins the tree until the heap dies (which is exactly what the first draft of this file
// did: OOM at ~296s, not a failing assertion).
const apiCalls = []
const tokenMints = []
const apiSeam = {
  fetch: (path) => { apiCalls.push(path); return Promise.resolve(null) },
  getToken: () => { tokenMints.push('getToken'); return Promise.resolve(null) },
}
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useApiFetch: () => apiSeam,
}))

// V4-COLDSTART-001 — the retry affordance's only side effect. Mocked rather than spied because
// jsdom's window.location is non-configurable, and the whole reason reloadApp lives in its own
// module is so this seam exists at all.
const { reloadSpy } = vi.hoisted(() => ({ reloadSpy: vi.fn() }))
vi.mock('../lib/bootReload.js', () => ({ reloadApp: reloadSpy }))

const { default: App, renderRoutes } = await import('../App.jsx')
const { default: TopChrome } = await import('../components/TopChrome.jsx')
const { getRouteClass } = await import('../lib/routeClass.js')
const { AuthProvider: RealAuthProvider } = await vi.importActual('../context/AuthContext.jsx')

const PENDING  = { user: null, profile: null, loading: true, identity: 'pending' }
const SIGNEDIN = { user: { id: 'user_dave' }, profile: { id: 'user_dave', display_name: 'Dave Nichols', avatar_url: null }, loading: false, identity: 'signed-in' }
const SIGNEDOUT = { user: null, profile: null, loading: false, identity: 'signed-out' }
// V4-COLDSTART-001. loading:true is not decoration — `unknown` is a strict subset of `loading` (the
// provider invariant proved in coldStartBoundedWait §C), so a fixture with loading:false would be a
// shape the app can never produce and every §6 assertion below would be measuring a fiction.
const UNKNOWN = { user: null, profile: null, loading: true, identity: 'unknown' }

// Everything the pending shell must never contain. Two identities, because "no data leaked" has to
// mean "no data at ALL", not "not the other one's" — a bug that painted the CURRENT user's name
// early is still a bug, and on a shared device it is the same bug.
const IDENTITY_STRINGS = ['Dave Nichols', 'Jen', 'user_dave', 'user_jen']

function renderApp(at = '/today') {
  window.history.replaceState({}, '', at)
  return render(<App />)
}

beforeEach(() => {
  authState = PENDING
  apiCalls.length = 0
  tokenMints.length = 0
  reloadSpy.mockClear()
  try { sessionStorage.clear() } catch { /* noop */ }
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in this suite'))))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── 1. The shell mounts before isLoaded ──────────────────────────────────────────────────────────
describe('V4-PERFCLERK-001 C — the shell MOUNTS before isLoaded', () => {
  it('paints the header chrome while auth is still loading', () => {
    const { container } = renderApp('/today')
    const header = container.querySelector('[data-app-chrome="top"]')
    expect(header).toBeTruthy()
    expect(header.getAttribute('data-chrome-state')).toBe('pending')
  })

  it('paints a content skeleton in the route slot instead of returning null', () => {
    renderApp('/today')
    // Pre-change this slot was literally nothing: Protected returned null for the whole ~2.5s window.
    expect(screen.getByTestId('route-skeleton')).toBeTruthy()
  })

  it('paints the bottom-nav frame so the shell is a whole shell, not a floating header', () => {
    renderApp('/today')
    expect(screen.getByTestId('nav-skeleton')).toBeTruthy()
  })

  it('reserves the nav height from the CONSTANT while pending — --bottom-nav-height is unset until BottomNav mounts', () => {
    const { container } = renderApp('/today')
    const frame = container.querySelector('div[style*="100dvh"]')
    // A calc() referencing an unset custom property is INVALID, i.e. no padding at all, i.e. the
    // skeleton nav sits on top of the last skeleton row.
    expect(frame.style.paddingBottom.includes('var(--bottom-nav-height)')).toBe(false)
    expect(frame.style.paddingBottom.includes('56px')).toBe(true)
  })

  it('the SPLASH no longer waits for auth — it is a brand moment again, not the boot gate', () => {
    vi.useFakeTimers()
    try {
      authState = PENDING
      renderApp('/today')
      expect(screen.queryByRole('img', { name: /welcome/i })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1400 + 320 + 10) })
      // Still loading. Pre-change the splash stayed up until isLoaded, which is what made the shell
      // behind it worthless; if this regresses, Option C ships a change nobody can see.
      expect(authState.loading).toBe(true)
      expect(screen.queryByRole('img', { name: /welcome/i })).toBe(null)
      expect(screen.getByTestId('route-skeleton')).toBeTruthy()
    } finally { vi.useRealTimers() }
  })
})

// ── 2. No user-scoped data renders before isLoaded ───────────────────────────────────────────────
describe('V4-PERFCLERK-001 C — NO user-scoped data renders before isLoaded', () => {
  it('renders no identity string anywhere in the pending shell', () => {
    // authState carries a fully populated profile, so this fails LOUDLY if any pending-path
    // component starts reading identity — it is not passing merely because the fixture is empty.
    authState = { ...SIGNEDIN, user: null, loading: true }
    const { container } = renderApp('/today')
    for (const s of IDENTITY_STRINGS) {
      expect(container.textContent.includes(s), `pending shell leaked "${s}"`).toBe(false)
    }
  })

  it('mounts NONE of the user-gated shell components (TodayBand, BottomNav, critters)', () => {
    const { container } = renderApp('/today')
    // The real BottomNav renders labelled tab links; the skeleton renders unlabelled bones.
    expect(screen.queryByText('Today')).toBe(null)
    expect(screen.queryByText('Harvests')).toBe(null)
    expect(screen.queryByText('More')).toBe(null)
    expect(container.querySelector('nav[data-app-chrome="bottom"]').getAttribute('aria-hidden')).toBe('true')
  })

  it('the pending SKELETONS are prop-less and context-free — no channel exists for user data', () => {
    // CODE only — the file's own comments discuss "user data" at length, and a guard that a comment
    // can satisfy or break is not a guard.
    const code = readFileSync(resolve(process.cwd(), 'src/components/BootSkeleton.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Structural, not stylistic: if either skeleton ever takes a prop or reads a context, the
    // guarantee above degrades from "cannot happen" to "did not happen this time".
    expect(/export function RouteSkeleton\(\)/.test(code)).toBe(true)
    expect(/export function NavSkeleton\(\)/.test(code)).toBe(true)
    expect(/useAuth|useContext|useApiFetch|profile|\buser\b/.test(code)).toBe(false)
  })

  it('the pending HEADER offers no navigation target at all — no Link, no href', () => {
    const { container } = renderApp('/today')
    const header = container.querySelector('[data-app-chrome="top"]')
    expect(header.querySelectorAll('a').length).toBe(0)
    // Both the signed-in affordances and the signed-out one are absent.
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    expect(screen.queryByTestId('topchrome-harvest')).toBe(null)
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
    expect(screen.queryByText('Sign in')).toBe(null)
  })

  it("'pending' is a class of its own — an unresolved identity is NOT a signed-out one", () => {
    expect(getRouteClass('/today', { user: null, loading: true })).toBe('pending')
    expect(getRouteClass('/today', { user: null, loading: false })).toBe('unauth')
    // And it wins over every other classification, so no route can slip past it.
    expect(getRouteClass('/capture', { user: { id: 'u' }, loading: true })).toBe('pending')
    expect(getRouteClass('/projects/abc', { user: { id: 'u' }, loading: true })).toBe('pending')
  })

  it('<Protected> withholds its CHILDREN while loading — the page component never mounts', () => {
    let mounted = false
    function Spy() { mounted = true; return <div>secret</div> }
    const route = renderRoutes({ overlay: false, user: null, loading: true }).find((r) => r.props.path === '/today')
    const Protected = route.props.element.type
    render(<MemoryRouter><Protected><Spy /></Protected></MemoryRouter>)
    expect(mounted).toBe(false)
    expect(screen.queryByText('secret')).toBe(null)
    expect(screen.getByTestId('route-skeleton')).toBeTruthy()
  })

  // The inverse leak. /login is the ONE route whose element branches on `user` outside <Protected>.
  it('/login shows the skeleton, NOT the sign-in page, while auth is unresolved', () => {
    const pending = renderRoutes({ overlay: false, user: null, loading: true }).find((r) => r.props.path === '/login')
    expect(pending.props.element.type.name).toBe('RouteSkeleton')
    const out = renderRoutes({ overlay: false, user: null, loading: false }).find((r) => r.props.path === '/login')
    expect(out.props.element.type.name).toBe('Login')
    const inn = renderRoutes({ overlay: false, user: { id: 'u' }, loading: false }).find((r) => r.props.path === '/login')
    expect(inn.props.element.props.to).toBe('/today')
  })

  it('renders the SIGN-IN page for a signed-out user landing on /login (the pending gate is not sticky)', () => {
    authState = SIGNEDOUT
    renderApp('/login')
    expect(screen.getByText(/Sign in with Google/i)).toBeTruthy()
    expect(screen.queryByTestId('route-skeleton')).toBe(null)
  })
})

// ── 3. The FETCH gate is unchanged ───────────────────────────────────────────────────────────────
describe('V4-PERFCLERK-001 C — no tokenless request to a token-requiring endpoint', () => {
  it('issues ZERO useApiFetch calls and mints ZERO tokens during the whole pending window', () => {
    renderApp('/today')
    expect(apiCalls).toEqual([])
    expect(tokenMints).toEqual([])
  })

  it('still issues zero after the pending shell has been on screen for a full second', () => {
    vi.useFakeTimers()
    try {
      renderApp('/today')
      act(() => { vi.advanceTimersByTime(1000) })
      expect(apiCalls).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('`loading` is exactly !isLoaded — the one line that translates Clerk into app terms', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/context/AuthContext.jsx'), 'utf8')
    expect(/const loading = !isLoaded/.test(src)).toBe(true)
    // and `user` is still gated on isSignedIn, not merely on the clerkUser object existing.
    expect(/const user = isSignedIn \? clerkUser : null/.test(src)).toBe(true)
  })

  it('the REAL AuthProvider reports loading:true when Clerk has not resolved (not just the mock)', async () => {
    // Guards the seam this suite fakes: if AuthContext stopped deriving `loading` from isLoaded,
    // every test above would keep passing against a fiction.
    vi.doMock('@clerk/react', () => ({
      useUser: () => ({ user: null, isSignedIn: false, isLoaded: false }),
      useClerk: () => ({ client: {}, signOut: () => {} }),
    }))
    vi.resetModules()
    const { AuthProvider, useAuth } = await vi.importActual('../context/AuthContext.jsx')
    let seen
    function Probe() { seen = useAuth(); return null }
    render(<AuthProvider><Probe /></AuthProvider>)
    expect(seen.loading).toBe(true)
    expect(seen.user).toBe(null)
    vi.doUnmock('@clerk/react')
    vi.resetModules()
  })
})

// ── 4 + 5. The signed-out path, and the transition INTO it after the shell has mounted ───────────
describe('V4-PERFCLERK-001 C — signed-out, and resolving to signed-out after mount', () => {
  it('redirects a signed-out user off a Protected route to /login', () => {
    authState = SIGNEDOUT
    const route = renderRoutes({ overlay: false, user: null, loading: false }).find((r) => r.props.path === '/today')
    const Protected = route.props.element.type
    const { container } = render(
      <MemoryRouter initialEntries={['/today']}>
        <Protected><div>secret</div></Protected>
      </MemoryRouter>,
    )
    expect(container.textContent.includes('secret')).toBe(false)
  })

  it('pending -> signed OUT: the skeleton is replaced by the unauth chrome, never by a signed-in shell', () => {
    authState = PENDING
    const { container, rerender } = render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe('pending')
    expect(screen.queryByText('Sign in')).toBe(null)

    authState = SIGNEDOUT
    act(() => { rerender(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>) })
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe(null)
    expect(screen.getByText('Sign in')).toBeTruthy()
    // The signed-IN affordances must never have appeared on the way through.
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })

  it('pending -> signed IN: the shell fills in, and only then do the user-gated surfaces appear', () => {
    authState = PENDING
    const { container, rerender } = render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(screen.queryByLabelText('Search your garden')).toBe(null)

    authState = SIGNEDIN
    act(() => { rerender(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>) })
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe(null)
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.getByTestId('topchrome-snap').getAttribute('href')).toBe('/capture')
    expect(screen.queryByText('Sign in')).toBe(null)
  })

  it('the pending header reserves the resolved height on a root tab, so the signed-in handover does not reflow', () => {
    authState = PENDING
    const { container, rerender } = render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    const pendingH = container.querySelector('header').style.height
    // 52 since V4-HEADERPARITY-001 — root lost its 88px launcher, so there is one height to reserve.
    expect(pendingH).toBe('calc(52px + env(safe-area-inset-top))')

    authState = SIGNEDIN
    act(() => { rerender(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>) })
    expect(container.querySelector('header').style.height).toBe(pendingH)
  })

  // Was "stays condensed on a non-root route (no phantom 88px bar on a detail page)" — the phantom
  // it guarded against cannot exist now that both classes are 52px, so it guards the stronger
  // property instead: the reservation is route-class-INDEPENDENT, and the launcher-shaped bone that
  // held the old 88px layout is gone everywhere rather than merely absent off-root.
  it('the pending header reserves the SAME box on every route, root or detail', () => {
    for (const path of ['/today', '/garden', '/projects/abc', '/settings']) {
      cleanup()
      authState = PENDING
      const { container } = render(<MemoryRouter initialEntries={[path]}><TopChrome /></MemoryRouter>)
      expect(container.querySelector('header').style.height, path).toBe('calc(52px + env(safe-area-inset-top))')
      expect(screen.queryByTestId('topchrome-pending-launcher'), path).toBe(null)
    }
  })

  it('pending and signed-in are MUTUALLY EXCLUSIVE in the shell — the nav skeleton and the real nav never coexist', () => {
    authState = PENDING
    const { container } = renderApp('/today')
    expect(container.querySelectorAll('[data-app-chrome="bottom"]').length).toBe(1)
    expect(screen.getByTestId('nav-skeleton')).toBeTruthy()
  })

  it('RealAuthProvider is exported and still the app-level provider (the mock did not delete it)', () => {
    expect(typeof RealAuthProvider).toBe('function')
  })
})

// Route-table integrity under the new signature: adding `loading` must not change the route set.
describe('V4-PERFCLERK-001 C — the route table is unchanged by the split', () => {
  it('renders the same path set with loading true, loading false, and loading absent', () => {
    const paths = (o) => renderRoutes(o).map((r) => r.props.path).join('|')
    const base = paths({ overlay: false, user: { id: 'u' } })
    expect(paths({ overlay: false, user: { id: 'u' }, loading: true })).toBe(base)
    expect(paths({ overlay: false, user: { id: 'u' }, loading: false })).toBe(base)
    expect(paths({ overlay: false, user: null, loading: true })).toBe(base)
  })

  it('Routes still accepts the generated children (no non-Route element crept in)', () => {
    const els = renderRoutes({ overlay: false, user: null, loading: true })
    expect(els.every((e) => e.type === Routes.prototype ? false : true)).toBe(true)
    expect(els.every((e) => typeof e.props.path === 'string')).toBe(true)
  })
})

// ── 6. V4-COLDSTART-001 — the SAME FIVE PROPERTIES, re-proved against the `unknown` state ─────────
//
// `unknown` means "loaded nothing, and we have given up expecting to" — an offline cold start where
// clerk-js can never hot-load. It is the first state in which the app renders a real, worded screen
// while not knowing who is in front of it, so every property above is re-derived here rather than
// inherited. Property 1 is the one that CHANGES shape: in `pending` the win is that the shell mounts;
// in `unknown` the requirement is the opposite — the shell must NOT be up, because a shell is a
// promise of an app that is not coming. The other four hold identically and are asserted identically.
describe('V4-COLDSTART-001 §6 property 1 — the unknown state REPLACES the shell, it does not sit inside it', () => {
  it('renders the notice and mounts no chrome at all: no header, no nav, no route slot', () => {
    authState = UNKNOWN
    const { container } = renderApp('/today')
    expect(screen.getByTestId('identity-unavailable')).toBeTruthy()
    // Every surface the pending state paints is absent. This is what makes the leak argument
    // structural instead of an enumeration: there is nothing else mounted to audit.
    expect(container.querySelector('[data-app-chrome="top"]')).toBe(null)
    expect(container.querySelector('[data-app-chrome="bottom"]')).toBe(null)
    expect(screen.queryByTestId('route-skeleton')).toBe(null)
    expect(screen.queryByTestId('nav-skeleton')).toBe(null)
  })

  it('is an alert with a retry affordance — an explanation AND a way out, not a prettier hang', () => {
    authState = UNKNOWN
    renderApp('/today')
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('data-testid')).toBe('identity-unavailable')
    expect(screen.getByTestId('identity-retry').tagName).toBe('BUTTON')
  })

  it('the retry actually reloads — the only retry that can re-attempt the clerk-js hot-load', () => {
    // IsomorphicClerk loads the script once and exposes no re-load API, so a button that did
    // anything cleverer than a new document would be a button that does nothing.
    authState = UNKNOWN
    renderApp('/today')
    expect(reloadSpy).not.toHaveBeenCalled()
    act(() => { screen.getByTestId('identity-retry').click() })
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('names the CAUSE honestly: "offline" only when the radio is actually down', () => {
    // Both causes are real and want different next actions. Telling someone holding five bars that
    // they are offline sends them debugging their phone instead of retrying.
    const desc = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
    try {
      authState = UNKNOWN
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
      const offline = renderApp('/today')
      expect(screen.getByTestId('identity-unavailable').textContent).toMatch(/offline/i)
      offline.unmount()

      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
      renderApp('/today')
      const text = screen.getByTestId('identity-unavailable').textContent
      expect(text).not.toMatch(/offline/i)
      expect(text).toMatch(/account/i)
      // Either way it stays a dead end for data: no identity, so still nothing to render.
      for (const s of IDENTITY_STRINGS) expect(text.includes(s)).toBe(false)
    } finally {
      if (desc) Object.defineProperty(window.navigator, 'onLine', desc)
      else delete window.navigator.onLine
    }
  })

  it('does not silently redirect anywhere — the URL Dave launched on is still the URL', () => {
    // The rejected alternative, stated as an assertion: /login cannot work offline and reads as
    // "you got signed out", which is false.
    authState = UNKNOWN
    renderApp('/today')
    expect(window.location.pathname).toBe('/today')
    expect(screen.queryByText(/Sign in with Google/i)).toBe(null)
  })
})

describe('V4-COLDSTART-001 §6 property 2 — NO user-scoped data renders in the unknown state', () => {
  it('renders no identity string anywhere, with a fully populated profile in the fixture', () => {
    // Same trap as the pending case: the fixture carries Dave's name and id, so this fails loudly if
    // the notice ever starts reading identity rather than passing because the fixture is empty.
    authState = { ...SIGNEDIN, user: null, loading: true, identity: 'unknown' }
    const { container } = renderApp('/today')
    expect(screen.getByTestId('identity-unavailable')).toBeTruthy()
    for (const s of IDENTITY_STRINGS) {
      expect(container.textContent.includes(s), `unknown screen leaked "${s}"`).toBe(false)
    }
  })

  it('mounts none of the user-gated surfaces and offers no navigation target at all', () => {
    authState = { ...SIGNEDIN, user: null, loading: true, identity: 'unknown' }
    const { container } = renderApp('/today')
    expect(screen.queryByText('Today')).toBe(null)
    expect(screen.queryByText('Harvests')).toBe(null)
    expect(screen.queryByText('More')).toBe(null)
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    // No link can be followed out of this screen — offline every one of them is a dead end, and a
    // link into the app is a link into a tree that has no identity to render.
    expect(container.querySelectorAll('a').length).toBe(0)
    // The notice itself carries no imagery at all. The tree DOES hold one <img>: SplashScreen's
    // brand illustration, a static asset that mounts above AuthProvider and is not gated on identity.
    // Named rather than excluded by a loose count, so a second image appearing anywhere fails here.
    const notice = screen.getByTestId('identity-unavailable')
    expect(notice.querySelectorAll('img').length).toBe(0)
    const imgs = [...container.querySelectorAll('img')]
    expect(imgs.length).toBe(1)
    expect(screen.getByRole('img', { name: /welcome/i }).contains(imgs[0])).toBe(true)
  })

  it('the notice is prop-less and context-free — no channel exists for identity to reach it', () => {
    // CODE only, comments stripped: this file discusses identity at length and a guard a comment can
    // satisfy is not a guard. Extends the existing BootSkeleton scan rather than duplicating it, so
    // the new terminal screen is bound by the SAME structural invariant as the skeletons.
    const code = readFileSync(resolve(process.cwd(), 'src/components/BootSkeleton.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(/export function IdentityUnavailable\(\)/.test(code)).toBe(true)
    expect(/useAuth|useContext|useApiFetch|profile|\buser\b/.test(code)).toBe(false)
    // PROVENANCE, not naming. The scan above only binds components declared in BootSkeleton.jsx, so
    // it is worth nothing unless whatever App renders in the unknown state comes from there. Read
    // the identifier OUT of the gate rather than asserting a spelling, so a rename stays green and a
    // rewire — to a local component, or one from a file with no such invariant — fails.
    //
    // Line comments are stripped BEFORE block comments here, unlike the BootSkeleton scan above.
    // App.jsx contains the literal `/projects/:id/*` inside a `//` comment; strip blocks first and
    // that stray `/*` opens a comment that runs to the next `*/` and swallows 13 770 characters —
    // including this gate — so the assertion would fail on correct code (it did).
    const app = readFileSync(resolve(process.cwd(), 'src/App.jsx'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const gate = app.match(/^\s*if \(identity === 'unknown'\) return <([A-Za-z0-9_]+) \/>$/m)
    expect(gate, 'App.jsx no longer gates the unknown identity on a single prop-less element').toBeTruthy()
    const imported = app.match(/^import \{([^}]*)\} from '\.\/components\/BootSkeleton\.jsx'$/m)
    expect(imported, 'App.jsx no longer imports from BootSkeleton.jsx').toBeTruthy()
    expect(imported[1].split(',').map((s) => s.trim())).toContain(gate[1])
    expect(new RegExp(`export function ${gate[1]}\\(\\)`).test(code)).toBe(true)
  })
})

describe('V4-COLDSTART-001 §6 property 3 — no tokenless request in the unknown state', () => {
  it('issues ZERO useApiFetch calls and mints ZERO tokens, including a full second later', () => {
    // The providers ABOVE the gate (Favorites/Zone/Mode/Toast) still mount, so this is not implied
    // by "nothing renders" — it is the same assertion the pending window carries, made again for a
    // state that lasts indefinitely rather than ~2.5s.
    vi.useFakeTimers()
    try {
      authState = UNKNOWN
      renderApp('/today')
      expect(apiCalls).toEqual([])
      expect(tokenMints).toEqual([])
      act(() => { vi.advanceTimersByTime(1000) })
      expect(apiCalls).toEqual([])
      expect(tokenMints).toEqual([])
    } finally { vi.useRealTimers() }
  })
})

describe('V4-COLDSTART-001 §6 property 4 — the signed-OUT path is untouched by the new state', () => {
  it('a signed-out user still lands on /login and never sees the offline notice', () => {
    authState = SIGNEDOUT
    renderApp('/login')
    expect(screen.getByText(/Sign in with Google/i)).toBeTruthy()
    expect(screen.queryByTestId('identity-unavailable')).toBe(null)
  })

  it('a signed-out user is still redirected off a Protected route', () => {
    authState = SIGNEDOUT
    const route = renderRoutes({ overlay: false, user: null, loading: false }).find((r) => r.props.path === '/today')
    const Protected = route.props.element.type
    const { container } = render(
      <MemoryRouter initialEntries={['/today']}>
        <Protected><div>secret</div></Protected>
      </MemoryRouter>,
    )
    expect(container.textContent.includes('secret')).toBe(false)
  })

  it('the PENDING window is unchanged — the new gate did not swallow the state it sits beside', () => {
    // The regression this change could most plausibly cause: gating too broadly and replacing the
    // ~2.5s skeleton shell (the whole of V4-PERFCLERK-001 C) with the offline notice.
    authState = PENDING
    const { container } = renderApp('/today')
    expect(screen.queryByTestId('identity-unavailable')).toBe(null)
    expect(screen.getByTestId('route-skeleton')).toBeTruthy()
    expect(screen.getByTestId('nav-skeleton')).toBeTruthy()
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe('pending')
  })
})

describe('V4-COLDSTART-001 §6 property 5 — the transitions OUT of unknown', () => {
  it('unknown -> signed IN: the real shell takes over and the notice is gone', () => {
    // A late resolve (the radio comes back, Clerk finally loads). The state is not sticky, so this
    // recovers with no interaction at all.
    authState = UNKNOWN
    const { container, rerender } = render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe('pending')

    authState = SIGNEDIN
    act(() => { rerender(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>) })
    expect(container.querySelector('[data-app-chrome="top"]').getAttribute('data-chrome-state')).toBe(null)
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
  })

  it('unknown -> signed OUT: the unauth chrome, and the signed-IN affordances never flash', () => {
    authState = UNKNOWN
    const { container, rerender } = render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(screen.queryByText('Sign in')).toBe(null)

    authState = SIGNEDOUT
    act(() => { rerender(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>) })
    expect(screen.getByText('Sign in')).toBeTruthy()
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })

  it('the full app tree recovers from unknown to a signed-in shell in place', () => {
    authState = UNKNOWN
    const { rerender } = renderApp('/today')
    expect(screen.getByTestId('identity-unavailable')).toBeTruthy()

    authState = SIGNEDIN
    act(() => { rerender(<App />) })
    expect(screen.queryByTestId('identity-unavailable')).toBe(null)
    expect(screen.getByLabelText('Search your garden')).toBeTruthy()
  })
})
