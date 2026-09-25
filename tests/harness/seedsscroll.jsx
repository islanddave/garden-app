// BUG-SAVEDSEEDSBACKTOP-001 + BUG-SEEDLOTOPENSATFORM-001 (v4.148.0) — Back keeps your place on the Seeds
// page, and a seed lot's page opens at its top, in a REAL browser, for scripts/layout-gate/seeds-scroll.mjs
// (gate:seeds-scroll). Framed by viewport.html (?page=seedsscroll.html&vw=426&vh=836).
//
// Why this entry exists (qa-v4148 IMPORTANT 1): both fixes live in behaviour jsdom cannot produce.
//   1. useScrollRestore's unmount save read window.scrollY AFTER React had swapped in the next page, when
//      Chrome had already CLAMPED the offset to that page's one-screen loading shell — so Back from a lot
//      page or a planting landed near the top of a long list (stored 108, not 3101).
//   2. BrowserRouter never resets scroll on a push: the lot page's loading shell carried the list's offset
//      and Chrome's SCROLL ANCHORING re-applied it once the lot landed — on the edit form (1742, not 0).
// The unit suites pin both contracts with MODELS (a clamp written into a layout effect, a scrollTo spy).
// Only a browser clamps and anchors, so only a browser can say a regression is back.
//
// WHAT IS REAL: the Seeds page (My seeds and Saved seeds, each with its real useScrollRestore) and
// InventoryDetail, under BrowserRouter — every history entry carries react-router's {usr, key, idx}
// exactly as prod's does, and Back is a real history traversal (popstate). The providers the two pages
// and their Back markers touch are App.jsx's own: AuthProvider (the Clerk stub signs a user in),
// DismissRegistryProvider and ToastProvider. The shell is AppShell's (src/App.jsx): a sticky top bar of
// TopChrome's BAR_H, then a flex column minHeight 100dvh whose paddingBottom reserves --bottom-nav-height,
// one route ErrorBoundary per page, and a fixed nav of BOTTOM_NAV_HEIGHT_PX that sets that variable in a
// layout effect as BottomNav does. Both stand-ins carry the real tags and heights (the gate checks them).
// Each carries ONE control, because BUG-OVERLAYDISMISSREKEY-001 (flows d to g) is about closing an
// overlay opened over the Seeds page: the top bar header Search, the nav BottomNav's +LOG door. TodayBand is off in prod
// (TODAY_BAND_HIDDEN), so --today-band-height is unset. The document's height — which is what the clamp
// and the anchoring act on — is therefore the app's.
//
// THE OVERLAY is App.jsx's machinery, not a model of it: the real OverlayProvider, the page tree rendered
// at pageLocation and the overlay tree at the real location only while a background exists (AppRoutes),
// header Search as a real OverlayLink (TopChrome's), and the real Sheet with kind="route" whose close is
// the real useOverlayDismiss. HarnessOverlayHost is App.jsx's OverlayHost line for line; it is copied
// rather than imported because importing App.jsx would pull every page of the app into this harness. Only
// the Search page inside the sheet is a stand-in (a block of the peek sheet's height, with one result
// link) — what is under test is how the sheet closes and what the page under it keeps, not what it shows.
//
// WHAT IS A STAND-IN, and why that is enough:
//   /today — two links in (Saved seeds, My seeds), so /seeds is a PUSH from an earlier entry, as it is
//     from More → Seeds. It is replaced into place before the first render.
//   /plantings/:id — PlantingDetail's two properties this bug turns on, copied from src/pages/
//     PlantingDetail.jsx: its loading Shell (minHeight calc(100dvh - 52px), "Loading…") is the short
//     first paint the old unmount save read, and its reset on mount (useEffect(() => window.scrollTo(0, 0),
//     [plantingId])), which since BUG-DETAILPAGESCARRYSCROLL-001 runs only with the app-level page-scroll
//     manager OFF, exactly as there. Its content lands PLANTING_MS later. The planting page itself is not
//     under test; the Saved seeds entry it is Backed out of is.
//
// THE PAGE-SCROLL MANAGER is AppShell's own (src/hooks/usePageScrollManager.js), imported and called the
// way App.jsx calls it, so every flow here also runs the app-level reset on a push and restore on a POP
// (rimpact-scrollmanager IMPORTANT-1). gate:page-scroll covers the manager itself across the app's pages.
//   Any other route renders a marker the gate refuses ("left the page").
//
// THE NETWORK is stubbed at window.fetch WITH LATENCY, because both bugs need a loading phase: the lot's
// GET answers after ITEM_MS and the seed list after ROWS_MS (300ms each by default), so each page paints
// its one-screen loading shell first, as it does on a phone against a real Lambda. The picker projection
// (/api/plants) answers in 20ms, well before the rows, so a Saved seeds card's "Saved from <planting>"
// name is in place by the commit that restores the scroll — the card heights never move after it.
//
// FIXTURE: 16 saved lots, then "Ristra Cayenne II Saved seed 2026" (stored a day ago), then three tomato
// lots stored more recently, then two bought packets. Saved seeds lists Stored oldest-first, so reaching
// Ristra means scrolling a long list, and it is NOT the last card: its card sits mid-page, where only the
// saved offset puts it back. Every lot has a parent planting, so every card offers "Saved from
// <planting> →". In My seeds Pepper holds 13 rows (11 lots, Ristra, a packet), so the Ristra row is a
// scroll away too. DATES are relative to the run.
//
//   http://localhost:5311/tests/harness/viewport.html?page=seedsscroll.html&vw=426&vh=836
//     topbar=52      the top-bar stand-in's height; the gate passes TopChrome.jsx's BAR_H
//     itemms=300     latency of GET /api/inventory-items/:id (the lot page's loading phase)
//     rowsms=300     latency of GET /api/inventory-items?category=seeds (the Seeds page's)
//
// EVERY LOAD IS A FIRST VISIT: sessionStorage is cleared before anything mounts, so no earlier load's
// stored offset or view state can be restored into this one (the gate also opens every flow in a fresh
// tab, whose sessionStorage and history are its own).
//
// EXCEPT A RELOAD THE GATE ASKS FOR (flow i, BUG-OVERLAYRELOADKEY-001): __h.reloadHere() reloads this
// document ON the current history entry, keeping sessionStorage and history.state, as the service
// worker's post-update reload and an Android tab restore reload the app. The dev server answers a
// router URL (/search) with the APP's index.html, so the entry's URL is swapped to this page's own for the
// reload and swapped back — same entry, same state — before React mounts. The app sees what it sees in
// prod: a new document at /search whose history entry carries the overlay's background.
import React, { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigationType } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import {
  OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss, OverlaySurfaceProvider, OverlayDirtyProvider,
} from '../../src/context/OverlayContext.jsx'
// BUG-DETAILPAGESCARRYSCROLL-001 (rimpact-scrollmanager IMPORTANT-1) — AppShell's page-scroll manager, the
// REAL module, called exactly as App.jsx calls it; the drift guard in scripts/layout-gate/seeds-scroll.mjs
// fails if either side stops. Without it this gate would prove a shell prod no longer has.
import { usePageScrollManager, PageScrollProvider, applyBrowserScrollRestoration } from '../../src/hooks/usePageScrollManager.js'
import { SCROLL_MANAGER_ENABLED } from '../../src/lib/featureFlags.js'
import Sheet from '../../src/components/forms/Sheet.jsx'
import SheetRowLink from '../../src/components/SheetRowLink.jsx'
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx'
import Seeds from '../../src/pages/Seeds.jsx'
import InventoryDetail from '../../src/pages/InventoryDetail.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

