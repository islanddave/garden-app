// todayshell — the Today V2 states inside the APP SHELL, for scripts/layout-gate/today-shell-v2.mjs
// (gate:today-shell:v2). V5-TODAYREDESIGN-001 S0, plan-v2 §8 S0 and §6 (the platform contract).
//
// todaymeasure mounts Today ALONE, so it cannot see what only the shell makes: the sticky jump bar pinned
// under a real 52px TopChrome (§6.1), a jump landing under it (§6.2), and a Back round trip through the
// real page-scroll manager (§6.3, §9.1 f/g/m). This entry is modelled on tests/harness/pagescroll.jsx and
// COPIED, not edited (the SEEDS session owns that file):
//   REAL:  TopChrome; the page-scroll manager, called exactly as AppShell calls it (today-shell-v2.mjs's
//          drift guard fails otherwise) with main.jsx's boot line; the providers App mounts around the page
//          (Auth on the Clerk stub, Mode, Favorites, Prefs, Toast, DismissRegistry, Overlay) under BrowserRouter;
//          the /today element, the same TodayRoute chooser todaymeasure ?v2=1 mounts (V1 Today until S2).
//   STAND-INS: BottomNav — a 56px fixed band (BOTTOM_NAV_HEIGHT_PX) that writes --bottom-nav-height in a
//          layout effect as BottomNav does; and the planting page, one screen with a heading, because (m) only
//          asks where Today comes BACK to.
// The WIRE is todaymeasure's, per contract state (v2wire.js + the same fixtures), with one deliberate
// difference, per the SEEDS session (2026-09-28): /api/members answers PRODUCTION-SHAPED — the roster prod
// returns — never an empty list; an empty roster hid a Garden bug from its gate, and Today's household lens
// and its first /api/daily-plan request both read it.
//
//   /tests/harness/todayshell.html?state=v2-busy&v2=1&clock=2026-09-24T14:30:00.000Z
import './robotoPin.js'
import React, { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ModeProvider } from '../../src/context/ModeContext.jsx'
import { FavoritesProvider } from '../../src/context/FavoritesContext.jsx'
import { PrefsProvider } from '../../src/context/PrefsContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import { OverlayProvider, useOverlay } from '../../src/context/OverlayContext.jsx'
import { usePageScrollManager, PageScrollProvider, applyBrowserScrollRestoration } from '../../src/hooks/usePageScrollManager.js'
import { SCROLL_MANAGER_ENABLED } from '../../src/lib/featureFlags.js'
import TopChrome from '../../src/components/TopChrome.jsx'
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx'
import Today from '../../src/pages/Today.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { stateByName } from './_todaymeasure/today-v2-contract.mjs'
import { buildV2State, localSeeds, selectorFor } from './_todaymeasure/v2wire.js'

// main.jsx's boot line, the real function (pagescroll.jsx's reason: without it Chrome's native restore runs).
applyBrowserScrollRestoration(SCROLL_MANAGER_ENABLED)

const realFetch = window.fetch.bind(window)
const params = new URLSearchParams(location.search)
const STATE = params.get('state') || 'v2-busy'
const V2STATE = stateByName(STATE)
const PROBLEM = V2STATE ? null : `state '${STATE}' is not a row of today-v2-contract.mjs`
const FIX = V2STATE ? V2STATE.fixture : 'busy'
const HARNESS_URL = location.pathname + location.search

