// todaymeasure — MEASUREMENT harness for the real /today surface at Dave's geometry.
//
// Purpose: characterise the Today page as it actually RENDERS, so a design crucible argues from
// pixels rather than from reading Today.jsx. Nothing under src/ is modified or re-implemented: this
// mounts the REAL `Today` page component inside the REAL router and the REAL AuthProvider, and only
// the wire (window.fetch) is stubbed.
//
// DATA IS PROD, NOT INVENTED. The payloads in ./_todaymeasure/ are dumped from the live Neon
// database as garden_ro (read-only role) for Dave's Clerk sub on 2026-09-08 — the same day this was
// measured. `dailyplan.dave.json` is daily_plan.items verbatim: 72 water_due, 12 fertilize, 8 pest.
// A hand-shaped fixture would have measured a page that nobody has.
//
// THREE STATES, because the complaint has two halves and they are different design problems:
//   ?state=busy   — today, as it really is for Dave (the default)
//   ?state=quiet  — a plan exists but every list in it is empty and every band is empty
//   ?state=noplan — has_plan false: the first-run / engine-hasn't-run empty state
//
// window.__h is the measurement surface. It reports geometry, computed CSS and an ink profile; it
// never asserts. Analysis happens in _todaymeasure/drive.mjs and downstream, so a change of opinion
// about what "too much whitespace" means does not require re-driving the browser.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Today from '../../src/pages/Today.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { P } from '../../src/lib/constants.js'
import { T } from '../../src/components/forms/formStyles.js'

const realFetch = window.fetch.bind(window)
const params = new URLSearchParams(location.search)
const STATE = params.get('state') || 'busy'

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

// The household lens is ONE TAP from the default and Dave has a second caretaker, so what it costs
// in scroll is a real number, not a hypothetical. localStorage is seeded before mount because the
// component reads it in a useState initialiser.
if (STATE === 'busyhh') { try { localStorage.setItem('garden.today.showOthers', '1') } catch { /* ignore */ } }
else { try { localStorage.removeItem('garden.today.showOthers') } catch { /* ignore */ } }

// ComposeHarvestBand is gated on TWO clocks — the read model's 24h `created_since` and the
// component's own 18h MAX_BATCH_AGE_MS — and Dave's last logged pick (2026-09-07 11:00 ET) fell
// outside both by the time this ran. So on the real 2026-09-08 that band is 0px, and 0px is the
// honest number for TODAY. It is NOT the honest number for "a day Dave picked something", which is
// the state the design has to work in too. `busyfull` serves the real prod batch with every
// timestamp rebased so the newest sits one hour back — real rows, real shape, moved clock. Labelled
// as its own state rather than folded into `busy` so no number here is quietly counterfactual.
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
const quietPlan = D?.plan ? {
  ...D.plan,
  water_due: [], fertilize: [], pest: [], cold: [], dormant: [], no_history: [], rain_skipped: [],
  dormancy_suppressed: [],
  counts: { ...(D.plan.counts || {}), water_due: 0, fertilize: 0, pest: 0, cold: 0, dormant: 0, no_history: 0, rain_skipped: 0 },
  substrate: { ...(D.plan.substrate || {}), on_hold: true },
} : null

const PAYLOAD = {
  busy:     { ...D, has_plan: true },
  busyfull: { ...D, has_plan: true },
  busyhh:   { ...D, has_plan: true, household_plans: JENPLAN ? [{ user_id: 'member_jen', generated_at: D?.generated_at ?? null, plan: JENPLAN }] : [] },
  quiet:  { plan: quietPlan, plan_date: D?.plan_date ?? null, generated_at: D?.generated_at ?? null, has_plan: true },
  noplan: { plan: null, plan_date: D?.plan_date ?? null, generated_at: null, has_plan: false },
}[STATE]

const EMPTY = !STATE.startsWith('busy')
const requests = []

// OPEN-METEO, STUBBED AT THE WIRE (V5-TODAYSHAPE-001 item 6). The original characterisation run let
// this through to the real public API, because Dave's phone does — correct for a one-off portrait of
// the page, wrong for a repeatable gate. The response decides the rain line's wording AND whether
// the "Updated … · live" stamp renders at all, so a live read makes ink-% and scroll-height move
// with the actual weather. A gate that reds because it rained is a gate that gets switched off.
//
// The numbers are SYNTHETIC and fixed, not a recording of a real day — the array is the shape
// mapOpenMeteoDailyToHydrology consumes: [D-2, D-1, D0, D1, D2] in inches, America/New_York buckets
// (src/lib/liveWeather.js:34). Chosen so every field of the mapped hydrology is non-null and
// non-zero, because a null there takes a DIFFERENT and shorter render branch and would measure the
// degraded surface while claiming to measure the normal one.
// ?wx=live restores the real read for characterisation runs.
const WX_LIVE = params.get('wx') === 'live'
const OPEN_METEO_STUB = {
  daily: {
    time: ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
    precipitation_sum: [0.31, 0.12, 0.04, 0.22, 0.09],
    precipitation_probability_max: [80, 45, 18, 61, 33],
  },
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  if (!WX_LIVE && /open-meteo\.com/.test(url)) {
    requests.push({ path: 'open-meteo (STUBBED)', method: init.method || 'GET' })
    return new Response(JSON.stringify(OPEN_METEO_STUB), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
  if (p === '/api/daily-plan') body = PAYLOAD
  else if (p === '/api/members') body = { members: EMPTY ? [] : [{ id: 'harness_user', display_name: 'Dave' }, { id: 'member_jen', display_name: 'Jen Koetters' }] }
  else if (p === '/api/plants') body = EMPTY ? [] : PLANTS
  else if (p === '/api/locations/with-path') body = LOCATIONS
  else if (p === '/api/preservation/use-soon') body = EMPTY ? [] : (USESOON ?? [])
  else if (p === '/api/harvests/watch') body = EMPTY ? [] : (WATCH ?? [])
  else if (p === '/api/harvests') body = EMPTY ? [] : (STATE === 'busyfull' ? rebase(BATCHWIN) : (HARVESTS ?? []))
  else if (p === '/api/inventory-items/sow-candidates') body = EMPTY ? [] : (SOWCAND ?? [])
  await new Promise(r => setTimeout(r, 20))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <MemoryRouter initialEntries={['/today']}>
      <Today />
    </MemoryRouter>
  </AuthProvider>
)

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
