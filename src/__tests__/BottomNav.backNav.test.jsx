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
//
// V5-NAVCUSTOM-001 — two harness changes ported from BackNav.history.test.jsx, and two invariants.
//   - EVENT-BASED WAITS. This file used to sleep 50ms after every action, the pattern that file
//     retired as load-flaky (under a 1,200-file parallel run the traversal task has not been
//     scheduled when the sleep expires, and the next assertion reads pre-Back state). A traversal is
//     now awaited by its popstate; an action that writes history WITHOUT traversing (arming, a
//     replace) is flushed with a zero-delay tick, because no event is ever coming for it.
//   - A REAL FLOOR (BUG-BACKNAVVACUOUSTEST-001): replaceState alone creates nothing beneath the
//     floor, so a back() from it was a silent jsdom no-op. beforeEach now pushes the floor on top of
//     a base entry.
//   - I7: EVERY rendered row uses up the armed entry — pinned rows, moved-tab rows and the header's
//     "Edit tab bar" door included — and the pin toggle writes no history at all.
//   - I11: pinning does not reorder the open sheet, against real history and the real registry.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { BrowserRouter, useLocation } from 'react-router-dom'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

const { signOutSpy, prefsRef, saveSpy } = vi.hoisted(() => ({
  signOutSpy: vi.fn(() => Promise.resolve()),
  prefsRef: { current: null },
  saveSpy: vi.fn(async () => ({ ok: true })),
}))

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
// The network edge of the prefs read and the pin save, for the I7/I11 cases that render through the
// real NavPrefsProvider.
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => prefsRef.current),
  saveMorePins: saveSpy,
}))

import BottomNav from '../components/BottomNav.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { OverlayProvider } from '../context/OverlayContext.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'
import { readMarker } from '../lib/backNav.js'
import { DEFAULT_NAV_TABS } from '../lib/navConfig.js'

// Wait for a traversal to LAND, not for a slice of wall clock — ported from BackNav.history.test.jsx,
// whose header records why the fixed sleep this file used to take was load-flaky. NET_MS is only a
// safety net: every traversal here returns the moment its popstate arrives.
const NET_MS = 2000
let pops = 0
window.addEventListener('popstate', () => { pops += 1 })
const settle = (from = pops) => act(async () => {
  const deadline = Date.now() + NET_MS
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  await new Promise((r) => setTimeout(r, 0))   // drain anything the handler scheduled
})
const back = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }
// For actions that write history WITHOUT traversing (arming is a push, a row tap a replace): there is
// no event to wait for, so drain the queue once. Waiting on `settle` here would always pay NET_MS.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

// Floor sentinel — see BackNav.history.test.jsx. arm() MERGES state, so the marker entry carries
// __floor forward; a ROW navigation (react-router push/replace) writes fresh {usr,key,idx} and
// drops it. That asymmetry is what makes atFloor() the no-orphan oracle: after row-navigate +
// ONE Back, atFloor()===true is only reachable if the marker entry did NOT linger mid-stack.
const BASE = { __base: 1 }
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1
// BUG-BACKNAVVACUOUSTEST-001: a replaceState "floor" is history index 0, where back() is a SILENT
// no-op. Own the current entry, then PUSH the floor, so there is a real entry beneath it.
const layFloor = () => {
  window.history.replaceState(BASE, '', '/today')
  window.history.pushState(SENTINEL, '', '/today')
}

// The page tree is irrelevant here — chrome only. The probe exposes the router's location so
// "navigated" and "overlay background preserved" are asserted from the router's view, not from
// react-router's internal history.state.usr shape.
// data-search (V5-SEEDSTAB-001): a Seeds door names its view in the query, so a pathname alone can
// no longer tell Sow now from the other two views.
function Probe() {
  const loc = useLocation()
  return <span data-testid="path" data-search={loc.search} data-bg={loc.state?.background?.pathname}>{loc.pathname}</span>
}
const path = () => screen.getByTestId('path').textContent
const search = () => screen.getByTestId('path').getAttribute('data-search')

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
  signOutSpy.mockReset()
  signOutSpy.mockResolvedValue(undefined)
  saveSpy.mockClear()
  prefsRef.current = { bar_layout: null, more_pins: null, can_edit_bar: false }
  layFloor()
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

  // The instrument check for every "nothing happened" assertion below (BUG-BACKNAVVACUOUSTEST-001):
  // SELF-TEST-2 proves the floor is CURRENT, this proves there is something BENEATH it.
  it('SELF-TEST-3/the-floor-is-a-real-floor: a back() from the floor actually traverses', async () => {
    const before = pops
    await back()
    expect(pops, 'back() from the floor fired no popstate — the floor is history index 0').toBe(before + 1)
    expect(window.history.state?.__base).toBe(1)
  })
})

