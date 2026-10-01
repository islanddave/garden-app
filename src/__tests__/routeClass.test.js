import { describe, it, expect } from 'vitest'
import { getRouteClass, isKnownClass, isRootTabPath, ROOT_TABS, CAPTURE_ROUTES, SLOT_LANDS_ON } from '../lib/routeClass.js'
import { TAB_REGISTRY, resolveBarLayout } from '../lib/navConfig.js'
import { MORE_ROWS, rowEnabled, barSlotRows } from '../lib/moreRegistry.js'

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

// V5-NAVANYSLOT-001 — THE HEADER FOLLOWS THE PERSON'S BAR (Dave, 2026-10-01: "follow my bar").
// A More page on your bar is a journey start and carries no Back; opened from the More sheet it keeps
// the class it always had. `bar` is built here the way NavPrefsContext builds the one BottomNav draws
// (resolveBarLayout → barSlotRows), so a slot the bar skips is a slot the header never sees.
describe('routeClass — a More page on the bar is root; off the bar it is what it was', () => {
  const authed = { user: { id: 'u1' } }
  const barOf = (order, opts) => barSlotRows(resolveBarLayout({ order, hidden: [] }).bar, opts)
  const SHIPPED_BAR = barSlotRows(resolveBarLayout(null).bar)
  const ROWS = MORE_ROWS.filter(rowEnabled)
  // The class each row's page has on main today, written out rather than read back from ROOT_TABS:
  // /dashboard and /findings were demoted into More and kept their root header; every other row is a
  // pushed page.
  const ROOT_ON_MAIN = ['/dashboard', '/findings']
  const classOnMain = (to) => (ROOT_ON_MAIN.includes(to) ? 'root' : 'detail')

  // RED before this change: every row but Dashboard and DrG resolves to 'detail' on the bar.
  // KILLING MUTATION: drop the bar arm of getRouteClass. RESULT: RED.
  it('every enabled More row: on the bar → root; off the bar → its class on main', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(16)
    expect(ROWS.filter(r => classOnMain(r.to) === 'detail').length).toBeGreaterThanOrEqual(14)
    for (const row of ROWS) {
      const on = barOf(['today', 'create', row.id])
      expect(on.map(s => s.key), row.id).toContain(row.id)
      expect(getRouteClass(row.to, { ...authed, bar: on }), `${row.id} on the bar`).toBe('root')
      expect(getRouteClass(row.to, { ...authed, bar: SHIPPED_BAR }), `${row.id} off the bar`).toBe(classOnMain(row.to))
      expect(getRouteClass(row.to, { ...authed, bar: barOf(['today', 'create']) }), `${row.id} off a short bar`).toBe(classOnMain(row.to))
      // No bar handed in at all (a caller that predates this): the static rule, unchanged.
      expect(getRouteClass(row.to, authed), `${row.id} with no bar`).toBe(classOnMain(row.to))
      expect(isRootTabPath(row.to, on), `${row.id} isRootTabPath`).toBe(true)
      expect(isRootTabPath(row.to), `${row.id} isRootTabPath, no bar`).toBe(classOnMain(row.to) === 'root')
    }
  })

  // EXACT, like ROOT_TABS: a slot makes ITS page root, never the pages pushed from it.
  // KILLING MUTATION: match a slot by prefix (end: false). RESULT: RED.
  it('a slotted row does not take Back off the pages under it', () => {
    for (const row of ROWS) {
      const on = barOf(['today', 'create', row.id])
      expect(getRouteClass(`${row.to}/zzz`, { ...authed, bar: on }), `${row.to}/zzz`).toBe('detail')
    }
    const settings = barOf(['today', 'create', 'settings'])
    expect(getRouteClass('/settings/controls', { ...authed, bar: settings })).toBe('detail')
    expect(getRouteClass('/inventory/add', { ...authed, bar: barOf(['today', 'create', 'inventory']) })).toBe('detail')
    // Controls is its own row: on the bar it is root, and it does not make Settings' page root.
    const controls = barOf(['today', 'create', 'settings-controls'])
    expect(getRouteClass('/settings/controls', { ...authed, bar: controls })).toBe('root')
    expect(getRouteClass('/settings/notifications', { ...authed, bar: controls })).toBe('detail')
    expect(getRouteClass('/settings', { ...authed, bar: controls })).toBe('detail')
  })

  // /settings is a redirect (src/pages/Settings.jsx), so the page a Settings slot opens is
  // /settings/notifications. SLOT_LANDS_ON names that page; TopChrome.barRoot.test.jsx renders the real
  // redirect against it. KILLING MUTATION: empty SLOT_LANDS_ON. RESULT: RED.
  it('a slot whose route only redirects makes the page it lands on root', () => {
    expect(SLOT_LANDS_ON).toEqual({ '/settings': '/settings/notifications' })
    const settings = barOf(['today', 'create', 'settings'])
    expect(getRouteClass('/settings/notifications', { ...authed, bar: settings })).toBe('root')
    expect(getRouteClass('/settings/notifications', { ...authed, bar: SHIPPED_BAR })).toBe('detail')
    expect(getRouteClass('/settings/notifications', authed)).toBe('detail')
  })

  // The header reads the DRAWN bar: an id the bar skips (a newer bundle's row, a flag-off row) gives
  // the header nothing either. The flag-off case injects a registry so it does not depend on which
  // build flags happen to be on. KILLING MUTATION: feed the header layout.bar ids resolved against
  // MORE_ROWS without rowEnabled. RESULT: RED.
  it('an id the bar does not draw is not root', () => {
    const unknown = barOf(['today', 'create', 'future-row'])
    expect(unknown.map(s => s.key)).toEqual(['today', 'create'])
    expect(getRouteClass('/future-row', { ...authed, bar: unknown })).toBe('detail')
    const rows = (enabled) => [{ id: 'photos', to: '/photos', label: 'Photos', iconName: 'media.camera', section: 'garden', enabled }]
    expect(getRouteClass('/photos', { ...authed, bar: barOf(['today', 'create', 'photos'], { rows: rows(false) }) })).toBe('detail')
    // Non-vacuity: the same injected row, flag on, is root.
    expect(getRouteClass('/photos', { ...authed, bar: barOf(['today', 'create', 'photos'], { rows: rows(true) }) })).toBe('root')
  })

  it('a slot stored under an alias makes the live page root', () => {
    expect(getRouteClass('/seeds', { ...authed, bar: barOf(['today', 'create', 'sow']) })).toBe('root')
  })

  // The FAB's `to` is /log, but the bar draws it as a button that opens the create sheet.
  // KILLING MUTATION: drop the `highlight` skip. RESULT: RED — the Log form loses its Back arrow.
  it('the ＋ slot is an action, not a page: /log stays detail on every bar', () => {
    expect(SHIPPED_BAR.some(s => s.highlight && s.to === '/log')).toBe(true)
    expect(getRouteClass('/log', { ...authed, bar: SHIPPED_BAR })).toBe('detail')
    expect(getRouteClass('/log', { ...authed, bar: barOf(['create', 'today', 'seeds']) })).toBe('detail')
  })

  // Rule 1 stands: a core tab keeps its root header wherever the layout puts it.
  it('ROOT_TABS stay root whatever the bar holds', () => {
    for (const bar of [barOf(['today', 'create']), barOf(['today', 'create', 'seeds', 'photos', 'admin']), [], undefined, null, 'garbage']) {
      for (const p of ROOT_TABS) expect(getRouteClass(p, { ...authed, bar }), p).toBe('root')
    }
  })

  // Identity and the capture surfaces are decided before the bar is looked at.
  it('pending, unauth and capture are not changed by a bar', () => {
    const bar = barOf(['today', 'create', 'season-end'])
    expect(getRouteClass('/season-end', { user: null, loading: true, bar })).toBe('pending')
    expect(getRouteClass('/season-end', { user: null, bar })).toBe('unauth')
    for (const p of CAPTURE_ROUTES) expect(getRouteClass(p, { ...authed, bar })).toBe('capture')
  })

  // A malformed bar can only fail toward Back, and never throws.
  it('a malformed bar is no bar', () => {
    for (const bar of [null, undefined, 'x', 7, {}, [null], [{}], [{ to: 7 }], [{ to: '' }]]) {
      expect(getRouteClass('/season-end', { ...authed, bar }), JSON.stringify(bar)).toBe('detail')
    }
  })
})
