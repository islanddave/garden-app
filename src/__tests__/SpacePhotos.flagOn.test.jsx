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
// PARTIAL mock (importOriginal spread): the enumerated form broke on every new flag added
// anywhere in featureFlags.js — most recently DISMISS_REGISTRY_ENABLED, which Sheet reads.
// Only SPACE_PHOTOS_ENABLED is actually under test here; the rest now track prod.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  SPACE_PHOTOS_ENABLED: true,
  OVERLAY_ROUTES_ENABLED: true,
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
    // 51 shipped (incl. /admin/voice-debug and /settings/controls, excl. /zone — deleted in
    // V4-AMBIENTZONE-001) + 2
    // 54 -> 55: V4-ARCHIVEBROWSE-001 adds /plantings/archived, flag-independent (see the flag-OFF
    // counterpart, which moves 52 -> 53 for the same route).
    // 55 -> 56: V5-HARVESTVOICEFLOW-001 adds /log/voice, flag-independent (see the flag-OFF
    // counterpart, which moves 53 -> 54 for the same route).
    // 56 -> 57: V4-SEEDSAVEFLOW-001 adds /seeds/saved, flag-independent (see the flag-OFF
    // counterpart, which moves 54 -> 55 for the same route).
    // 57 -> 58: V5-HARVESTONEDOOR-001 adds /log/harvest, the combined harvest page. Also
    // flag-independent — it has nothing to do with SPACE_PHOTOS_ENABLED; it moves both counts by
    // one because it is an unconditional route, which is exactly why this pair is asserted on both
    // sides of the flag rather than once.
    expect(paths).toHaveLength(58)
    expect(new Set(paths).size).toBe(58)
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
