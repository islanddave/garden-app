// V4-PWAHARVSHORTCUT-001 — the installed-PWA home-screen "Harvest" shortcut opens the WEIGH-IN
// SESSION, the same thing the header action and the Harvests CTA open.
//
// WHY A STRING ASSERTION ON THE MANIFEST IS NOT ENOUGH. Session mode is gated in EventNew on
// `harvestSessionParam && !inOverlay` (EventNew.jsx:493). A surface that carries the right
// ?session=harvest target but arrives in an OVERLAY posture lands with the param and the session
// STILL never engages — it degrades to the plain ?event_type=harvest form and nothing says so. The
// sibling lane proved this is invisible to href-shaped tests (V4-WEIGHINCTA-001: mutating Link to
// OverlayLink left TopChrome.test.jsx fully green). A manifest url has no <Link> to inspect, so the
// posture has to be established from the routing itself. Four asserted links, then the payoff:
//
//   1. the manifest's bytes parse to /log + session=harvest                      (`target`)
//   2. that url is byte-identical to what the header action renders              (`parity`)
//   3. a launch carrying no history state yields OverlayProvider background=undefined  (`posture A`)
//   4. with no background App renders the PAGE tree, whose /log element is NOT
//      OverlayHost-wrapped — so no OverlaySurfaceProvider, so inOverlay is false   (`posture B`)
//   5. EventNew mounted at the manifest url in that posture ENGAGES the session   (`engagement`)
//
// Every one of those uses shipped code (real OverlayProvider, real renderRoutes, real EventNew) —
// none of it re-implements the decision it is asserting. Each posture test carries its own
// non-vacuity control (an overlay-shaped entry that must read the other way), so a probe that
// reported "page" for everything fails rather than passing silently.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { apiFetchSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  dataRef: { projects: [], plants: [] },
}))

// PLANTING_REQUIRED_ENABLED false mirrors EventNew.harvestSession.test.jsx: the gate under test is
// the session gate, and dragging PlantingSelect into every mount tests something else. OVERLAY_ROUTES
// pinned true because posture A/B are meaningless with the overlay machinery off — App.routes.test.jsx
// pins it the same way and for the same reason.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
  OVERLAY_ROUTES_ENABLED: true,
}))

// Spread the original: App.jsx imports AuthProvider from here too, and a bare factory would leave it
// undefined in the module graph this file imports for the route table.
let mockUser
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ user: mockUser }),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

import EventNew from '../pages/EventNew.jsx'
import TopChrome from '../components/TopChrome.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayProvider, OverlaySurfaceProvider, useOverlay } from '../context/OverlayContext.jsx'
import { renderRoutes, OverlayHost } from '../App.jsx'

// The shortcut is read from the shipped manifest, never retyped. Retyping it is how a test keeps
// passing after the file it guards has been edited.
const MANIFEST = JSON.parse(readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))
const SHORTCUT = MANIFEST.shortcuts.find(s => s.short_name === 'Harvest')
const SHORTCUT_URL = SHORTCUT?.url

