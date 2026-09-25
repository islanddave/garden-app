// BUG-UNDOTOASTTAPTARGET-001 — real-browser check of the SHARED undo toast's controls
// (src/context/ToastContext.jsx UndoToast) at Dave's viewport: 426x836 CSS px, DPR 3.
//
// Why a browser entry: jsdom has no layout engine. ToastUndoTarget.test.jsx can pin what the Undo
// button DECLARES; it cannot say what a thumb gets — the area that actually hit-tests, whether the
// toast grew to make room for it, or where a stack of three now ends. This page measures those and
// prints innerWidth into its own badge. Driver: scripts/layout-gate/undo-toast-target.mjs.
//
// Two sources of toasts, both through the REAL provider the app mounts at its root:
//   1. CALLERS — one toast per production caller of showUndo, raised through useToast() with the
//      message that caller builds. Every caller renders the same UndoToast, so what differs per
//      caller is only how its message wraps beside the controls, and whether it carries EventNew's
//      detail line. The long shapes are there on purpose: a wrap is what makes a toast tall.
//   2. STACK — the tallest stack Today can build, from real taps on real CareNeeded rows: Water,
//      Skip, Feed (three toasts, Skip's is low priority), then a Moist check, which makes the Skip
//      toast give way. The tapped rows carry the longest real names from the live care list
//      (careskip.jsx's fixture), so their toasts wrap the way the long rows do.
//
// FONT (OPS-UNDOTOASTGATECI-001): text is laid out in Roboto, what Dave's Android renders, here and on
// the CI runner alike, so a wrap measured on the Mac is the wrap CI measures. The import is FIRST and
// the module loads every face before this entry's body runs. See robotoPin.js.
import './robotoPin.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CareNeeded from '../../src/components/today/CareNeeded.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider, useToast } from '../../src/context/ToastContext.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

// BottomNav owns --bottom-nav-height and sets it INLINE on <html> when it mounts; the toast stack's
// container anchors on it. Same mechanism, same constant, so the stack sits where it does in the app.
// (A :root rule in undotap.html would lose to the injected global style's `--bottom-nav-height: 0px`,
// which lands later in <head> — inline on the element wins regardless of order.)
document.documentElement.style.setProperty('--bottom-nav-height', BOTTOM_NAV_HEIGHT_PX + 'px')
document.getElementById('nav').style.height = BOTTOM_NAV_HEIGHT_PX + 'px'

// A fresh day every load: a skip from a previous run must not hide a row before anything is measured.
for (const k of Object.keys(localStorage)) if (k.startsWith('today-')) localStorage.removeItem(k)

const water = (id, name, overdue) => ({
  id, name, crop: 'lettuce', project: 'Bag Area 2026', project_id: 'pr-bag',
  overdue_by: overdue, in_ground: false, interval: 3, days_since: overdue + 3,
})
// The three long water names and the Feed name are real plantings from the live care list
// (careskip.jsx: p50 13 characters, p90 24, max 52). The fill rows are toaststack.jsx's real names
// from Dave's 2026-09-10 report; they are there so the page behind the stack is rows, as on Today.
const FILL = ['Purple Basil', 'Lettuce Leaf Basil', 'Holy Basil', 'Tulsi Basil', 'Lemon Verbena',
  'Megatron Jalapeños', 'Sweet Basil', 'Yatsufusa', 'Tatli Kil Sivri', 'Capeliente', 'Cowhorn',
  'Ristra Cayenne II', 'King of the North', 'Petra']
const PLAN = {
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10, today_observed_in: 0 },
  rain_skipped: [],
  water_due: [
    water('w-52', 'Onion — scallion-type (thick blue-green, ID pending)', 3),
    water('w-41', 'Marvel of Four Seasons Butterhead Lettuce', 2),
    water('w-24', 'Cherokee Purple Tomato 2', 1),
    ...FILL.map((name, i) => water('w-f' + i, name, i % 3)),
  ],
  no_history: [],
  fertilize: [{ id: 'f-32', name: 'Sunny Susy White Halo Thunbergia', crop: 'thunbergia', project: 'Bag Area 2026', project_id: 'pr-bag', item: 'MG', apply: 'half strength' }],
  pest: [], cold: [], dormant: [],
}
const ALL_IDS = [...PLAN.water_due, ...PLAN.fertilize].map(r => r.id)
const PLANTS = ALL_IDS.map(id => ({ id, location_id: 'loc-bag', container_type: null, featured_photo_view_url: null, featured_photo_id: null }))
const LOCATIONS = [{ id: 'loc-bag', name: 'Pasture Bag Area', full_path: 'Pasture Bag Area' }]