describe('ACCEPTANCE 1 — Back closes the open More sheet; the tab does not navigate', () => {
  it('open More → Back → sheet closed, still on /today, entry consumed', async () => {
    renderNav()
    expect(path()).toBe('/today')
    openMore()
    await flush()
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
    await flush()
    expect(armed()).toBe(true)

    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByText('Dashboard'))
    await flush()
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
    await flush()
    const from = pops
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await settle(from)                           // disarm() traverses: wait for THAT popstate
    expect(moreIsOpen()).toBe(false)
    expect(atFloor()).toBe(true)                 // Escape-close consumed the entry too

    openMore()
    await flush()
    expect(armed()).toBe(true)
    fireEvent.click(screen.getByText('Settings'))
    await flush()
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
    await flush()
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
    await flush()
    fireEvent.click(screen.getByText('Sow from seed'))
    await flush()
    // V5-SEEDSTAB-001 — the row lands on Seeds › Sow now (was /sow), as a page: no background.
    expect(path()).toBe('/seeds')
    expect(search()).toBe('?view=sow')
    expect(screen.getByTestId('path').getAttribute('data-bg')).toBeNull()
    expect(createIsOpen()).toBe(false)

    await back()
    expect(path()).toBe('/today')
    expect(search()).toBe('')
    expect(atFloor()).toBe(true)
  })

  it('an OVERLAY row (Log an event) keeps its background state through the replace', async () => {
    // The consume path routes overlay rows through useOverlayNavigate — losing `background` here
    // would silently turn the flyover into a full-page render (the V4-HARVFAB-001 trap).
    // V4-HARVFABREMOVE-001: this case used to drive "Log harvest", which no longer exists in the
    // sheet. "Log an event" is the same /log overlay target and exercises the identical consume
    // path, so the property under test is unchanged — only the row that reaches it.
    renderNav()
    openCreate()
    await flush()
    fireEvent.click(screen.getByText('Log an event'))
    await flush()
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
    await flush()
    expect(armed()).toBe(true)
    openMore()                                   // closes Create, opens More in one commit
    await flush()
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
    await flush()
    expect(armed()).toBe(true)
    const from = pops
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^close$/i })) })
    await settle(from)                           // the self-pop guard traverses: wait for it
    expect(moreIsOpen()).toBe(false)
    expect(atFloor()).toBe(true)                 // self-pop guard consumed our entry exactly once
    expect(path()).toBe('/today')
  })
})