// ── fixtures (todaymeasure.jsx's ledger, copied) ─────────────────────────────────────────────────────────
const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVQIW2NkYGD4z8DAwMgABXAGNgGwSgwVAFHrAQVLGCC0AAAAAElFTkSuQmCC'
const fixtures = []
const j = async (p) => {
  const name = p.split('/').pop()
  try {
    const r = await realFetch(p)
    if (!r.ok) { fixtures.push({ name, ok: false, bytes: 0, why: 'HTTP ' + r.status }); return null }
    const text = await r.text()
    const doc = JSON.parse(text)
    fixtures.push({ name, ok: true, bytes: text.length, why: null })
    return doc
  } catch (e) { fixtures.push({ name, ok: false, bytes: 0, why: String(e && e.message) }); return null }
}
const F = '/tests/harness/_todaymeasure/'
const D = await j(F + 'dailyplan.dave.json')
const PLANTS_RAW = (await j(F + 'plants.json')) || []
const LOCATIONS = (await j(F + 'locations.json')) || []
const USESOON = await j(F + 'usesoon.json')
const WATCH = await j(F + 'harvestwatch.json')
const HARVESTS = await j(F + 'harvests.json')
const SOWCAND = await j(F + 'sowcandidates.json')
const BATCHWIN = await j(F + 'harvests.batchwindow.json')
const JENPLAN = await j(F + 'dailyplan.jen.json')
const GRAFTS = await j(F + 'busyfull-grafts.json')
const STORAGE_GRAFTS = await j(F + 'storage-grafts.json')
const V2GRAFTS = await j(F + 'v2-grafts.json')
const LOCATIONS_FULL = await j(F + 'locations.full.json')
const V2PREFS = V2STATE ? await j(F + V2STATE.prefs) : null

// ── the v1 payload builders, COPIED from todaymeasure.jsx (unified at S8c). today-shell-v2.mjs's drift guard
// compares rebase() and graftBusyfull() with the originals, so a change there cannot leave this copy behind.
function rebase(payload) {
  if (!payload?.entries?.length) return payload
  const newest = Math.max(...payload.entries.map(e => new Date(e.created_at).getTime()))
  const delta = (Date.now() - 60 * 60 * 1000) - newest
  const shift = t => (t ? new Date(new Date(t).getTime() + delta).toISOString() : t)
  // created_by is rewritten to the harness identity too: the band scopes the batch to the VIEWER
  // (detectLastBatch({createdBy: viewerId})), and the harness Clerk stub is not Dave's real sub. Same
  // rows, same shape, viewer swapped — without this the band correctly finds nothing.
  return { ...payload, entries: payload.entries.map(e => ({ ...e, created_by: 'harness_user', created_at: shift(e.created_at), event_date: shift(e.event_date), day_key: shift(e.event_date)?.slice(0, 10) ?? e.day_key })) }
}
function graftBusyfull(plan, g) {
  if (!plan || !g) return plan
  const out = { ...plan }
  if (g.alerts_sent?.value) out.alerts_sent = g.alerts_sent.value
  if (g.weather_callout?.value) out.weather = { ...(plan.weather || {}), callout: g.weather_callout.value }
  if (g.leaf_wetness?.value) out.leaf_wetness = g.leaf_wetness.value
  if (g.rain_skipped?.value) out.rain_skipped = g.rain_skipped.value
  if (g.drought?.plan_level) out.drought = g.drought.plan_level
  if (g.drought?.per_item && Array.isArray(plan.dormancy_suppressed)) {
    out.dormancy_suppressed = plan.dormancy_suppressed.map(it => ({ ...it, drought: g.drought.per_item }))
  }
  return out
}
const PLANTS = PLANTS_RAW.map(p => ({ ...p, featured_photo_view_url: p.featured_photo_view_url ? THUMB : null, featured_photo_thumb_url: p.featured_photo_thumb_url ? THUMB : null }))
const quietPlan = D?.plan ? (() => {
  // eslint-disable-next-line no-unused-vars
  const { alerts_sent, drought, leaf_wetness, ...rest } = D.plan
  return {
    ...rest,
    water_due: [], fertilize: [], pest: [], cold: [], dormant: [], no_history: [], rain_skipped: [],
    overwintering: [], dormancy_suppressed: [], feed_suppressed: [],
    weather: rest.weather ? { ...rest.weather, callout: null } : rest.weather,
    counts: { ...(rest.counts || {}), water_due: 0, fertilize: 0, pest: 0, cold: 0, dormant: 0, no_history: 0, rain_skipped: 0 },
    substrate: { ...(rest.substrate || {}), on_hold: true },
  }
})() : null
const addDays = (iso, n) => (iso ? new Date(new Date(iso).getTime() + n * 86400000).toISOString() : iso)
const STORAGE_PLANTS = PLANTS.map(p => (p.id === STORAGE_GRAFTS?.sweet_potato_planting?.id ? { ...p, status: STORAGE_GRAFTS.sweet_potato_planting.status } : p))
const PAYLOAD_BY_FIX = {
  busy: { ...D, has_plan: true },
  busyfull: { ...D, has_plan: true, plan: graftBusyfull(D?.plan, GRAFTS) },
  busyhh: { ...D, has_plan: true, household_plans: JENPLAN ? [{ user_id: 'member_jen', generated_at: D?.generated_at ?? null, plan: JENPLAN }] : [] },
  quiet: { plan: quietPlan, plan_date: D?.plan_date ?? null, generated_at: D?.generated_at ?? null, has_plan: true },
  noplan: { plan: null, plan_date: D?.plan_date ?? null, generated_at: null, has_plan: false },
  storage: { plan: quietPlan, plan_date: D?.plan_date ? addDays(D.plan_date + 'T12:00:00.000Z', 7).slice(0, 10) : null, generated_at: addDays(D?.generated_at ?? null, 7), has_plan: true },
}
const STORAGE = FIX === 'storage'
const EMPTY = !FIX.startsWith('busy')
const WIRE = V2STATE && V2GRAFTS ? buildV2State(V2STATE, { payload: PAYLOAD_BY_FIX[FIX], plants: STORAGE ? STORAGE_PLANTS : (EMPTY ? [] : PLANTS) }, V2GRAFTS, V2PREFS) : null

