/**
 * src/__tests__/BottomNav.test.jsx
 * NAV-IA-1 (V1.2a-3 Increment C / PR-C1, 2026-05-18) tests.
 *
 * Verifies the V3-IA 5-slot bottom-nav layout (Garden · Critters · +LOG · Photos · More;
 * Inventory demoted to the More menu) plus the Sign Out confirmation flow.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

const { signOutSpy, navigateSpy, locationRef } = vi.hoisted(() => ({
  signOutSpy: vi.fn(() => Promise.resolve()),
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
}))

// V4-HARVFAB-001 — the Link mock now SERIALIZES `state.background` into a data attribute. Without
// it "opens as an overlay" had no observable in jsdom at all: OverlayLink and Link both render an
// <a href>, so a route silently dropping out of OVERLAYABLE_CREATE — the exact-string trap that
// makes a query-string route fall through to a full-page navigation — was untestable. `state` is
// stripped from the spread either way so React never sees it as a DOM attribute.
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => (
    <a
      href={typeof to === 'string' ? to : '#'}
      data-overlay-bg={state?.background ? String(state.background.pathname) : undefined}
      {...rest}
    >{children}</a>
  ),
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user:    { id: 'user-1' },
    profile: { display_name: 'Dave', email: 'islanddave@gmail.com' },
    signOut: signOutSpy,
  }),
}))

// V1.2a-4 S1: CatchUpBadge child uses useApiFetch (Clerk-dependent). Stub it here;
// CatchUpBadge has its own test suite.
vi.mock('../components/CatchUpBadge.jsx', () => ({
  default: () => null,
}))

// MVP-Critter Session 2: BottomNavDot child fetches /api/critters/active — stubbed here
// to keep BottomNav tests focused. BottomNavDot has its own test suite.
vi.mock('../components/BottomNavDot.jsx', () => ({
  default: () => null,
}))

// useApiFetch wraps Clerk; stub returns a no-op getToken so BottomNav can mount in tests.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({
    fetch: () => Promise.resolve(null),
    getToken: () => Promise.resolve(null),
  }),
}))

// useMode requires a ModeProvider ancestor; this suite renders <BottomNav /> bare.
// Desk mode (isField:false) is the default surface these tests exercise (Create
// sheet + More menu). Field-mode behavior has dedicated coverage in BottomNav.modeSwap.test.jsx.
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav, { BOTTOM_NAV_HEIGHT_PX } from '../components/BottomNav.jsx'
import { TOAST_BOTTOM } from '../components/forms/Toast.jsx'

beforeEach(() => {
  signOutSpy.mockClear()
  navigateSpy.mockClear()
  locationRef.pathname = '/dashboard'
})

describe('BottomNav — V3-IA layout', () => {
  // V4-NAVHARVEST-001 (2026-08-10): the 4th tab is Harvests, not DrG. DrG is DEMOTED into the
  // More menu, never removed — the "still reachable" assertion below is the load-bearing half of
  // this change, and a demote that quietly became a deletion is exactly what it guards.
  it('renders Today + Garden + Create + Harvests + Put-Up + More (V200 nav; Critters + Photos folded into More)', () => {
    render(<BottomNav />)
    expect(screen.getByText('Today')).toBeDefined()
    expect(screen.getByText('Garden')).toBeDefined()
    expect(screen.getByLabelText('Create')).toBeDefined()
    expect(screen.getByText('Harvests')).toBeDefined()
    // V4-PUTUPENGINE-001 — Put-Up is the 5th tab, promoted out of the More sheet.
    expect(screen.getByText('Put-Up')).toBeDefined()
    expect(screen.getByText('More')).toBeDefined()
    // DrG is no longer a first-class tab.
    expect(screen.queryByText('DrG')).toBeNull()
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Plants')).toBeNull()
    expect(screen.queryByText('Inventory')).toBeNull()
    // Critters + Photos are no longer first-class tabs (folded into More — V200/V4-THEME-001).
    expect(screen.queryByText('Critters')).toBeNull()
    expect(screen.queryByText('Photos')).toBeNull()
  })

  // V4-PUTUPENGINE-001 — the slot count moves 5 -> 6. This assertion IS the tab bar's only cap
  // (the "4 IS THE CAP" note lives on CREATE_ACTIONS and governs the FAB sheet, not TABS), so
  // widening it is a deliberate act, not a test repair: an add-without-displacement, taken because
  // nothing in the previous four is displaceable for put-up. Keep it exact — a 7th slot should
  // have to argue for itself here the same way this one did.
  it('FAB keeps the center slot: tab order is Today · Garden · ＋ · Harvests · Put-Up · More', () => {
    render(<BottomNav />)
    const nav = screen.getByLabelText('Main navigation')
    expect(nav.children.length).toBe(6)
    expect(nav.children[0].textContent).toContain('Today')
    expect(nav.children[1].textContent).toContain('Garden')
    expect(nav.children[2].getAttribute('aria-label')).toBe('Create')
    expect(nav.children[3].textContent).toContain('Harvests')
    expect(nav.children[4].textContent).toContain('Put-Up')
    expect(nav.children[5].textContent).toContain('More')
  })

  it('does NOT render Dashboard in the bottom nav (dropped per 2026-05-15 adjustment)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('does NOT render Favorites in the bottom nav (moved to TopBar)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Favorites')).toBeNull()
  })

  it('tab links point to correct routes', () => {
    render(<BottomNav />)
    expect(screen.getByText('Today').closest('a').getAttribute('href')).toBe('/today')
    expect(screen.getByText('Garden').closest('a').getAttribute('href')).toBe('/garden')
    expect(screen.getByText('Harvests').closest('a').getAttribute('href')).toBe('/harvests')
    expect(screen.getByText('Put-Up').closest('a').getAttribute('href')).toBe('/put-up')
    // Create is not a direct link — it's a button that opens the create action sheet.
    const logBtn = screen.getByLabelText('Create')
    expect(logBtn.tagName).toBe('BUTTON')
    expect(logBtn.getAttribute('aria-haspopup')).toBe('true')
  })
})

// V4-PUTUPENGINE-001 — Dave 2026-08-20: "I'm just gonna go to a put up tab and start there the same
// way I'm going to the harvest tab … that is its own process that deserves its own landing page."
// The claim under test is REACHABILITY AT A LEVEL, not the existence of a link: `/put-up` had a link
// before this change too — two taps down, inside the More sheet — so any assertion that merely finds
// an href somewhere in the document passes identically before and after and proves nothing.
describe('BottomNav — Put-Up is a first-class tab (V4-PUTUPENGINE-001)', () => {
  it('reaches /put-up from the nav bar itself, with the More sheet never opened', () => {
    render(<BottomNav />)
    // Sign out is the deterministic signal that the sheet is CLOSED (it renders only when open),
    // so anything found below is in the bar, not behind a menu.
    expect(screen.queryByText('Sign out')).toBeNull()
    const nav = screen.getByLabelText('Main navigation')
    const link = within(nav).getByText('Put-Up').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/put-up')
    expect(nav.contains(link)).toBe(true)
  })

  it('opens /put-up as a full-page landing, not as an overlay flyover', () => {
    // The structural half of "its own landing page". The More row it replaces was an OverlayLink —
    // a flyover over whatever page you were already on. A tab that flew over would satisfy the
    // reachability test above and still not be a landing page.
    render(<BottomNav />)
    const nav = screen.getByLabelText('Main navigation')
    expect(within(nav).getByText('Put-Up').closest('a').getAttribute('data-overlay-bg')).toBeNull()
    // CONTROL — without this the null above could just mean the mock serializes nothing at all.
    // The create sheet's /log row is an overlay under the SAME mock and must read '/dashboard'.
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('a').getAttribute('data-overlay-bg')).toBe('/dashboard')
  })

  it('does NOT duplicate Put-Up in the More menu now that it is a tab', () => {
    // Same door-count rule V4-NAVHARVEST-001 applied to Harvests: promote, do not duplicate. Counted
    // with the sheet OPEN, which is the only state where a leftover row could still be hiding.
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const putUpLinks = screen.getAllByText('Put-Up').map(n => n.closest('a')).filter(Boolean)
    expect(putUpLinks).toHaveLength(1)
    expect(putUpLinks[0].getAttribute('href')).toBe('/put-up')
    expect(screen.getByLabelText('Main navigation').contains(putUpLinks[0])).toBe(true)
  })
})

// V4-SOWMOREMENU-001 (BD-067) — Dave could not find Sow Now at all and asked for it as "its own
// listing in the more menu". Two separate things are pinned here and they fail for different
// reasons: that the row EXISTS at top level (the thing he asked for), and that adding it did NOT
// cost the pre-existing doors (the scope guard on the row — he never asked to consolidate).
describe('BottomNav — Sow now in the More menu', () => {
  it('lists Sow now as a TOP-LEVEL More row, not nested under Inventory', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Sow now').closest('a')
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/sow')
    // Sibling of the Inventory row, not a descendant of it — "nested under Inventory" is the exact
    // placement Dave rejected, and a nested row would still satisfy a bare getByText.
    const inventory = screen.getByText('Inventory').closest('a')
    expect(inventory.contains(link)).toBe(false)
  })

  it('keeps the create-sheet Sow from seed action — the More row is additive', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    const fabSow = screen.getByText('Sow from seed').closest('a')
    expect(fabSow).toBeTruthy()
    expect(fabSow.getAttribute('href')).toBe('/sow')
  })
})

describe('BottomNav — More menu', () => {
  it('More menu is closed by default', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Sign out')).toBeNull()
  })

  it('clicking More opens the menu and shows Sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('shows signed-in identity in the More menu', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Dave')).toBeDefined()
  })

  it('Achievements is not visible until More is opened (NAV-REGRESSION restore, 2026-05-22)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Achievements')).toBeNull()
  })

  it('More menu shows the Achievements link pointing to /achievements', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Achievements').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/achievements')
  })

  it('More menu shows the Inventory link pointing to /inventory (V3-IA demotion)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Inventory').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/inventory')
  })

  // V4-NAVHARVEST-001 — Harvests was PROMOTED out of this menu into the tab bar. The old test here
  // asserted a More row via getByText('Harvests'), which would now pass VACUOUSLY by matching the
  // tab. Assert the door count instead: exactly one Harvests link exists with the menu OPEN.
  it('does NOT duplicate Harvests in the More menu now that it is a tab', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const harvestLinks = screen.getAllByText('Harvests').map(n => n.closest('a')).filter(Boolean)
    expect(harvestLinks).toHaveLength(1)
    expect(harvestLinks[0].getAttribute('href')).toBe('/harvests')
  })

  // The load-bearing half of the demote: DrG loses the tab but keeps a door. If this goes red,
  // the change has silently become a deletion and /findings is unreachable from the nav.
  it('More menu shows the DrG link pointing to /findings (V4-NAVHARVEST-001 demotion)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('DrG').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/findings')
  })

  it('More menu shows the Dashboard link pointing to /dashboard (DRG-TODAY-003 demotion)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Dashboard').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/dashboard')
  })

  it('More menu houses Critters (/collection) and Photos (/photos), folded in from the nav (V200)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByText('Plants')).toBeNull()
    const photos = screen.getAllByText('Photos')
    expect(photos.length).toBe(1)
    expect(photos[0].closest('a').getAttribute('href')).toBe('/photos')
    const critters = screen.getAllByText('Critters')
    expect(critters.length).toBe(1)
    expect(critters[0].closest('a').getAttribute('href')).toBe('/collection')
  })


  it('More menu shows the Garden Helper link pointing to /helper (Post-V2 UX overhaul Inc 2 Bite 1, 2026-05-28)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Garden Helper').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/helper')
  })

  // Slice 9 (V4-THEME-001): Field/Desk mode mirror row in the More menu.
  it('More menu shows the Field/Desk mode mirror row (useMode mock = desk)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('View mode')).toBeDefined()
    expect(screen.getByText('Desk')).toBeDefined()
  })

  it('does NOT render the Catch-up badge container (hidden 2.0.1 until S1.1 editor ships)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByTestId('catch-up-nav-item')).toBeNull()
  })
})

describe('BottomNav — Sign Out confirmation flow', () => {
  it('first click on Sign out shows confirmation, does NOT sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    expect(screen.getByText('Sign out of your account?')).toBeDefined()
    expect(screen.getByText('Cancel')).toBeDefined()
    expect(screen.getByText('Yes, sign out')).toBeDefined()
    expect(signOutSpy).not.toHaveBeenCalled()
  })

  it('Cancel reverts confirmation, leaves user signed in', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Sign out of your account?')).toBeNull()
    expect(signOutSpy).not.toHaveBeenCalled()
    // After cancel, Sign out button should be back
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('confirming Yes, sign out calls signOut and navigates to /', async () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, sign out'))
    })
    expect(signOutSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true })
  })
})

describe('BottomNav — +LOG create action sheet (Increment 1 FAB)', () => {
  it('create sheet is closed by default', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Add a planting')).toBeNull()
    expect(screen.getByLabelText('Create').getAttribute('aria-expanded')).toBe('false')
  })

  it('clicking +LOG opens the sheet with the four create options', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    // V4-HARVFABREMOVE-001 (BD-028): Log harvest is GONE from the sheet — it lives in TopChrome now.
    expect(screen.queryByText('Log harvest')).toBeNull()
    expect(screen.getByText('Log an event')).toBeDefined()
    expect(screen.getByText('Log many')).toBeDefined()
    expect(screen.getByText('Add a planting')).toBeDefined()
    // V4-SOWFAB-001: Sow from seed is the 4th action (/sow was URL-only before).
    expect(screen.getByText('Sow from seed')).toBeDefined()
    // Slice 9: New project + Add inventory dropped from the FAB.
    expect(screen.queryByText('New project')).toBeNull()
    expect(screen.queryByText('Add inventory')).toBeNull()
    expect(screen.getByLabelText('Create').getAttribute('aria-expanded')).toBe('true')
  })

  // THE BUDGET GUARD. This REPLACES an assertion that read
  //   getAllByRole('link').filter(a => ALLOWED_HREFS.includes(a.href)).length <= 4
  // which was vacuous against the only change it could ever need to catch: a NEW action's href is
  // by definition not in the allow-list, so it was filtered out before being counted and a 5th,
  // 6th, or 20th row all passed. (The recon for this slice claimed the opposite; the crucible's qa
  // and regression seats independently inverted it, and the pre-change suite confirmed it by
  // staying green after Log harvest landed.) Counting EVERY row by testid is the form that fails.
  it('renders exactly four create actions — 4 is a hard cap, not a starting point', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getAllByTestId('create-action')).toHaveLength(4)
  })

  // V4-HARVFABREMOVE-001: the row is gone, so the guard inverts — absence is now the contract, and
  // a "helpful" re-add beside the header action is the regression this catches. Asserted by testid
  // count AND by href, because a re-add under a different label would slip a text-only check.
  it('has NO harvest row — the harvest action lives in TopChrome (BD-028)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.queryByText('Log harvest')).toBeNull()
    const hrefs = screen.getAllByTestId('create-action').map(a => a.getAttribute('href'))
    expect(hrefs.some(h => h && h.includes('event_type=harvest'))).toBe(false)
  })

  it('puts Log an event FIRST now that harvest has vacated slot 1', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    const labels = screen.getAllByTestId('create-action').map(row => row.textContent)
    expect(labels[0]).toContain('Log an event')
    expect(labels[1]).toContain('Log many')
  })

  it('each create option points to the correct route', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('a').getAttribute('href')).toBe('/log')
    expect(screen.getByText('Log many').closest('a').getAttribute('href')).toBe('/log/many')
    expect(screen.getByText('Add a planting').closest('a').getAttribute('href')).toBe('/garden?add=1')
    expect(screen.getByText('Sow from seed').closest('a').getAttribute('href')).toBe('/sow')
  })

  it('opens the log rows as OVERLAYS — not as full-page navigations', () => {
    // OVERLAYABLE_CREATE matches action.to by EXACT STRING, so a query-string route that is not
    // listed verbatim degrades silently: same link, same href, same test result, different UX.
    // The background-state attribute is the only thing that tells the two apart. (The harvest row
    // that used to anchor this case is gone — TopChrome.test.jsx now pins the same property for
    // the header action that replaced it.)
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('a').getAttribute('data-overlay-bg')).toBe('/dashboard')
    expect(screen.getByText('Log many').closest('a').getAttribute('data-overlay-bg')).toBe('/dashboard')
    // The control reading — /garden?add=1 is a PAGE by design (Slice 3), so it carries no
    // background. Without this half, an OverlayLink-everywhere mutation would pass.
    expect(screen.getByText('Add a planting').closest('a').getAttribute('data-overlay-bg')).toBeNull()
    expect(screen.getByText('Sow from seed').closest('a').getAttribute('data-overlay-bg')).toBeNull()
  })

  it('Log an event reclaims "harvest" in its sub-copy now that the dedicated row is gone', () => {
    // The inverse of the V4-HARVFAB-001 assertion this replaces. That change stripped "harvest"
    // from this sub-copy because two harvest-scented rows in one sheet is a worse sheet than
    // either alone; with the dedicated row removed, the reason is gone and the sheet must not be
    // left silently claiming you cannot log a harvest from "Log an event" — you can.
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('[data-testid="create-action"]').textContent)
      .toMatch(/harvest/i)
    expect(screen.getByText('A harvest, watering, a note…')).toBeDefined()
  })

  it('selecting an option closes the sheet', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    fireEvent.click(screen.getByText('Add a planting'))
    expect(screen.queryByText('Log an event')).toBeNull()
  })

  it('opening More closes the create sheet (mutually exclusive)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Add a planting')).toBeDefined()
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByText('Add a planting')).toBeNull()
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('opening create closes the More menu (mutually exclusive)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Sign out')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.queryByText('Sign out')).toBeNull()
    expect(screen.getByText('Add a planting')).toBeDefined()
  })
})

// MVP-Critter Session 4 Phase A — Settings entry placement.
describe('Settings entry in More menu', () => {
  it('renders Settings link between Garden Helper and Sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const settings = screen.getByText('Settings')
    expect(settings).toBeDefined()
    expect(settings.closest('a').getAttribute('href')).toBe('/settings')

    // Order check: in DOM order Garden Helper precedes Settings precedes Sign out.
    const helperEl = screen.getByText('Garden Helper')
    const signoutEl = screen.getByText('Sign out')
    const all = Array.from(document.querySelectorAll('a, button'))
    const helperIdx = all.findIndex(el => el.contains(helperEl))
    const settingsIdx = all.findIndex(el => el.contains(settings))
    const signoutIdx = all.findIndex(el => el.contains(signoutEl))
    expect(helperIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(helperIdx)
    expect(signoutIdx).toBeGreaterThan(settingsIdx)
  })

  it('clicking Settings closes the More menu', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Settings')).toBeDefined()
    fireEvent.click(screen.getByText('Settings'))
    // Sign out vanishes when menu closes (deterministic signal the menu collapsed).
    expect(screen.queryByText('Sign out')).toBeNull()
  })
})

// The nav owns --bottom-nav-height. Hardcoding 56px at :root reserved space for a nav that only
// renders when signed in, so on the sign-in and public-share screens a toast — and UpdateBanner,
// which renders regardless of auth by design — floated ~56px above the bottom edge over nothing.
describe('--bottom-nav-height ownership', () => {
  const navVar = () => document.documentElement.style.getPropertyValue('--bottom-nav-height')

  it('sets the variable to the nav height while mounted, and clears it to 0px on unmount', () => {
    document.documentElement.style.removeProperty('--bottom-nav-height')
    const { unmount } = render(<BottomNav />)
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    unmount()
    expect(navVar()).toBe('0px')          // signed-out surfaces reserve nothing
  })

  it('renders its own height from the constant, not from the variable it sets', () => {
    // Reading the var it owns would make the first frame lay out against 0px.
    render(<BottomNav />)
    const nav = screen.getByRole('navigation', { name: /main navigation/i })
    expect(nav.style.height).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    expect(nav.style.height).not.toContain('var(')
  })

  it('TOAST_BOTTOM resolves to a bare safe-area offset once the nav is gone', () => {
    // The property that actually regressed: with no nav, the toast must not reserve 56px.
    const { unmount } = render(<BottomNav />)
    unmount()
    expect(navVar()).toBe('0px')
    expect(TOAST_BOTTOM).toContain('var(--bottom-nav-height, 0px)')
  })
})
