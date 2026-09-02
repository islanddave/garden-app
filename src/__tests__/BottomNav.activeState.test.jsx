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
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'

const { navigateSpy, locationRef } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
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

import BottomNav from '../components/BottomNav.jsx'

const INDICATOR = '[data-testid="nav-active-indicator"]'
// label -> the route that makes that tab active. The FAB has no route and is not a destination.
const TABS = [['Today', '/today'], ['Garden', '/garden'], ['Harvests', '/harvests'], ['Put-Up', '/put-up']]

const slotOf = (label) => within(screen.getByRole('navigation')).getByText(label).parentElement
const indicatorsIn = (el) => el.querySelectorAll(INDICATOR)

beforeEach(() => { locationRef.pathname = '/dashboard' })
afterEach(cleanup)

describe('V4-NAVACTIVESTATE-001 — the glyph carries the active state', () => {
  it.each(TABS)('%s on its own route shows the indicator, and no other tab does', (label, path) => {
    locationRef.pathname = path
    render(<BottomNav />)
    for (const [other] of TABS) {
      expect(indicatorsIn(slotOf(other)), `${other} while on ${path}`)
        .toHaveLength(other === label ? 1 : 0)
    }
  })

  // Non-vacuity, and the property that makes the whole file meaningful: on a route that is not
  // a tab, the bar draws its six glyphs and ZERO indicators. Without this, an indicator wired to
  // render unconditionally — which is exactly the bug the glyph had before this item — would
  // satisfy every "the active tab has one" assertion above.
  it('draws no indicator at all on a non-tab route, while still drawing every glyph', () => {
    const { container } = render(<BottomNav />)
    expect(indicatorsIn(screen.getByRole('navigation'))).toHaveLength(0)
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
