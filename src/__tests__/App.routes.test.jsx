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
  it('the page tree has the full 46-route set with no duplicates', () => {
    const paths = pagePaths()
    expect(paths).toHaveLength(46)
    expect(new Set(paths).size).toBe(46)
  })

  it('includes the catch-all, index redirect, and every key route', () => {
    const paths = pagePaths()
    for (const p of ['/', '*', '/today', '/search', '/log', '/log/many', '/put-up', '/harvests', '/garden/:slug', '/login', '/projects/:id/plantings/:plantingId']) {
      expect(paths).toContain(p)
    }
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