// BUG-SIGNOUTBACKRACE-001 — the ONE More-sheet row that is not a SheetRowLink.
//
// handleSignOutConfirmed used to do `closeMore(); await signOut(); navigate('/', {replace})`. Since
// the sheets arm (above), closeMore() unmounts the Sheet -> useDismissable cleanup -> disarm() ->
// history.back(). That traversal is ASYNC, so it races the replace-navigate:
//
//   deferred signOut (production-dominant — a real network round trip): back() commits first, the
//     replace then lands on the FLOOR entry, and the marker entry is left as a forward entry. The
//     user is at '/', but the tab they came from is GONE from the back stack.
//   immediate signOut (offline / already-signed-out / fast reject): the replace lands on the marker
//     entry FIRST and the queued back() then walks the user one entry BACKWARD — out of '/' and
//     onto a stale authed route, while signed out.
//
// Two mocked orderings, ONE expected outcome. The fix is the same consume-on-navigate gate
// SheetRowLink uses, applied at click time before any await can interleave.
describe('BUG-SIGNOUTBACKRACE-001 — sign out consumes the armed entry, in EITHER ordering', () => {
  const startSignOut = () => {
    fireEvent.click(screen.getByText('Sign out'))          // step 1 of the 2-step confirm
    fireEvent.click(screen.getByText('Yes, sign out'))     // step 2 — fires the async handler
  }

  // The single outcome both orderings must reach: signed out at '/', sheet closed, and the stack
  // collapsed so ONE Back reaches the ORIGINAL tab. atFloor() is the no-stray-entry oracle — the
  // marker entry must have been REUSED as the '/' entry, not left standing beside it.
  const expectLandedCleanly = async () => {
    expect(signOutSpy).toHaveBeenCalledTimes(1)
    expect(moreIsOpen()).toBe(false)
    expect(path()).toBe('/')
    expect(armed()).toBe(false)
    await back()
    expect(path()).toBe('/today')
    expect(atFloor()).toBe(true)
  }

  it('ADVERSARIAL — signOut resolves immediately: no queued back() walks the user off /', async () => {
    signOutSpy.mockResolvedValue(undefined)
    renderNav()
    openMore()
    await flush()
    expect(armed()).toBe(true)

    startSignOut()
    await flush()
    await expectLandedCleanly()
  })

  it('REALISTIC — signOut deferred (network round trip): the tab stays reachable by ONE Back', async () => {
    // A manually-settled promise, so any disarm traversal is GUARANTEED to have run before the
    // navigate. This is the ordering production actually takes, and the one that silently ate the
    // original tab entry.
    let release
    signOutSpy.mockImplementation(() => new Promise((r) => { release = r }))
    renderNav()
    openMore()
    await flush()
    expect(armed()).toBe(true)

    startSignOut()
    await flush()                        // the click-time gate consumed the marker: no traversal
    await act(async () => { release() })
    await flush()
    await expectLandedCleanly()
  })

  it('flag OFF — nothing armed, so the consume gate is inert and the row behaves as shipped', async () => {
    // The gate is `readMarker(history.state)`, the same predicate SheetRowLink uses: with no marker
    // it must not fire, leaving exactly one history write (the post-signOut replace).
    flags.BACKNAV_ENABLED = false
    renderNav()
    openMore()
    await flush()
    expect(armed()).toBe(false)

    const push = vi.spyOn(window.history, 'pushState')
    startSignOut()
    await flush()
    expect(signOutSpy).toHaveBeenCalledTimes(1)
    expect(path()).toBe('/')
    expect(push).not.toHaveBeenCalled()  // no arming, and the row never pushes
    push.mockRestore()
  })
})

describe('ACCEPTANCE 4 — flag OFF keeps the pre-arming fallback, byte for byte', () => {
  it('no marker is written; a row tap is a plain PUSH; Back walks it normally', async () => {
    flags.BACKNAV_ENABLED = false
    renderNav()
    openMore()
    await flush()
    expect(armed()).toBe(false)                  // nothing armed
    expect(atFloor()).toBe(true)

    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByText('Dashboard'))
    await flush()
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
    await flush()
    expect(armed()).toBe(false)
    // Nothing was pushed for the sheet, so this Back consumes the FLOOR entry — exactly the
    // pre-arming behaviour ("Back navigates the underlying tab"). Asserted to have HAPPENED first,
    // because on a floor with nothing beneath it the same "still open" would be a silent no-op.
    const before = pops
    await back()
    expect(pops).toBe(before + 1)
    expect(window.history.state?.__base).toBe(1)
    expect(moreIsOpen()).toBe(true)              // registry never saw the gesture
  })
})

// ── V5-NAVCUSTOM-001 ──────────────────────────────────────────────────────────────────────────────
// Rendered through the REAL prefs chain, so the sheet carries a moved tab (Put-Up), two pins and the
// "Edit tab bar" header door — every kind of navigating control the sheet can now hold.
async function renderWithPrefs(prefs) {
  prefsRef.current = prefs
  localStorage.clear()
  let view
  await act(async () => {
    view = render(
      <BrowserRouter>
        <DismissRegistryProvider>
          <OverlayProvider>
            <PrefsProvider>
              <NavPrefsProvider>
                <BottomNav />
                <Probe />
              </NavPrefsProvider>
            </PrefsProvider>
          </OverlayProvider>
        </DismissRegistryProvider>
      </BrowserRouter>
    )
  })
  return view
}
const EVERY_KIND = { bar_layout: { order: [...DEFAULT_NAV_TABS], hidden: ['put-up'] }, more_pins: ['seeds', 'photos'], can_edit_bar: true }
const sheetEl = () => screen.getByRole('dialog', { name: 'More navigation options' })
const moreButton = () => screen.getByRole('button', { name: 'More navigation options' })
const rowOrder = () => [...sheetEl().querySelectorAll('[data-more-row]')].map(r => r.getAttribute('data-more-row'))

