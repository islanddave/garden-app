// V4-TODAYSECTIONBULK-001 (BD-037) + BUG-TODAYCAREREORDER-001 (BD-036) — real-browser layout check
// for the Today care list at Dave's geometry.
//
// Why this entry exists at all: jsdom has no layout engine, so every getBoundingClientRect() in the
// vitest run is zero. The unit suite can prove the section-bulk button EXISTS and that the group
// order holds; it cannot prove the header still fits at 390px with a long location name beside a
// count and a button. That is the only question this file answers, and it is the one that decides
// whether the feature is usable on the device it was built for.
//
// Separate entry from main.jsx (EventNew) and editdeeplink.jsx, so nothing in either moves.
//
// The fixture is shaped from the live 2026-08-24 plan rather than invented: one dominant location
// group in the seventies (Dave's "Pasture Bag Area 77" is the case in the ask), a mid group, and a
// long-named group to put the header under its worst text pressure.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CareNeeded from '../../src/components/today/CareNeeded.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'

const LOCATIONS = [
  { id: 'loc-bag', name: 'Pasture Bag Area', full_path: 'Pasture Bag Area' },
  { id: 'loc-drive', name: 'Drive Trough', full_path: 'Drive Trough' },
  // Worst-case label: the header must ellipsize this, not wrap or push the button off-screen.
  { id: 'loc-long', name: 'Legacy Pasture In-Ground Beds (north row)', full_path: 'Legacy Pasture In-Ground Beds (north row)' },
]

// BD-036b — `overdue` may be a number or a function of the row index. The Bag group uses the
// function form to spread rows across ALL THREE severity tiers (gold 0 / terra 1-2 / terra-bold 3+),
// because after the redesign the tier COLOUR is the only on-screen carrier of urgency. A fixture
// where every row scores the same cannot show whether the three are actually distinguishable at a
// glance, which is now the question the whole design rests on.
const mk = (locId, n, overdue) => Array.from({ length: n }, (_, i) => {
  const od = typeof overdue === 'function' ? overdue(i) : overdue
  return {
    id: locId + '-' + i,
    name: ['Bhut Jolokia', 'Sungold', 'Genovese Basil', 'Lacinato Kale', 'Wild Bergamot'][i % 5] + ' ' + (i + 1),
    crop: 'pepper', project: 'Peppers 2026', project_id: 'pr-' + locId,
    overdue_by: od, in_ground: locId === 'loc-long', interval: 3, days_since: od + 3,
  }
})

// Bag cycles 0 / 1 / 2 / 4 / 11 so the first five rows on screen are gold, terra, terra, terra-bold,
// terra-bold — i.e. every tier boundary is visible in one screenshot, adjacent, for comparison.
const WATER = [
  ...mk('loc-bag', 77, i => [0, 1, 2, 4, 11][i % 5]),
  ...mk('loc-drive', 9, 2),
  ...mk('loc-long', 4, 6),
]
const PLANTS = WATER.map(w => ({
  id: w.id, location_id: w.id.replace(/-\d+$/, ''), container_type: null,
  featured_photo_view_url: null, featured_photo_id: null,
}))

const PLAN = {
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10, today_observed_in: 0 },
  rain_skipped: [],
  water_due: WATER,
  no_history: [],
  fertilize: [{ id: 'loc-bag-0', name: 'Bhut Jolokia 1', crop: 'pepper', project: 'Peppers 2026', project_id: 'pr-loc-bag', item: 'MG', apply: 'half strength' }],
  pest: [], cold: [], dormant: [],
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
  await new Promise(r => setTimeout(r, 30))       // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <MemoryRouter initialEntries={['/today']}>
      <CareNeeded plan={PLAN} />
    </MemoryRouter>
  </AuthProvider>
)

// The measurements, burned into the page so a screenshot is self-evidencing rather than trusted.
const headers = () => [...document.querySelectorAll('[aria-expanded]')].map(b => b.parentElement)

