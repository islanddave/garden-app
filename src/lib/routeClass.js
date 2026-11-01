// Header route-class resolver. One header is always present; TopChrome renders a VARIANT per class.
// Unknown routes default to 'detail' (a usable back+title header) so a NEW route can never silently
// fall into "no header" — an exact-match allowlist did exactly that (it's why /capture ended up
// drawing its own bar). A guard test (routeClass.test.js) asserts every app route resolves to a known class.
import { matchPath } from 'react-router-dom'

// Primary bottom-nav destinations. A root tab is the START of a journey, so it carries NO Back
// button; every other route does. Must stay == bottom-nav roots.
// This list means ONE thing — no Back arrow. Search is identical everywhere (TopChrome renders root
// and detail from one block), so it does not separate the classes. Emptying this list would not
// simplify anything: it would ship a navigate(-1) arrow on the primary tabs, the regression below.
// A route that becomes a primary tab earns the root header here. /harvests and /put-up each shipped
// as a bar tab resolving to 'detail', with a navigate(-1) Back arrow in its header and no root
// header — green tests throughout, because routeClass.test.js only asserted ROOT_TABS *contains* a
// route, never that it matches the nav. It now derives the required set from TAB_REGISTRY, so the
// next tab cannot repeat this.
// This list is STATIC and stays so: a person can move Garden, Harvests or Put-Up into More, and the
// moved tab keeps its root header, like /dashboard and /findings (both live in More and deliberately
// kept their root header). Demoting a route in the nav and re-classing its header are separate decisions.
export const ROOT_TABS = ['/today', '/garden', '/harvests', '/put-up', '/findings', '/dashboard']

// THE HEADER FOLLOWS THE PERSON'S BAR, FOR MORE ROWS ONLY. Any More row can take a tab-bar slot, and
// none of them is in ROOT_TABS, so a page tapped as a tab would draw a navigate(-1) Back arrow — the
// /harvests and /put-up regression again, for up to eighteen pages at once. So: A MORE PAGE CARRIES
// NO BACK ARROW ONLY WHILE IT IS ON YOUR BAR; OPENED FROM THE MORE SHEET, NOT ON YOUR BAR, IT KEEPS BACK.
//
// That relaxes a layout-independent header: one that follows the layout can gain or lose its Back
// arrow when prefs land after first paint, and can differ between two people's phones. Both costs are
// bounded by ONE SOURCE: the caller passes `bar`, the drawn slots NavPrefsContext hands BottomNav
// (useNavLayout().bar), so the header can only change in the commit that re-lays the bar itself, and can never disagree with the
// bar on screen. With a launch cache that is never mid-session; with none (the first launch after
// sign-in) it is once, when prefs land, together with the bar; and after the person's own Save in
// the editor. TopChrome.barRoot.test.jsx photographs every commit of both launches.
//
// ROOT_TABS itself stays layout-independent (a core tab moved into More keeps its root header), and
// `bar` only ever ADDS roots, so no page that was root can gain an arrow.
//
// A slot makes ITS OWN page root and nothing under it: exact match, the same test ROOT_TABS gets.
// Settings on the bar leaves Back on /settings/controls unless Controls holds a slot too. A slot the
// bar does not draw (an id this build does not know, a row whose flag is off) is not in `bar`, so it
// is not root. The ＋ slot is skipped: its `to` is /log, but the bar draws it as the button that
// opens the create sheet, and the Log form is a pushed page.
//
// SLOT_LANDS_ON — a slot whose route is only a redirect opens the page it redirects to, so THAT page
// is the slot's page. /settings is the one such row (src/pages/Settings.jsx); without this entry a
// Settings tab would open /settings/notifications with the arrow still on it.
// TopChrome.barRoot.test.jsx renders the real redirect against this map.
export const SLOT_LANDS_ON = { '/settings': '/settings/notifications' }

// Full-screen focused capture surfaces: slim immersive bar (Back + optional title, no search/fav).
export const CAPTURE_ROUTES = ['/capture', '/field']

// Optional title for the immersive capture bar (null/absent = back-only; the page keeps its own title).
export const CAPTURE_TITLES = { '/capture': 'Snap' }

// Public / logged-out routes -> minimal unified header variant (handled as 'unauth' via the user check below).
// 'pending' is the THIRD identity state — auth has not resolved yet, so the app knows neither that the
// user is signed in nor that they are signed out. `!user` alone would conflate the two: during the ~2.5s
// Clerk window `user` is null, so the header would render the signed-OUT variant ("Sign in") to a user
// who is very probably signed IN, a visible wrong-identity flash now that the shell paints during the
// window. 'pending' renders brand + banner and nothing identity-bearing.
const ROUTE_CLASSES = ['root', 'capture', 'detail', 'unauth', 'pending']
export function isKnownClass(c) { return ROUTE_CLASSES.includes(c) }

const matches = (patterns, pathname) =>
  patterns.some((p) => matchPath({ path: p, end: true }, pathname))

// The pages the drawn bar makes root. `bar` is useNavLayout().bar — rows of { key, to, highlight? } —
// and anything else (absent, malformed) is no bar: this can only fail toward a Back arrow. A `to` is
// read as a pathname, so a row that ever carries a query or hash still matches its page.
function barRootPaths(bar) {
  if (!Array.isArray(bar)) return []
  const out = []
  for (const slot of bar) {
    if (!slot || slot.highlight || typeof slot.to !== 'string') continue
    const path = slot.to.split(/[?#]/)[0]
    if (!path) continue
    out.push(path)
    if (Object.hasOwn(SLOT_LANDS_ON, path)) out.push(SLOT_LANDS_ON[path])
  }
  return out
}

// Would this pathname carry the root header IF the user turns out to be signed in? Written for the
// pending header, which used it to reserve the 88px root height; every variant is now 52px, so
// pending reserves the right box unconditionally and its one caller today is getRouteClass below.
// `bar` is optional: without it this is the static ROOT_TABS answer.
export function isRootTabPath(pathname, bar) {
  return matches(ROOT_TABS, pathname) || matches(barRootPaths(bar), pathname)
}

// Resolve the header class for a pathname. PURE: the bar is passed in, never read from a context.
// `loading` truthy => 'pending' (checked FIRST — an unresolved identity is not a signed-out one).
// `user` falsy => 'unauth'.
// `bar` => the slots on this person's bar right now; a More page among them is 'root' (see above).
export function getRouteClass(pathname, { user, loading, bar } = {}) {
  if (loading) return 'pending'
  if (!user) return 'unauth'
  if (matches(CAPTURE_ROUTES, pathname)) return 'capture'
  if (isRootTabPath(pathname, bar)) return 'root'
  return 'detail'
}
