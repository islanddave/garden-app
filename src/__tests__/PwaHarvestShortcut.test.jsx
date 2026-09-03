// V4-PWAHARVSHORTCUT-001 + V5-HARVESTONEDOOR-001 — the installed-PWA home-screen "Harvest" shortcut
// opens the COMBINED harvest page: voice by default, the weigh-in session one tap away on its
// selector.
//
// WHAT CHANGED, AND WHY THE OLD PAYOFF HAD TO GO. This file used to end by proving the shortcut
// landed IN the weigh-in session. That is now false ON PURPOSE — Dave asked for the combined page
// to default to voice (2026-09-03). Deleting the engagement section would have left the file
// asserting only strings, so it is REPLACED by a stronger pair: the shortcut lands on voice, AND
// the session still engages through the same door at ?mode=manual. The old file proved one mode
// worked; this proves the door and both modes behind it.
//
// WHY A STRING ASSERTION ON THE MANIFEST IS NOT ENOUGH — unchanged, and the reason is unchanged.
// Session mode is gated in EventNew on `harvestSessionParam && !inOverlay`. A surface that carries
// the right target but arrives in an OVERLAY posture lands and the session STILL never engages,
// silently. The sibling lane proved that is invisible to href-shaped tests (V4-WEIGHINCTA-001:
// mutating Link to OverlayLink left TopChrome.test.jsx fully green). A manifest url has no <Link>
// to inspect, so the posture is established from the routing itself.
//
//   1. the manifest's bytes parse to /log/harvest, bare                              (`target`)
//   2. that url is byte-identical to what the header action renders                  (`parity`)
//   3. /log/harvest in the page tree is NOT OverlayHost-wrapped, so inOverlay is false (`posture`)
//   4. mounted at the shortcut url, the page renders VOICE and not the session       (`default`)
//   5. the same page at ?mode=manual DOES engage the session                         (`reachability`)
//
// Every one uses shipped code — the real manifest bytes, the real route table, the real HarvestLog,
// the real VoiceHarvest and the real EventNew. Each posture check carries its own non-vacuity
// control so a probe that reported the same answer for everything fails rather than passing.
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
// pinned true because the posture case is meaningless with the overlay machinery off — App.routes.test.jsx
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

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

import HarvestLog from '../pages/HarvestLog.jsx'
import TopChrome from '../components/TopChrome.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
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
describe('V5-HARVESTONEDOOR-001 target — the manifest points at the combined harvest page', () => {
  it('exists and is /log/harvest, parsed rather than string-matched', () => {
    expect(SHORTCUT, 'no shortcut with short_name "Harvest" in the manifest').toBeTruthy()
    const url = new URL(SHORTCUT_URL, 'https://garden.futureishere.net')
    expect(url.pathname).toBe('/log/harvest')
  })

  // The retired targets, all three. `session=harvest` and `event_type=harvest` both open EventNew
  // directly and skip the selector entirely; an explicit `mode=voice` would be redundant with the
  // default and would make the canonical url for the common case a different string from the one
  // the header action renders, quietly breaking the parity case below.
  it('carries no mode, session, event_type or fromquick', () => {
    const params = new URL(SHORTCUT_URL, 'https://garden.futureishere.net').searchParams
    expect(params.get('mode')).toBeNull()
    expect(params.get('session')).toBeNull()
    expect(params.get('event_type')).toBeNull()
    expect(params.get('fromquick')).toBeNull()
  })
})

// ── 2. parity ───────────────────────────────────────────────────────────
// "Every top-level Harvest entry point means the same thing" is the row's whole point, so it is
// asserted against what the header RENDERS rather than against a copy of the string.
describe('V5-HARVESTONEDOOR-001 parity — the shortcut and the header action agree', () => {
  it('the manifest url is byte-identical to the header Harvest action href', () => {
    render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe(SHORTCUT_URL)
  })
})

