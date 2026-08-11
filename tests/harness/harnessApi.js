// window.__h — the measurement surface. Everything the Browser-pane driver calls lives here so a
// re-run is `__h.<method>()` and not a wall of ad-hoc page script that nobody can reproduce.
//
// Counters are attached in the CAPTURE phase at document level, so they see every gesture the
// scripted run dispatches regardless of which handler ultimately consumes it.

const counters = { pointerdown: 0, keydown: 0, scroll: 0, click: 0 }
let installed = false

export function installCounters() {
  if (installed) return
  installed = true
  document.addEventListener('pointerdown', () => { counters.pointerdown++ }, true)
  document.addEventListener('keydown', () => { counters.keydown++ }, true)
  document.addEventListener('click', () => { counters.click++ }, true)
}

export function resetCounters() {
  counters.pointerdown = 0; counters.keydown = 0; counters.scroll = 0; counters.click = 0
}
export function readCounters() { return { ...counters } }
export function noteScroll() { counters.scroll++ }

// ── Scheduling in a HIDDEN tab ─────────────────────────────────────────────────────────────────
// The Browser pane reports document.hidden whenever it is collapsed, and a hidden tab (a) never
// fires requestAnimationFrame and (b) clamps setTimeout to ~1000ms. A rAF-based settle() therefore
// hangs forever, and a setTimeout-based one turns a 5-harvest run into minutes of wall clock. Both
// were observed building this.
// MessageChannel is the way out: a port message is a macrotask that is NOT clamped in a background
// tab, so `yieldMacro()` gives React a real chance to flush effects at full speed either way. Use
// `settle()` (macrotask ticks) for state flushes and `sleepReal()` only where genuine wall-clock
// time is the point.
export const yieldMacro = () => new Promise(r => {
  const ch = new MessageChannel()
  ch.port1.onmessage = () => { ch.port1.close(); r() }
  ch.port2.postMessage(0)
})
export const sleepReal = ms => new Promise(r => setTimeout(r, ms))

const raf = () => (document.hidden ? yieldMacro() : new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

// `ticks` macrotask turns, not milliseconds. React commits + effects + a stubbed fetch resolution
// all land within a handful of turns; 10 is comfortably past that with margin for the double-render
// StrictMode would add if it were ever switched on.
export const settle = async (ticks = 10) => {
  await raf()
  for (let i = 0; i < ticks; i++) await yieldMacro()
  await raf()
}

export async function waitFor(fn, { timeout = 5000, label = 'condition' } = {}) {
  const t0 = performance.now()
  for (;;) {
    let v
    try { v = fn() } catch { v = null }
    if (v) return v
    if (performance.now() - t0 > timeout) throw new Error(`waitFor timeout: ${label}`)
    await yieldMacro()
  }
}

// ── DOM queries ────────────────────────────────────────────────────────────────────────────────
export const q = sel => document.querySelector(sel)
export const qa = sel => Array.from(document.querySelectorAll(sel))
export function byText(text, sel = 'button, a') {
  return qa(sel).find(el => (el.textContent || '').trim().replace(/\s+/g, ' ').includes(text)) || null
}
export const saveButton = () => q('[data-testid="save-sticky"] button')
export const qtyChip = v => q(`[data-testid="qty-chip-${v}"]`)
export const qtyChipRow = () => q('[aria-label="Harvest quantity quick pick"]')
export const qtyInput = () => q('#harvest-quantity')
export const plantingInput = () => q('[data-testid="evtnew-planting"]')
export const plantingChip = () => q('[data-testid="evtnew-planting-chip"]')

// ── Synthetic touch tap ────────────────────────────────────────────────────────────────────────
// One tap = one pointerdown, exactly as a finger produces. mousedown/mouseup are included because
// PlantingSelect's listbox relies on onMouseDown preventDefault to hold input focus, and click()
// alone would skip that path. focus() is only issued for genuinely focusable controls, mirroring
// what a real touch does.
// FOCUS EVENTS IN A BACKGROUND TAB — the single least obvious thing in this harness.
// The Browser pane is `document.hidden` whenever it is collapsed, and then `document.hasFocus()` is
// false. Per the HTML spec, calling .focus() in a document that does not have system focus updates
// the focused element but DEFERS the focus/focusin events until the document gains focus. React 17+
// binds onFocus/onBlur to focusin/focusout at the root, so nothing fires: PlantingSelect's onFocus
// never runs, the listbox never opens, and the run dies at a waitFor with no visible cause.
// Synthesising focusin/focusout when hasFocus() is false restores the real sequence. When the pane
// IS focused the browser fires them itself and these are skipped, so behaviour is identical either
// way — this compensates for the tab state, it does not fake the interaction.
let lastFocused = null
function syncFocus(el) {
  if (document.hasFocus()) return
  if (lastFocused && lastFocused !== el && lastFocused.isConnected) {
    lastFocused.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }))
  }
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
  lastFocused = el
}
export function blurActive() {
  const el = lastFocused
  if (!el) return
  if (typeof el.blur === 'function') el.blur()
  if (!document.hasFocus() && el.isConnected) el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }))
  lastFocused = null
}