// The four taps the STACK scenario makes, by the row control's real aria-label.
const TAPS = [
  'Log Water for Marvel of Four Seasons Butterhead Lettuce',
  'Skip Onion — scallion-type (thick blue-green, ID pending) today',
  'Log Feed for Sunny Susy White Halo Thunbergia',
  'Checked Cherokee Purple Tomato 2 — still moist',
]

// Every production caller of showUndo (grep `showUndo(` under src/, 2026-09-24: CareNeeded x4,
// Dashboard, InactiveProjects, EventNew), by the message template it builds. Names are real where
// the caller's source is data; elsewhere the template is filled at its longest realistic shape.
const CALLERS = [
  { caller: 'Today one-tap log (CareNeeded logRow)', message: 'Logged Water for Habanero' },
  { caller: 'Today one-tap log, longest live name', message: 'Logged Water for Onion — scallion-type (thick blue-green, ID pending)' },
  { caller: 'Today one-tap log, coalesced run', message: 'Logged Water for 12 plants' },
  { caller: 'Today moisture check (CareNeeded moistRow)', message: 'Checked Marvel of Four Seasons Butterhead Lettuce — still moist' },
  { caller: 'Today Skip (CareNeeded skipRow, low priority)', message: 'Skipped Onion — scallion-type (thick blue-green, ID pending) for today', priority: 'low' },
  { caller: 'Today bulk log, partial failure (CareNeeded runBulk)', message: 'Logged 59 — 1 failed' },
  { caller: 'Dashboard, back from Log Event', message: 'Logged event for Peppers 2026' },
  { caller: 'Inactive projects, dismiss', message: 'Dismissed Peppers 2026' },
  { caller: 'Log Event, planting + water depth line', message: 'Logged event — Cayenne #1', detail: 'Deep — soaked to runoff' },
  { caller: 'Log Event, no planting + photo failure + depth line', message: "Logged event for Peppers 2026 — no planting attached — but 2 of 3 photos didn't upload", detail: 'Deep — soaked to runoff' },
]

const posts = []
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path === '/api/plants') body = PLANTS
  else if (path === '/api/locations/with-path') body = LOCATIONS
  else if (path === '/api/events' && init.method === 'POST') { posts.push(JSON.parse(init.body)); body = { id: 'ev-' + posts.length } }
  await new Promise(r => setTimeout(r, 30))       // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

let api = null
function ToastApiBridge() {
  api = useToast()
  return null
}

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ToastProvider>
      <ToastApiBridge />
      <MemoryRouter initialEntries={['/today']}>
        <CareNeeded plan={PLAN} />
      </MemoryRouter>
    </ToastProvider>
  </AuthProvider>
)

const r1 = n => Math.round(n * 10) / 10
const rect = el => el.getBoundingClientRect()
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms))
const buttonLabelled = label => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
const isUndo = b => b.textContent.trim() === 'Undo'
// Undo toasts only. CareNeeded also owns a visually-hidden role="status" live region (1x1, clipped)
// carrying the same "Logged …" words; it has no Undo, so it never counts.
const undoToasts = () => [...document.querySelectorAll('[role="status"]')].filter(s => [...s.querySelectorAll('button')].some(isUndo))
const labelOf = e => e.getAttribute('aria-label') || (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)

// The run of CSS px through the control's centre, along one axis, whose hit-test lands INSIDE the
// control. Read from elementFromPoint, never from the box: a box can exist and still not take the tap
// (pointer-events, an overlay, a sibling painted over it).
const hitExtent = (el, axis) => {
  const b = rect(el), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
  const hits = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && el.contains(h) }
  if (!hits(cx, cy)) return 0
  const STEP = 0.25, MAX = 80
  let lo = 0, hi = 0
  if (axis === 'y') {
    while (lo < MAX && hits(cx, cy - lo - STEP)) lo += STEP
    while (hi < MAX && hits(cx, cy + hi + STEP)) hi += STEP
  } else {
    while (lo < MAX && hits(cx - lo - STEP, cy)) lo += STEP
    while (hi < MAX && hits(cx + hi + STEP, cy)) hi += STEP
  }
  return r1(lo + hi + STEP)
}
// Does a whole w x h rectangle centred on the control take the tap? A 5x5 grid of hit-tests, inset
// 0.5px from the rectangle's edges. Centre-line extents alone would pass a plus-shaped target.
const gridProbe = (el, w, h) => {
  const b = rect(el), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
  let ok = 0
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const x = cx - w / 2 + 0.5 + (w - 1) * i / 4, y = cy - h / 2 + 0.5 + (h - 1) * j / 4
    const hit = document.elementFromPoint(x, y)
    if (hit && el.contains(hit)) ok++
  }
  return { ok, of: 25 }
}
const box = el => { const q = rect(el); return { left: r1(q.left), top: r1(q.top), right: r1(q.right), bottom: r1(q.bottom), w: r1(q.width), h: r1(q.height) } }
// Where the WORDS are painted, independent of whichever box carries them: a Range over the first
// non-empty text node under `el`. Lets a before/after say "the label did not move" by measurement.
const glyphBox = el => {
  if (!el) return null
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walk.nextNode()) && !n.textContent.trim()) { /* skip whitespace */ }
  if (!n) return null
  const rg = document.createRange(); rg.selectNodeContents(n)
  const q = rg.getBoundingClientRect()
  return { left: r1(q.left), top: r1(q.top), w: r1(q.width), h: r1(q.height) }
}
// `grid` = a side x side square centred on the control; `ownGrid` = the control's own box.
const control = (el, side) => el && {
  ...box(el),
  hitW: hitExtent(el, 'x'), hitH: hitExtent(el, 'y'),
  grid: gridProbe(el, side, side), ownGrid: gridProbe(el, rect(el).width, rect(el).height),
  visible: el.checkVisibility(), name: el.getAttribute('aria-label') || el.textContent.trim(),
}

