// todaymeasure — MEASUREMENT harness for the real /today surface at Dave's geometry.
//
// Purpose: characterise the Today page as it actually RENDERS, so a design crucible argues from
// pixels rather than from reading Today.jsx. Nothing under src/ is modified or re-implemented: this
// mounts the REAL `Today` page component inside the REAL router and the REAL AuthProvider, and only
// the wire (window.fetch) is stubbed.
//
// DATA IS PROD, NOT INVENTED. The payloads in ./_todaymeasure/ are dumped from live prod Neon,
// read-only, by ./_todaymeasure/dump-prod.mjs for Dave's household on 2026-09-24 (the 10:00 ET plan
// run), then scrubbed. `dailyplan.dave.json` is daily_plan.items verbatim: 168 water_due, 58
// fertilize, 7 pest, 5 cold, 9 dormant, 9 feed_suppressed. A hand-shaped fixture would have measured
// a page that nobody has. (Carried unchanged from the 2026-09-08 dump: harvests.json and
// harvests.batchwindow.json — see _todaymeasure/bands-notes.md.)
//
// STATES, because the complaint has two halves and they are different design problems:
//   ?state=busy     — today, as it really is for Dave (the default)
//   ?state=busyfull — today PLUS every conditional line and band Today can show, grafted from the
//                     latest real day each one occurred (busyfull-grafts.json, provenance per key)
//   ?state=busyhh   — busy with the household lens open (recorder only, not in the gate budget)
//   ?state=quiet    — a plan exists but every list in it is empty and every band is empty
//   ?state=noplan   — has_plan false: the first-run / engine-hasn't-run empty state
//   ?state=storage  — `quiet`, one week on (clock and plan dated 2026-10-01, see todaymeasure.html),
//                     plus the two regions no 2026-09-24 payload can show: StorageDeadlineAlert inside
//                     the sweet-potato check window and PutUpUseSoonBand with jars in their window,
//                     each from real prod rows with one field moved (storage-grafts.json)
//
// window.__h is the measurement surface. It reports geometry, computed CSS and an ink profile; it
// never asserts. Analysis happens in _todaymeasure/drive.mjs and downstream, so a change of opinion
// about what "too much whitespace" means does not require re-driving the browser.
//
// FONT (V5-TODAYSHAPECI-001): the page's text is laid out in Roboto, the face Dave's Android renders,
// on the Mac that records the budget and on the CI runner that checks it alike. The import is FIRST
// and the module loads every face before this entry's body runs. See robotoPin.js.
import './robotoPin.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Today from '../../src/pages/Today.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { PrefsProvider } from '../../src/context/PrefsContext.jsx'
import { P } from '../../src/lib/constants.js'
import { T } from '../../src/components/forms/formStyles.js'
import { stateByName } from './_todaymeasure/today-v2-contract.mjs'
import { buildV2State, localSeeds, selectorFor, flipState, flipAttr } from './_todaymeasure/v2wire.js'

const realFetch = window.fetch.bind(window)
const params = new URLSearchParams(location.search)
const STATE = params.get('state') || 'busy'

// ── V2 SEAMS (V5-TODAYREDESIGN-001 S0, plan-v2 §8 S0 a–c). INERT unless the URL says ?v2=1, so every v1
// run — gate:today-shape, its mutants, the recorder — takes exactly the path it took before. With ?v2=1:
//   (a) the state is a row of today-v2-contract.mjs (v2-frost, v2-busy, …); the device is cleared, then
//       `garden.todayV2`='1' and the state's local seeds are written before mount, and the page mounts the
//       same TodayRoute chooser App mounts (src/components/today/v2/TodayRoute.jsx — S2 writes it; until
//       then there is no chooser, so V1 Today mounts, exactly as App would, and __h.v2().route says
//       'absent'). ?v2stub=1 mounts tests/harness/stubs/TodayV2Stub.jsx instead: the gate's self-test.
//   (b) PrefsProvider is mounted and GET /api/notifications/prefs is answered from the state's prefs
//       fixture. It only goes out when VITE_API_CRITTERS is set, which tests/harness/vite.harness.v2.mjs
//       does; __h.requests() shows the GET and __h.v2().prefs counts it.
//   (c) __h.act(step) drives a tap or a scroll; a tap that does not flip aria-expanded is VOID.
// FIX is the v1 payload a state starts from: STATE itself for v1, the contract row's fixture for v2.
const V2 = params.get('v2') === '1'
const V2STATE = V2 ? stateByName(STATE) : null
const V2PROBLEM = V2 && !V2STATE ? `?v2=1 with state '${STATE}', which is not a row of today-v2-contract.mjs` : null
const FIX = V2STATE ? V2STATE.fixture : STATE

