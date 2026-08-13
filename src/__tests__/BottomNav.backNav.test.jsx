// BUG-BACKNAVMORE-001 (BD-009) — BottomNav's two sheets against REAL jsdom history.
//
// THE BUG: with the More (or +LOG) fly-up open, Android Back navigated the underlying tab instead
// of closing the sheet. NOT a regression — V4-BACKNAV-001 deliberately excluded these two sheets
// from arming (armsBack=false) because every row closes the sheet AND navigates, which would
// strand the pushed marker entry mid-stack: a permanent dead Back press on the app's most
// frequent path. This file pins the resolution: the sheets now ARM, and SheetRowLink consumes the
// armed entry on row-navigate (replace instead of push, gated at click time on readMarker — the
// exact predicate disarm() guards on).
//
// HARNESS: copied from BackNav.history.test.jsx, the repo's real-history conventions — do not
// swap in MemoryRouter (it never touches window.history; every assertion here would pass
// VACUOUSLY) and do not remove the floor sentinel (back() at history index 0 is a SILENT no-op in
// jsdom, so a test at index 0 false-passes "nothing navigated"). Unlike that file, this one uses
// the REAL react-router BrowserRouter: the whole point is what the ROWS write into history, and a
// mocked <Link> writes nothing.
//
// The unregistered/no-provider fallback (registered=false → no arming, rows push normally) stays
// covered by BottomNav.test.jsx, which renders bare with a mocked router. This file covers the
// flag-off half of that contract against real history.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { BrowserRouter, useLocation } from 'react-router-dom'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

const { signOutSpy } = vi.hoisted(() => ({ signOutSpy: vi.fn(() => Promise.resolve()) }))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user:    { id: 'user-1' },
    profile: { display_name: 'Dave', email: 'islanddave@gmail.com' },
    signOut: signOutSpy,
  }),
}))
// Clerk-dependent children with their own suites — stubbed, same as BottomNav.test.jsx.
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve(null) }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav from '../components/BottomNav.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { OverlayProvider } from '../context/OverlayContext.jsx'
import { readMarker } from '../lib/backNav.js'

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const back = async () => { act(() => { window.history.back() }); await settle() }

// Floor sentinel — see BackNav.history.test.jsx. arm() MERGES state, so the marker entry carries
// __floor forward; a ROW navigation (react-router push/replace) writes fresh {usr,key,idx} and
// drops it. That asymmetry is what makes atFloor() the no-orphan oracle: after row-navigate +
// ONE Back, atFloor()===true is only reachable if the marker entry did NOT linger mid-stack.
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1

// The page tree is irrelevant here — chrome only. The probe exposes the router's location so
// "navigated" and "overlay background preserved" are asserted from the router's view, not from
// react-router's internal history.state.usr shape.
function Probe() {
  const loc = useLocation()
  return <span data-testid="path" data-bg={loc.state?.background?.pathname}>{loc.pathname}</span>
}
const path = () => screen.getByTestId('path').textContent

// Provider nesting mirrors App.jsx: DismissRegistryProvider wraps OverlayProvider.
function renderNav() {
  return render(
    <BrowserRouter>
      <DismissRegistryProvider>
        <OverlayProvider>
          <BottomNav />
          <Probe />
        </OverlayProvider>
      </DismissRegistryProvider>
    </BrowserRouter>
  )
}

const openMore = () => { fireEvent.click(screen.getByLabelText('More navigation options')) }
const openCreate = () => { fireEvent.click(screen.getByLabelText('Create')) }
const moreIsOpen = () => !!screen.queryByText('Sign out')
const createIsOpen = () => !!screen.queryByText('Add a planting')

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  window.history.replaceState(SENTINEL, '', '/today')
})
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

describe('SELF-TEST — the harness itself, before any behaviour is asserted', () => {
  it('SELF-TEST-1/popstate-arrives: a real popstate reaches a listener', async () => {
    const seen = vi.fn()
    window.addEventListener('popstate', seen)
    window.history.pushState({ probe: 1 }, '')
    await back()
    window.removeEventListener('popstate', seen)
    expect(seen).toHaveBeenCalled()
  })

  it('SELF-TEST-2/not-at-index-0: the floor sentinel is current before each traversal', () => {
    expect(atFloor()).toBe(true)
  })
})

describe('ACCEPTANCE 1 — Back closes the open More sheet; the tab does not navigate', () => {
  it('open More → Back → sheet closed, still on /today, entry consumed', async () => {
    renderNav()
    expect(path()).toBe('/today')
    openMore()
    await settle()
    expect(moreIsOpen()).toBe(true)
    // The sheet ARMED — this is the line that was deliberately false before this fix.
    expect(armed()).toBe(true)
    // MERGE, never replace: the floor sentinel survives alongside the marker.
    expect(window.history.state.__floor).toBe(1)

    await back()
    expect(moreIsOpen()).toBe(false)   // the sheet closed…
    expect(path()).toBe('/today')      // …the tab did NOT navigate…
    expect(atFloor()).toBe(true)       // …and the armed entry was consumed, not stranded.
  })
})