// main.jsx's boot line, the real function: the browser's own scroll restoration as prod sets it ('manual' with
// the page-scroll manager on). Without it this entry measures Chrome's native restore, which prod does not run.
applyBrowserScrollRestoration(SCROLL_MANAGER_ENABLED)

const q = new URLSearchParams(location.search)
const TOP_CHROME_PX = Number(q.get('topbar') || 52)
const ITEM_MS = Number(q.get('itemms') ?? 300)
const ROWS_MS = Number(q.get('rowsms') ?? 300)
const PLANTING_MS = 300

// This page's own URL, before the router moves it: where a reload has to land.
const HARNESS_URL = location.pathname + location.search
const RELOAD_TO_KEY = 'harness.seedsscroll.reloadTo'
const RELOAD_TO = (() => {
  try {
    if (performance.getEntriesByType('navigation')[0]?.type !== 'reload') return null
    return window.sessionStorage.getItem(RELOAD_TO_KEY)
  } catch { return null }
})()
if (RELOAD_TO) { try { window.sessionStorage.removeItem(RELOAD_TO_KEY) } catch { /* ignore */ } }
else { try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ } }

// ── fixture ──────────────────────────────────────────────────────────────────────────────────────────
const DAY = 86400000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString()
// GET /api/inventory-items/:id — `i.*`, the cultivar facts the route joins and the seeds-only reads
// (seeddetail.jsx's row shape). The list rows are the same objects: every column either page reads is
// present, nulled when unset.
const base = {
  type: 'consumable', category: 'seeds', status: 'active', unit: 'packet', quantity: null,
  reorder_threshold: null, reorder_quantity: null, condition: null, unit_cost: null, quantity_purchased: null,
  purchase_date: null, source: null, source_url: null, source_id: null, acquired_from_source_id: null,
  brand: null, model: null, location_text: null, notes: null, year_harvested: 2026,
  seed_stage: 'stored', seed_process: 'wet', stage_entered_at: null, source_plant_id: null, source_kind: 'own_garden',
  seed_count: null, seed_weight_g: null, seed_count_estimated: null, sow_archived_season: null, metadata: {},
  crop_slug: 'pepper', scoville_min: null, scoville_max: null, scoville_source: null, origin_country: null,
  origin_region: null, species: 'Capsicum annuum', breeding_system: null, days_to_maturity_min: null,
  days_to_maturity_max: null, dtm_basis: null, variety_source_url: null,
  featured_photo_id: null, hero_photo_id: null, hero_thumb_key: null, featured_is_explicit: false, featured_photo_view_url: null,
  germination: { sowings: [], seeds_sown: 0, seeds_germinated: 0, rate: null }, sown_from: [],
  created_at: iso(90), updated_at: iso(3), quantity_on_hand: 1, variety_name: null,
}
let n = 0
const lot = (name, crop, over = {}) => {
  n += 1
  return { ...base, id: `lot-${String(n).padStart(2, '0')}`, name, crop_slug: crop, variety_id: `var-${n}`,
    stage_entered_at: iso(60 - n), source_plant_id: `pl-${n}`, seed_count: 40 + n, seed_count_estimated: true, ...over }
}
const NAMES = [
  ['Aji Charapita', 'pepper'], ['Hot Paper Lantern', 'pepper'], ['Thai Dragon', 'pepper'], ['Gong Bao', 'pepper'],
  ['Big Boy', 'tomato'], ['Cherokee Purple', 'tomato'], ['Porch 1884', 'tomato'], ['Sungold', 'tomato'],
  ['Aji Amarillo', 'pepper'], ['Bishop Crown', 'pepper'], ['Fish', 'pepper'], ['Datil', 'pepper'],
  ['Brandywine', 'tomato'], ['Hungarian Wax', 'pepper'], ['Jimmy Nardello', 'pepper'], ['Lemon Drop', 'pepper'],
]
// The lot every flow opens. Its stage entry is the newest, so it is the last card in Stored.
const RISTRA_ID = 'lot-ristra'
const RISTRA = {
  ...base, id: RISTRA_ID, name: 'Ristra Cayenne II Saved seed 2026', variety_id: 'var-ristra', variety_name: null,
  crop_slug: 'pepper', breeding_system: 'f1', seed_stage: 'stored', seed_process: 'wet', stage_entered_at: iso(1),
  source_plant_id: 'pl-ristra', source_kind: 'own_garden', seed_count: 175, seed_count_estimated: false,
  quantity_on_hand: 1, scoville_min: 30000, scoville_max: 50000, days_to_maturity_min: 75, days_to_maturity_max: 80,
}
// Three tomato lots stored AFTER Ristra (newer stage entries), so its card sits mid-list rather than at
// the page's end: a Back that lands anywhere but the saved offset — including "the bottom" — is visible.
const AFTER_RISTRA = [['Cherry Bomb', 0.6], ['Juliet', 0.4], ['San Marzano', 0.2]]
const ROWS = [
  ...NAMES.map(([v, c]) => lot(`${v} saved seed 2026`, c)),
  RISTRA,
  ...AFTER_RISTRA.map(([v, days]) => lot(`${v} saved seed 2026`, 'tomato', { stage_entered_at: iso(days) })),
  lot('Serrano packet', 'pepper', { id: 'pk-1', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null, year_harvested: null, breeding_system: null }),
  lot('Buttercrunch packet', 'lettuce', { id: 'pk-2', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null, year_harvested: null }),
]
const BY_ID = Object.fromEntries(ROWS.map((r) => [r.id, r]))
// The lot's processing log (GET /:id/seed-stage), newest entry first as the route orders it.
const STAGE_LOG = [
  { id: 'st-3', stage: 'stored', entered_at: iso(1), note: null },
  { id: 'st-2', stage: 'drying', entered_at: iso(6), note: null },
  { id: 'st-1', stage: 'fermenting', entered_at: iso(9), note: 'Water changed on day 2.' },
]
// The picker projection (/api/plants?view=picker): every lot's parent, so each card's "Saved from" names it.
const PLANTINGS = ROWS.filter((r) => r.source_plant_id).map((r) => ({
  id: r.source_plant_id, name: r.id === RISTRA_ID ? 'Ristra Cayenne II, bed 4' : `${r.name.split(' saved')[0]} plant`,
  quantity: 1, variety_id: r.variety_id, variety_ref: { name: r.name.split(' saved')[0] }, sown_at: '2026-03-02', succession_order: null, project_name: null,
}))
const CROP_TYPES = [{ slug: 'pepper', display_name: 'Pepper' }, { slug: 'tomato', display_name: 'Tomato' }, { slug: 'lettuce', display_name: 'Lettuce' }]