// ── 3. posture ──────────────────────────────────────────────────────────
// Read off App's own route table (element props only, no render — the App.routes.test.jsx idiom).
// Only the overlay tree wraps a route in OverlayHost, and OverlayHost is the only thing in the app
// that mounts OverlaySurfaceProvider — which is what `inOverlay` reads. /log/harvest must never be
// overlay-wrapped in either tree, because the Manual half degrades silently if it is.
describe('V5-HARVESTONEDOOR-001 posture — the combined page is never an overlay surface', () => {
  const routeAt = (path, overlay) => renderRoutes({ overlay, user: { id: 'u1' }, loading: false })
    .find(r => r.props.path === path)

  it('/log/harvest is not OverlayHost-wrapped in the PAGE tree', () => {
    expect(routeAt('/log/harvest', false).props.element.type).not.toBe(OverlayHost)
  })

  // Stronger than "not wrapped": a non-overlayable route is ABSENT from the overlay tree entirely,
  // so there is no element that could be wrapped. Asserted as absence rather than as a property of
  // an element, because reading `.props` off undefined is how the first draft of this case failed —
  // and a `?.` there would have turned a real absence into a silent pass.
  it('/log/harvest is absent from the OVERLAY tree — it is not overlayable at all', () => {
    expect(routeAt('/log/harvest', true)).toBeUndefined()
  })

  // THE NON-VACUITY CONTROL. /log IS overlayable, so it must read the other way in the overlay tree.
  // Without this, a renderRoutes that returned unwrapped elements for everything would pass the two
  // assertions above while proving nothing.
  it('/log in the OVERLAY tree IS OverlayHost-wrapped — the control', () => {
    expect(routeAt('/log', true).props.element.type).toBe(OverlayHost)
  })
})

// ── 4. default ──────────────────────────────────────────────────────────
// Mounted at the url the shortcut actually ships, through a real router, so the query string the
// page reads is the manifest's own bytes and not a hand-typed restatement of them.
function mountShortcut(url = SHORTCUT_URL) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <Routes>
          <Route path="/log/harvest" element={<HarvestLog />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('V5-HARVESTONEDOOR-001 default — the shortcut lands on voice', () => {
  it('renders the voice surface, not the weigh-in session', async () => {
    mountShortcut()
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    // The negative half matters as much as the positive one: "voice rendered" and "the session did
    // not" are separate claims, and only asserting the first would pass if both mounted at once.
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
  })

  it('the selector is present and reads By voice', async () => {
    mountShortcut()
    await waitFor(() => expect(screen.getByTestId('harvest-log-mode')).toBeTruthy())
    const checked = screen.getByTestId('harvest-log-mode').querySelector('[aria-checked="true"]')
    expect(checked?.textContent).toBe('By voice')
  })
})

// ── 5. reachability ─────────────────────────────────────────────────────
// THE PAYOFF, and the replacement for the old engagement section: the weigh-in session did not
// become unreachable when it stopped being the default. Same page, same door, one param.
describe('V5-HARVESTONEDOOR-001 reachability — the weigh-in session still engages through the new door', () => {
  it('?mode=manual locks the type to harvest — the session gate opened', async () => {
    mountShortcut('/log/harvest?mode=manual')
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
  })

  it('engages the session quantity loop, a witness the lock strip markup cannot fake', async () => {
    mountShortcut('/log/harvest?mode=manual')
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
    await act(async () => { await Promise.resolve() })
    // enterKeyHint on the quantity field is `inHarvestSession ? 'next' : undefined` — set nowhere
    // else, and it belongs to the session's qty -> grams -> save loop rather than to its chrome. A
    // second, independent witness so this describe does not rest on one testid.
    const qty = document.getElementById('harvest-quantity')
    expect(qty).toBeTruthy()
    expect(qty.getAttribute('enterkeyhint')).toBe('next')
  })

  it('and voice is NOT mounted in manual mode — only one surface is live at a time', async () => {
    cleanup()
    mountShortcut('/log/harvest?mode=manual')
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
    // This is the assertion behind HarvestLog's mount-one design: a hidden-but-mounted VoiceHarvest
    // would hold a recogniser and a mic token behind a div nobody can see.
    expect(screen.queryByTestId('voice-harvest')).toBeNull()
  })
})
