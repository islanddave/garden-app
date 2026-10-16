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
//      caller is only how its message wraps beside the controls, and whether it carries a detail
//      line. The long shapes are there on purpose: a wrap is what makes a toast tall.
//   2. STACK — the tallest stack the provider can hold: three of the tallest caller shapes (each with
//      a detail line) at the cap, one of them priority 'low', then a fourth, which must take the low
//      toast's slot rather than a log's.
// V5-TODAYREDESIGN-001 S8c (L8): until the old Today page was removed, both came from real taps on real
// CareNeeded rows (Water, Skip, Feed, then Moist). The redesigned Today raises no toast for a care write —
// its done lines carry Undo (useNeedsCare / useProtect hand useCareActions a SILENT toast) — so no Today
// tap reaches this layer any more, and the stack is raised through the provider instead. The low-priority
// rule is the provider's own (ToastContext evictForCap); useCareActions' Skip still declares it.
//
// FONT (OPS-UNDOTOASTGATECI-001): text is laid out in Roboto, what Dave's Android renders, here and on
// the CI runner alike, so a wrap measured on the Mac is the wrap CI measures. The import is FIRST and
// the module loads every face before this entry's body runs. See robotoPin.js.
import './robotoPin.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider, useToast } from '../../src/context/ToastContext.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

// BottomNav owns --bottom-nav-height and sets it INLINE on <html> when it mounts; the toast stack's
// container anchors on it. Same mechanism, same constant, so the stack sits where it does in the app.
// (A :root rule in undotap.html would lose to the injected global style's `--bottom-nav-height: 0px`,
// which lands later in <head> — inline on the element wins regardless of order.)
document.documentElement.style.setProperty('--bottom-nav-height', BOTTOM_NAV_HEIGHT_PX + 'px')
document.getElementById('nav').style.height = BOTTOM_NAV_HEIGHT_PX + 'px'

// Every production caller of showUndo (grep `showUndo(` under src/, 2026-10-16: Dashboard,
// InactiveProjects, EventNew, SeasonEnd — useCareActions builds four more shapes, but the only page that
// mounts it hands it a SILENT toast since S8c), by the message template it builds. Names are real where
// the caller's source is data; elsewhere the template is filled at its longest realistic shape.
const CALLERS = [
  { caller: 'Dashboard, back from Log Event', message: 'Logged event for Peppers 2026' },
  { caller: 'Inactive projects, dismiss', message: 'Dismissed Peppers 2026' },
  { caller: 'Log Event, planting + water depth line', message: 'Logged event — Cayenne #1', detail: 'Deep — soaked to runoff' },
  { caller: 'Log Event, no planting + photo failure + depth line', message: "Logged event for Peppers 2026 — no planting attached — but 2 of 3 photos didn't upload", detail: 'Deep — soaked to runoff' },
  { caller: 'Season end, a batch ended', message: 'Ended 12 plantings', detail: "They leave Today's list at its next update, within a few hours." },
]

// The STACK: three tall shapes at the cap — the LOW one in the middle, so a front-trim (the oldest goes)
// would keep it and only the priority rule removes it — then a fourth, a normal log.
const STACK = [
  { message: "Logged event for Peppers 2026 — no planting attached — but 2 of 3 photos didn't upload", detail: 'Deep — soaked to runoff' },
  { message: 'Skipped Onion — scallion-type (thick blue-green, ID pending) for today', priority: 'low' },
  { message: 'Ended 12 plantings', detail: "They leave Today's list at its next update, within a few hours." },
]
const FOURTH = { message: 'Logged event — Cayenne #1', detail: 'Deep — soaked to runoff' }

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

let api = null
function ToastApiBridge() {
  api = useToast()
  return null
}

createRoot(document.getElementById('root')).render(
  <ToastProvider>
    <ToastApiBridge />
  </ToastProvider>
)

const r1 = n => Math.round(n * 10) / 10
const rect = el => el.getBoundingClientRect()
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms))
const isUndo = b => b.textContent.trim() === 'Undo'
// Undo toasts only: a role="status" region with no Undo in it never counts.
const undoToasts = () => [...document.querySelectorAll('[role="status"]')].filter(s => [...s.querySelectorAll('button')].some(isUndo))

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
  // (Until S8c this also counted the Today list controls the stack hid; there is no list behind it now.)
  return {
    count: ts.length,
    toasts: ts.map(t => measureToast(t, side)),
    stackTop: top == null ? null : r1(top), stackBottom: bottom == null ? null : r1(bottom),
    stackH: top == null ? 0 : r1(bottom - top),
    navTop: r1(nav.top), clearanceAboveNav: bottom == null ? null : r1(nav.top - bottom),
    overlaps,
  }
}

// Poll until `pred` holds or give up — a wait with a failure branch, never an open-ended one.
async function until(pred, what, ms = 3000) {
  for (let t = 0; t < ms; t += 50) { if (pred()) return; await settle(50) }
  throw new Error('timed out waiting for ' + what)
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
  // The STACK: three toasts raised one after another at the cap (the low one second), then the fourth,
  // when the low-priority toast is the one that gives way. No timer (duration 0) on any of them.
  async stack(side) {
    window.__h.clear()
    await until(() => undoToasts().length === 0, 'an empty stack')
    for (let i = 0; i < STACK.length; i++) {
      raised.push(api.showUndo({ ...STACK[i], detail: STACK[i].detail ?? null, onUndo: () => {}, duration: 0 }))
      await until(() => undoToasts().length === i + 1, (i + 1) + ' toast(s)')
      await settle()
    }
    const three = measureStack(side)
    return { three }
  },
  async stackGiveWay(side) {
    const before = undoToasts().map(t => t.firstElementChild.firstElementChild.textContent)
    raised.push(api.showUndo({ ...FOURTH, onUndo: () => {}, duration: 0 }))
    await until(() => undoToasts().some(t => t.textContent.includes(FOURTH.message)), 'the fourth toast')
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
}

let ticks = 0
const boot = () => {
  if (!api) { if (++ticks < 60) setTimeout(boot, 150); else window.__h.badge('ERROR: the toast provider never mounted', true); return }
  booted = true
  window.__h.badge(`innerWidth ${innerWidth} · innerHeight ${innerHeight} · dpr ${devicePixelRatio} · scrollW ${document.documentElement.scrollWidth} · ready`)
}
setTimeout(boot, 150)
