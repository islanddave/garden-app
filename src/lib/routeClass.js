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
// V5-NAVCUSTOM-001 — /put-up joins (BUG-PUTUPROOTTAB-001: V4-PUTUPENGINE-001 made it a bar tab and it
// shipped with a navigate(-1) Back arrow, the exact /harvests regression above, repeated). This list
// is STATIC and stays so: a person can move Garden, Harvests or Put-Up into More (D4) and the moved
// tab keeps its root header, like /dashboard and /findings. routeClass.test.js derives the required
// set from TAB_REGISTRY, so the next tab cannot repeat this.
export const ROOT_TABS = ['/today', '/garden', '/harvests', '/put-up', '/findings', '/dashboard']

// V5-NAVANYSLOT-001 — THE HEADER FOLLOWS THE PERSON'S BAR, FOR MORE ROWS ONLY (Dave, 2026-10-01:
// "follow my bar"). Any More row can take a tab-bar slot now, and none of them is in ROOT_TABS, so a
// page tapped as a tab drew a navigate(-1) Back arrow — the /harvests and /put-up regression a third
// time, for up to eighteen pages at once. Dave's ruling: A MORE PAGE CARRIES NO BACK ARROW ONLY WHILE
// IT IS ON YOUR BAR; OPENED FROM THE MORE SHEET, NOT ON YOUR BAR, IT KEEPS BACK.
//
// That relaxes the rule this file held until then — "a header that followed the layout would gain or
// lose its Back arrow when prefs land after first paint, and would differ between Dave's phone and
// Jen's". He was shown that trade-off and chose it, and both costs are bounded by ONE SOURCE: the
// caller passes `bar`, the drawn slots NavPrefsContext hands BottomNav (useNavLayout().bar), so the
// header can only change in the commit that re-lays the bar itself, and can never disagree with the
// bar on screen. With a launch cache that is never mid-session; with none (the first launch after
// sign-in) it is once, when prefs land, together with the bar; and after the person's own Save in
// the editor. TopChrome.barRoot.test.jsx photographs every commit of both launches.
//
// What did NOT change: ROOT_TABS is still layout-independent (rule 1 — a core tab moved into More
// keeps its root header), and `bar` only ever ADDS roots, so no page that was root can gain an arrow.
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
// pending header, which used it to reserve the 88px root height; V4-HEADERPARITY-001 made every
// variant 52px, so pending reserves the right box unconditionally and its one caller today is
// getRouteClass below. `bar` is optional: without it this is the static ROOT_TABS answer.
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
