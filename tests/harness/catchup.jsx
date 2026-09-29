// V5-PLANTSTARTDATES-001 — real-browser look at /plants/catch-up at Dave's geometry (426x836).
//
// jsdom proves the rows, the PUT bodies and the 48px inline min-heights; it cannot show whether a
// thumb, a two-line title block, two half-width month pickers and a Save + note line actually fit a
// 426px column without overlap or horizontal scroll. That is the one question this entry answers.
//
// Fixture: the eight plantings named by the V5-PLANTSTARTDATES-001 ledger row (neither start date on
// prod), spread over nested, flat and missing locations; plus two that must NOT be listed.
// `?step=saved` drives three rows after mount: one saved, one whose PUT fails, one out of order.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import PlantsCatchUp from '../../src/pages/PlantsCatchUp.jsx'

const LOCATIONS = [
  { id: 'loc-drive', name: 'Drive', parent_id: null, sort_order: 1 },
  { id: 'loc-bed', name: 'Raised bed 2', parent_id: 'loc-drive', sort_order: 0 },
  { id: 'loc-stable', name: 'Stable', parent_id: null, sort_order: 2 },
]
const RAW = [
  ['King of the North', 'pepper', 'loc-bed', 'fruiting'],
  ['Purple Tiger', 'pepper', 'loc-bed', 'fruiting'],
  ['Biquinho Yellow F1', 'pepper', 'loc-stable', 'fruiting'],
  ['Emerald Green', 'pepper', 'loc-stable', 'ended'],
  ['Piquin', 'pepper', 'loc-stable', 'fruiting'],
  ['Palmetto Punch', 'pepper', null, 'fruiting'],
  ['Sweet Chocolate', 'pepper', null, 'fruiting'],
  ['Black Krim', 'tomato', 'loc-bed', 'ended'],
]
const THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6a994e"/><circle cx="48" cy="52" r="26" fill="#bc4749"/></svg>')
const plants = [
  ...RAW.map(([name, crop, loc, status], i) => ({
    id: `p-${i}`, name, status, location_id: loc, created_at: '2026-03-01T15:00:00Z',
    sown_at: null, planted_out_at: null,
    featured_photo_id: i % 3 === 0 ? `ph-${i}` : null,
    featured_photo_view_url: i % 3 === 0 ? THUMB : null,
    featured_photo_thumb_url: i % 3 === 0 ? THUMB : null,
    variety_ref: { name, crop_type_slug: crop },
  })),
  { id: 'p-dated', name: 'Has a sown date', status: 'fruiting', location_id: 'loc-bed', sown_at: '2026-02-20', planted_out_at: null },
  { id: 'p-out', name: 'Has a planted-out date', status: 'fruiting', location_id: 'loc-bed', sown_at: null, planted_out_at: '2026-05-18' },
]

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.__puts = []
window.fetch = async (input, init = {}) => {
  const url = new URL(String(typeof input === 'string' ? input : input?.url ?? ''), location.origin)
  const method = init.method ?? 'GET'
  if (url.pathname === '/api/plants' && method === 'GET') return json(plants)
  if (url.pathname === '/api/locations' && method === 'GET') return json(LOCATIONS)
  const m = /^\/api\/plants\/([^/]+)$/.exec(url.pathname)
  if (m && method === 'PUT') {
    window.__puts.push({ id: m[1], body: JSON.parse(init.body) })
    return m[1] === 'p-4' ? json({ error: 'boom' }, 500) : json({ id: m[1] })
  }
  return realFetch(input, init)
}

// Controlled <select>: set through the native setter so React sees the change.
function choose(select, value) {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  set.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
const rowById = (id) => document.querySelector(`[data-planting-id="${id}"]`)
const later = (ms) => new Promise(r => setTimeout(r, ms))

window.__h = {
  ready: () => document.querySelectorAll('[data-testid="catchup-row"]').length > 0,
  async drive() {
    choose(rowById('p-0').querySelector('select[id$="-sown"]'), '2026-02')
    await later(50)
    rowById('p-0').querySelector('button').click()
    choose(rowById('p-4').querySelector('select[id$="-out"]'), '2026-05')
    await later(50)
    rowById('p-4').querySelector('button').click()
    choose(rowById('p-2').querySelector('select[id$="-sown"]'), '2026-05')
    choose(rowById('p-2').querySelector('select[id$="-out"]'), '2026-04')
    await later(300)
  },
  measure() {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
    const controls = [...document.querySelectorAll('[data-testid="catchup-row"] select, [data-testid="catchup-row"] button')]
    const overlaps = []
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect()
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push([i, j])
    }
    return {
      innerWidth, scrollWidth: document.documentElement.scrollWidth, hscroll: document.documentElement.scrollWidth > innerWidth,
      rows: document.querySelectorAll('[data-testid="catchup-row"]').length,
      header: document.querySelector('[data-testid="catchup-header"]')?.textContent,
      groups: [...document.querySelectorAll('[data-testid="catchup-group"]')].map(g => g.getAttribute('aria-label')),
      minControlHeight: Math.min(...controls.map(c => c.getBoundingClientRect().height)),
      overlaps, firstRow: [...rowById('p-0').querySelectorAll('select, button')].map(rect),
      notes: [...document.querySelectorAll('[data-testid="catchup-row-note"]')].map(n => n.textContent).filter(Boolean),
      puts: window.__puts,
    }
  },
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter><PlantsCatchUp /></MemoryRouter>
)