export function tap(el, { focus = false } = {}) {
  if (!el) throw new Error('tap: element not found')
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  const pd = { ...base, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, width: 30, height: 30 }
  el.dispatchEvent(new PointerEvent('pointerdown', pd))
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }))
  if (focus && typeof el.focus === 'function') { el.focus(); syncFocus(el) }
  el.dispatchEvent(new PointerEvent('pointerup', { ...pd, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }))
  el.click()
}

// A typed character on the soft keypad. Counted separately from taps: a keypad press is a tap in
// the physical sense but NOT an app-surface tap, and conflating the two is how tap models inflate.
export function typeInto(el, text) {
  if (!el) throw new Error('typeInto: element not found')
  el.focus(); syncFocus(el)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  for (const ch of String(text)) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
    setter.call(el, el.value + ch)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }))
  }
}

// ── Geometry ───────────────────────────────────────────────────────────────────────────────────
export function viewport() {
  const vv = window.visualViewport
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualViewport: vv ? { width: Math.round(vv.width), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) } : null,
    devicePixelRatio: window.devicePixelRatio,
    documentHeight: document.documentElement.scrollHeight,
  }
}

function rect(el) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }
}

// MEASUREMENT A — is the Save control inside the layout viewport?
// `aboveFold` is the literal question the plan asks: rect.bottom <= innerHeight.
// `fullyVisible` additionally requires the top edge in-viewport, which is what "usable" means when
// the control is 44px tall and the viewport is 500px.
export function measureA() {
  const btn = saveButton()
  const r = rect(btn)
  const vp = viewport()
  const visible = btn ? getComputedStyle(btn.closest('[data-testid="save-sticky"]')).visibility : null
  return {
    found: !!btn,
    visibility: visible,
    rect: r,
    innerHeight: vp.innerHeight,
    aboveFold: r ? r.bottom <= vp.innerHeight : null,
    fullyVisible: r ? (r.top >= 0 && r.bottom <= vp.innerHeight) : null,
    slackPx: r ? +(vp.innerHeight - r.bottom).toFixed(1) : null,
    viewport: vp,
    plantingSelected: !!plantingChip(),
    quantity: qtyInput()?.value ?? null,
    activeElement: document.activeElement ? (document.activeElement.id || document.activeElement.getAttribute('data-testid') || document.activeElement.tagName) : null,
  }
}

// MEASUREMENT C — does the quantity chip row wrap?
// Distinct offsetTop values across the chips IS the wrap count; a grid that wraps puts its second
// line at a different offsetTop. Also re-measured with the longest label the row can hold, by
// temporarily swapping the chip text (restored before returning) — the row's own labels are single
// digits, so "its longest label" has to be produced, not observed.
export function measureC({ longestLabel = null } = {}) {
  const row = qtyChipRow()
  if (!row) return { found: false }
  const chips = Array.from(row.querySelectorAll('button'))
  const read = () => {
    const tops = chips.map(c => Math.round(c.getBoundingClientRect().top))
    const uniq = [...new Set(tops)]
    return {
      rows: uniq.length,
      wrapped: uniq.length > 1,
      rowHeight: +row.getBoundingClientRect().height.toFixed(1),
      chipWidths: chips.map(c => +c.getBoundingClientRect().width.toFixed(2)),
      chipHeights: chips.map(c => +c.getBoundingClientRect().height.toFixed(2)),
      labels: chips.map(c => c.textContent),
    }
  }
  const asShipped = read()
  let withLongest = null
  if (longestLabel) {
    const originals = chips.map(c => c.textContent)
    chips.forEach(c => { c.textContent = longestLabel })
    withLongest = read()
    chips.forEach((c, i) => { c.textContent = originals[i] })
  }
  return { found: true, count: chips.length, asShipped, withLongest, containerWidth: +row.getBoundingClientRect().width.toFixed(1) }
}
