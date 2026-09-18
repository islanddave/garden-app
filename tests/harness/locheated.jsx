// V5-LOCHEATEDUI-001 — the Locations edit form's Heated checkbox, in a real browser at phone width.
//
// Locations.heated.test.jsx proves the coupling and the save body; jsdom has no layout, so it cannot
// say whether the new row fits a 390px screen, whether its tap target is really 44px tall, or whether
// the hint is painted. This entry answers those.
//
//   ?row=house|stable|bagarea   whose edit form to open (House heated+covered, Stable covered,
//                               Bag Area open to the sky)
//   &act=tick|untick|opensky    a gesture to apply once the form is open
//
// Host it in an iframe for a true narrow viewport — a headless window cannot go below ~500px and
// crops instead (memory: garden-app-browser-harness). plantingphotosheet.viewport.html takes
// ?page=locheated.html and reads __h.all() into its #out node.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Locations from '../../src/pages/Locations.jsx'

const q = new URLSearchParams(location.search)
const ROW = q.get('row') || 'house'
const ACT = q.get('act') || ''

const LOCATIONS = [
  { id: 'l-house', name: 'House', slug: 'house', level: 0, type_label: 'zone', parent_id: null, sort_order: 0, description: null, is_active: true, covered: true, heated: true },
  { id: 'l-stable', name: 'Stable', slug: 'stable', level: 0, type_label: 'zone', parent_id: null, sort_order: 1, description: 'the old horse barn', is_active: true, covered: true, heated: false },
  { id: 'l-bag', name: 'Bag Area', slug: 'bag-area', level: 0, type_label: 'area', parent_id: null, sort_order: 2, description: null, is_active: true, covered: false, heated: false },
]
const ROW_INDEX = { house: 0, stable: 1, bagarea: 2 }

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = {}
  if (path === '/api/locations') body = { locations: LOCATIONS }
  else if (path === '/api/locations/with-path') body = []
  await new Promise(r => setTimeout(r, 30))          // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/locations']}><Locations /></MemoryRouter>,
)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const box = () => document.getElementById('inline-edit-heated')
const cover = () => document.getElementById('inline-edit-covered')
let staged = false

// Open the row's edit form, then apply the gesture. Same menu mechanics as iconwire3.jsx: the
// wrapper stops propagation, so the opening click does not immediately close the menu.
async function stage() {
  for (let i = 0; i < 100 && document.querySelectorAll('[aria-label="Actions"]').length < 3; i++) await sleep(50)
  document.querySelectorAll('[aria-label="Actions"]')[ROW_INDEX[ROW] ?? 0]?.click()
  await sleep(50)
  ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit')?.click()
  for (let i = 0; i < 100 && !box(); i++) await sleep(50)
  if (ACT === 'tick' && !box().checked) box().click()
  if (ACT === 'untick' && box().checked) box().click()
  if (ACT === 'opensky') {
    cover().value = 'false'
    cover().dispatchEvent(new Event('change', { bubbles: true }))
  }
  await sleep(100)
  box()?.closest('label')?.scrollIntoView({ block: 'center' })
  await sleep(100)
  staged = true
}
stage()

const vis = (el) => !!el && el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })
const rect = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
}

window.__h = {
  error: () => firstError,
  ready: () => staged,
  all() {
    const vw = window.innerWidth
    const b = box()
    const label = b?.closest('label')
    const hint = b ? document.getElementById(b.getAttribute('aria-describedby')) : null
    const lr = label?.getBoundingClientRect()
    // Tap sanity: the centre of the label row must hit the label or the checkbox, not something
    // painted over it.
    const hit = lr ? document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2) : null
    return {
      row: ROW, act: ACT,
      vw, scrollW: document.documentElement.scrollWidth,
      hscroll: document.documentElement.scrollWidth > vw,
      heatedChecked: b?.checked ?? null,
      cover: cover()?.value ?? null,
      checkbox: rect(b), labelRow: rect(label), hint: rect(hint),
      labelText: label?.textContent.trim() ?? null,
      hintText: hint?.textContent.trim() ?? null,
      checkboxVisible: vis(b), hintVisible: vis(hint),
      labelRowFits: !!lr && lr.left >= -0.5 && lr.right <= vw + 0.5,
      hintFits: !!hint && hint.getBoundingClientRect().right <= vw + 0.5,
      tapTargetOk: !!lr && lr.height >= 44,
      centreHitsControl: !!hit && (hit === label || hit === b || label.contains(hit)),
      error: firstError,
    }
  },
}

// Live verdict strip, burned into the capture so the screenshot is self-evidencing.
let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  if (el && staged) {
    const a = window.__h.all()
    const ok = !a.hscroll && a.tapTargetOk && a.labelRowFits && a.hintFits && a.hintVisible && a.centreHitsControl && !a.error
    el.style.background = ok ? '#2d6a2d' : '#a33'
    el.textContent =
      `vw ${a.vw} · scrollW ${a.scrollW} · hscroll ${a.hscroll ? 'YES' : 'no'} · row=${a.row}${a.act ? ' act=' + a.act : ''}\n` +
      `Heated ${a.heatedChecked ? 'ON' : 'off'} · Rain shelter=${a.cover || 'not set'} · label row ${a.labelRow?.h}px` +
      ` · fits ${a.labelRowFits ? 'yes' : 'NO'} · tap ${a.centreHitsControl ? 'hits' : 'MISSES'}${a.error ? ' · ERR ' + a.error : ''}`
  }
  if (++ticks < 400) setTimeout(paint, 100)
}
paint()