// A first visit on a clean device, except on the reload the gate asks for (Back returns within one document,
// so this runs once per flow). Then the state's seeds, as todaymeasure ?v2=1 writes them.
try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ }
if (FIX === 'busyhh') { try { localStorage.setItem('garden.today.showOthers', '1') } catch { /* ignore */ } }
const SEEDS = WIRE ? localSeeds(V2STATE, WIRE.payload, 'harness_user') : []
for (const [k, v] of SEEDS) { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

// ── the wire ────────────────────────────────────────────────────────────────────────────────────────────
const OPEN_METEO_STUB = { daily: { time: [-2, -1, 0, 1, 2].map(n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })), precipitation_sum: [0.31, 0.12, 0.04, 0.22, 0.09], precipitation_probability_max: [80, 45, 18, 61, 33] } }
const OPEN_METEO_MODELS_STUB = { daily: { time: [0, 1, 2].map(n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })), precipitation_sum_gfs_global: [0.02, 0.5, 0.2], precipitation_sum_ecmwf_ifs025: [0.03, 0.3, 0.15], precipitation_sum_gem_seamless: [0.05, 0.3, 0.1], precipitation_sum_icon_seamless: [0.08, 0, 0], precipitation_sum_ncep_nbm_conus: [0.02, 0, 0] } }
// Production-shaped roster (the SEEDS session's finding, above). First names only, as todaymeasure's.
const MEMBERS = { members: [{ id: 'harness_user', display_name: 'Dave N' }, { id: 'member_jen', display_name: 'Jen' }] }
const requests = []
let prefsServed = 0
let membersServed = 0
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const method = (init.method || 'GET').toUpperCase()
  if (/open-meteo\.com/.test(url)) {
    const multi = /[?&]models=/.test(url)
    requests.push({ path: multi ? 'open-meteo models (STUBBED)' : 'open-meteo (STUBBED)', method })
    return new Response(JSON.stringify(multi ? OPEN_METEO_MODELS_STUB : OPEN_METEO_STUB), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (/^https?:/.test(url) && !/\/api\//.test(url)) { requests.push({ path: `PASSTHROUGH ${url}`, method, live: true }); return realFetch(input, init) }
  const u = url.startsWith('http') ? new URL(url) : new URL(url, location.origin)
  if (!u.pathname.includes('/api/')) return realFetch(input, init)
  requests.push({ path: u.pathname + u.search, method })
  const p = u.pathname.replace(/^.*(\/api\/)/, '/api/')
  let body = []
  let ms = 20
  if (method !== 'GET') body = { ok: true }
  else if (p === '/api/daily-plan') body = WIRE ? WIRE.payload : PAYLOAD_BY_FIX[FIX]
  else if (p === '/api/members') { membersServed++; body = MEMBERS }
  else if (p === '/api/plants') body = WIRE ? WIRE.plants : PLANTS
  else if (p === '/api/locations/with-path') body = LOCATIONS
  else if (p === '/api/locations') body = LOCATIONS_FULL
  else if (p === '/api/notifications/prefs') { prefsServed++; body = V2PREFS; ms = Math.max(ms, WIRE?.prefsDelayMs || 0) }
  else if (p === '/api/preservation/use-soon') body = STORAGE ? (STORAGE_GRAFTS?.use_soon?.value ?? { items: [] }) : (EMPTY ? [] : (USESOON ?? []))
  else if (p === '/api/harvests/watch') body = EMPTY ? [] : (WATCH ?? [])
  else if (p === '/api/harvests') body = EMPTY ? [] : (FIX === 'busyfull' ? rebase(BATCHWIN) : (HARVESTS ?? []))
  else if (p === '/api/inventory-items/sow-candidates') body = EMPTY ? [] : (SOWCAND ?? [])
  await new Promise(r => setTimeout(r, ms))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

// ── the /today element: the same chooser todaymeasure ?v2=1 mounts ─────────────────────────────────────────
const V2_ROUTE = import.meta.glob('../../src/components/today/v2/TodayRoute.jsx')
let TodayEl = Today
let route = 'absent'
if (params.get('v2stub') === '1') { TodayEl = (await import('./stubs/TodayV2Stub.jsx')).default; route = 'stub' }
else {
  const loaders = Object.values(V2_ROUTE)
  if (loaders.length === 1) { const m = await loaders[0](); TodayEl = m.default || m.TodayRoute; route = 'present' }
}

function PlantingStandIn() {
  const loc = useLocation()
  return <div data-testid="harness-planting" style={{ padding: 20, minHeight: '100dvh' }}><h1 style={{ margin: 0, fontSize: '1.3rem' }}>A planting</h1><p>{loc.pathname}</p></div>
}

// BottomNav's band: fixed, BOTTOM_NAV_HEIGHT_PX tall, writing --bottom-nav-height in a layout effect as BottomNav does.
function BottomNavStandIn() {
  useLayoutEffect(() => { document.documentElement.style.setProperty('--bottom-nav-height', `${BOTTOM_NAV_HEIGHT_PX}px`) }, [])
  return (
    <nav aria-label="Main navigation" data-testid="harness-bottom-nav"
      style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100, background: '#fff', borderTop: '1px solid #d4c9be', boxSizing: 'border-box' }} />
  )
}

const routeEl = (el) => <ErrorBoundary scope="route" fallback={<div data-testid="harness-route-fallback">route fallback</div>}>{el}</ErrorBoundary>

// AppShell's shape, with AppShell's manager call.
function Shell() {
  const { pageLocation, overlayLocation } = useOverlay()
  const navigationType = useNavigationType()
  const authed = true
  const pageScroll = usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready: authed })
  return (
    <PageScrollProvider value={pageScroll}>
      <TopChrome />
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh', paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
        <div data-harness-pages="" style={{ flex: 1 }}>
          <Routes location={pageLocation}>
            <Route path="/today" element={routeEl(<TodayEl />)} />
            <Route path="*" element={routeEl(<PlantingStandIn />)} />
          </Routes>
        </div>
      </div>
      <BottomNavStandIn />
    </PageScrollProvider>
  )
}

