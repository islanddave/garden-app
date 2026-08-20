// SpacePhotos.flagOff.test.jsx — V4-SPACEPHOTO-001 Lane C. THE ROLLBACK-LEVER PROOF.
//
// RETARGETED 2026-08-02 with the client flip (V4-SPACECLIENTGAP-001). Read what changed and why,
// because the file's PURPOSE changed, not just its assertions.
//
// It used to assert the SHIPPED VALUE of the constant (`expect(SPACE_PHOTOS_ENABLED).toBe(false)`)
// and derive everything else from that. That made it a pin on a value that was always going to
// change — the flip turned it RED by construction, exactly as its own header warned. Worse, it
// meant the moment the flag went true there was NO test left covering the flag-off path at all.
//
// The flag-off path is not dead code after the flip: it is the ROLLBACK LEVER. "Rollback = flip
// false + redeploy" is the entire safety story this feature was architected around (byte-identical
// insert templates, a flag-gated attach route, a gated list decoration). A rollback nobody tests is
// a rollback nobody knows works. So this file now MOCKS the flag false and proves the lever still
// lands: no /space routes, the 48-route table restored exactly, no space request reachable.
//
// Its counterpart SpacePhotos.flagOn.test.jsx mocks true and owns the shipped-value pin. Between
// them both edges are covered and neither breaks on a future flip.
//
// Every assertion is mechanical (route table, rendered nav rows), not a screenshot claim.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The lever, held OFF. Other values mirror the shipped defaults so nothing else changes shape.
// PARTIAL mock (importOriginal spread): the enumerated form broke on every new flag added
// anywhere in featureFlags.js — most recently DISMISS_REGISTRY_ENABLED, which Sheet reads.
// Only SPACE_PHOTOS_ENABLED is actually under test here; the rest now track prod.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  SPACE_PHOTOS_ENABLED: false,
  OVERLAY_ROUTES_ENABLED: true,
}))

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

describe('SPACE_PHOTOS_ENABLED — the lever, held off', () => {
  it('is false under this file’s mock (the rollback configuration under test)', () => {
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

  // The rollback is EXACT, not merely "smaller". A lever that drops the two space routes but also
  // perturbs the other 50 is not a rollback, and a bare not-to-contain check could not tell the
  // difference. This is the flag-OFF counterpart to App.routes.test.jsx's flag-ON 52.
  // 48 → 49: V4-EDITCOMPLETE-001 V3's /varieties/:varietyId/edit is NOT flag-gated, so it is
  // present in both tables; the flag's delta stays exactly the two space routes.
  // 49 → 50: W-RESTORE's /photos/deleted is likewise not flag-gated — same reasoning, and the same
  // delta invariant: the flag still adds exactly two routes and nothing else.
  it('restores the shipped 50-route table exactly, with no duplicates', async () => {
    const { renderRoutes } = await import('../App.jsx')
    const paths = renderRoutes({ overlay: false, user: true }).map(r => r.props.path)
    // 50 → 51: BUG-VOICEDUPE-002 added /admin/voice-debug (flag-independent — not a /space route)
    // 51 → 50: V4-AMBIENTZONE-001 deleted /zone (likewise flag-independent). The delta invariant
    // this file exists to protect is unchanged: the flag still adds exactly the two /space routes,
    // so flag-OFF stays exactly 2 below App.routes.test.jsx's flag-ON pin.
    expect(paths).toHaveLength(50)
    expect(new Set(paths).size).toBe(50)
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

  // V4-SPACECLIENTGAP-001 (Dave 2026-08-02): the /locations row now reads "Zones" UNCONDITIONALLY.
  // Previously it was flag-conditional ("Spaces" off / "Zones" on), which meant a rollback would
  // silently RENAME a nav row under the user. The naming is a product decision about what the
  // location tier is called; it is orthogonal to whether the Space surface is switched on, so the
  // rollback lever must NOT move it. That invariant is what this test now guards.
  it('keeps the /locations row labelled "Zones" — a rollback does not rename it back', () => {
    openMore()
    const row = screen.getByText('Zones')
    expect(row.closest('a').getAttribute('href')).toBe('/locations')
    expect(screen.queryByText('Spaces')).toBeNull()
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
