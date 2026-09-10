// BUG-TOASTSTACK-001 — real-browser check that a RUN of one-tap care logs produces one readable
// toast instead of a column that buries the app.
//
// Why a browser entry: jsdom has no layout engine, so the vitest pins in ToastStack.test.jsx can
// prove the queue is capped and coalesced, and that no toast carries its own fixed offset — but
// they cannot prove the result FITS. The original defect was a height mistake (a 56px per-index
// stride under toasts that wrap to ~90px with a long plant name), and only a real layout engine
// can catch that class. This page measures it and burns the numbers into the screenshot.
//
// Fixture names are the ones from Dave's 2026-09-10 report — deliberately the long ones, because
// short names would hide the wrap that caused the overlap.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CareNeeded from '../../src/components/today/CareNeeded.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'

const NAMES = ['Purple Basil', 'Lettuce Leaf Basil', 'Holy Basil', 'Tulsi Basil', 'Lemon Verbena',
  'Megatron Jalapeños', 'Sweet Basil', 'Yatsufusa', 'Tatli Kil Sivri', 'Capeliente', 'Cowhorn',
  'Ristra Cayenne II', 'King of the North', 'Petra']

const LOCATIONS = [{ id: 'loc-bag', name: 'Pasture Bag Area', full_path: 'Pasture > Bag Area' }]
const WATER = NAMES.map((name, i) => ({
  id: 'w-' + i, name, crop: 'pepper', project: 'Peppers 2026', project_id: 'pr-bag',
  overdue_by: [0, 1, 2, 4, 11][i % 5], in_ground: false, interval: 3, days_since: 3,
}))
const PLANTS = WATER.map(w => ({
  id: w.id, location_id: 'loc-bag', container_type: null,
  featured_photo_view_url: null, featured_photo_id: null,
}))
const PLAN = {
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10, today_observed_in: 0 },
  rain_skipped: [], water_due: WATER, no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
}

const posts = []
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path === '/api/plants') body = PLANTS
  else if (path === '/api/locations/with-path') body = LOCATIONS
  else if (path === '/api/events' && init.method === 'POST') { posts.push(JSON.parse(init.body)); body = { id: 'ev-' + posts.length } }
  await new Promise(r => setTimeout(r, 20))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ToastProvider>
      <MemoryRouter initialEntries={['/today']}>
        <CareNeeded plan={PLAN} />
      </MemoryRouter>
    </ToastProvider>
  </AuthProvider>
)

// PER-ROW taps only. `[aria-label^="Log "]` also matches the section bulk button ("Log all
// watering (14)"), and tapping THAT exercises runBulk — which has always aggregated — so the run
// would report a single toast for the wrong reason. The row buttons are "Log Water for <name>".
const logButtons = () => [...document.querySelectorAll('[aria-label^="Log Water for "]')]
// The care list also owns a visually-hidden aria-live region (1x1, clipped) carrying the same
// "Logged …" text. It is not a toast; including it dragged the measured stack top to y=44 and
// reported 95% viewport coverage for a single 48px toast sitting at the bottom.
const toastEls = () => [...document.querySelectorAll('[role="status"]')]
  .filter(el => el.textContent.startsWith('Logged') && el.getBoundingClientRect().height > 10)

window.__t = {
  // Tap N rows as fast as the writes come back — the shape that produced the pile-up.
  async run(n = 14) {
    for (let i = 0; i < n; i++) {
      const b = logButtons()[0]
      if (!b) break
      b.click()
      await new Promise(r => setTimeout(r, 60))
    }
    await new Promise(r => setTimeout(r, 200))
    return window.__t.measure()
  },
  measure() {
    const els = toastEls()
    const vh = window.innerHeight, vw = window.innerWidth
    const boxes = els.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) } })
    // Overlap is THE original symptom: a 56px stride under ~90px toasts drew them through each
    // other. Sorted by top, any pair whose boxes intersect vertically is a regression.
    const sorted = [...boxes].sort((a, b) => a.top - b.top)
    let overlaps = 0
    for (let i = 1; i < sorted.length; i++) if (sorted[i].top < sorted[i - 1].bottom) overlaps++
    const stackTop = sorted.length ? sorted[0].top : vh
    return {
      count: boxes.length, overlaps,
      offscreenTop: stackTop < 0,
      // How much of the viewport the whole toast layer eats. The reported stack covered ~100%.
      viewportCoveredPct: sorted.length ? Math.round(((vh - stackTop) / vh) * 100) : 0,
      overflowsSide: boxes.some(b => b.left < 0 || b.right > vw),
      posts: posts.length,
      boxes,
    }
  },
}

const paint = (m) => {
  const el = document.getElementById('verdict')
  const bad = firstError || !m || m.overlaps > 0 || m.offscreenTop || m.overflowsSide || m.viewportCoveredPct > 40
  el.style.background = bad ? '#a4161a' : '#2d6a4f'
  el.textContent = firstError ? 'ERROR: ' + firstError
    : !m ? 'idle — call __t.run()'
    : `${m.posts} logged @${window.innerWidth}x${window.innerHeight} · toasts=${m.count} · overlaps=${m.overlaps}`
      + ` · offscreenTop=${m.offscreenTop} · sideOverflow=${m.overflowsSide} · layer covers ${m.viewportCoveredPct}% of viewport`
      + ` · ${bad ? 'FAIL' : 'PASS'}`
}
paint(null)
window.__t.paint = paint
setTimeout(async () => { paint(await window.__t.run(14)) }, 1200)
