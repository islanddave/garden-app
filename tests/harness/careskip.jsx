// BUG-TODAYSKIPNOUNDO-001 — real-browser check of the Today care row's Skip control.
//
// Two questions jsdom cannot answer, because it has no layout engine and no painted toast:
//   1. Does Skip clear 48px, with a gap before the control beside it, while the plant name keeps a
//      usable width at Dave's viewport (426x836 CSS px, DPR 3)?
//   2. Does a skip put a VISIBLE Undo on screen, and does Undo bring the row back?
//
// Separate entry from careneeded.jsx on purpose: that one has no ToastProvider (useOptionalToast
// falls back to a no-op), so it cannot show the toast this change adds. Wrapped here in the real
// provider the app mounts at its root.
//
// Names are sized from live data: today's care rows on prod (2026-09-24) run p50 13 characters, p90
// 24, max 52. The four longest below are real plantings from that list; the rest are stand-ins at
// about p50 and p90 length.
// One water_due row per length (Skip then Moist then Water), one no_history row (Skip directly
// beside Water) and one fertilize row (Skip beside Feed), so every neighbour Skip can have appears.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CareNeeded from '../../src/components/today/CareNeeded.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'

const water = (id, name, overdue) => ({
  id, name, crop: 'lettuce', project: 'Bag Area 2026', project_id: 'pr-bag',
  overdue_by: overdue, in_ground: false, interval: 3, days_since: overdue + 3,
})

const PLAN = {
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10, today_observed_in: 0 },
  rain_skipped: [],
  water_due: [
    water('w-52', 'Onion — scallion-type (thick blue-green, ID pending)', 3),
    water('w-41', 'Marvel of Four Seasons Butterhead Lettuce', 2),
    water('w-24', 'Cherokee Purple Tomato 2', 1),
    water('w-14', 'Sungold Tomato', 1),
    water('w-08', 'Habanero', 0),
  ],
  no_history: [{ id: 'n-31', name: 'Little Gem Mini-Romaine Lettuce', project: 'Bag Area 2026', project_id: 'pr-bag', in_ground: false, never: true }],
  fertilize: [{ id: 'f-32', name: 'Sunny Susy White Halo Thunbergia', crop: 'thunbergia', project: 'Bag Area 2026', project_id: 'pr-bag', item: 'MG', apply: 'half strength' }],
  pest: [], cold: [], dormant: [],
}
const ALL_IDS = [...PLAN.water_due, ...PLAN.no_history, ...PLAN.fertilize].map(r => r.id)
const PLANTS = ALL_IDS.map(id => ({ id, location_id: 'loc-bag', container_type: null, featured_photo_view_url: null, featured_photo_id: null }))
const LOCATIONS = [{ id: 'loc-bag', name: 'Pasture Bag Area', full_path: 'Pasture Bag Area' }]

// A fresh day every load: a skip from a previous run must not hide a row before anything is measured.
for (const k of Object.keys(localStorage)) if (k.startsWith('today-')) localStorage.removeItem(k)

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

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ToastProvider>
      <MemoryRouter initialEntries={['/today']}>
        <CareNeeded plan={PLAN} />
      </MemoryRouter>
    </ToastProvider>
  </AuthProvider>
)

const r = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height } }
const skips = () => [...document.querySelectorAll('button[aria-label^="Skip "]')]
const undoToast = () => [...document.querySelectorAll('[role="status"]')].find(s => /Skipped/.test(s.textContent) && s.querySelector('button'))

window.__h = {
  error: () => firstError,
  ready: () => skips().length >= ALL_IDS.length,
  // Per row: Skip's box, the gap to whatever control sits to its right, and the width the plant name
  // actually gets — with `truncated` read off the painted node (scrollWidth > clientWidth), not guessed.
  measure() {
    const rows = skips().map(s => {
      const row = s.parentElement
      const next = s.nextElementSibling
      const nameEl = row.querySelector('a div div')
      const sb = r(s)
      return {
        name: nameEl ? nameEl.textContent : null,
        skipW: Math.round(sb.width * 10) / 10,
        skipH: Math.round(sb.height * 10) / 10,
        skipVisible: s.checkVisibility(),
        next: next ? next.textContent.trim() : null,
        gapToNext: next ? Math.round((r(next).left - sb.right) * 10) / 10 : null,
        nameW: nameEl ? nameEl.clientWidth : null,
        truncated: nameEl ? nameEl.scrollWidth > nameEl.clientWidth : null,
      }
    })
    return {
      vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
      scrollW: document.documentElement.scrollWidth, rows,
    }
  },
  badge(text) { const el = document.getElementById('verdict'); el.textContent = text; el.style.background = firstError ? '#a4161a' : '#2d6a4f' },
  skip(name) { const b = skips().find(s => s.getAttribute('aria-label') === 'Skip ' + name + ' today'); if (!b) throw new Error('no Skip for ' + name); b.click() },
  toast() {
    const t = undoToast()
    if (!t) return null
    const btn = [...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo')
    return { text: t.textContent.replace(/Undo×?$/, '').trim(), undoVisible: !!btn && btn.checkVisibility(), undo: btn ? r(btn) : null }
  },
  undo() { const t = undoToast(); const btn = t && [...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo'); if (!btn) throw new Error('no Undo on screen'); btn.click() },
  // A row counts as present only if it is painted — checkVisibility, never offsetParent.
  has(name) { return [...document.querySelectorAll('a')].some(a => a.textContent.includes(name) && a.checkVisibility()) },
  skipped: () => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('today-skipped:')) || 'x') || '[]'),
  posts: () => posts.length,
}

let ticks = 0
const paint = () => {
  if (!window.__h.ready()) { if (++ticks < 40) setTimeout(paint, 150); return }
  const m = window.__h.measure()
  const minW = Math.min(...m.rows.map(x => x.skipW)); const minGap = Math.min(...m.rows.map(x => x.gapToNext))
  window.__h.badge(`innerWidth ${m.vw} · innerHeight ${m.vh} · dpr ${m.dpr} · scrollW ${m.scrollW}\nSkip min ${minW}px wide · min gap to next control ${minGap}px · name min ${Math.min(...m.rows.map(x => x.nameW))}px · truncated ${m.rows.filter(x => x.truncated).length}/${m.rows.length}`)
}
setTimeout(paint, 150)
