// V4-ICON-001 slice 3 — real-browser render of the two surfaces this lane rewires.
//
// Why this entry exists: iconWire3.test.jsx proves the right registry entry is MOUNTED, but jsdom
// has no layout engine and no font stack, so it cannot answer the question the swap actually
// raises — an emoji is a text glyph on the text baseline, and an inline SVG is a replaced box.
// Every site changed here sets its own alignment (flex row on the two headings, verticalAlign on
// the in-sentence heart, flex on the menu rows), and whether those land is a rendering question.
//
// Separate entry per the established pattern in this directory, so nothing in the other harness
// entries moves. `?surface=favorites|favorites-empty|locations` picks the page; the shot script
// visits all three. `favorites-empty` is not padding: the empty state is the one place an icon
// sits INSIDE a sentence rather than in its own flex slot, which makes it the riskiest alignment
// of the three and the only one carrying an announced (non-decorative) name.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Favorites from '../../src/pages/Favorites.jsx'
import Locations from '../../src/pages/Locations.jsx'

const SURFACE = new URLSearchParams(location.search).get('surface') || 'favorites'

// One favourite per surviving section. PROJECTS_HIDDEN is true, so a `project` favourite would be
// dropped by the page — included anyway to prove the suppression still holds after the rewire.
const FAVORITES = [
  { entity_type: 'plant', entity_id: 'p1' },
  { entity_type: 'project', entity_id: 'j1' },
  { entity_type: 'location', entity_id: 'l1' },
  { entity_type: 'inventory_item', entity_id: 'i1' },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold Cherry Tomato', variety: 'Sungold', status: 'fruiting' },
]
const INVENTORY = [
  { id: 'i1', name: 'Pro-Mix HP Mycorrhizae 3.8cf', status: 'active' },
]
// A three-level tree, so the action menu opens on a row that has children to add to and the
// level accents are visible in the same frame.
const LOCATIONS = [
  { id: 'l1', name: 'Stable', slug: 'stable', level: 0, type_label: 'Zone', parent_id: null, sort_order: 0, description: null, is_active: true },
  { id: 'l2', name: 'South Beds', slug: 'south-beds', level: 1, type_label: 'Area', parent_id: 'l1', sort_order: 0, description: null, is_active: true },
  { id: 'l3', name: 'Bed 3', slug: 'bed-3', level: 2, type_label: 'Section', parent_id: 'l2', sort_order: 0, description: null, is_active: false },
]

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path.startsWith('/api/favorites')) body = SURFACE === 'favorites-empty' ? [] : FAVORITES
  else if (path.startsWith('/api/plants')) body = PLANTS
  else if (path.startsWith('/api/inventory-items')) body = INVENTORY
  else if (path === '/api/locations') body = { locations: LOCATIONS }
  else if (path === '/api/locations/with-path') body = { locations_with_path: [] }
  await new Promise(r => setTimeout(r, 30))          // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

const Page = SURFACE === 'locations' ? Locations : Favorites
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[SURFACE === 'locations' ? '/locations' : '/favorites']}>
    <Page />
  </MemoryRouter>,
)

// Measurements burned into the page so the screenshot is self-evidencing rather than trusted.
const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu

window.__h = {
  surface: () => SURFACE,
  error: () => firstError,
  ready: () => SURFACE === 'locations'
    ? document.querySelectorAll('[aria-label="Actions"]').length > 0
    : SURFACE === 'favorites-empty'
      ? /No favorites yet/.test(document.body.textContent)
      : document.querySelectorAll('h2').length > 0,

  // Opens the Locations action menu. The page closes the menu on any document click, but the
  // wrapper stops propagation and the listener is only attached on the following effect pass, so
  // the opening click does not immediately close it.
  openMenu() {
    const btn = document.querySelector('[aria-label="Actions"]')
    if (btn) btn.click()
    return document.querySelectorAll('[aria-label="Actions"]').length
  },

  // The whole point of the swap: an SVG in a text run must sit ON the line, not float above or
  // drop below it. Measured as the gap between each icon's vertical centre and the centre of the
  // text it shares a line with — jsdom reports 0 for every rect involved.
  //
  // The REFERENCE RECT is the subtle part, and getting it wrong invents failures. For an icon in
  // its own flex slot (the two headings) the parent's box IS the line. For an icon sitting inside
  // a sentence (the empty state) the parent is a 40px-padded multi-line block whose centre is
  // nowhere near the line the icon is on, so comparing against it would report a ~30px skew on
  // perfectly-aligned markup. There, the honest reference is the LAST client rect of the nearest
  // preceding non-blank text node — i.e. the line the icon actually continues.
  icons() {
    const vw = window.innerWidth
    const lineRect = (svg) => {
      let prev = svg.previousSibling
      while (prev && !(prev.nodeType === 3 && prev.textContent.trim())) prev = prev.previousSibling
      if (prev) {
        const range = document.createRange()
        range.selectNodeContents(prev)
        const rects = [...range.getClientRects()]
        if (rects.length) return rects[rects.length - 1]
      }
      return svg.parentElement ? svg.parentElement.getBoundingClientRect() : svg.getBoundingClientRect()
    }
    return [...document.querySelectorAll('svg')].map(svg => {
      const r = svg.getBoundingClientRect()
      const host = svg.parentElement
      const hr = lineRect(svg)
      return {
        label: (host?.textContent || svg.getAttribute('aria-label') || '?').trim().slice(0, 24),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        // Positive = icon centre sits BELOW the line's centre, negative = above.
        baselineSkew: +((r.top + r.height / 2) - (hr.top + hr.height / 2)).toFixed(1),
        fits: r.left >= -0.5 && r.right <= vw + 0.5,
        visible: svg.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        named: svg.getAttribute('aria-label'),
        hidden: svg.getAttribute('aria-hidden') === 'true',
      }
    })
  },

  // No glyph may be the ONLY thing in its row: every icon here is paired with text.
  textOf: (sel) => [...document.querySelectorAll(sel)].map(e => e.textContent.trim()),
  pictographic: () => document.body.textContent.match(PICTOGRAPHIC) ?? [],
  docOverflows: () => document.documentElement.scrollWidth > window.innerWidth,
}

// Live verdict strip, same pattern as inventory.jsx / careneeded.jsx.
let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  if (!window.__h.ready()) { el.textContent = 'booting…'; if (++ticks < 20) setTimeout(paint, 200); return }
  const icons = window.__h.icons()
  const emoji = window.__h.pictographic()
  const skewed = icons.filter(i => Math.abs(i.baselineSkew) > 3)
  const ok = !firstError && !emoji.length && !skewed.length && !window.__h.docOverflows()
  el.style.background = ok ? '#2d6a4f' : '#a4161a'
  el.textContent = firstError
    ? 'ERROR: ' + firstError
    : `${SURFACE} @${window.innerWidth}px · ${icons.length} svg · `
      + (emoji.length ? 'EMOJI LEFT: ' + emoji.join('') : 'no emoji')
      + ' · ' + (skewed.length ? 'OFF-BASELINE: ' + skewed.map(s => `${s.label}(${s.baselineSkew})`).join(', ')
                               : 'all icons on the line')
  if (++ticks < 24) setTimeout(paint, 250)
}
setTimeout(paint, 200)
