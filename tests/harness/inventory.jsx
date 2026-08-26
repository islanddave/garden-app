// HG-4.2 — real-browser render of the Inventory LIST at phone geometry.
//
// Why this entry exists: the vitest lock (src/__tests__/Inventory.list.test.jsx) proves the
// structure and the AUTHORED tap sizes, but jsdom has no layout engine — every
// getBoundingClientRect() there is zero. "Does the redesigned row actually fit at 390px with a
// long item name beside a qty, a unit, a cost and a Low badge" is not a question that suite can
// answer, and it is the question Dave's "very, very raw" complaint was about.
//
// Separate entry from main.jsx / careneeded.jsx / editdeeplink.jsx, per the established pattern
// here, so nothing in those moves.
//
// The fixture is shaped to put the row under its worst text pressure rather than to look tidy:
// a 44-character item name, a four-digit quantity, both low-stock states, a durable with a
// condition, and an item with no cost at all — plus enough categories that the section headers
// and the canonical ordering are both visible in one frame.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Inventory from '../../src/pages/Inventory.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const ITEMS = [
  { id: '1', name: 'Sungold Cherry Tomato', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 2, reorder_threshold: 5, unit: 'packet', unit_cost: 3.95, quantity_purchased: 10,
    purchase_date: '2026-02-14', source: 'Johnny’s' },
  { id: '2', name: 'Bhut Jolokia (ghost) pepper seed — 2026 lot', type: 'consumable', category: 'seeds',
    status: 'active', quantity_on_hand: 0, reorder_threshold: 1, unit: 'packet', unit_cost: 4.5,
    quantity_purchased: 3, purchase_date: '2026-01-08' },
  { id: '3', name: 'Genovese Basil', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 12, reorder_threshold: null, unit: 'packet', unit_cost: 2.75, quantity_purchased: 12,
    purchase_date: '2026-03-02' },
  { id: '4', name: 'Pro-Mix HP Mycorrhizae 3.8cf', type: 'consumable', category: 'growing_media',
    status: 'active', quantity_on_hand: 1, reorder_threshold: 2, unit: 'bag', unit_cost: 42,
    quantity_purchased: 4, purchase_date: '2026-03-20' },
  { id: '5', name: 'Neptune’s Harvest Fish & Seaweed', type: 'consumable', category: 'fertilizer',
    status: 'active', quantity_on_hand: 3, reorder_threshold: null, unit: 'qt', unit_cost: 18.5,
    quantity_purchased: 4, purchase_date: '2026-04-11' },
  { id: '6', name: '5 gallon fabric grow bag', type: 'durable', category: 'containers', status: 'active',
    quantity: 1240, condition: 'good', unit_cost: null, quantity_purchased: null, purchase_date: '2026-02-02' },
  { id: '7', name: 'Hori Hori Knife', type: 'durable', category: 'tools', status: 'active',
    quantity: 2, condition: 'excellent', unit_cost: 34.99, quantity_purchased: 2, purchase_date: '2026-04-10' },
  { id: '8', name: 'Barrina T5 grow light 4ft', type: 'durable', category: 'lighting', status: 'active',
    quantity: 8, condition: 'good', unit_cost: 22.5, quantity_purchased: 8, purchase_date: '2026-01-30' },
]

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  const body = path.startsWith('/api/inventory-items') ? ITEMS : []
  await new Promise(r => setTimeout(r, 30))          // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

// The page's sticky cost bar offsets itself by this var; BottomNav owns it in the real app and
// is not mounted here, so the harness supplies the same number from the same constant.
document.documentElement.style.setProperty('--bottom-nav-height', BOTTOM_NAV_HEIGHT_PX + 'px')

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/inventory']}>
    <Inventory />
  </MemoryRouter>
)