window.history.replaceState(null, '', '/today')
createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ModeProvider>
      <FavoritesProvider>
        <PrefsProvider>
          <ToastProvider>
            <BrowserRouter>
              <DismissRegistryProvider>
                <OverlayProvider>
                  <Shell />
                </OverlayProvider>
              </DismissRegistryProvider>
            </BrowserRouter>
          </ToastProvider>
        </PrefsProvider>
      </FavoritesProvider>
    </ModeProvider>
  </AuthProvider>,
)

const frames = (n) => new Promise(r => { const f = k => (k <= 0 ? r() : requestAnimationFrame(() => f(k - 1))); f(n) })
const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right } }
window.__h = {
  problem: () => PROBLEM,
  state: () => STATE,
  route: () => route,
  ready: () => {
    if (location.pathname !== '/today') return !!document.querySelector('[data-testid="harness-planting"]')
    if (route === 'absent') { const t = document.querySelector('[data-testid="today-title"]'); return !!t && !document.body.textContent.includes('Loading…') }
    // The real V2 at its ready point (plan-v2 §6.4; the sections paint there), as todaymeasure's v2ready.
    if (route === 'present') return !!document.querySelector('[data-today-version="2"][data-today-ready="true"]')
    return !!document.querySelector('[data-today-version="2"]')
  },
  errors: () => [...errors],
  error: () => errors[0] || null,
  requests: () => requests,
  fixtures: () => fixtures,
  clock: () => ({ pinned: !!window.__pinnedClock, ...(window.__pinnedClock || {}), now: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  weatherStubbed: () => true,
  v2: () => ({ state: V2STATE?.name ?? null, fixture: FIX, route, seeds: SEEDS.map(([k]) => k), flag: (() => { try { return localStorage.getItem('garden.todayV2') } catch { return null } })(), prefs: { fixture: V2STATE?.prefs ?? null, served: prefsServed }, members: { served: membersServed, count: MEMBERS.members.length }, critterOrigin: import.meta.env.VITE_API_CRITTERS || null }),
  // The shell's own geometry — what the platform contract is measured against.
  chrome: () => {
    const top = document.querySelector('header[data-app-chrome="top"]')
    const nav = document.querySelector('[data-testid="harness-bottom-nav"]')
    return {
      top: rect(top), topState: top ? top.getAttribute('data-chrome-state') : null, topPosition: top ? getComputedStyle(top).position : null,
      nav: rect(nav), navVar: getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height').trim(),
      restoration: (() => { try { return window.history.scrollRestoration } catch { return null } })(),
      manager: SCROLL_MANAGER_ENABLED, innerWidth, innerHeight, dpr: devicePixelRatio, path: location.pathname,
    }
  },
  scrollY: () => Math.round(window.scrollY),
  harnessUrl: () => HARNESS_URL,
  // The same interaction driver as todaymeasure ?v2=1 (hit-tested tap, aria-expanded must flip).
  async act(step) {
    const out = { step, ok: false, void: null, before: null, after: null }
    let sel, flipSel
    try { sel = selectorFor(step.tap); flipSel = selectorFor(step.flip || step.tap) } catch (e) { out.void = e.message; return out }
    const el = document.querySelector(sel)
    if (!el) { out.void = `tap target '${step.tap}' matched nothing`; return out }
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!hit || !(hit === el || el.contains(hit))) { out.void = `tap target '${step.tap}' is covered at its centre`; return out }
    out.before = document.querySelector(flipSel)?.getAttribute('aria-expanded') ?? null
    el.click(); await frames(3)
    out.after = document.querySelector(flipSel)?.getAttribute('aria-expanded') ?? null
    if (out.before == null || out.after == null || out.before === out.after) out.void = `aria-expanded on '${step.flip || step.tap}' did not flip (${out.before} → ${out.after})`
    else out.ok = true
    return out
  },
}