describe('ACCEPTANCE 2 — a More row navigates; ONE Back returns to the ORIGINAL tab', () => {
  it('tap Dashboard → /dashboard via REPLACE (marker entry collapsed), Back → /today', async () => {
    renderNav()
    openMore()
    await settle()
    expect(armed()).toBe(true)

    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByText('Dashboard'))
    await settle()
    expect(path()).toBe('/dashboard')            // the row navigated
    expect(moreIsOpen()).toBe(false)             // and closed the sheet
    // THE ORPHANING FIX: the navigation consumed the marker entry (replace, not push). A push
    // here re-creates the shipped defect this file exists to prevent.
    expect(push).not.toHaveBeenCalled()
    expect(armed()).toBe(false)
    push.mockRestore()

    await back()
    expect(path()).toBe('/today')                // ONE Back reaches the original tab —
    expect(atFloor()).toBe(true)                 // no lingering marker entry, no double-Back
    expect(moreIsOpen()).toBe(false)             // and the sheet did not reopen
  })

  it('row taps still close the sheet and navigate when nothing is armed mid-session', async () => {
    // Control reading for the click-time gate: Escape-close first (disarm consumes the entry via
    // the self-pop guard), REOPEN, then tap — the marker must be freshly re-armed and consumed.
    renderNav()
    openMore()
    await settle()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await settle()
    expect(moreIsOpen()).toBe(false)
    expect(atFloor()).toBe(true)                 // Escape-close consumed the entry too

    openMore()
    await settle()
    expect(armed()).toBe(true)
    fireEvent.click(screen.getByText('Settings'))
    await settle()
    expect(path()).toBe('/settings')
    await back()
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })
})

describe('ACCEPTANCE 3 — the second sheet (+LOG create) gets identical treatment', () => {
  it('open Create → Back → sheet closed, tab unchanged', async () => {
    renderNav()
    openCreate()
    await settle()
    expect(createIsOpen()).toBe(true)
    expect(armed()).toBe(true)

    await back()
    expect(createIsOpen()).toBe(false)
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })

  it('a PAGE row (Sow from seed) consumes the entry: Back returns to the tab', async () => {
    renderNav()
    openCreate()
    await settle()
    fireEvent.click(screen.getByText('Sow from seed'))
    await settle()
    expect(path()).toBe('/sow')
    expect(createIsOpen()).toBe(false)

    await back()
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })

  it('an OVERLAY row (Log harvest) keeps its background state through the replace', async () => {
    // The consume path routes overlay rows through useOverlayNavigate — losing `background` here
    // would silently turn the flyover into a full-page render (the V4-HARVFAB-001 trap).
    renderNav()
    openCreate()
    await settle()
    fireEvent.click(screen.getByText('Log harvest'))
    await settle()
    expect(path()).toBe('/log')
    expect(screen.getByTestId('path').getAttribute('data-bg')).toBe('/today')

    await back()
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })

  it('swapping Create → More keeps ONE marker armed; Back closes the swapped-in sheet', async () => {
    // Mutual exclusivity swaps sheets inside a single render — armable never goes false, so the
    // session marker must carry over rather than double-arm or disarm.
    renderNav()
    openCreate()
    await settle()
    expect(armed()).toBe(true)
    openMore()                                   // closes Create, opens More in one commit
    await settle()
    expect(createIsOpen()).toBe(false)
    expect(moreIsOpen()).toBe(true)
    expect(armed()).toBe(true)

    await back()
    expect(moreIsOpen()).toBe(false)
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })
})

describe('close-in-place (Close button) consumes the entry — no stranded Back', () => {
  it('the Close control leaves the stack where it started', async () => {
    renderNav()
    openMore()
    await settle()
    expect(armed()).toBe(true)
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^close$/i })) })
    await settle()
    expect(moreIsOpen()).toBe(false)
    expect(atFloor()).toBe(true)                 // self-pop guard consumed our entry exactly once
    expect(path()).toBe('/today')
  })
})

describe('ACCEPTANCE 4 — flag OFF keeps the pre-arming fallback, byte for byte', () => {
  it('no marker is written; a row tap is a plain PUSH; Back walks it normally', async () => {
    flags.BACKNAV_ENABLED = false
    renderNav()
    openMore()
    await settle()
    expect(armed()).toBe(false)                  // nothing armed
    expect(atFloor()).toBe(true)

    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByText('Dashboard'))
    await settle()
    expect(path()).toBe('/dashboard')
    expect(moreIsOpen()).toBe(false)
    expect(push).toHaveBeenCalledTimes(1)        // normal push — the replace gate never fired
    push.mockRestore()

    await back()
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  })

  it('Back with the sheet open falls through untouched (the pre-fix contract)', async () => {
    flags.BACKNAV_ENABLED = false
    renderNav()
    openMore()
    await settle()
    expect(armed()).toBe(false)
    // Nothing was pushed for the sheet, so this Back consumes the FLOOR entry — exactly the
    // pre-arming behaviour ("Back navigates the underlying tab"). Restore the floor afterwards.
    await back()
    expect(moreIsOpen()).toBe(true)              // registry never saw the gesture
    window.history.replaceState(SENTINEL, '', '/today')
  })
})