// ── network: the far side of the wire only ───────────────────────────────────────────────────────────
// Order matters: /seed-stage and every sub-route also contain the item path.
const realFetch = window.fetch
const json = (body, ms = 20, status = 200) => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), ms))
const unstubbed = []
window.fetch = (url, opts = {}, ...rest) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  if (!u.includes('/api/')) return realFetch(url, opts, ...rest)
  if (method !== 'GET') return json({ ok: true })
  if (u.includes('/api/photos/view-url/')) return json({ error: 'not found' }, 0, 404)
  if (/\/api\/inventory-items\/[^/?]+\/seed-stage/.test(u)) return json(STAGE_LOG)
  const item = u.match(/\/api\/inventory-items\/([^/?]+)(\?|$)/)
  if (item) return BY_ID[item[1]] ? json(BY_ID[item[1]], ITEM_MS) : json({ error: 'Not found' }, 20, 404)
  if (/\/api\/inventory-items(\?|$)/.test(u)) return json(ROWS, ROWS_MS)
  if (u.includes('/sow-candidates')) return json({ items: [] })
  if (u.includes('/api/varieties/crop-types')) return json(CROP_TYPES)
  if (u.includes('/api/varieties/sources')) return json([])
  if (u.includes('/api/varieties/source-kinds')) return json([])
  if (u.includes('/api/plants')) return json(PLANTINGS)
  if (u.includes('/api/projects')) return json([])
  if (u.includes('/api/favorites')) return json([])
  // Anything else answers an empty list and is RECORDED, so a request this fixture does not know shows.
  unstubbed.push(`${method} ${u.replace(location.origin, '')}`)
  return json([])
}

