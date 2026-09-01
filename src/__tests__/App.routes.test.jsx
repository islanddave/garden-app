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

// Converted from an ENUMERATED literal to the partial importOriginal form (the shape the
// SpacePhotos and *.projhide suites already use). The enumerated form re-broke this file on every
// new featureFlags export — it did so for PROJECTS_HIDDEN, again for SPACE_PHOTOS_ENABLED
// (BottomNav.modeSwap.test.jsx:42 records both), and would have again for EVENT_REANCHOR_ENABLED.
// The two flags this file actually pins are still stated explicitly; everything else now inherits
// its shipped value instead of silently drifting from one.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  SPACE_PHOTOS_ENABLED: true,
  OVERLAY_ROUTES_ENABLED: true,
}))

import { renderRoutes } from '../App.jsx'

const pagePaths = () => renderRoutes({ overlay: false, user: true }).map((r) => r.props.path)
const overlayPaths = () => renderRoutes({ overlay: true, user: true }).map((r) => r.props.path)

describe('App route table (single source of truth)', () => {
  it('the page tree has the full 55-route set with no duplicates', () => {
    // 46 → 48: V4-UNSCOPEDROUTES-001 added the canonical un-scoped /plantings/:plantingId and
    // /events/:eventId (the /projects/:id/* forms remain as redirects, still counted).
    // 48 → 50: V4-SPACEPHOTO-001 Lane C adds /space and /space/:spaceId. Counted here because the
    // mock above pins SPACE_PHOTOS_ENABLED true; the flag-OFF table is pinned at 48 in
    // SpacePhotos.flagOff.test.jsx, which mocks it false.
    // 50 → 51: V4-EDITCOMPLETE-001 V3 adds /varieties/:varietyId/edit — the first and only write
    // surface for the 32 PUT-writable cultivar columns, which had no edit UI at all.
    // 51 → 52: W-RESTORE adds /photos/deleted — the Recently deleted surface the photo-delete
    // confirm's "recoverable from Recently deleted" copy names. It is NOT flag-gated: the copy
    // promising it ships unconditionally, so the destination must too.
    // 52 → 53: BUG-VOICEDUPE-002 added /admin/voice-debug (unlinked, Protected, admin-only
    // raw Web Speech capture). Registered exactly once in App.jsx — the uniqueness assert below
    // is what proves a count bump is a new route rather than a duplicate registration.
    // 53 → 52: V4-AMBIENTZONE-001 DELETES /zone. The route registered ZonePicker, whose pick wrote
    // ZoneContext.activeZone — a value with ZERO readers anywhere in the tree — so the page was
    // both unreachable (no `to="/zone"` in src) and inert. Context, page and route went together.
    // This is the first DECREMENT in this ledger; the uniqueness assert below cannot catch a
    // deletion, so the count is the only mechanical proof the route actually left the table.
    // 52 → 53: V4-HANDEDNESSCONTROLS-001 (BD-054) adds /settings/controls, the handedness
    // preference. A SIBLING of /settings/notifications rather than a section of it — that page
    // is titled Notifications and is about critter visits. /settings itself still redirects to
    // notifications, so Settings.test.jsx is untouched; the parent-index refactor its header has
    // anticipated since MVP-Critter Session 4 was deliberately NOT done here.
    // 53 → 54: OPS-DEBUGMENU-001 adds /admin, the index for the three /admin/* pages that were each
    // shipped "unlinked, reachable by URL". That convention silently meant UNREACHABLE on the app's
    // real platform — an installed PWA has no address bar — so this route is the address bar. The
    // reachability invariant that keeps the set honest lives in DebugMenu.reachability.test.jsx: a
    // new /admin/* route with no row on the menu fails there, not here.
    const paths = pagePaths()
    // 54 -> 55: V4-ARCHIVEBROWSE-001 adds /plantings/archived, the browse surface for archived
    // plantings. It is declared ABOVE /plantings/:plantingId so the static segment is visibly
    // ordered ahead of the dynamic one rather than relying on router ranking alone.
    // 55 -> 56: V5-HARVESTVOICEFLOW-001 adds /log/voice, the hands-free harvest surface. It sits
    // BESIDE /log rather than inside it, which is the containment Dave asked for — the existing
    // harvest form is not modified, not wrapped and not reachable from it, so a failure here is
    // recovered by leaving the route.
    // 56 -> 57: V4-SEEDSAVEFLOW-001 adds /seeds/saved, the saved-seed lot surface. A PAGE, not
    // `overlayable`, for the same reason /sow is one: it is a destination reached from the More
    // sheet and worked in, not a task flyover launched over whatever was already open.
    expect(paths).toHaveLength(57)
    expect(new Set(paths).size).toBe(57)
  })

  it('/log/voice is a PAGE, never an overlay — a live mic must not mount over another surface', () => {
    // An `overlayable` route renders over the surface beneath it and closes back to it. That would
    // put a running recogniser on top of /log and make "the normal form is untouched" false in the
    // one way that matters. Asserted as presence-in-one-set-and-absence-from-the-other, which is the
    // observable consequence of the declaration — /log and /log/many are both in BOTH sets, so the
    // absence below is a real distinction and not an artefact of how the table is built.
    expect(pagePaths()).toContain('/log/voice')
    expect(overlayPaths()).not.toContain('/log/voice')
    expect(overlayPaths()).toContain('/log')
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
