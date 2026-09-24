/**
 * src/__tests__/BottomNav.activeState.test.jsx
 *
 * V4-NAVACTIVESTATE-001 — gates for the bottom bar's THIRD active-state channel.
 *
 * WHY THIS FILE EXISTS. The bar shipped signalling the active tab two ways, colour and
 * fontWeight, and both of them ride on the same 0.62rem (9.9px) label — while the 22px glyph
 * above it rendered `variant="filled"` unconditionally and carried no state at all. Every test
 * in the suite stayed green through that, because nothing had an opinion about whether the
 * largest element in a tab says anything about where you are. This file is where that property
 * lives now.
 *
 * The channel under test is an ENCLOSURE behind the glyph: present on the active tab, absent
 * everywhere else. It is deliberately presence-of-an-element rather than a style value, so the
 * assertions below can be written without reference to any colour — which is the same reason
 * the indicator survives greyscale and a peripheral glance.
 *
 * V5-NAVCUSTOM-001 — REWRITTEN, NOT REPAIRED. The bar is a person's layout now (D4), and a tab can
 * move into More. The old file hardcoded four tabs and its own note warned that `slotOf` would THROW
 * on a hidden tab rather than fail an assertion. So the tabs under test are read off the bar that each
 * layout actually renders, and a moved tab's route is asserted to light NOTHING — a moved tab's page
 * is a More-row page, like /dashboard, and the bar has no slot for it.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const { navigateSpy, locationRef, prefsRef } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
  prefsRef: { current: null },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve(null) }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => prefsRef.current),
}))

import BottomNav from '../components/BottomNav.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'
import { DEFAULT_NAV_TABS } from '../lib/navConfig.js'

const INDICATOR = '[data-testid="nav-active-indicator"]'
const nav = () => screen.getByRole('navigation')
// The destination tabs the bar ACTUALLY rendered: every link in the nav. The FAB is a button, and
// More is a button, so neither is a destination.
const renderedTabs = () => [...nav().querySelectorAll('a[href]')]
  .map(a => ({ label: a.textContent, path: a.getAttribute('href'), slot: a }))
const slotOf = (label) => renderedTabs().find(t => t.label === label)?.slot
const indicatorsIn = (el) => el.querySelectorAll(INDICATOR)

// Layouts under test, rendered through the REAL provider chain (first launch: applies at once).
const LAYOUTS = [
  null,
  { order: ['harvests', 'today', 'create', 'put-up', 'garden'], hidden: [] },
  { order: [...DEFAULT_NAV_TABS], hidden: ['put-up'] },
  { order: ['put-up', 'create', 'today', 'garden', 'harvests'], hidden: ['garden', 'harvests'] },
  { order: [...DEFAULT_NAV_TABS], hidden: ['garden', 'harvests', 'put-up'] },
]
async function renderLayout(barLayout) {
  localStorage.clear()
  prefsRef.current = { bar_layout: barLayout, more_pins: null, can_edit_bar: false }
  let view
  await act(async () => {
    view = render(<PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider>)
  })
  return view
}

beforeEach(() => { locationRef.pathname = '/dashboard' })
afterEach(cleanup)

describe('V4-NAVACTIVESTATE-001 — the glyph carries the active state, under every layout', () => {
  // For each layout, each tab it RENDERS: on that tab's route it is lit, and no other slot is.
  // KILLING MUTATION: render the indicator unconditionally, or key it to index instead of route.
  // RESULT: RED.
  it('each rendered tab on its own route shows the indicator, and no other tab does', async () => {
    for (const layout of LAYOUTS) {
      const probe = await renderLayout(layout)
      const tabs = renderedTabs()
      probe.unmount()
      expect(tabs.length, JSON.stringify(layout)).toBeGreaterThanOrEqual(1)
      for (const { label, path } of tabs) {
        locationRef.pathname = path
        const view = await renderLayout(layout)
        for (const other of renderedTabs()) {
          expect(indicatorsIn(other.slot), `${other.label} while on ${path} under ${JSON.stringify(layout)}`)
            .toHaveLength(other.label === label ? 1 : 0)
        }
        view.unmount()
      }
    }
  })

  // THE CASE THE OLD FILE COULD NOT EXPRESS: its `slotOf` threw on a hidden label. On a MOVED tab's
  // own route the bar has no slot to light, so it lights nothing — and must not throw.
  // KILLING MUTATION: draw moved tabs on the bar anyway (bar = order). RESULT: RED — one lit slot.
  it('on a MOVED tab’s route the bar lights nothing, and nothing throws', async () => {
    for (const [moved, path] of [['put-up', '/put-up'], ['garden', '/garden'], ['harvests', '/harvests/2026']]) {
      locationRef.pathname = path
      const view = await renderLayout({ order: [...DEFAULT_NAV_TABS], hidden: [moved] })
      expect(indicatorsIn(nav()), `${path} with ${moved} moved`).toHaveLength(0)
      expect(renderedTabs().map(t => t.path)).not.toContain(path.split('/').slice(0, 2).join('/'))
      view.unmount()
    }
  })

  // Non-vacuity, and the property that makes the whole file meaningful: on a route that is not
  // a tab, the bar draws its glyphs and ZERO indicators. Without this, an indicator wired to
  // render unconditionally — which is exactly the bug the glyph had before this item — would
  // satisfy every "the active tab has one" assertion above.
  it('draws no indicator at all on a non-tab route, while still drawing every glyph', () => {
    const { container } = render(<BottomNav />)
    expect(indicatorsIn(nav())).toHaveLength(0)
    expect(container.querySelectorAll('nav svg').length).toBeGreaterThanOrEqual(6)
  })

  // The item is a GLYPH-level backstop, not a bar-level one: the indicator has to sit in the
  // glyph's own box, or it is a second thing to look at rather than a state on the thing that is
  // already the most salient element in the tab.
  it('sits in the glyph box, as a sibling of that tab’s own svg', () => {
    locationRef.pathname = '/garden'
    render(<BottomNav />)
    const indicator = slotOf('Garden').querySelector(INDICATOR)
    expect(indicator).toBeTruthy()
    expect(indicator.parentElement.querySelector('svg')).toBeTruthy()
    // …and the label is NOT inside that box — the enclosure wraps the glyph, not the tab.
    expect(indicator.parentElement.textContent).toBe('')
  })

  it('moves with the route rather than sticking to the first-rendered tab', () => {
    locationRef.pathname = '/today'
    const first = render(<BottomNav />)
    expect(indicatorsIn(slotOf('Today'))).toHaveLength(1)
    locationRef.pathname = '/harvests'
    first.rerender(<BottomNav />)
    expect(indicatorsIn(slotOf('Today'))).toHaveLength(0)
    expect(indicatorsIn(slotOf('Harvests'))).toHaveLength(1)
  })

  // Nested routes are active too — /garden/abc is still the Garden tab (isActive's prefix arm).
  it('stays lit on a nested route under the tab', () => {
    locationRef.pathname = '/harvests/2026'
    render(<BottomNav />)
    expect(indicatorsIn(slotOf('Harvests'))).toHaveLength(1)
    expect(indicatorsIn(slotOf('Garden'))).toHaveLength(0)
  })

  // More takes the same two label channels from `showMore` that the destinations take from
  // `active`, so it takes the third one too. A tab that goes green-and-bold with no indicator
  // reads as a bug rather than as a rule.
  it('More gets the indicator while its sheet is open, and not before', () => {
    render(<BottomNav />)
    const more = screen.getByLabelText('More navigation options')
    expect(indicatorsIn(more)).toHaveLength(0)
    fireEvent.click(more)
    expect(indicatorsIn(more)).toHaveLength(1)
  })
})

describe('V4-NAVACTIVESTATE-001 — what the indicator must not cost', () => {
  // It is absolutely positioned precisely so a tab becoming active reflows nothing: no glyph
  // moves, nothing jumps inside a 56px bar. A future edit that drops this to a normal-flow box
  // would look identical in a screenshot and shift the whole bar on every navigation.
  it('is out of flow and untappable', () => {
    locationRef.pathname = '/today'
    render(<BottomNav />)
    const s = slotOf('Today').querySelector(INDICATOR).style
    expect(s.position).toBe('absolute')
    expect(s.pointerEvents).toBe('none')
  })

  // The standing rule this item had to work around, pinned so the next session does not "simplify"
  // the indicator away by tinting the glyph instead: a multi-region colour glyph re-tinted by tab
  // state collapses every region to one hue. The active and inactive glyph must be the same ink.
  it('does not re-tint the glyph: active and inactive draw identical markup', () => {
    locationRef.pathname = '/today'
    const { unmount } = render(<BottomNav />)
    const activeMarkup = slotOf('Today').querySelector('svg').innerHTML
    unmount()
    locationRef.pathname = '/dashboard'
    render(<BottomNav />)
    const inactiveMarkup = slotOf('Today').querySelector('svg').innerHTML
    expect(activeMarkup).toBe(inactiveMarkup)
    // Non-vacuous: this is the coloured `filled` variant, not a mono fallback that trivially matches.
    expect(activeMarkup).toMatch(/#[0-9a-f]{6}/i)
  })
})