// Anything the page throws on the way up is recorded, and the gate refuses to measure past it.
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

// A scroll trace for the gate's failure messages: every scroll event since the last mark(), with the
// route it happened on. Observation only — nothing here moves the page.
const trace = []
const T0 = performance.now()
window.addEventListener('scroll', () => {
  if (trace.length < 400) trace.push({ t: Math.round(performance.now() - T0), y: Math.round(window.scrollY), path: location.pathname })
}, { capture: true, passive: true })

// ── stand-ins ─────────────────────────────────────────────────────────────────────────────────────────
function TodayStandIn() {
  return (
    <div style={{ padding: 20, display: 'grid', gap: 12 }}>
      <Link to="/seeds?view=saved" data-testid="harness-to-saved" style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>Saved seeds</Link>
      <Link to="/seeds?view=mine" data-testid="harness-to-mine" style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>My seeds</Link>
    </div>
  )
}
function PlantingStandIn() {
  const { plantingId } = useParams()
  const [loading, setLoading] = useState(true)
  // PlantingDetail's reset, gated exactly as PlantingDetail gates it (BUG-DETAILPAGESCARRYSCROLL-001): with
  // the app-level manager on, the manager owns the top and the return.
  useEffect(() => { if (!SCROLL_MANAGER_ENABLED) window.scrollTo(0, 0) }, [plantingId])
  useEffect(() => { const t = setTimeout(() => setLoading(false), PLANTING_MS); return () => clearTimeout(t) }, [plantingId])
  // PlantingDetail's Shell, exactly: minHeight calc(100dvh - 52px), maxWidth 720, padding 32px 20px.
  const shell = (children) => (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: '#faf8f3' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
  if (loading) return shell(<div data-testid="harness-planting-loading" style={{ padding: 48, textAlign: 'center' }}>Loading…</div>)
  return shell(<div data-testid="harness-planting" style={{ minHeight: 1200 }}><h1>Planting {plantingId}</h1></div>)
}
function LeftThePage() {
  const loc = useLocation()
  return <div data-testid="harness-left-page">left the page for {loc.pathname}</div>
}
// BottomNav's +LOG door, as BottomNav builds it: an ARMED sheet (armsBack — the registry pushes a Back
// marker entry that copies the page's idx) whose row is a SheetRowLink with `overlay`, which on tap closes
// the sheet and REPLACE-opens the overlay into the marker's slot. The real rows go to /log and /log/many;
// this one goes to /search, the harness's only overlay route — the door's history shape is what is under
// test (flow f), not the form behind it.
function BottomNavStandIn() {
  const [create, setCreate] = useState(false)
  // BottomNav writes --bottom-nav-height in a layout effect; AppShell's paddingBottom reads it.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', `${BOTTOM_NAV_HEIGHT_PX}px`)
  }, [])
  return (
    <>
      <nav aria-label="Main navigation"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100,
          background: '#fff', borderTop: '1px solid #d4c9be', boxSizing: 'border-box', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <button type="button" data-testid="harness-plus-log" onClick={() => setCreate(true)} style={{ height: 44, minWidth: 64 }}>+LOG</button>
      </nav>
      <Sheet open={create} onClose={() => setCreate(false)} ariaLabel="Create new" armsBack>
        <SheetRowLink to="/search" overlay onClick={() => setCreate(false)} data-testid="harness-create-log"
          style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 24px' }}>Log an event</SheetRowLink>
      </Sheet>
    </>
  )
}
const routeEl = (el) => <ErrorBoundary scope="route" fallback={<div data-testid="harness-route-fallback">route fallback</div>}>{el}</ErrorBoundary>