// A 4x4 sage PNG. Photo URLs in the dumped rows are S3 presigns that expire and cannot be replayed;
// what matters for layout is that the <img> box paints at all, so every thumb gets this. Documented
// deviation: real photos differ in nothing that changes a box's height.
const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVQIW2NkYGD4z8DAwMgABXAGNgGwSgwVAFHrAQVLGCC0AAAAAElFTkSuQmCC'

// FIXTURE LEDGER (V5-TODAYSHAPE-001 item 7, the zero-byte sibling of the innerWidth refusal). Every
// fixture read is recorded with its byte length and top-level row count, and `j` no longer swallows
// a miss into `null` silently — it records it. A 404, a truncated dump or an empty array all render
// a SHORTER page that passes every ceiling and scores a perfect ink-%, so "the fixture was there"
// has to be an assertion the gate can make, not an assumption. The gate reads __h.fixtures().
const fixtures = []
const j = async (p) => {
  const name = p.split('/').pop()
  try {
    const r = await realFetch(p)
    if (!r.ok) { fixtures.push({ name, ok: false, bytes: 0, rows: null, why: 'HTTP ' + r.status }); return null }
    const text = await r.text()
    let doc = null
    try { doc = JSON.parse(text) } catch (e) { fixtures.push({ name, ok: false, bytes: text.length, rows: null, why: 'unparseable: ' + e.message }); return null }
    const rows = Array.isArray(doc) ? doc.length
      : (doc && Array.isArray(doc.items)) ? doc.items.length
      : (doc && Array.isArray(doc.entries)) ? doc.entries.length
      : (doc && typeof doc === 'object') ? Object.keys(doc).length : 0
    fixtures.push({ name, ok: true, bytes: text.length, rows, why: null })
    return doc
  } catch (e) {
    fixtures.push({ name, ok: false, bytes: 0, rows: null, why: String(e && e.message) })
    return null
  }
}

const D = await j('/tests/harness/_todaymeasure/dailyplan.dave.json')
const PLANTS_RAW = (await j('/tests/harness/_todaymeasure/plants.json')) || []
const LOCATIONS = (await j('/tests/harness/_todaymeasure/locations.json')) || []
const USESOON = (await j('/tests/harness/_todaymeasure/usesoon.json'))
const WATCH = (await j('/tests/harness/_todaymeasure/harvestwatch.json'))
const HARVESTS = (await j('/tests/harness/_todaymeasure/harvests.json'))
const SOWCAND = (await j('/tests/harness/_todaymeasure/sowcandidates.json'))
const BATCHWIN = (await j('/tests/harness/_todaymeasure/harvests.batchwindow.json'))
const JENPLAN = (await j('/tests/harness/_todaymeasure/dailyplan.jen.json'))
const GRAFTS = (await j('/tests/harness/_todaymeasure/busyfull-grafts.json'))
const STORAGE_GRAFTS = (await j('/tests/harness/_todaymeasure/storage-grafts.json'))
// V2 only (seam a/b): the engine-built grafts, GET /api/locations in full, and this state's prefs body.
const V2GRAFTS = V2 ? await j('/tests/harness/_todaymeasure/v2-grafts.json') : null
const LOCATIONS_FULL = V2 ? await j('/tests/harness/_todaymeasure/locations.full.json') : null
const V2PREFS = V2STATE ? await j(`/tests/harness/_todaymeasure/${V2STATE.prefs}`) : null
// A v2 state is a first visit on a clean device: nothing an earlier state in the same browser wrote may
// leak into it (the gate runs every state in one Chrome profile). Its own seeds are written below.
// HARNESS HYGIENE (V5-TODAYREDESIGN-001 S2, the S1b finding): V1's care list holds its section order and open
// set per tab + user + plan day (src/components/today/visitLayout.js, 'today-visit:' in sessionStorage), and
// the v1 gate drives ONE signed-in tab through its states — so without this, busy measured the layout busyfull
// left behind (a Back restore) instead of a fresh visit. Every state now boots a fresh visit, v1 and v2 alike.
// ?keepVisit=1 keeps the visit keys: that is how a back-restore check measures a return.
const KEEP_VISIT = params.get('keepVisit') === '1'
const dropSession = (keep) => {
  const drop = []
  for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && !keep(k)) drop.push(k) }
  for (const k of drop) sessionStorage.removeItem(k)
}
const isVisitKey = (k) => k.startsWith('today-visit:')
if (V2) { try { localStorage.clear(); dropSession((k) => KEEP_VISIT && isVisitKey(k)) } catch { /* ignore */ } }
else if (!KEEP_VISIT) { try { dropSession((k) => !isVisitKey(k)) } catch { /* ignore */ } }