describe('I7 — every rendered row uses up the armed Back entry', () => {
  // For EVERY link the sheet draws — pinned rows, the moved-tab row, home rows and the header door —
  // tapping it navigates by REPLACE (no push), leaves no marker, and ONE Back lands on the tab.
  // KILLING MUTATION: render one kind of row (or the "Edit tab bar" door) with a plain <Link>.
  // RESULT: RED — a push, a stranded marker, and a Back that goes nowhere.
  it('pinned, moved and home rows and the Edit tab bar door: replace, marker gone, one Back home', async () => {
    const probe = await renderWithPrefs(EVERY_KIND)
    fireEvent.click(moreButton())
    await flush()
    const hrefs = within(sheetEl()).getAllByRole('link').map(a => a.getAttribute('href'))
    probe.unmount()
    // Non-vacuity: all four kinds are really in the list.
    expect(hrefs).toEqual(expect.arrayContaining(['/seeds', '/photos', '/put-up', '/admin/config', '/admin', '/dashboard']))
    for (const href of hrefs) {
      layFloor()
      const view = await renderWithPrefs(EVERY_KIND)
      fireEvent.click(moreButton())
      await flush()
      expect(armed(), href).toBe(true)
      const push = vi.spyOn(window.history, 'pushState')
      fireEvent.click(within(sheetEl()).getAllByRole('link').find(a => a.getAttribute('href') === href))
      await flush()
      expect(path(), href).toBe(href)
      expect(push, href).not.toHaveBeenCalled()
      expect(armed(), href).toBe(false)
      push.mockRestore()
      await back()
      expect(path(), href).toBe('/today')
      expect(atFloor(), href).toBe(true)
      view.unmount()
    }
  })

  // The pin button is not a navigation: it writes NOTHING to history, the sheet stays open and
  // armed, and Back still closes it. KILLING MUTATION: make the pin button a link, or put it inside
  // the row's SheetRowLink. RESULT: RED.
  it('the pin toggle writes no history; the sheet stays open and armed; Back still closes it', async () => {
    await renderWithPrefs(EVERY_KIND)
    fireEvent.click(moreButton())
    await flush()
    expect(armed()).toBe(true)
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    await act(async () => { fireEvent.click(within(sheetEl()).getByRole('button', { name: 'Pin Dashboard to the top' })) })
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    push.mockRestore()
    replace.mockRestore()
    expect(moreIsOpen()).toBe(true)
    expect(armed()).toBe(true)
    expect(path()).toBe('/today')
    await back()
    expect(moreIsOpen()).toBe(false)
    expect(atFloor()).toBe(true)
  })
})

describe('I11 — nothing reorders while the sheet is open', () => {
  // KILLING MUTATION: compute the sheet's rows from the live pins instead of the snapshot taken on
  // open. RESULT: RED — Dashboard would jump into Pinned under the thumb.
  it('pinning leaves every row where it was; the next open re-sorts', async () => {
    await renderWithPrefs(EVERY_KIND)
    fireEvent.click(moreButton())
    await flush()
    const before = rowOrder()
    await act(async () => { fireEvent.click(within(sheetEl()).getByRole('button', { name: 'Pin Dashboard to the top' })) })
    await flush()
    expect(rowOrder()).toEqual(before)
    await back()                                  // close with Back, the way Dave does
    expect(moreIsOpen()).toBe(false)
    fireEvent.click(moreButton())
    await flush()
    const pinned = [...screen.getByTestId('more-pinned').querySelectorAll('[data-more-row]')].map(r => r.getAttribute('data-more-row'))
    expect(pinned).toEqual(['seeds', 'photos', 'dashboard'])
  })
})
