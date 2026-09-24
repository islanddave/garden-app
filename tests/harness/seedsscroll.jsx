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
// layout effect as BottomNav does. Both stand-ins carry the real tags and heights (the gate checks them);
// they carry no controls. TodayBand is off in prod (TODAY_BAND_HIDDEN), so --today-band-height is unset.
// The document's height — which is what the clamp and the anchoring act on — is therefore the app's.
//
// WHAT IS A STAND-IN, and why that is enough:
//   /today — two links in (Saved seeds, My seeds), so /seeds is a PUSH from an earlier entry, as it is
//     from More → Seeds. It is replaced into place before the first render.
//   /plantings/:id — PlantingDetail's two properties this bug turns on, copied from src/pages/
//     PlantingDetail.jsx: its loading Shell (minHeight calc(100dvh - 52px), "Loading…") is the short
//     first paint the old unmount save read, and it resets scroll on mount (useEffect(() =>
//     window.scrollTo(0, 0), [plantingId])). Its content lands PLANTING_MS later. The planting page itself
//     is not under test; the Saved seeds entry it is Backed out of is.
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
import React, { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx'
import Seeds from '../../src/pages/Seeds.jsx'
import InventoryDetail from '../../src/pages/InventoryDetail.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const q = new URLSearchParams(location.search)
const TOP_CHROME_PX = Number(q.get('topbar') || 52)
const ITEM_MS = Number(q.get('itemms') ?? 300)
const ROWS_MS = Number(q.get('rowsms') ?? 300)
const PLANTING_MS = 300

try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ }

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
  useEffect(() => { window.scrollTo(0, 0) }, [plantingId])
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
function BottomNavStandIn() {
  // BottomNav writes --bottom-nav-height in a layout effect; AppShell's paddingBottom reads it.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', `${BOTTOM_NAV_HEIGHT_PX}px`)
  }, [])
  return (
    <nav aria-label="Main navigation"
      style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100,
        background: '#fff', borderTop: '1px solid #d4c9be', boxSizing: 'border-box' }} />
  )
}
const routeEl = (el) => <ErrorBoundary scope="route" fallback={<div data-testid="harness-route-fallback">route fallback</div>}>{el}</ErrorBoundary>

// Start on /today, so the Seeds entry the gate taps into is a PUSH from an earlier entry.
window.history.replaceState(null, '', '/today')
createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <BrowserRouter>
      <DismissRegistryProvider>
        <ToastProvider>
          <header data-app-chrome="top"
            style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
              background: '#e8efe4', borderBottom: '1px solid #d4c9be' }} />
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh',
            paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
            <div style={{ flex: 1 }}>
              <Routes>
                <Route path="/today" element={routeEl(<TodayStandIn />)} />
                <Route path="/seeds" element={routeEl(<Seeds />)} />
                <Route path="/inventory/:id" element={routeEl(<InventoryDetail />)} />
                <Route path="/plantings/:plantingId" element={routeEl(<PlantingStandIn />)} />
                <Route path="*" element={<LeftThePage />} />
              </Routes>
            </div>
          </div>
          <BottomNavStandIn />
        </ToastProvider>
      </DismissRegistryProvider>
    </BrowserRouter>
  </AuthProvider>,
)

window.__h = {
  ready: () => !!document.querySelector('[data-testid="harness-to-saved"]') || location.pathname !== '/today',
  errors: () => [...errors],
  unstubbed: () => [...unstubbed],
  // react-router's key for the current history entry — the key useScrollRestore files offsets under.
  key: () => { try { return window.history.state?.key ?? null } catch { return null } },
  // useScrollRestore's sessionStorage mirror, for the gate's failure messages only (never asserted: the
  // storage shape is the hook's business, Back's landing is the contract).
  store: () => { try { return JSON.parse(window.sessionStorage.getItem('garden.scrollRestore.v1')) } catch { return null } },
  mark: () => { trace.length = 0; return true },
  trace: () => trace.slice(),
  fixture: () => ({ rows: ROWS.length, lotId: RISTRA_ID, lotName: RISTRA.name, parent: 'pl-ristra', itemMs: ITEM_MS, rowsMs: ROWS_MS }),
}