// The household lens is ONE TAP from the default and Dave has a second caretaker, so what it costs
// in scroll is a real number, not a hypothetical. localStorage is seeded before mount because the
// component reads it in a useState initialiser.
if (FIX === 'busyhh') { try { localStorage.setItem('garden.today.showOthers', '1') } catch { /* ignore */ } }
else { try { localStorage.removeItem('garden.today.showOthers') } catch { /* ignore */ } }

// ComposeHarvestBand is gated on TWO clocks — the read model's 24h `created_since` and the
// component's own 18h MAX_BATCH_AGE_MS — and Dave's last logged pick before this dump (2026-09-23
// 14:14 ET) is outside the 18h one at the pinned 10:30 ET. So on the real 2026-09-24 that band is
// 0px, and 0px is the honest number for TODAY. It is NOT the honest number for "a day Dave picked
// something", which is the state the design has to work in too. `busyfull` serves a real prod batch
// (the 20-entry 2026-09-07 one) with every timestamp rebased so the newest sits one hour back — real
// rows, real shape, moved clock. Labelled as its own state rather than folded into `busy` so no
// number here is quietly counterfactual.
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

const PLANTS = PLANTS_RAW.map(p => ({
  ...p,
  featured_photo_view_url: p.featured_photo_view_url ? THUMB : null,
  featured_photo_thumb_url: p.featured_photo_thumb_url ? THUMB : null,
}))

// The quiet day: the SAME plan envelope with every actionable list drained. Not `has_plan:false` —
// that is the third state. This is "the engine ran, and there is nothing for you to do", which is
// the state Dave sees on a rainy day in January and the one the complaint's second half is about.
// The conditional ambient lines are stripped too (frost entries, cue, drought, leaf wetness), so the
// state stays quiet if a later re-dump happens to land on a day that carried one.
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

// busyfull — today's REAL plan plus each conditional line Today can render, so every region is on
// screen at once. Each graft is a real payload fragment from the most recent prod day that carried
// it (busyfull-grafts.json names the day per key); the one exception is drought, which prod has never
// emitted, and whose fragment the dump produced with the engine's own droughtSignal.js and labelled
// `synthetic`. Grafting only ADDS keys the renderers read; nothing already in today's plan is edited
// except `weather.callout` (null today) and the drought key on the two dormancy_suppressed items.
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

// storage — the quiet plan RE-DATED one week on. todaymeasure.html pins this state's clock to 10:30
// ET on 2026-10-01 (the sweet-potato check window opens 09-28), so the plan it serves is dated that
// same morning: the date subtitle and the "as of" stamp then describe the instant measured, as they
// do in every other state. Its /api/plants is the real list with ONE planting's status moved, and
// its /api/preservation/use-soon is the real stored jars with their window status forced — both
// named, with provenance, in storage-grafts.json.
const STORAGE_DAYS = 7
const addDays = (iso, n) => (iso ? new Date(new Date(iso).getTime() + n * 86400000).toISOString() : iso)
const STORAGE_PLANTS = PLANTS.map(p => (p.id === STORAGE_GRAFTS?.sweet_potato_planting?.id ? { ...p, status: STORAGE_GRAFTS.sweet_potato_planting.status } : p))

const PAYLOAD_BY_FIX = {
  busy:     { ...D, has_plan: true },
  busyfull: { ...D, has_plan: true, plan: graftBusyfull(D?.plan, GRAFTS) },
  busyhh:   { ...D, has_plan: true, household_plans: JENPLAN ? [{ user_id: 'member_jen', generated_at: D?.generated_at ?? null, plan: JENPLAN }] : [] },
  quiet:  { plan: quietPlan, plan_date: D?.plan_date ?? null, generated_at: D?.generated_at ?? null, has_plan: true },
  noplan: { plan: null, plan_date: D?.plan_date ?? null, generated_at: null, has_plan: false },
  storage: {
    plan: quietPlan,
    plan_date: D?.plan_date ? addDays(D.plan_date + 'T12:00:00.000Z', STORAGE_DAYS).slice(0, 10) : null,
    generated_at: addDays(D?.generated_at ?? null, STORAGE_DAYS),
    has_plan: true,
  },
}
const STORAGE = FIX === 'storage'

const EMPTY = !FIX.startsWith('busy')
const requests = []

// V2 (seam a): the contract row's payload = its fixture's v1 payload, re-dated and grafted (v2wire.js).
const V2WIRE = V2STATE && V2GRAFTS
  ? buildV2State(V2STATE, { payload: PAYLOAD_BY_FIX[FIX], plants: STORAGE ? STORAGE_PLANTS : (EMPTY ? [] : PLANTS) }, V2GRAFTS, V2PREFS)
  : null