function measureToast(t, side) {
  const buttons = [...t.querySelectorAll('button')]
  const undo = buttons.find(isUndo)
  const close = buttons.find(b => b.getAttribute('aria-label') === 'Dismiss')
  const textCol = t.firstElementChild
  const msg = textCol && textCol.firstElementChild
  const cs = getComputedStyle(t)
  // The pill the eye sees: whichever node under Undo paints its border (the button itself, or a
  // child if the button's own box is an invisible hit area).
  const pill = undo && [undo, ...undo.querySelectorAll('*')].find(e => parseFloat(getComputedStyle(e).borderTopWidth) > 0)
  let lines = 0
  if (msg) { const rg = document.createRange(); rg.selectNodeContents(msg); lines = new Set([...rg.getClientRects()].map(q => Math.round(q.top))).size }
  return {
    message: msg ? msg.textContent : null,
    detail: textCol && textCol.children[1] ? textCol.children[1].textContent : null,
    lines,
    toast: { ...box(t), padY: r1(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)), padRight: r1(parseFloat(cs.paddingRight)) },
    textCol: textCol ? box(textCol) : null,
    undo: control(undo, side),
    pill: pill ? box(pill) : null,
    undoLabel: glyphBox(undo),
    close: control(close, side),
    closeGlyph: glyphBox(close),
    gapUndoToClose: undo && close ? r1(rect(close).left - rect(undo).right) : null,
    gapTextToUndo: undo && textCol ? r1(rect(undo).left - rect(textCol).right) : null,
  }
}

function measureStack(side) {
  const ts = undoToasts()
  const boxes = ts.map(rect).sort((a, b) => a.top - b.top)
  const nav = rect(document.getElementById('nav'))
  let overlaps = 0
  for (let i = 1; i < boxes.length; i++) if (boxes[i].top < boxes[i - 1].bottom - 0.5) overlaps++
  const top = boxes.length ? boxes[0].top : null
  const bottom = boxes.length ? boxes[boxes.length - 1].bottom : null
  // Every LIST control on screen, and how much of each the stack hides. Two traps, both hit while
  // building this: the toast layer renders inside #root (so its own Undo/Dismiss must be excluded),
  // and a centre-point hit-test lets a row dodge the count by centring in the 8px gap between two
  // toasts while most of it is buried. So: area overlap against the toast boxes, which never overlap
  // each other. `covered` = at least half hidden; `touched` = any of it hidden.
  const inToast = e => ts.some(t => t.contains(e))
  const controls = [...document.getElementById('root').querySelectorAll('button, a[href]')].filter(e => {
    if (inToast(e) || !e.checkVisibility()) return false
    const q = rect(e)
    return q.height > 0 && q.bottom > 0 && q.top < innerHeight
  })
  const hidden = e => {
    const q = rect(e)
    let a = 0
    for (const t of boxes) a += Math.max(0, Math.min(q.right, t.right) - Math.max(q.left, t.left)) * Math.max(0, Math.min(q.bottom, t.bottom) - Math.max(q.top, t.top))
    return a / (q.width * q.height)
  }
  const covered = controls.filter(e => hidden(e) >= 0.5)
  const touched = controls.filter(e => hidden(e) > 0)
  return {
    count: ts.length,
    toasts: ts.map(t => measureToast(t, side)),
    stackTop: top == null ? null : r1(top), stackBottom: bottom == null ? null : r1(bottom),
    stackH: top == null ? 0 : r1(bottom - top),
    navTop: r1(nav.top), clearanceAboveNav: bottom == null ? null : r1(nav.top - bottom),
    overlaps,
    controlsOnScreen: controls.length, controlsCovered: covered.length, controlsTouched: touched.length,
    coveredLabels: covered.map(labelOf),
  }
}

