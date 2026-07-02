// V4-APPBAR-002 — header route-class resolver (replaces the old ROOT_TABS allowlist in TopChrome).
// One header is always present; TopChrome renders a VARIANT per class. Unknown routes default to
// 'detail' (a usable back+title header) so a NEW route can never silently fall into "no header" —
// the old exact-match allowlist did exactly that (it's why /capture ended up drawing its own bar).
// A guard test (routeClass.test.js) asserts every app route resolves to a known class.
import { matchPath } from 'react-router-dom'

// Primary bottom-nav destinations that earn the 88px search-first header. Search belongs where a
// journey STARTS; detail pages get a Back affordance there instead. Must stay == bottom-nav roots.
export const ROOT_TABS = ['/today', '/garden', '/findings', '/dashboard']

// Full-screen focused capture surfaces: slim immersive bar (Back + optional title, no search/fav).
export const CAPTURE_ROUTES = ['/capture', '/field']

// Optional title for the immersive capture bar (null/absent = back-only; the page keeps its own title).
export const CAPTURE_TITLES = { '/capture': 'Snap' }

// Public / logged-out routes -> minimal TopBar (handled as 'unauth' via the user check below).
const ROUTE_CLASSES = ['root', 'capture', 'detail', 'unauth']
export function isKnownClass(c) { return ROUTE_CLASSES.includes(c) }

const matches = (patterns, pathname) =>
  patterns.some((p) => matchPath({ path: p, end: true }, pathname))

// Resolve the header class for a pathname. `user` falsy => 'unauth'.
export function getRouteClass(pathname, { user } = {}) {
  if (!user) return 'unauth'
  if (matches(CAPTURE_ROUTES, pathname)) return 'capture'
  if (matches(ROOT_TABS, pathname)) return 'root'
  return 'detail'
}