beforeEach(() => {
  mockUser = { id: 'u1' }
  apiFetchSpy.mockReset()
  dataRef.projects = [{ id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }]
  dataRef.plants = []
  try { localStorage.clear() } catch { /* noop */ }
  apiFetchSpy.mockImplementation(path => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

// ── 1. target ───────────────────────────────────────────────────────────
describe('V4-PWAHARVSHORTCUT-001 target — the manifest points at the weigh-in session', () => {
  it('exists and is /log?session=harvest, parsed rather than string-matched', () => {
    expect(SHORTCUT, 'no shortcut with short_name "Harvest" in the manifest').toBeTruthy()
    const url = new URL(SHORTCUT_URL, 'https://garden.futureishere.net')
    expect(url.pathname).toBe('/log')
    expect(url.searchParams.get('session')).toBe('harvest')
  })

  // The retired target. event_type=harvest opens the single-event form, which is the whole defect
  // this row closes; fromquick is inert for a non-photo arrival (EventNew.jsx BUG-QUICKPHOTONOTICE-001)
  // and its only remaining effect on this url would be to suppress the draft restore — a difference
  // from the other two session entry points, not a shared behavior.
  it('carries neither event_type nor fromquick', () => {
    const params = new URL(SHORTCUT_URL, 'https://garden.futureishere.net').searchParams
    expect(params.get('event_type')).toBeNull()
    expect(params.get('fromquick')).toBeNull()
  })
})

// ── 2. parity ───────────────────────────────────────────────────────────
// "Every top-level Harvest entry point means the same thing" is the row's whole point, so it is
// asserted against what the header RENDERS rather than against a copy of the string.
describe('V4-PWAHARVSHORTCUT-001 parity — the shortcut and the header action agree', () => {
  it('the manifest url is byte-identical to the header Harvest action href', () => {
    render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe(SHORTCUT_URL)
  })
})

// ── 3. posture A ────────────────────────────────────────────────────────
// A home-screen shortcut is a top-level browser navigation into a new document: there is no
// history.state, so react-router reports no location.state, so OverlayProvider computes no
// background. The overlay-shaped entry beside it is the control.
function BackgroundProbe() {
  const { background } = useOverlay()
  return <div data-testid="posture">{background ? 'overlay' : 'page'}</div>
}

describe('V4-PWAHARVSHORTCUT-001 posture A — a shortcut launch carries no overlay background', () => {
  it('the manifest url with no history state is a PAGE', () => {
    render(
      <MemoryRouter initialEntries={[SHORTCUT_URL]}>
        <OverlayProvider><BackgroundProbe /></OverlayProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('posture').textContent).toBe('page')
  })

  it('the SAME url entered the way an OverlayLink enters it is an OVERLAY — the probe can tell', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/log', search: '?session=harvest', state: { background: { pathname: '/today', search: '' } } }]}>
        <OverlayProvider><BackgroundProbe /></OverlayProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('posture').textContent).toBe('overlay')
  })
})

// ── 4. posture B ────────────────────────────────────────────────────────
// The link from "no background" to "inOverlay is false", read off App's own route table (element
// props only, no render — the App.routes.test.jsx idiom). With no background AppShell renders the
// PAGE tree ALONE; only the overlay tree wraps a route in OverlayHost, and OverlayHost is the only
// thing in the app that mounts OverlaySurfaceProvider.
describe('V4-PWAHARVSHORTCUT-001 posture B — the page tree does not wrap /log in an overlay surface', () => {
  const logRoute = overlay => renderRoutes({ overlay, user: { id: 'u1' }, loading: false })
    .find(r => r.props.path === '/log')

  it('/log in the PAGE tree is not OverlayHost-wrapped', () => {
    expect(logRoute(false).props.element.type).not.toBe(OverlayHost)
  })

  it('/log in the OVERLAY tree IS OverlayHost-wrapped — the control for the assertion above', () => {
    expect(logRoute(true).props.element.type).toBe(OverlayHost)
  })
})

// ── 5. engagement ───────────────────────────────────────────────────────
// The payoff. EventNew is mounted at the manifest url through a real router, so the query string the
// component reads is the one the shortcut ships — not a hand-typed restatement of it.
async function launchShortcut({ overlaySurface = false } = {}) {
  const tree = <ToastProvider><EventNew /></ToastProvider>
  const utils = render(
    <MemoryRouter initialEntries={[SHORTCUT_URL]}>
      <Routes>
        <Route path="/log" element={overlaySurface ? <OverlaySurfaceProvider>{tree}</OverlaySurfaceProvider> : tree} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return utils
}

describe('V4-PWAHARVSHORTCUT-001 engagement — the session actually starts', () => {
  it('lands in session mode: the type is locked to harvest', async () => {
    await launchShortcut()
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
  })

  it('engages the session quantity loop on arrival', async () => {
    await launchShortcut()
    // A SECOND, INDEPENDENT witness that the gate opened — one a change to the lock strip's markup
    // cannot fake. It used to be the tray fetch (/api/events/harvest-ready), which BD-044 removed
    // along with the whole weigh-in queue; the witness had to be replaced rather than dropped,
    // because the first case in this describe reads the lock strip and would then be the only
    // check, which is exactly the single-point-of-failure this pair exists to avoid.
    //
    // enterKeyHint on the quantity field is `inHarvestSession ? 'next' : undefined` — set nowhere
    // else, and it belongs to the session's qty -> grams -> save loop rather than to its chrome.
    const qty = document.getElementById('harvest-quantity')
    expect(qty).toBeTruthy()
    expect(qty.getAttribute('enterkeyhint')).toBe('next')
  })

  // THE TRAP, pinned. Same url, same component, overlay posture: the session silently does not
  // engage. `What happened? *` is the mount control — it renders in BOTH branches, so a red here
  // means "session absent", never "component failed to render".
  it('the SAME url inside an overlay surface does NOT engage the session', async () => {
    await launchShortcut({ overlaySurface: true })
    expect(screen.getByText('What happened? *')).toBeTruthy()
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
  })

  it('and in page posture that same mount control is present too', async () => {
    cleanup()
    await launchShortcut()
    expect(screen.getByText('What happened? *')).toBeTruthy()
  })
})
