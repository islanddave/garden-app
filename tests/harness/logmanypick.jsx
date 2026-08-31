// V4-LOGMANYUXREFRESH-001 S2 + S3 — the WHOLE Log Many page at Dave's geometry, in a real browser.
//
// WHY A SECOND LOG MANY ENTRY. `logmany.jsx` mounts ScopeChecklist ALONE, which is enough to measure
// the review list but cannot answer either question this lane has to answer:
//   S2 — raising four tap targets adds height to a PAGE. "Nothing here sits under a sticky band" is
//        a claim about the page, so the page is what has to be rendered to check it, and the fourth
//        control ("Reset to today") lives in LogMany.jsx and not in the component at all.
//   S3 — the pick frame is `position: fixed; inset: 0`. Whether it really owns the viewport, and
//        whether its three tracks land where the design says, is only observable with the page
//        underneath it.
// jsdom returns zero for every getBoundingClientRect(), so no vitest file can falsify any of it.
//
// The REAL LogMany runs: only the network is stubbed. Mocking the page's own modules would measure
// the harness. Fixture is 239 plantings on the measured prod crop distribution (design §3.1) —
// a 12-row fixture makes any list look fine, and scale is the entire complaint.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import LogMany from '../../src/pages/LogMany.jsx'

const HEAD = [
  ['tomato', 46], ['pepper', 38], ['basil', 7], ['geranium', 6], ['lettuce', 5],
  ['broccoli', 4], ['melon', 4], [null, 3], ['onion', 3], ['tomatillo', 3], ['kale', 3],
]
const CULTIVARS = {
  tomato: ['Sun Gold', 'San Marzano', 'Black Krim', 'Brandywine', 'Sunray', 'Cherokee Purple'],
  pepper: ['Aji Dulce', 'Jalapeno', 'Shishito', 'Chili Red', 'Padron', 'Habanero'],
  basil: ['Genovese', 'Thai Basil', 'Lemon Basil'],
  melon: ['Charentais', 'Hales Best'],
}
const PLANTINGS = []
let n = 0
for (const [slug, count] of HEAD) {
  for (let i = 0; i < count; i++) {
    const names = CULTIVARS[slug]
    const name = names ? `${names[i % names.length]} ${Math.floor(i / names.length) + 1}` : null
    PLANTINGS.push({
      id: `pl-${++n}`,
      name: name ?? (slug ? `${slug[0].toUpperCase()}${slug.slice(1)} ${i + 1}` : `Kousa Dogwood ${i + 1}`),
      crop_type_slug: slug,
    })
  }
}
const TAIL = ['squash', 'cucumber', 'bean', 'pea', 'carrot', 'beet', 'chard', 'arugula', 'cilantro',
  'dill', 'mint', 'oregano', 'parsley', 'rosemary', 'sage', 'thyme', 'chive', 'leek', 'radish',
  'spinach', 'turnip', 'eggplant', 'okra', 'celery', 'fennel', 'garlic', 'shallot', 'strawberry',
  'raspberry', 'blueberry', 'zinnia', 'marigold', 'nasturtium', 'sunflower', 'cosmos', 'dahlia',
  'hydrangea', 'dogwood', 'hosta', 'fern', 'sedum', 'lavender', 'yarrow', 'echinacea', 'aster']
for (let t = 0; PLANTINGS.length < 239; t++) {
  const slug = TAIL[t % TAIL.length]
  PLANTINGS.push({
    id: `pl-${++n}`,
    name: `${slug[0].toUpperCase()}${slug.slice(1)} ${Math.floor(t / TAIL.length) + 1}`,
    crop_type_slug: slug,
  })
}

const LOCATIONS = [
  { id: 'bag', name: 'Bag Area', sort_order: 1 },
  { id: 'trough', name: 'Trough', sort_order: 2 },
  { id: 'deck', name: 'Deck', sort_order: 3 },
  { id: 'yard', name: 'Yard', sort_order: 4 },
]

