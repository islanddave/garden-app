import { describe, it, expect } from 'vitest'
import { getRouteClass, isKnownClass, ROOT_TABS, CAPTURE_ROUTES } from '../lib/routeClass.js'
import { TAB_REGISTRY } from '../lib/navConfig.js'

// Guard test (V4-APPBAR-002): every app route MUST resolve to a known header class, and the
// resolver must never yield "no header". Enumerates the App.jsx route table so a NEW route that
// forgets its class still lands on the safe 'detail' default (a usable back+title header) — and
// this test documents that. Prevents the old ROOT_TABS-allowlist silent-drop (the /capture double bar).
const APP_ROUTES = [
  '/today', '/garden', '/findings', '/dashboard',            // root tabs
  '/capture', '/field',                                      // capture surfaces
  '/log', '/log/many', '/photos', '/favorites', '/search',  // detail
  '/inventory', '/inventory/add', '/inventory/abc',
  '/projects', '/projects/new', '/projects/abc',
  '/projects/abc/plantings/xyz', '/projects/abc/events/xyz',
  '/locations', '/locations/abc', '/project-types',
  '/plants/catch-up', '/achievements', '/collection', '/helper',
  '/settings', '/settings/notifications', '/about', '/releases',
  '/admin/classify', '/admin/garden-activity', '/admin/voice-debug', '/inactive', '/feed',
]

describe('routeClass — header IA guard', () => {
  it('every app route resolves to a known class for an authed user', () => {
    for (const p of APP_ROUTES) {
      const c = getRouteClass(p, { user: { id: 'u1' } })
      expect(isKnownClass(c), `${p} -> ${c}`).toBe(true)
    }
  })

  it('root tabs resolve to root', () => {
    for (const p of ROOT_TABS) expect(getRouteClass(p, { user: { id: 'u1' } })).toBe('root')
  })

  it('capture surfaces resolve to capture', () => {
    for (const p of CAPTURE_ROUTES) expect(getRouteClass(p, { user: { id: 'u1' } })).toBe('capture')
  })

  it('pushed/detail routes resolve to detail (safe default)', () => {
    for (const p of ['/projects/abc/plantings/xyz', '/inventory/add', '/settings', '/photos'])
      expect(getRouteClass(p, { user: { id: 'u1' } })).toBe('detail')
  })

  it('unauthenticated users always get the unauth (minimal) header', () => {
    for (const p of ['/today', '/login', '/garden/some-slug', '/'])
      expect(getRouteClass(p, { user: null })).toBe('unauth')
  })

  it('ROOT_TABS covers the primary bottom-nav destinations (a journey start carries no Back)', () => {
    for (const t of ['/today', '/garden', '/findings']) expect(ROOT_TABS).toContain(t)
  })

  // I8 (V5-NAVCUSTOM-001, BUG-PUTUPROOTTAB-001). Derived from TAB_REGISTRY rather than a copied list:
  // the hand list above is exactly how /harvests (V4-NAVHARVEST-001) and then /put-up
  // (V4-PUTUPENGINE-001) each shipped as a bar tab with a navigate(-1) Back arrow, green throughout.
  // RED on dev ff1e03ea (no /put-up). KILLING MUTATION: remove '/put-up' from ROOT_TABS.
  it('I8 — ROOT_TABS ⊇ every bar destination in TAB_REGISTRY (the FAB is an action, not a page)', () => {
    const destinations = Object.values(TAB_REGISTRY).filter(t => !t.highlight).map(t => t.to)
    expect(destinations.length).toBeGreaterThanOrEqual(4)
    expect(destinations.filter(p => !ROOT_TABS.includes(p))).toEqual([])
    for (const p of destinations) expect(getRouteClass(p, { user: { id: 'u1' } }), p).toBe('root')
  })
})