window.__h = {
  // Does any section header overflow the viewport, wrap to a second line, or clip its bulk button?
  measureHeaders() {
    const vw = window.innerWidth
    return headers().map(h => {
      const toggle = h.querySelector('[aria-expanded]')
      const bulk = [...h.querySelectorAll('button')].find(b => /all$/.test(b.textContent.trim()))
      const r = h.getBoundingClientRect()
      return {
        label: toggle.querySelector('span').textContent,
        height: Math.round(r.height),
        overflowsRight: Math.round(r.right) > vw,
        bulk: bulk ? bulk.textContent.trim() : null,
        bulkRight: bulk ? Math.round(bulk.getBoundingClientRect().right) : null,
        bulkFits: bulk ? bulk.getBoundingClientRect().right <= vw + 0.5 : null,
        // A header that grew past ~one line has wrapped; 52 is the design minHeight.
        wrapped: Math.round(r.height) > 60,
      }
    })
  },
  order() { return headers().map(h => h.querySelector('[aria-expanded] span').textContent) },
  posts: () => posts.length,
  // BD-036 in a real browser: tap Log on N rows and confirm the header order is byte-identical.
  //
  // `only` names the group to drain, and it matters. Draining the DOMINANT group proves nothing:
  // Pasture Bag Area scores 77x2=154 against 28 and 27, so a handful of logs cannot reorder it with
  // or without the fix, and the check would report `stable:true` for fixture reasons. The two small
  // groups sit one point apart on purpose — Legacy 4x7=28 vs Drive 9x3=27 — so draining a single
  // Legacy row is enough to invert them unpinned. Always drain a group the sort can actually move.
  //
  // `counterfactual` is the honesty channel: it re-sorts the rows still on screen by the old rule
  // (severity, desc) and reports what the page WOULD look like without the pin. stable:true is only
  // evidence when counterfactualDiffers is also true.
  async drainAndCompare({ n = 3, only = 'Legacy' } = {}) {
    const before = window.__h.order()
    let clicked = 0
    for (let i = 0; i < n; i++) {
      const section = headers().find(h => h.querySelector('[aria-expanded] span').textContent.includes(only))
      if (!section) break
      const panel = section.parentElement.querySelector('[role="list"]')
      const btn = panel && [...panel.querySelectorAll('button')]
        .find(b => /^Log Water for /.test(b.getAttribute('aria-label') || ''))
      if (!btn) break
      btn.click(); clicked++
      await new Promise(r => setTimeout(r, 90))
    }
    const after = window.__h.order()
    return {
      before, after, clicked, posts: posts.length,
      stable: JSON.stringify(before) === JSON.stringify(after),
      counterfactual: window.__h.counterfactualOrder(),
      counterfactualDiffers: JSON.stringify(after) !== JSON.stringify(window.__h.counterfactualOrder()),
    }
  },
  // What the OLD unconditional sort would produce from the rows currently rendered. Read straight
  // off the DOM rather than from component state so it cannot drift from what is on screen.
  counterfactualOrder() {
    return headers().map(h => {
      const label = h.querySelector('[aria-expanded] span').textContent
      const panel = h.parentElement.querySelector('[role="list"]')
      const rows = panel ? [...panel.querySelectorAll('[aria-label^="Log "]')].length : null
      // Severity is unavailable post-render for collapsed groups; use the header count, which is
      // what changes as rows drain, and the overdue weight baked into the fixture.
      const count = Number(h.querySelector('[aria-expanded] span + span').textContent)
      const weight = label.includes('Legacy') ? 7 : label.includes('Drive') ? 3 : 2
      return { label, score: count * weight, rows }
    }).sort((a, b) => b.score - a.score).map(x => x.label)
  },
}

let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  const m = window.__h.measureHeaders()
  const bad = m.filter(x => x.wrapped || x.overflowsRight || x.bulkFits === false)
  el.style.background = firstError ? '#a4161a' : bad.length ? '#a4161a' : '#2d6a4f'
  el.textContent = firstError
    ? 'ERROR: ' + firstError
    : m.length === 0
      ? 'no sections rendered yet…'
      : `${m.length} sections @${window.innerWidth}px · ${bad.length ? 'LAYOUT FAIL: ' + bad.map(b => b.label).join(', ') : 'all headers fit, none wrapped'} · bulk=${m.map(x => x.bulk || '—').join('|')}`
  if (++ticks < 12) setTimeout(paint, 250)
}
setTimeout(paint, 250)
