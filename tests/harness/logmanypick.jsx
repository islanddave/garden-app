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

// V4-LOGMANYUXREFRESH-001 S4 — a 2-TIER tree, not the flat list S3 shipped with. The location
// filter's whole claim is the descendant cascade (pick Pasture, keep Bag Area), and a flat fixture
// cannot falsify it. Shape copied from prod: level-0 zones with sub-locations under two of them,
// including the repeated "Shade" name that makes the disambiguating chip prefix load-bearing.
const LOCATIONS = [
  { id: 'pasture', name: 'Pasture', parent_id: null, sort_order: 1 },
  { id: 'bag', name: 'Bag Area', parent_id: 'pasture', sort_order: 1 },
  { id: 'pshade', name: 'Shade', parent_id: 'pasture', sort_order: 2 },
  { id: 'drive', name: 'Drive', parent_id: null, sort_order: 2 },
  { id: 'trough', name: 'Trough', parent_id: 'drive', sort_order: 1 },
  { id: 'dshade', name: 'Shade', parent_id: 'drive', sort_order: 2 },
  { id: 'deck', name: 'Deck', parent_id: null, sort_order: 3 },
  { id: 'yard', name: 'Yard', parent_id: null, sort_order: 4 },
]
// Spread across the tree, with a null tail so the "No zone" bucket renders. Deterministic (index
// modulo) rather than random: a harness whose fixture changes between runs cannot be a baseline.
const PLACES = ['bag', 'bag', 'trough', 'pasture', 'deck', 'pshade', 'yard', 'dshade', 'drive', null]
PLANTINGS.forEach((pl, i) => { pl.location_id = PLACES[i % PLACES.length] })

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

  // ── S4: the second filter axis ────────────────────────────────────────────────────────────
  // FilterChipRow collapses its tray on selecting a tray-only chip (its own BD-011 rider), so
  // every tap on a non-pinned chip has to be preceded by its own expand. Returning false when a
  // control is missing matters: `?.click()` on a null makes a no-op look like a completed step.
  // Expand and tap are SEPARATE calls on purpose, one render tick apart. Doing both in one
  // function looked right and silently did nothing: setExpanded is async, so the re-query for the
  // now-revealed chip ran against the pre-expand DOM, found nothing, and returned false — a filter
  // that never applied, reported as a step that ran. (Caught by the measurement disagreeing with
  // the jsdom test, not by the harness.)
  chipExpand: (testid) => {
    const scope = document.querySelector(`[data-testid="${testid}"]`)
    const more = scope && [...scope.querySelectorAll('button')].find(b => /^More/.test(b.textContent))
    if (!more) return false
    more.click()
    return true
  },
  chipTap: (testid, label) => {
    const scope = document.querySelector(`[data-testid="${testid}"]`)
    if (!scope) return false
    const btn = [...scope.querySelectorAll('button')]
      .find(b => b.textContent.replace(/\s+/g, ' ').trim() === label)
    if (!btn) return 'missing'
    btn.click()
    // 'tapped', never the post-click aria-pressed: React has not re-rendered yet, so that attribute
    // still reads "false" — indistinguishable, in a dataset attribute, from "the chip was not
    // there". A step that no-opped has to look different from one that worked.
    return 'tapped'
  },

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

  // ── S5: the BULK review list's geometry, which is the panel Dave ruled on ──────────────────
  // S4 argued AGAINST grouping this list with an ESTIMATE: "a maxHeight 240 window showing ~5 rows,
  // and 28px headers would consume ~40% of its viewport". Dave accepted that cost and asked for the
  // grouping anyway, so the number he agreed to has to become a measured one. Everything here is
  // read at scrollTop 0 — the state the list opens in, which is the only state the estimate was
  // about; scrolled, a header is just another 28px anywhere on an 11,000px strip.
  //
  // `headerPxVisible` INTERSECTS each header with the panel's visible box rather than summing header
  // heights: a header below the fold costs nothing on the screen the user is looking at, and summing
  // all 56 of them would report a share over 100% and read as a catastrophe.
  review: () => {
    // The testid is S5's own addition, so a BASELINE run (baselinePlugin serving src/** from a
    // pre-S5 object, which is how the before/after column is produced) would find nothing and report
    // `present: false` — an instrument that only works on the build it was written for measures
    // nothing. The fallback is structural: in BULK the review list is the only <ul> outside the pick
    // frame carrying exclusion toggles.
    const list = q('[data-testid="sc-review-list"]')
      || [...document.querySelectorAll('ul')]
        .find(u => !u.closest('[data-testid="pick-frame"]') && u.querySelector('button[aria-pressed]'))
    if (!list) return { present: false, innerWidth: window.innerWidth, innerHeight: window.innerHeight }
    const lr = list.getBoundingClientRect()
    // clientHeight, not rect.height: the visible scrollport, with the maxHeight cap applied.
    const viewTop = lr.top
    const viewBottom = lr.top + list.clientHeight
    const headers = [...list.querySelectorAll(':scope > [data-testid^="sc-group-"]')]
    const rows = [...list.querySelectorAll('button[aria-pressed]')]
    const overlap = (el) => {
      const r = el.getBoundingClientRect()
      return Math.max(0, Math.min(r.bottom, viewBottom) - Math.max(r.top, viewTop))
    }
    const headerPxVisible = headers.reduce((s, el) => s + overlap(el), 0)
    const fullyVisible = (el) => {
      const r = el.getBoundingClientRect()
      return r.top >= viewTop - 0.5 && r.bottom <= viewBottom + 0.5
    }
    return {
      present: true,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      panelTop: Math.round(lr.top),
      panelClientH: list.clientHeight,
      panelScrollH: list.scrollHeight,
      panelScrolls: list.scrollHeight > list.clientHeight + 1,
      headerCount: headers.length,
      headerH: headers.length ? Math.min(...headers.map(h)) : null,
      // The pitch a header really costs the list: its own height plus the flex `gap` above it.
      headerPitch: (() => {
        if (headers.length < 1 || !rows.length) return null
        const hr = headers[0].getBoundingClientRect()
        const next = headers[0].nextElementSibling
        return next ? Math.round(next.getBoundingClientRect().top - hr.top) : Math.round(hr.height)
      })(),
      headersVisible: headers.filter(el => overlap(el) > 0).length,
      headerPxVisible: Math.round(headerPxVisible),
      // THE NUMBER S4 ESTIMATED AT ~40%.
      headerSharePct: list.clientHeight ? Math.round((headerPxVisible / list.clientHeight) * 1000) / 10 : null,
      rowCount: rows.length,
      rowH: rows.length ? Math.min(...rows.map(h)) : null,
      rowsFullyVisible: rows.filter(fullyVisible).length,
      rowsPartlyVisible: rows.filter(el => overlap(el) > 0).length,
      // THE OTHER HALF OF S4's ESTIMATE, and the half that makes it defensible. The share above is
      // the list AS IT OPENS, where the first group is 46 tomatoes and exactly one header is on
      // screen. Scroll into the tail — 45 crop types with 1-3 plantings each — and a 240px window
      // holds three or four headers instead of one. S4's "~40%" is a claim about THAT window, not
      // about the opening one, so the honest comparison measures the worst window in the list.
      // Every window start is a real laid-out element top, so this reports a position the user can
      // actually scroll to rather than an arbitrary offset.
      worstWindow: (() => {
        if (!headers.length) return { headerPx: 0, headerPct: 0, headersInView: 0, rowsFullyVisible: rows.length ? Math.min(rows.length, Math.floor(list.clientHeight / (rows[0].getBoundingClientRect().height + 4))) : 0, startPx: 0 }
        const contentTop = lr.top - list.scrollTop
        const box = el => { const r = el.getBoundingClientRect(); return { top: r.top - contentTop, bottom: r.bottom - contentTop } }
        const hb = headers.map(box)
        const rb = rows.map(box)
        const view = list.clientHeight
        let best = { headerPx: -1 }
        for (const start of [...hb, ...rb].map(b => b.top)) {
          const end = start + view
          let px = 0, n = 0
          for (const b of hb) { const o = Math.max(0, Math.min(b.bottom, end) - Math.max(b.top, start)); if (o > 0) { px += o; n += 1 } }
          if (px > best.headerPx) {
            best = {
              startPx: Math.round(start), headerPx: Math.round(px), headersInView: n,
              headerPct: Math.round((px / view) * 1000) / 10,
              rowsFullyVisible: rb.filter(b => b.top >= start - 0.5 && b.bottom <= end + 0.5).length,
            }
          }
        }
        return best
      })(),
      headerText: headers.slice(0, 4).map(g => g.textContent.replace(/\s+/g, ' ').trim()),
      // The bucket BD-073 says must never vanish, on this list too.
      ungrouped: (() => {
        const g = list.querySelector('[data-testid="sc-group-__ungrouped__"]')
        return g ? g.textContent.replace(/\s+/g, ' ').trim() : null
      })(),
      firstRowText: rows.slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()),
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
    // S4 — the two things this slice ADDS to the frame, and both of them cost track 2 its height:
    // a second chip row in track 1, and a header per crop group inside the scroller.
    const zoneChips = [...document.querySelectorAll('[data-testid="sc-zone-chips"] button')]
    const cropChips = [...document.querySelectorAll('[data-testid="sc-crop-chips"] button')]
    const groupHeaders = [...list.querySelectorAll('[data-testid^="pick-group-"]')]
    const track1 = f.firstElementChild
    return {
      present: true,
      // TRACK 1's real height is the S4 number to watch: at 390x500 (keyboard up) whatever this
      // costs comes straight out of the candidate list, which is the thing being chosen from.
      track1H: h(track1),
      zoneChipCount: zoneChips.length,
      zoneChipH: zoneChips.length ? Math.min(...zoneChips.map(h)) : null,
      zoneChipRows: new Set(zoneChips.map(b => Math.round(b.getBoundingClientRect().top))).size,
      zoneChipLabels: zoneChips.map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      cropChipRows: new Set(cropChips.map(b => Math.round(b.getBoundingClientRect().top))).size,
      groupHeaderCount: groupHeaders.length,
      groupHeaderH: groupHeaders.length ? Math.min(...groupHeaders.map(h)) : null,
      groupHeaderText: groupHeaders.slice(0, 4).map(g => g.textContent.replace(/\s+/g, ' ').trim()),
      // The bucket BD-073 says must never vanish — asserted as PRESENT and as its own group.
      ungrouped: (() => {
        const g = list.querySelector('[data-testid="pick-group-__ungrouped__"]')
        return g ? g.textContent.replace(/\s+/g, ' ').trim() : null
      })(),
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