// Stubbed at the NETWORK layer so the real page, the real ScopeChecklist and the real
// useApiFetch/token path all run. A `space` scope resolves to a slice, mirroring the server-side
// cascade closely enough for layout purposes (the wire shape itself is pinned by
// lambda/events/logmany-cropslug.test.js).
const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}))
const realFetch = window.fetch.bind(window)
window.fetch = (url, opts = {}) => {
  const u = String(url)
  if (u.includes('/api/projects')) return json([])
  if (u.includes('/api/locations')) return json({ locations: LOCATIONS })
  if (u.includes('/api/notification-prefs')) return json({})
  if (u.includes('/api/events/batch')) {
    let scope = { type: 'all' }
    try { scope = JSON.parse(opts.body ?? '{}').scope ?? scope } catch (e) { /* keep default */ }
    const rows = scope.type === 'space' ? PLANTINGS.slice(0, 24) : PLANTINGS
    return json({ count: rows.length, capped: false, plantings: rows })
  }
  return realFetch(url, opts)
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/log/many']}><LogMany /></MemoryRouter>,
)

const q = (s) => document.querySelector(s)
const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
const byText = (re, sel = 'button') => [...document.querySelectorAll(sel)].find(b => re.test(b.textContent))
const clickText = (re, sel = 'button') => { const b = byText(re, sel); if (b) b.click(); return !!b }

// A control is only a tap target if it is REALLY visible. checkVisibility() rather than
// offsetParent: a `position: fixed` node has a null offsetParent whether or not it is painted, and
// the pick frame is entirely fixed-position.
const visible = (el) => !!(el && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null))

