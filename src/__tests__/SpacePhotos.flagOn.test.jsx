// SpacePhotos.flagOn.test.jsx — V4-SPACEPHOTO-001 Lane C. The counterpart to
// SpacePhotos.flagOff.test.jsx: it proves those inertness assertions are not passing VACUOUSLY.
// Every surface the off-suite asserts is absent must be asserted PRESENT here with the flag
// mocked true — otherwise a typo'd import or a dead branch would read as "correctly inert".
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { navigateSpy, locationRef } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
}))

// Full flag surface, SPACE_PHOTOS_ENABLED flipped. The other values mirror the shipped defaults so
// nothing else in App.jsx / BottomNav changes shape under this mock.
vi.mock('../lib/featureFlags.js', () => ({
  SPACE_PHOTOS_ENABLED: true,
  OVERLAY_ROUTES_ENABLED: true,
  PROJECTS_HIDDEN: false,
  CATCH_UP_EDITOR_SHIPPED: false,
  IMAGE_LIST_CACHE_ENABLED: true,
  PLANTING_REQUIRED_ENABLED: false,
  SYSTEM_NOTIFICATIONS_ENABLED: false,
  EVENTNEW_ADD_DETAILS_EXPANDED: false,
  CARE_RAIN_CREDIT_ENABLED: false,
  CARE_RAIN_MAXDAYS_ENABLED: false,
  VARIETY_REF_UI_SHIPPED: false,
}))
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
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
  apiFetch: () => Promise.resolve(null),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav from '../components/BottomNav.jsx'

beforeEach(() => { document.body.innerHTML = '' })

// V4-SPACECLIENTGAP-001: THE shipped-value pin, and the only one in the suite. Both flag files now
// mock the constant, so without this nothing would notice the flag being flipped back by accident —
// every test would keep passing against its own mock while the app shipped dark. `importActual`
// deliberately bypasses this file's own mock to read the real module.
// If a rollback is INTENTIONAL, this line is the one to change, and changing it should feel like a
// decision rather than a test fix.
describe('the shipped flag value', () => {
  it('is TRUE in src/lib/featureFlags.js — the space surface ships live', async () => {
    const actual = await vi.importActual('../lib/featureFlags.js')
    expect(actual.SPACE_PHOTOS_ENABLED).toBe(true)
  })
})

describe('flag ON — the /space routes appear', () => {
  it('registers both the single-space and the :spaceId form, and only those two', async () => {
    const { renderRoutes } = await import('../App.jsx')
    const paths = renderRoutes({ overlay: false, user: true }).map(r => r.props.path)
    expect(paths).toContain('/space')
    expect(paths).toContain('/space/:spaceId')
    expect(paths).toHaveLength(50)          // 48 shipped + 2
    expect(new Set(paths).size).toBe(50)
  })

  it('adds nothing to the overlay tree (the space page is a full page, not a flyover)', async () => {
    const { renderRoutes } = await import('../App.jsx')
    const overlayPaths = renderRoutes({ overlay: true, user: true }).map(r => r.props.path)
    expect(overlayPaths.sort()).toEqual(['/log', '/log/many', '/put-up', '/search'])
  })
})

describe('flag ON — the More sheet gains a Space row and disambiguates the zones row', () => {
  function openMore() {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
  }

  it('adds a "Space" row pointing at /space', () => {
    openMore()
    expect(screen.getByText('Space').closest('a').getAttribute('href')).toBe('/space')
  })

  it('relabels the /locations row "Zones" so no two rows read as the same tier', () => {
    openMore()
    expect(screen.getByText('Zones').closest('a').getAttribute('href')).toBe('/locations')
    expect(screen.queryByText('Spaces')).toBeNull()
  })

  it('keeps /locations reachable — the Space row does not steal its only nav entry', () => {
    openMore()
    expect(document.querySelector('a[href="/locations"]')).toBeTruthy()
  })

  it('places Space ABOVE the zones row (the property comes before its zones)', () => {
    openMore()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs.indexOf('/space')).toBeLessThan(hrefs.indexOf('/locations'))
  })
})