// Poll until `pred` holds or give up — a wait with a failure branch, never an open-ended one.
async function until(pred, what, ms = 3000) {
  for (let t = 0; t < ms; t += 50) { if (pred()) return; await settle(50) }
  throw new Error('timed out waiting for ' + what)
}

// CareNeeded auto-expands groups against a row budget; open every collapsed group so each tapped
// row is rendered and the page behind the stack is full of rows.
function expandAll() {
  for (const b of document.getElementById('root').querySelectorAll('button[aria-expanded="false"]')) b.click()
}

let booted = false
const raised = []
window.__h = {
  error: () => firstError,
  ready: () => booted,
  vw: () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, scrollW: document.documentElement.scrollWidth }),
  callers: CALLERS.map(c => c.caller),
  // One caller's toast at a time, alone on screen, with no timer (duration 0) so nothing dismisses
  // it mid-measurement.
  async measureCallers(side) {
    window.__h.clear()
    await settle()
    const out = []
    for (const c of CALLERS) {
      const id = api.showUndo({ message: c.message, detail: c.detail ?? null, onUndo: () => {}, duration: 0, ...(c.priority ? { priority: c.priority } : {}) })
      await until(() => undoToasts().length === 1, c.caller + ' toast')
      await settle()
      out.push({ caller: c.caller, ...measureToast(undoToasts()[0], side) })
      api.dismiss(id)
      await until(() => undoToasts().length === 0, c.caller + ' toast to clear')
    }
    return out
  },
  // Leave callers[idx...] up together (the cap is 3) for a screenshot.
  async raise(idxs) {
    window.__h.clear()
    for (const i of idxs) {
      const c = CALLERS[i]
      raised.push(api.showUndo({ message: c.message, detail: c.detail ?? null, onUndo: () => {}, duration: 0, ...(c.priority ? { priority: c.priority } : {}) }))
    }
    await until(() => undoToasts().length === Math.min(idxs.length, 3), 'raised toasts')
    await settle()
  },
  clear() { while (raised.length) api.dismiss(raised.pop()) },
  // The real Today sequence. Returns the stack after three taps (Water, Skip, Feed) and after the
  // fourth (Moist), when the low-priority Skip toast is the one that gives way.
  async stack(side) {
    window.__h.clear()
    await until(() => undoToasts().length === 0, 'an empty stack')
    const tap = async (label, expect) => {
      const b = buttonLabelled(label)
      if (!b) throw new Error('no row control labelled ' + JSON.stringify(label))
      b.click()
      await until(() => undoToasts().length === expect, expect + ' toast(s) after ' + JSON.stringify(label))
      await settle()
    }
    await tap(TAPS[0], 1); await tap(TAPS[1], 2); await tap(TAPS[2], 3)
    const three = measureStack(side)
    return { three }
  },
  async stackGiveWay(side) {
    const b = buttonLabelled(TAPS[3])
    if (!b) throw new Error('no row control labelled ' + JSON.stringify(TAPS[3]))
    const before = undoToasts().map(t => t.firstElementChild.firstElementChild.textContent)
    b.click()
    await until(() => undoToasts().some(t => /still moist/.test(t.textContent)), 'the Moist toast')
    await settle()
    return { before, after: measureStack(side) }
  },
  // Dashed outline over every control in every undo toast, drawn in a fixed layer that takes no
  // taps — makes an invisible hit area visible in a screenshot. Remove before measuring anything.
  outline(on) {
    document.querySelectorAll('[data-hitbox]').forEach(e => e.remove())
    if (!on) return
    for (const t of undoToasts()) for (const b of t.querySelectorAll('button')) {
      const q = rect(b)
      const d = document.createElement('div')
      d.setAttribute('data-hitbox', '')
      Object.assign(d.style, { position: 'fixed', left: q.left + 'px', top: q.top + 'px', width: q.width + 'px', height: q.height + 'px',
        outline: '1px dashed #ff2bd6', outlineOffset: '-1px', pointerEvents: 'none', zIndex: 99998 })
      document.body.appendChild(d)
    }
  },
  badge(text, bad = false) { const el = document.getElementById('verdict'); el.textContent = text; el.style.background = bad || firstError ? '#a4161a' : '#2d6a4f' },
  posts: () => posts.length,
}

let ticks = 0
const boot = () => {
  expandAll()
  const present = TAPS.every(l => buttonLabelled(l)) && api
  if (!present) { if (++ticks < 60) setTimeout(boot, 150); else window.__h.badge('ERROR: rows never rendered', true); return }
  booted = true
  window.__h.badge(`innerWidth ${innerWidth} · innerHeight ${innerHeight} · dpr ${devicePixelRatio} · scrollW ${document.documentElement.scrollWidth} · ready`)
}
setTimeout(boot, 150)