// Measurements burned into the page so the screenshot is self-evidencing rather than trusted.
window.__h = {
  error: () => firstError,
  ready: () => document.querySelectorAll('[data-testid="inv-row"]').length > 0,

  // Every control the redesign owns, measured as RENDERED — the number jsdom cannot produce.
  //
  // EACH CONTROL IS SCROLLED INTO VIEW BEFORE IT IS HIT-TESTED, and that is not a nicety.
  // elementFromPoint is VIEWPORT-relative: for anything below the fold it returns null (or
  // whatever happens to sit at those coordinates on screen), so a naive single-pass version of
  // this reported the last three section headers as "occluded" when they were simply further
  // down the page. That is a false positive of exactly the kind these gates exist to catch, so
  // the fix is to measure each control where the user actually meets it — centred in the
  // viewport, clear of the fixed verdict strip at the top.
  tapTargets() {
    const vw = window.innerWidth
    const sel = [
      '[data-testid="inv-section"]',
      'button[aria-label="Decrease quantity"]',
      'button[aria-label="Increase quantity"]',
      'select',
      'a[href^="/inventory"]',
      'a[href="/sow"]',
      'button[aria-label*="need restock"]',
    ].join(',')
    const els = [...document.querySelectorAll(sel)]
    const out = els.map(el => {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hit = (cy >= 0 && cy <= window.innerHeight) ? document.elementFromPoint(cx, cy) : null
      return {
        id: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 34),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        fits: r.left >= -0.5 && r.right <= vw + 0.5,
        visible: el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        // null (never probed) is reported distinctly from false (probed and occluded) so the
        // gate can refuse a run that silently checked nothing.
        hitIsSelf: hit === null ? null : (hit === el || el.contains(hit)),
      }
    })
    window.scrollTo(0, 0)
    return out
  },

  // Does the at-a-glance row hold together at 390, or does the meta line wrap / overflow?
  rows() {
    const vw = window.innerWidth
    return [...document.querySelectorAll('[data-testid="inv-row"]')].map(row => {
      const r = row.getBoundingClientRect()
      const coin = row.querySelector('[data-testid="inv-coin"]')
      const badge = row.querySelector('[role="img"][aria-label*="stock"]')
      return {
        name: row.querySelector('button').textContent.trim().slice(0, 30),
        h: +r.height.toFixed(1),
        overflowsRight: r.right > vw + 0.5,
        coin: coin ? +coin.getBoundingClientRect().width.toFixed(1) : null,
        badge: badge ? badge.getAttribute('aria-label') : null,
        // A single-line row is ~64-72 tall; anything much past that means the meta line wrapped.
        wrapped: r.height > 84,
      }
    })
  },

  sections() {
    return [...document.querySelectorAll('[data-testid="inv-section"]')].map(s => s.dataset.category)
  },

  // The header holds an h1 and three actions on one flex row. At 390px they do not all fit, so
  // the action group wraps — measured here rather than eyeballed, because raising the two chips
  // from 38 to 44px needed to be shown NOT to have caused that wrap (it is width-driven; the
  // chips are the same width at either height, so the only delta is the block's own height).
  header() {
    const h1 = document.querySelector('h1')
    const wrap = h1?.parentElement
    const actions = wrap?.lastElementChild
    const kids = actions ? [...actions.children].map(c => c.getBoundingClientRect()) : []
    const lines = new Set(kids.map(r => Math.round(r.top))).size
    return {
      blockH: wrap ? +wrap.getBoundingClientRect().height.toFixed(1) : null,
      actionsH: actions ? +actions.getBoundingClientRect().height.toFixed(1) : null,
      actionLines: lines,
      chipH: kids.length ? +kids[0].height.toFixed(1) : null,
      totalActionWidth: +kids.reduce((a, r) => a + r.width, 0).toFixed(1),
      availableWidth: wrap ? +wrap.getBoundingClientRect().width.toFixed(1) : null,
      h1Width: h1 ? +h1.getBoundingClientRect().width.toFixed(1) : null,
    }
  },

  docOverflows: () => document.documentElement.scrollWidth > window.innerWidth,
}

// Live verdict strip, same pattern as careneeded.jsx.
let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  if (!window.__h.ready()) { el.textContent = 'booting…'; if (++ticks < 20) setTimeout(paint, 200); return }
  const taps = window.__h.tapTargets()
  const rows = window.__h.rows()
  const small = taps.filter(t => t.h < 44 || t.w < 44)
  const bad = rows.filter(r => r.overflowsRight || r.wrapped)
  const ok = !firstError && !small.length && !bad.length && !window.__h.docOverflows()
  el.style.background = ok ? '#2d6a4f' : '#a4161a'
  el.textContent = firstError
    ? 'ERROR: ' + firstError
    : `${rows.length} rows / ${window.__h.sections().length} sections @${window.innerWidth}px · `
      + (small.length ? 'UNDER 44: ' + small.map(s => `${s.id}(${s.w}x${s.h})`).join(', ')
                      : `all ${taps.length} targets >=44`)
      + ' · ' + (bad.length ? 'ROW OVERFLOW: ' + bad.map(b => b.name).join(', ') : 'no row wrap/overflow')
  if (++ticks < 24) setTimeout(paint, 250)
}
setTimeout(paint, 200)
