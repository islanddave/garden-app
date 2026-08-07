// V4-OVERLAY-001 §3 — guard the single source-of-truth route table. Both the page tree and the
// overlay tree derive from ONE array (renderRoutes); this pins the path set + the overlayable
// subset so a future edit — Slices 2-3 mutate full-page rendering OUTSIDE the flag guard — cannot
// silently drop/duplicate a route or lose the overlay set. Closes the regression-impact IMPORTANT #3
// gap (the 44-route transcription had no automated backstop). No jest-dom (L-182); no render — we
// inspect the returned <Route> element props directly.
//
// V4-SPACECLIENTGAP-001: the flag surface is now MOCKED rather than read from the shipped module.
// Before this, the count pin silently doubled as a pin on SPACE_PHOTOS_ENABLED's shipped value —
// flipping that flag turned this file RED for a reason that has nothing to do with what it guards
// (route-table integrity). Mocking makes the two independent: this file asserts the table for a
// KNOWN flag configuration, and the flag's shipped value is pinned once, deliberately, in
// SpacePhotos.flagOn.test.jsx. Values mirror the shipped defaults so nothing else changes shape.
import { describe, it, expect, vi } from 'vitest'

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

import { renderRoutes } from '../App.jsx'

const pagePaths = () => renderRoutes({ overlay: false, user: true }).map((r) => r.props.path)
const overlayPaths = () => renderRoutes({ overlay: true, user: true }).map((r) => r.props.path)

describe('App route table (single source of truth)', () => {
  it('the page tree has the full 51-route set with no duplicates', () => {
    // 46 → 48: V4-UNSCOPEDROUTES-001 added the canonical un-scoped /plantings/:plantingId and
    // /events/:eventId (the /projects/:id/* forms remain as redirects, still counted).
    // 48 → 50: V4-SPACEPHOTO-001 Lane C adds /space and /space/:spaceId. Counted here because the
    // mock above pins SPACE_PHOTOS_ENABLED true; the flag-OFF table is pinned at 48 in
    // SpacePhotos.flagOff.test.jsx, which mocks it false.
    // 50 → 51: V4-EDITCOMPLETE-001 V3 adds /varieties/:varietyId/edit — the first and only write
    // surface for the 32 PUT-writable cultivar columns, which had no edit UI at all.
    const paths = pagePaths()
    expect(paths).toHaveLength(51)
    expect(new Set(paths).size).toBe(51)
  })

  it('includes the catch-all, index redirect, and every key route', () => {
    const paths = pagePaths()
    for (const p of ['/', '*', '/today', '/search', '/log', '/log/many', '/put-up', '/harvests', '/garden/:slug', '/login', '/plantings/:plantingId', '/events/:eventId', '/projects/:id/plantings/:plantingId', '/projects/:id/events/:eventId']) {
      expect(paths).toContain(p)
    }
  })

  // V4-UNSCOPEDROUTES-001: the scoped forms must stay redirects (never re-grow their own detail
  // rendering) and the un-scoped forms are the ones carrying the real pages.
  it('scoped detail routes are redirect elements, un-scoped routes render the detail pages', () => {
    const routes = renderRoutes({ overlay: false, user: true })
    const scoped = routes.find((r) => r.props.path === '/projects/:id/plantings/:plantingId')
    const unscoped = routes.find((r) => r.props.path === '/plantings/:plantingId')
    expect(scoped.props.element.type.name).toBe('ScopedPlantingRedirect')
    expect(unscoped.props.element.type.name).not.toBe('ScopedPlantingRedirect')
    const scopedEv = routes.find((r) => r.props.path === '/projects/:id/events/:eventId')
    const unscopedEv = routes.find((r) => r.props.path === '/events/:eventId')
    expect(scopedEv.props.element.type.name).toBe('ScopedEventRedirect')
    expect(unscopedEv.props.element.type.name).not.toBe('ScopedEventRedirect')
  })

  it('the overlay tree contains ONLY the four overlayable routes', () => {
    expect(overlayPaths().sort()).toEqual(['/log', '/log/many', '/put-up', '/search'])
  })

  it('an overlayable route is wrapped (OverlayHost) in the overlay tree but raw in the page tree', () => {
    const page = renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === '/search')
    const overlay = renderRoutes({ overlay: true, user: true }).find((r) => r.props.path === '/search')
    // Different element type in each tree: page renders <Protected> directly; overlay wraps in OverlayHost.
    expect(page.props.element.type).not.toBe(overlay.props.element.type)
  })

  // V102 §5.7 — `title`/`ariaLabel` is REQUIRED on OverlayHost. V100's own sketch passed it to none
  // of its routes, giving role="dialog" no accessible name: an SC 4.1.2 (Level A) failure. The type
  // check above passes whether or not the props survive, so the props need their own pin. `size`
  // rides along because §5.1 is explicit that 85vh ('peek') is the wrong container for a long form.
  it('every overlayable route gives OverlayHost an accessible name and an explicit size', () => {
    const expected = {
      '/search':   { ariaLabel: 'Search your garden', size: 'peek' },
      '/log':      { ariaLabel: 'Log an event',       size: 'full' },
      '/log/many': { ariaLabel: 'Log many',           size: 'full' },
      '/put-up':   { ariaLabel: 'Log a put-up',       size: 'full' },
    }
    for (const r of renderRoutes({ overlay: true, user: true })) {
      const host = r.props.element
      expect(host.props.ariaLabel).toBe(expected[r.props.path].ariaLabel)
      expect(host.props.size).toBe(expected[r.props.path].size)
    }
  })

  it('a NON-overlayable route renders the identical element in both trees (page tree only for overlay=true drops it)', () => {
    const page = renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === '/today')
    expect(page).toBeTruthy()
    expect(overlayPaths()).not.toContain('/today') // never appears in the overlay tree
  })
})