const PAYLOAD = V2WIRE ? V2WIRE.payload : PAYLOAD_BY_FIX[FIX]
const V2SEEDS = V2WIRE ? localSeeds(V2STATE, PAYLOAD, 'harness_user') : []
for (const [k, v] of V2SEEDS) { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
let prefsServed = 0

// OPEN-METEO, STUBBED AT THE WIRE (V5-TODAYSHAPE-001 item 6). The original characterisation run let
// this through to the real public API, because Dave's phone does — correct for a one-off portrait of
// the page, wrong for a repeatable gate. The response decides the rain line's wording AND whether
// the "Updated … · live" stamp renders at all, so a live read makes ink-% and scroll-height move
// with the actual weather. A gate that reds because it rained is a gate that gets switched off.
//
// The numbers are SYNTHETIC and fixed, not a recording of a real day — the array is the shape
// mapOpenMeteoDailyToHydrology consumes: [D-2, D-1, D0, D1, D2] in inches, America/New_York buckets
// (src/lib/liveWeather.js). Chosen so every field of the mapped hydrology is non-null and
// non-zero, because a null there takes a DIFFERENT and shorter render branch and would measure the
// degraded surface while claiming to measure the normal one. The mapper is POSITIONAL, so `time` is
// decoration; it is still derived from the pinned clock so the stub never names a different week.
// ?wx=live restores the real read for characterisation runs.
const WX_LIVE = params.get('wx') === 'live'
const etDayOffset = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const OPEN_METEO_STUB = {
  daily: {
    time: [-2, -1, 0, 1, 2].map(etDayOffset),
    precipitation_sum: [0.31, 0.12, 0.04, 0.22, 0.09],
    precipitation_probability_max: [80, 45, 18, 61, 33],
  },
}

// BUG-RAINFCSTONEMODEL-001 — the card's day-ahead line now comes from a SECOND, five-model request
// (src/lib/rainForecast.js). Answered with the single-model body above it would parse to null and the gate
// would silently measure the best_match fallback instead of the branch prod renders. Same D1/D2 means as
// the stub above (0.22″, 0.09″) with 3 of 5 models wet, so the line reads "… · 60% chance".
const OPEN_METEO_MODELS_STUB = {
  daily: {
    time: [0, 1, 2].map(etDayOffset),
    precipitation_sum_gfs_global: [0.02, 0.5, 0.2],
    precipitation_sum_ecmwf_ifs025: [0.03, 0.3, 0.15],
    precipitation_sum_gem_seamless: [0.05, 0.3, 0.1],
    precipitation_sum_icon_seamless: [0.08, 0, 0],
    precipitation_sum_ncep_nbm_conus: [0.02, 0, 0],
  },
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  if (!WX_LIVE && /open-meteo\.com/.test(url)) {
    const multi = /[?&]models=/.test(url)
    requests.push({ path: multi ? 'open-meteo models (STUBBED)' : 'open-meteo (STUBBED)', method: init.method || 'GET' })
    return new Response(JSON.stringify(multi ? OPEN_METEO_MODELS_STUB : OPEN_METEO_STUB), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  // Any other third-party read still goes to the network. Nothing on this page makes one today; the
  // passthrough stays so a newly-added one is visible in requests() rather than silently mocked.
  // V5-TODAYSHAPE-001 — it is now RECORDED, not merely allowed, and the gate fails on it. The
  // comment above previously claimed this visibility while the branch returned without pushing, so
  // nothing was visible. That mattered because `weatherStubbed()` below reports the WX_LIVE FLAG —
  // an intent — not whether the stub ever fired: if Open-Meteo's host moves, the request stops
  // matching the stub arm above, falls through to here, and the flag still reads `true`. The gate
  // would then certify "determinism enforced" over numbers drifting with the real weather.
  if (/^https?:/.test(url) && !/\/api\//.test(url)) {
    requests.push({ path: `PASSTHROUGH ${url}`, method: init.method || 'GET', live: true })
    return realFetch(input, init)
  }
  const u = url.startsWith('http') ? new URL(url) : new URL(url, location.origin)
  const path = u.pathname + u.search
  if (!u.pathname.includes('/api/')) return realFetch(input, init)
  requests.push({ path, method: init.method || 'GET' })
  const p = u.pathname.replace(/^.*(\/api\/)/, '/api/')
  let body = []
  let ms = 20
  if (p === '/api/daily-plan') body = PAYLOAD
  // First names only (privacy sweep 2026-09-24). Today prints only the first token of a member's
  // display_name (Today.jsx nameFor), so a surname here buys no geometry and exposes a person.
  else if (p === '/api/members') body = { members: EMPTY ? [] : [{ id: 'harness_user', display_name: 'Dave' }, { id: 'member_jen', display_name: 'Jen' }] }
  else if (p === '/api/plants') body = V2WIRE ? V2WIRE.plants : (STORAGE ? STORAGE_PLANTS : (EMPTY ? [] : PLANTS))
  else if (p === '/api/locations/with-path') body = LOCATIONS
  // V2 only (seam b): GET /api/locations in full (covered/heated/parent_id) and the prefs read.
  else if (V2 && p === '/api/locations') body = LOCATIONS_FULL
  else if (V2 && p === '/api/notifications/prefs' && (init.method || 'GET').toUpperCase() === 'GET') { prefsServed++; body = V2PREFS; ms = Math.max(ms, V2WIRE?.prefsDelayMs || 0) }
  else if (p === '/api/preservation/use-soon') body = STORAGE ? (STORAGE_GRAFTS?.use_soon?.value ?? { items: [] }) : (EMPTY ? [] : (USESOON ?? []))
  else if (p === '/api/harvests/watch') body = EMPTY ? [] : (WATCH ?? [])
  else if (p === '/api/harvests') body = EMPTY ? [] : (FIX === 'busyfull' ? rebase(BATCHWIN) : (HARVESTS ?? []))
  else if (p === '/api/inventory-items/sow-candidates') body = EMPTY ? [] : (SOWCAND ?? [])
  // V2 only (S4): a logged event answers with an id, as the events Lambda does, so a V2 Undo has something to
  // DELETE (gate:today-shape:v2 group-water-all runs the MF3 round trip). DELETE /api/events/:id answers 200.
  // S4g: the gate can make the next N of these POSTs fail (__h.failPosts), as a dropped write in the garden
  // does — MF3's "Not logged · Retry" has no other way to appear on a stubbed wire. The count is consumed in
  // CALL order, so which rows of a run fail is fixed by the run's own order.
  else if (V2 && p === '/api/events' && (init.method || 'GET').toUpperCase() === 'POST') {
    if (v2FailPosts > 0) {
      v2FailPosts--
      await new Promise(r => setTimeout(r, ms))
      return new Response(JSON.stringify({ error: 'harness: injected write failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    }
    body = { id: 'hv2-' + (++v2EventSeq) }
  }
  await new Promise(r => setTimeout(r, ms))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

var v2EventSeq = 0
var v2FailPosts = 0
let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

// V2 (seam a): the chooser App mounts, found by glob so its ABSENCE (before S2) is a fact this page
// reports rather than a build error. A literal path: the glob matches that one file or nothing.
const V2_ROUTE = import.meta.glob('../../src/components/today/v2/TodayRoute.jsx')
let V2Root = null
let v2Route = null
if (V2) {
  if (params.get('v2stub') === '1') { V2Root = (await import('./stubs/TodayV2Stub.jsx')).default; v2Route = 'stub' }
  else {
    const loaders = Object.values(V2_ROUTE)
    if (loaders.length === 1) { const m = await loaders[0](); V2Root = m.default || m.TodayRoute; v2Route = 'present' }
    else { V2Root = Today; v2Route = 'absent' }
  }
}

createRoot(document.getElementById('root')).render(V2 ? (
  <AuthProvider>
    <PrefsProvider>
      <MemoryRouter initialEntries={['/today']}>
        <V2Root />
      </MemoryRouter>
    </PrefsProvider>
  </AuthProvider>
) : (
  <AuthProvider>
    <MemoryRouter initialEntries={['/today']}>
      <Today />
    </MemoryRouter>
  </AuthProvider>
))

// ── measurement ────────────────────────────────────────────────────────────────────────────────
const BADGE = document.getElementById('hbadge')
const todayRoot = () => document.getElementById('root').firstElementChild
const inBadge = el => BADGE.contains(el)

const px = v => (v == null ? null : Math.round(parseFloat(v) * 100) / 100)
const norm = s => (s || '').replace(/\s+/g, ' ').trim()

// Reverse index rgb() -> the palette constant that produced it, so "is this section using tokens or
// hardcoding?" is answered by the computed value rather than by reading the class name.
function rgbOf(hex) {
  const d = document.createElement('div'); d.style.color = hex; document.body.appendChild(d)
  const v = getComputedStyle(d).color; d.remove(); return v
}
const COLOR_INDEX = {}
for (const [k, v] of Object.entries(P)) { if (typeof v === 'string' && /^#|^rgb/.test(v)) { const r = rgbOf(v); if (!COLOR_INDEX[r]) COLOR_INDEX[r] = 'P.' + k } }
const tokenName = c => COLOR_INDEX[c] || null

const STYLE_KEYS = [
  'display', 'flexDirection', 'gap', 'rowGap', 'position',
  'backgroundColor', 'backgroundImage', 'boxShadow', 'opacity',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderTopColor', 'borderBottomColor',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'textAlign', 'color', 'fontFamily',
  'overflowY', 'maxHeight',
]

function styleOf(el) {
  const cs = getComputedStyle(el)
  const o = {}
  for (const k of STYLE_KEYS) o[k] = cs[k]
  o._bgToken = tokenName(cs.backgroundColor)
  o._colorToken = tokenName(cs.color)
  o._borderToken = tokenName(cs.borderTopColor)
  return o
}

function rectOf(el) {
  const r = el.getBoundingClientRect()
  return { top: px(r.top + window.scrollY), bottom: px(r.bottom + window.scrollY), left: px(r.left), right: px(r.right), width: px(r.width), height: px(r.height) }
}

function label(el) {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    testid: el.getAttribute('data-testid') || null,
    aria: el.getAttribute('aria-label') || null,
    role: el.getAttribute('role') || null,
    text: norm(el.textContent).slice(0, 110),
    children: el.children.length,
  }
}

// Depth-limited tree of everything Today renders, in DOM (= visual) order.
function tree(el, depth, maxDepth, path) {
  const out = []
  let i = 0
  for (const c of el.children) {
    if (inBadge(c)) { i++; continue }
    const p = path ? path + '.' + i : String(i)
    const r = rectOf(c)
    out.push({ path: p, depth, ...label(c), rect: r, style: styleOf(c) })
    if (depth < maxDepth) out.push(...tree(c, depth + 1, maxDepth, p))
    i++
  }
  return out
}

// INK PROFILE — the whitespace instrument. A document-height bitmap where a row is 1 if ANY visible
// text run, image, svg or form control paints on it. Blank rows inside a section are vertical space
// spent carrying nothing, which is the literal complaint. Text rects come from Range.getClientRects
// (the actual glyph boxes), not from element boxes, so a 60px-tall div holding one 15px line is
// correctly scored as 45 blank rows rather than 60 ink rows.
function inkProfile() {
  const H = Math.ceil(document.documentElement.scrollHeight)
  const ink = new Uint8Array(H)
  const painted = new Uint8Array(H)
  const mark = (arr, top, bottom) => {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(H, Math.ceil(bottom)); y++) arr[y] = 1
  }
  const sy = window.scrollY
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue
    if (n.parentElement && inBadge(n.parentElement)) continue
    const cs = n.parentElement && getComputedStyle(n.parentElement)
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0')) continue
    const range = document.createRange(); range.selectNodeContents(n)
    for (const rc of range.getClientRects()) if (rc.width > 0.5 && rc.height > 0.5) mark(ink, rc.top + sy, rc.bottom + sy)
  }
  for (const el of document.querySelectorAll('img,svg,canvas,video,input,select,textarea')) {
    if (inBadge(el)) continue
    const rc = el.getBoundingClientRect()
    if (rc.width > 0.5 && rc.height > 0.5) mark(ink, rc.top + sy, rc.bottom + sy)
  }
  for (const el of document.querySelectorAll('*')) {
    if (inBadge(el) || el === document.body || el === document.documentElement) continue
    const cs = getComputedStyle(el)
    const bg = cs.backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      const rc = el.getBoundingClientRect()
      if (rc.width > 0.5 && rc.height > 0.5) mark(painted, rc.top + sy, rc.bottom + sy)
    }
  }
  return { H, ink: Array.from(ink), painted: Array.from(painted) }
}

// Every element that presents as a CARD/CONTAINER: it paints a background, draws a border, or
// rounds its corners. Collected without regard to what component made it, then fingerprinted, so
// "how many distinct container treatments does this one page use?" is a count and not an opinion.
function containers() {
  const root = todayRoot()
  if (!root) return []
  const out = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (inBadge(el)) continue
    const cs = getComputedStyle(el)
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    const bord = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
    const rad = parseFloat(cs.borderTopLeftRadius) > 0
    if (!bg && !bord && !rad) continue
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 20) continue      // chips/badges are a separate question
    out.push({
      ...label(el), rect: rectOf(el),
      fp: [
        cs.backgroundColor,
        `${px(cs.borderTopWidth)}px ${cs.borderTopStyle} ${cs.borderTopColor}`,
        `${px(cs.borderTopLeftRadius)}/${px(cs.borderBottomRightRadius)}`,
        cs.boxShadow,
        `${px(cs.paddingTop)} ${px(cs.paddingRight)} ${px(cs.paddingBottom)} ${px(cs.paddingLeft)}`,
      ].join(' | '),
      style: styleOf(el),
    })
  }
  return out
}

// Every element that carries direct text, with its type treatment. Feeds the type-scale audit.
function typeRuns() {
  const root = todayRoot()
  if (!root) return []
  const seen = new Set()
  const out = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue
    const el = n.parentElement
    if (!el || seen.has(el) || inBadge(el)) continue
    seen.add(el)
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.height <= 0) continue
    out.push({
      text: norm(n.nodeValue).slice(0, 60),
      tag: el.tagName.toLowerCase(),
      top: px(r.top + window.scrollY),
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
      color: cs.color, colorToken: tokenName(cs.color),
      letterSpacing: cs.letterSpacing, textTransform: cs.textTransform,
    })
  }
  return out
}

// Every actionable control with the treatment it actually renders with. "Things are styled
// differently depending on what they're showing" is a claim about controls as much as containers,
// and a class name cannot settle it — two buttons authored in different files can compute the same,
// and two authored from the same helper can compute differently once a parent overrides.
function buttonStyles() {
  const root = todayRoot()
  if (!root) return []
  return [...root.querySelectorAll('button,a,[role="button"],summary')].map(el => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      text: norm(el.textContent).slice(0, 30),
      top: px(r.top + window.scrollY), w: px(r.width), h: px(r.height),
      fp: [cs.backgroundColor, `${px(cs.borderTopWidth)} ${cs.borderTopStyle} ${cs.borderTopColor}`, px(cs.borderTopLeftRadius), cs.color, cs.fontSize, cs.fontWeight, `${px(cs.paddingTop)}/${px(cs.paddingLeft)}`].join(' | '),
      bgToken: tokenName(cs.backgroundColor), colorToken: tokenName(cs.color),
      radius: px(cs.borderTopLeftRadius), fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      border: `${px(cs.borderTopWidth)} ${cs.borderTopStyle}`,
    }
  })
}