window.__h = {
  ready: () => !!byText(/^Review \d+ plantings/) || !!q('[data-testid="sc-open-pick"]'),
  openReview: () => clickText(/^Review \d+ plantings/),
  setZone: () => clickText(/^By zone$/),
  // "Reset to today" only renders once a back-date is set — it is the fourth S2 target and it is
  // invisible until the affordance it undoes has been used.
  backDate: () => {
    const el = q('input[type="date"]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '2026-08-01')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  },
  pickMode: () => { q('[data-testid="sc-mode-pick"]')?.click(); return true },
  bulkMode: () => { q('[data-testid="sc-mode-bulk"]')?.click(); return true },
  openFrame: () => { q('[data-testid="sc-open-pick"]')?.click(); return true },
  doneFrame: () => { q('[data-testid="pick-done"]')?.click(); return true },
  type: (v) => {
    const el = q('[data-testid="sc-search"]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  // Tap the first N candidate rows currently on screen — the "pick three by name" gesture.
  tapRows: (k) => {
    const rows = [...document.querySelectorAll('[data-testid="pick-list"] button[aria-pressed]')]
    rows.slice(0, k).forEach(r => r.click())
    return rows.length
  },
  rows: () => [...document.querySelectorAll('[data-testid="pick-list"] button[aria-pressed]')]
    .map(b => b.textContent).slice(0, 8),

  // ── S2: the four targets that were under the app's own 44px floor ─────────────────────────
  targets: () => {
    const label = q('[data-testid="sc-default-all"]')?.closest('label')
    const scopeChips = [...document.querySelectorAll('button')]
      .filter(b => /^(All active|By zone)$/.test(b.textContent))
    const zoneChips = [...document.querySelectorAll('[role="group"][aria-label="Zone"] button')]
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      reviewLinkH: h(byText(/^(Review|Hide) \d+ plantings/)),
      prefLabelH: h(label),               // the real target: a click on the label toggles the box
      prefBoxH: h(q('[data-testid="sc-default-all"]')),
      scopeChipH: scopeChips.length ? Math.min(...scopeChips.map(h)) : null,
      scopeChipRows: new Set(scopeChips.map(b => Math.round(b.getBoundingClientRect().top))).size,
      zoneChipH: zoneChips.length ? Math.min(...zoneChips.map(h)) : null,
      zoneChipRows: new Set(zoneChips.map(b => Math.round(b.getBoundingClientRect().top))).size,
      resetTodayH: h(byText(/^Reset to today$/)),
      modeChipH: h(q('[data-testid="sc-mode-pick"]')),
      // The page grows when targets grow; nothing on Log Many is sticky, so the check is that the
      // primary action is still in normal flow and reachable by scrolling, not pinned under a band.
      docHeight: Math.round(document.documentElement.scrollHeight),
      stickyCount: [...document.querySelectorAll('body *')]
        .filter(el => { const p = getComputedStyle(el).position; return p === 'sticky' || p === 'fixed' }).length,
      primaryH: h(byText(/^Log \w+ on \d+$/)),
      primaryCount: [...document.querySelectorAll('button')].filter(b => /^Log \w+ on \d+$/.test(b.textContent)).length,
    }
  },

  // ── S3: the frame's geometry ──────────────────────────────────────────────────────────────
  frame: () => {
    const f = q('[data-testid="pick-frame"]')
    if (!f) return { present: false }
    const list = q('[data-testid="pick-list"]')
    const tray = q('[data-testid="pick-tray"]')
    const primary = byText(/^Log \w+ on \d+$/)
    const rect = f.getBoundingClientRect()
    const lr = list.getBoundingClientRect()
    const rows = [...list.querySelectorAll('button[aria-pressed]')]
    const trayChips = [...tray.querySelectorAll('button')]
    // Every scrollable box inside the frame. The design's claim is that there is EXACTLY ONE and it
    // is the candidate list; anything else that scrolls is a second scroller and a defect.
    const scrollers = [...f.querySelectorAll('*')].filter(el => {
      const s = getComputedStyle(el)
      return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
    }).map(el => el.dataset.testid ?? el.tagName.toLowerCase())
    const pr = primary?.getBoundingClientRect()
    return {
      present: true,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      frameTop: Math.round(rect.top), frameBottom: Math.round(rect.bottom),
      frameWidth: Math.round(rect.width),
      ownsViewport: Math.round(rect.top) === 0 && Math.round(rect.bottom) === window.innerHeight
        && Math.round(rect.width) === window.innerWidth,
      // The page behind must not scroll while the frame is up.
      docScrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
      verticalScrollers: scrollers,
      listTop: Math.round(lr.top), listBottom: Math.round(lr.bottom),
      listClientH: list.clientHeight, listScrollH: list.scrollHeight,
      rowCount: rows.length,
      rowH: rows.length ? Math.min(...rows.map(h)) : null,
      rowText: rows.slice(0, 3).map(r => r.textContent),
      trayVisible: visible(tray),
      trayChipH: trayChips.length ? Math.min(...trayChips.map(h)) : null,
      trayChipCount: trayChips.length,
      trayScrollsHorizontally: tray.scrollWidth > tray.clientWidth + 1,
      trayWrapped: new Set(trayChips.map(b => Math.round(b.getBoundingClientRect().top))).size,
      pickCount: q('[data-testid="pick-count"]')?.textContent ?? null,
      doneH: h(q('[data-testid="pick-done"]')),
      searchH: h(q('[data-testid="sc-search"]')),
      chipH: (() => {
        const c = [...document.querySelectorAll('[data-testid="sc-crop-chips"] button')]
        return c.length ? Math.min(...c.map(h)) : null
      })(),
      shownNote: q('[data-testid="sc-shown-note"]')?.textContent ?? null,
      primaryText: primary?.textContent ?? null,
      primaryH: pr ? Math.round(pr.height) : null,
      primaryBottom: pr ? Math.round(pr.bottom) : null,
      primaryInView: pr ? Math.round(pr.bottom) <= window.innerHeight : null,
      primaryVisible: visible(primary),
      // Exactly one commit control in the document — the page copy must be suppressed.
      primaryCount: [...document.querySelectorAll('button')].filter(b => /^Log \w+ on \d+$/.test(b.textContent)).length,
    }
  },
}