// App.jsx's OverlayHost, line for line (see the header for why it is copied).
function HarnessOverlayHost({ ariaLabel, size = 'peek', children }) {
  const dismiss = useOverlayDismiss()
  const [dirty, setDirty] = React.useState(false)
  return (
    <Sheet open onClose={dismiss} ariaLabel={ariaLabel} size={size} dirty={dirty} kind="route">
      <OverlaySurfaceProvider>
        <OverlayDirtyProvider onDirtyChange={setDirty}>{children}</OverlayDirtyProvider>
      </OverlaySurfaceProvider>
    </Sheet>
  )
}
// The Search page's stand-in: a block of the height the peek sheet shows, so its X sits where it does, and
// ONE result. A result is what Search.jsx renders it as — a plain <Link> to the page, a PUSH that carries no
// background — so Back from it re-opens Search over a Seeds page that re-MOUNTS under the sheet (flow h,
// BUG-OVERLAYRELOADKEY-001). It goes to the planting stand-in, which is not under test.
function SearchStandIn() {
  return (
    <div data-testid="harness-search" style={{ height: 360, padding: 20, boxSizing: 'border-box' }}>
      <Link to="/plantings/pl-ristra" data-testid="harness-search-result"
        style={{ display: 'flex', alignItems: 'center', minHeight: 48 }}>Ristra Cayenne II, bed 4</Link>
    </div>
  )
}
// The Seeds page, counted: flow h has to know the page really re-mounted under Search (its precondition),
// and a parent mounts and unmounts with its only child. Observation only; it renders the real page as is.
let seedsMounts = 0
function SeedsCounted() {
  useEffect(() => { seedsMounts += 1 }, [])
  return <Seeds />
}

