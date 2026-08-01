// SpacePhotos.flagOff.test.jsx — V4-SPACEPHOTO-001 Lane C INERTNESS proof.
//
// The backing columns (photos.space_id, spaces.featured_photo_id) do not exist in prod —
// migrations/v4-spacephoto-001 is authored but UNAPPLIED — so SPACE_PHOTOS_ENABLED=false is the
// only thing that makes this code promote-safe. These tests fail loudly if the flag is flipped or
// if any surface leaks out from behind it. Every assertion is mechanical (route table, rendered
// nav rows), not a screenshot claim.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { navigateSpy, locationRef } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
}))

// Partial mock: BottomNav renders bare (no Router), so Link/useLocation/useNavigate are stubbed —
// but App.jsx's route table constructs <Navigate>/<Route> elements, so the rest must stay real.
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
  // App.jsx pulls in the upload stack transitively; useUploadPhoto reads apiFetch at module scope.
  apiFetch: () => Promise.resolve(null),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav from '../components/BottomNav.jsx'
import { SPACE_PHOTOS_ENABLED } from '../lib/featureFlags.js'
import { resolveSpaceId, spaceHeroPath, isPinnedFeatured } from '../lib/spaceId.js'

beforeEach(() => { document.body.innerHTML = '' })

describe('SPACE_PHOTOS_ENABLED — the flag itself', () => {
  it('ships FALSE (the columns it depends on are not in prod yet)', () => {
    expect(SPACE_PHOTOS_ENABLED).toBe(false)
  })
})

describe('flag OFF — the /space routes are ABSENT from the table, not merely redirected', () => {
  it('renderRoutes exposes no /space path at all', async () => {
    const { renderRoutes } = await import('../App.jsx')
    const paths = renderRoutes({ overlay: false, user: true }).map(r => r.props.path)
    expect(paths).not.toContain('/space')
    expect(paths).not.toContain('/space/:spaceId')
    // A visit to /space therefore falls through to the pre-existing '*' catch-all, exactly as today.
    expect(paths).toContain('*')
  })

  it('adds NO route to the overlay tree either', async () => {
    const { renderRoutes } = await import('../App.jsx')
    const overlayPaths = renderRoutes({ overlay: true, user: true }).map(r => r.props.path)
    expect(overlayPaths.sort()).toEqual(['/log', '/log/many', '/put-up', '/search'])
  })
})

describe('flag OFF — the More sheet is byte-identical to today', () => {
  function openMore() {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
  }

  it('renders NO "Space" row', () => {
    openMore()
    expect(screen.queryByText('Space')).toBeNull()
    expect(document.querySelector('a[href="/space"]')).toBeNull()
  })

  it('keeps the shipped "Spaces" row pointing at /locations, un-relabelled', () => {
    openMore()
    const row = screen.getByText('Spaces')
    expect(row.closest('a').getAttribute('href')).toBe('/locations')
    expect(screen.queryByText('Zones')).toBeNull()
  })
})

describe('space id resolution', () => {
  it('falls back to the id resolved by the id-free discovery read (VITE_SPACE_ID is gone)', () => {
    expect(resolveSpaceId(undefined, { space_id: 'space-7' })).toBe('space-7')
    expect(resolveSpaceId('', { space_id: 'space-7' })).toBe('space-7')
  })

  it('lets a route param win, so a second space needs a link and not a code change', () => {
    expect(resolveSpaceId('space-9', { space_id: 'space-7' })).toBe('space-9')
  })

  it('resolves to null when nothing supplies an id — the zero-space empty state, not a bad request', () => {
    expect(resolveSpaceId(undefined, null)).toBe(null)
    expect(resolveSpaceId(undefined, undefined)).toBe(null)
    // The zero-space 200 body: present, but every field null.
    expect(resolveSpaceId(undefined, { space_id: null, household_space_count: 0 })).toBe(null)
  })
})

describe('spaceHeroPath — /space-hero/undefined is unconstructible', () => {
  it('emits the id-free DISCOVERY form for every non-id value', () => {
    for (const v of [undefined, null, '', '   ', 0, false, {}]) {
      expect(spaceHeroPath(v)).toBe('/api/photos/space-hero')
    }
  })

  it('emits the by-id form for a real route param, url-encoded', () => {
    expect(spaceHeroPath('space-9')).toBe('/api/photos/space-hero/space-9')
    expect(spaceHeroPath('a/b')).toBe('/api/photos/space-hero/a%2Fb')
  })
})

describe('isPinnedFeatured — the set-featured no-op guard', () => {
  const ID = 'ph1'
  it('is TRUE only for an id match that the server marked explicit', () => {
    expect(isPinnedFeatured({ featured_photo_id: ID, featured_is_explicit: true }, ID)).toBe(true)
  })

  it('is FALSE on an id match the server did NOT mark explicit — the silently-reverting case', () => {
    // spaces.featured_photo_id is NULL / soft-deleted / foreign, so the hero is the newest-photo
    // fallback. Treating this as "already featured" is exactly the bug featured_is_explicit exists
    // to kill: the PUT must still fire.
    expect(isPinnedFeatured({ featured_photo_id: ID, featured_is_explicit: false }, ID)).toBe(false)
    // A response that somehow omits the field is treated as NOT pinned — fail toward persisting.
    expect(isPinnedFeatured({ featured_photo_id: ID }, ID)).toBe(false)
  })

  it('is FALSE for a different photo, a heroless space, and a missing hero', () => {
    expect(isPinnedFeatured({ featured_photo_id: ID, featured_is_explicit: true }, 'ph2')).toBe(false)
    expect(isPinnedFeatured({ featured_photo_id: null, featured_is_explicit: false }, ID)).toBe(false)
    expect(isPinnedFeatured(null, ID)).toBe(false)
    expect(isPinnedFeatured({ featured_photo_id: null, featured_is_explicit: false }, null)).toBe(false)
  })
})
