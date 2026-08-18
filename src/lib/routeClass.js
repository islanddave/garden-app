// V4-APPBAR-002 — header route-class resolver (replaces the old ROOT_TABS allowlist in TopChrome).
// One header is always present; TopChrome renders a VARIANT per class. Unknown routes default to
// 'detail' (a usable back+title header) so a NEW route can never silently fall into "no header" —
// the old exact-match allowlist did exactly that (it's why /capture ended up drawing its own bar).
// A guard test (routeClass.test.js) asserts every app route resolves to a known class.
import { matchPath } from 'react-router-dom'

// Primary bottom-nav destinations. A root tab is the START of a journey, so it carries NO Back
// button; every other route does. Must stay == bottom-nav roots.
// V4-HEADERPARITY-001 (Dave, 2026-08-18) — HALF of the old stance is reversed. It used to read
// "search belongs where a journey STARTS; detail pages get a Back affordance there instead", and
// root accordingly got an 88px full-width search launcher while detail got a magnifier icon. Dave
// asked for the icon on all five tabs: search is now identical everywhere (TopChrome renders root
// and detail from one block) and this list means ONE thing — no Back arrow. The Back half stands,
// and is the reason this is a class distinction rather than an empty ROOT_TABS: emptying it would
// buy the search icon and ship a navigate(-1) arrow on the five primary tabs, which is exactly the
// regression recorded below.
// V4-NAVHARVEST-001: /harvests became a primary tab, so it earns the root header. Without this it
// resolved to 'detail' and the headline tab of that change shipped with a navigate(-1) Back arrow
// in its header and no search — green tests throughout, because routeClass.test.js only asserts
// ROOT_TABS *contains* a route, never that it matches the nav.
// /findings is KEPT despite moving into More, following the /dashboard precedent: /dashboard was
// demoted to More long ago (DRG-TODAY-003) and deliberately kept its root header. Demoting a route
// in the nav and re-classing its header are separate decisions; this commit makes only the one the
// nav change requires.
export const ROOT_TABS = ['/today', '/garden', '/harvests', '/findings', '/dashboard']

// Full-screen focused capture surfaces: slim immersive bar (Back + optional title, no search/fav).
export const CAPTURE_ROUTES = ['/capture', '/field']

// Optional title for the immersive capture bar (null/absent = back-only; the page keeps its own title).
export const CAPTURE_TITLES = { '/capture': 'Snap' }

// Public / logged-out routes -> minimal unified header variant (handled as 'unauth' via the user check below).
// V4-PERFCLERK-001 C: 'pending' is the THIRD identity state — auth has not resolved yet, so the app
// knows neither that the user is signed in nor that they are signed out. It exists because `!user`
// used to conflate the two: during the ~2.5s Clerk window `user` is null, so the header rendered the
// signed-OUT variant ("Sign in") to a user who was very probably signed IN. That was invisible only
// because SplashScreen covered it; now that the shell paints during the window, it would be a
// visible wrong-identity flash. 'pending' renders brand + banner and nothing identity-bearing.
const ROUTE_CLASSES = ['root', 'capture', 'detail', 'unauth', 'pending']
export function isKnownClass(c) { return ROUTE_CLASSES.includes(c) }

const matches = (patterns, pathname) =>
  patterns.some((p) => matchPath({ path: p, end: true }, pathname))

// Would this pathname carry the root header IF the user turns out to be signed in? Written for the
// pending header, which used it to reserve the 88px root height; V4-HEADERPARITY-001 made every
// variant 52px, so pending reserves the right box unconditionally and this has no caller today.
export function isRootTabPath(pathname) { return matches(ROOT_TABS, pathname) }

// Resolve the header class for a pathname.
// `loading` truthy => 'pending' (checked FIRST — an unresolved identity is not a signed-out one).
// `user` falsy => 'unauth'.
export function getRouteClass(pathname, { user, loading } = {}) {
  if (loading) return 'pending'
  if (!user) return 'unauth'
  if (matches(CAPTURE_ROUTES, pathname)) return 'capture'
  if (matches(ROOT_TABS, pathname)) return 'root'
  return 'detail'
}