// AppShell's shape: the top bar (with header Search), the page tree at pageLocation, the overlay tree at the
// real location only while an overlay has a background, and the bottom nav.
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  const navigationType = useNavigationType()
  const pageScroll = usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready: true })
  return (
    <PageScrollProvider value={pageScroll}>
      <header data-app-chrome="top"
        style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
          background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 8 }}>
        <OverlayLink to="/search" aria-label="Search your garden" data-testid="harness-open-search"
          style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⌕</OverlayLink>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh',
        paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
        <div style={{ flex: 1 }}>
          <Routes location={pageLocation}>
            <Route path="/today" element={routeEl(<TodayStandIn />)} />
            <Route path="/seeds" element={routeEl(<SeedsCounted />)} />
            <Route path="/inventory/:id" element={routeEl(<InventoryDetail />)} />
            <Route path="/plantings/:plantingId" element={routeEl(<PlantingStandIn />)} />
            <Route path="*" element={<LeftThePage />} />
          </Routes>
        </div>
      </div>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<HarnessOverlayHost ariaLabel="Search your garden" size="peek"><SearchStandIn /></HarnessOverlayHost>} />
        </Routes>
      )}
      <BottomNavStandIn />
    </PageScrollProvider>
  )
}

// Start on /today, so the Seeds entry the gate taps into is a PUSH from an earlier entry. A requested
// reload instead goes back to the router URL it was on, keeping the entry's state (see the header).
if (RELOAD_TO) window.history.replaceState(window.history.state, '', RELOAD_TO)
else window.history.replaceState(null, '', '/today')
createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <BrowserRouter>
      <DismissRegistryProvider>
        <OverlayProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </OverlayProvider>
      </DismissRegistryProvider>
    </BrowserRouter>
  </AuthProvider>,
)

// One id per document: the gate reads it at the start and end of a flow, so a reload in between (Vite
// re-optimizing a dependency reloads the frame at whatever router URL it is on) is named as such.
const BOOT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
window.__h = {
  boot: () => BOOT,
  ready: () => !!document.querySelector('[data-testid="harness-to-saved"]') || location.pathname !== '/today',
  errors: () => [...errors],
  unstubbed: () => [...unstubbed],
  // react-router's key for the current history entry — the key useScrollRestore files offsets under.
  key: () => { try { return window.history.state?.key ?? null } catch { return null } },
  // useScrollRestore's sessionStorage mirror, for the gate's failure messages only (never asserted: the
  // storage shape is the hook's business, Back's landing is the contract).
  store: () => { try { return JSON.parse(window.sessionStorage.getItem('garden.scrollRestore.v1')) } catch { return null } },
  // How many times the Seeds page has mounted in this document (flow h's precondition).
  seedsMounts: () => seedsMounts,
  // Flow i: reload this document on the current history entry (see the header), and whether this
  // document IS such a reload.
  reloadHere: () => {
    window.sessionStorage.setItem(RELOAD_TO_KEY, location.pathname + location.search + location.hash)
    window.history.replaceState(window.history.state, '', HARNESS_URL)
    location.reload()
    return true
  },
  reloadedDoc: () => !!RELOAD_TO,
  mark: () => { trace.length = 0; return true },
  trace: () => trace.slice(),
  // The page-scroll manager's flag as this document was served it, and the mode the browser is in.
  manager: () => ({ enabled: SCROLL_MANAGER_ENABLED, mode: (() => { try { return window.history.scrollRestoration } catch { return null } })() }),
  fixture: () => ({ rows: ROWS.length, lotId: RISTRA_ID, lotName: RISTRA.name, parent: 'pl-ristra', itemMs: ITEM_MS, rowsMs: ROWS_MS }),
}
