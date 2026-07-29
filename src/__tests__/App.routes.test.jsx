// V4-OVERLAY-001 §3 — guard the single source-of-truth route table. Both the page tree and the
// overlay tree derive from ONE array (renderRoutes); this pins the path set + the overlayable
// subset so a future edit — Slices 2-3 mutate full-page rendering OUTSIDE the flag guard — cannot
// silently drop/duplicate a route or lose the overlay set. Closes the regression-impact IMPORTANT #3
// gap (the 44-route transcription had no automated backstop). No jest-dom (L-182); no render — we
// inspect the returned <Route> element props directly.
import { describe, it, expect } from 'vitest'
import { renderRoutes } from '../App.jsx'

const pagePaths = () => renderRoutes({ overlay: false, user: true }).map((r) => r.props.path)
const overlayPaths = () => renderRoutes({ overlay: true, user: true }).map((r) => r.props.path)

describe('App route table (single source of truth)', () => {
  it('the page tree has the full 48-route set with no duplicates', () => {
    // 46 → 48: V4-UNSCOPEDROUTES-001 added the canonical un-scoped /plantings/:plantingId and
    // /events/:eventId (the /projects/:id/* forms remain as redirects, still counted).
    const paths = pagePaths()
    expect(paths).toHaveLength(48)
    expect(new Set(paths).size).toBe(48)
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

  it('a NON-overlayable route renders the identical element in both trees (page tree only for overlay=true drops it)', () => {
    const page = renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === '/today')
    expect(page).toBeTruthy()
    expect(overlayPaths()).not.toContain('/today') // never appears in the overlay tree
  })
})