function taps() {
  const root = todayRoot()
  if (!root) return []
  return [...root.querySelectorAll('button,a,[role="button"],summary,input,select')].map(el => {
    const r = el.getBoundingClientRect()
    return { ...label(el), w: px(r.width), h: px(r.height), top: px(r.top + window.scrollY), under44: r.height < 44 || r.width < 44 }
  })
}

window.__h = {
  ready() {
    const r = todayRoot()
    return !!r && r.getBoundingClientRect().height > 100 && !document.body.textContent.includes('Loading…')
  },
  error: () => firstError,
  state: () => STATE,
  requests: () => requests,
  fixtures: () => fixtures,
  // Reported so the gate can assert determinism was actually IN FORCE rather than assume it. A run
  // whose clock silently fell back to live (a malformed ?clock=, a browser that resisted the shim)
  // would produce numbers that drift and a gate that blames the page.
  clock: () => ({ pinned: !!window.__pinnedClock, ...(window.__pinnedClock || {}), now: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  weatherStubbed: () => !WX_LIVE,
  tokens: () => ({ P, space: T.space, type: T.type, radius: { field: T.radiusField, button: T.radiusButton, card: T.radiusCard, badge: T.radiusBadge } }),
  viewport: () => ({
    innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    rootHeight: todayRoot() ? px(todayRoot().getBoundingClientRect().height) : null,
  }),
  tree: (maxDepth = 3) => tree(document.getElementById('root'), 0, maxDepth, ''),
  ink: inkProfile,
  containers,
  typeRuns,
  taps,
  buttonStyles,
  hideBadge() { BADGE.style.display = 'none'; return true },
  showBadge() { BADGE.style.display = ''; return true },
  // ── V2 seams (see the note at the top). Reported, never asserted — the gate asserts.
  v2: () => ({
    requested: V2, problem: V2PROBLEM, state: V2STATE?.name ?? null, fixture: FIX, route: v2Route,
    flag: (() => { try { return localStorage.getItem('garden.todayV2') } catch { return null } })(),
    seeds: V2SEEDS.map(([k]) => k), grafts: V2STATE?.grafts || [], redate: V2STATE?.redate || null,
    planDate: PAYLOAD?.plan_date ?? null,
    prefs: { fixture: V2STATE?.prefs ?? null, delayMs: V2WIRE?.prefsDelayMs ?? 0, served: prefsServed, bytes: V2PREFS ? JSON.stringify(V2PREFS).length : 0 },
    critterOrigin: import.meta.env.VITE_API_CRITTERS || null,
  }),
  // Ready: the chooser's V2 at its READY point (plan-v2 §6.4, data-today-ready — the sections paint there; the
  // version anchor alone paints at mount, before the plan lands, and a measurement taken then would read an
  // empty page), the stub on its version anchor, else V1's own readiness.
  v2ready() {
    if (v2Route === 'present') return !!document.querySelector('[data-today-version="2"][data-today-ready="true"]')
    if (v2Route === 'stub') return !!document.querySelector('[data-today-version="2"]')
    return this.ready()
  },
  expanded: (target) => { try { return document.querySelector(selectorFor(target))?.getAttribute('aria-expanded') ?? null } catch { return null } },
  // S4g: the next `n` POST /api/events answer 503 (0 clears). Returns how many of the LAST request were still
  // unconsumed, so the gate can tell a run that posted fewer writes than it injected failures for.
  failPosts(n) { const left = v2FailPosts; v2FailPosts = Math.max(0, Math.floor(Number(n) || 0)); return left },
  // (c) The interaction driver. A tap is hit-tested at its target's centre first (covered = VOID: a sticky
  // bar over a chip is a defect, not something to click through), then clicked; its `flip` target (the tap
  // target itself by default) must change aria-expanded — aria-pressed for a `task-filter:` chip (v2wire
  // flipState) — or the step did nothing measurable and the run is VOID. A scroll must land where it was sent
  // (clamped to the document). Steps come from the contract.
  async act(step) {
    const frames = (n) => new Promise(r => { const f = k => (k <= 0 ? r() : requestAnimationFrame(() => f(k - 1))); f(n) })
    const out = { step, ok: false, void: null, before: null, after: null, scrollY: null }
    if (step && step.scroll != null) {
      const y = Number(step.scroll)
      if (!Number.isFinite(y)) { out.void = `scroll step '${step.scroll}' is not a number (the gate resolves FIRST_SCREEN expressions)`; return out }
      window.scrollTo(0, y); await frames(3)
      out.scrollY = Math.round(window.scrollY)
      const want = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight))
      if (Math.abs(out.scrollY - want) > 1) out.void = `scroll to ${y} landed at ${out.scrollY} (expected ${want})`
      else out.ok = true
      return out
    }
    const flip = step.flip || step.tap
    let sel
    try { sel = selectorFor(step.tap); flipState(flip) } catch (e) { out.void = e.message; return out }
    const el = document.querySelector(sel)
    if (!el) { out.void = `tap target '${step.tap}' (${sel}) matched nothing`; return out }
    // S4: a target wholly off screen is scrolled to first, as a thumb would (the cohort line under an opened
    // Bag Area sits below the fold); a target ON screen is never moved, so a bar covering it still VOIDs.
    const r0 = el.getBoundingClientRect()
    if (r0.bottom <= 0 || r0.top >= innerHeight) { el.scrollIntoView({ block: 'center' }); await frames(3) }
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!hit || !(hit === el || el.contains(hit))) { out.void = `tap target '${step.tap}' is not what a finger at its centre would hit (${hit ? hit.tagName.toLowerCase() + (hit.getAttribute('data-testid') ? '[' + hit.getAttribute('data-testid') + ']' : '') : 'nothing — off screen'})`; return out }
    out.before = flipState(flip)
    el.click()
    await frames(3); await new Promise(res => setTimeout(res, 50))
    // S6: a tap that scrolls the page (a jump chip — smooth, the gate emulates no reduced motion) is judged once the
    // scroll has SETTLED, so the next step hit-tests where the page came to rest, never mid-animation. Measured: on a
    // v2-frost page ~40px longer than S6's, the Water jump was still gliding when the next step hit-tested Bag Area,
    // and found the jump bar over it. The shell gate's settle rule (10 still frames, bounded).
    for (let i = 0, last = -1, same = 0; i < 240 && same < 10; i++) { await frames(1); const y = window.scrollY; if (Math.abs(y - last) < 0.5) same++; else same = 0; last = y }
    out.after = flipState(flip)
    if (out.before == null || out.after == null || out.before === out.after) out.void = `${flipAttr(flip)} on '${flip}' did not flip (${out.before} → ${out.after}) — the step did nothing measurable, so the run is VOID`
    else out.ok = true
    return out
  },
  all(maxDepth = 3) {
    return {
      state: STATE, error: firstError, viewport: this.viewport(), requests,
      tree: this.tree(maxDepth), ink: inkProfile(), containers: containers(),
      typeRuns: typeRuns(), taps: taps(), buttons: buttonStyles(), tokens: this.tokens(),
    }
  },
}

// ?badge=0 strips the instrument bar outright rather than hiding it late. It is position:fixed at
// z-index 99999 across the bottom of the viewport, so under elementFromPoint it sits ON TOP of the
// page's own controls and a gate probing hit-tests would be measuring the instrument. Same seam
// putupclose.jsx uses for `verdict=0`, for the same reason.
if (params.get('badge') === '0') BADGE.remove()

let ticks = 0
const paint = () => {
  if (!BADGE.isConnected) return
  const v = window.__h.viewport()
  BADGE.textContent = firstError
    ? 'ERROR: ' + firstError
    : `state=${STATE} · vw ${v.innerWidth}x${v.innerHeight} dpr${v.dpr} · scrollH ${v.scrollHeight} (${(v.scrollHeight / v.innerHeight).toFixed(2)} screens) · hscroll ${v.scrollWidth > v.innerWidth ? 'YES' : 'no'} · reqs ${requests.length}`
  BADGE.style.background = firstError ? '#a4161a' : '#2d6a4f'
  if (++ticks < 20) setTimeout(paint, 300)
}
setTimeout(paint, 300)
