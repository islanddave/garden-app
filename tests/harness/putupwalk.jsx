// V4-PUTUPSESSION-001 slice 0 — the freezer walk at Dave's real geometry.
//
// THE ONE QUESTION THIS EXISTS TO ANSWER: does the bag-count NumberPad clear the walk's fixed
// bottom band? The brief was explicit that the weigh-in's answer does not transfer — that pad lives
// in a fixed three-track grid over a band that grows 48 -> 184px, this one lives in ordinary
// document flow above a band whose height is measured at runtime. jsdom returns zeros from
// getBoundingClientRect (README:14-16), so no vitest file can answer it at any viewport.
//
// A REAL <nav aria-label="Main navigation"> is mounted below, not a stand-in div, because the walk
// suppresses the nav by a stylesheet rule matched on exactly that selector. A stand-in with a
// different tag would make the suppression untestable AND leave 56px of chrome under the band that
// the real app does not have — measuring a layout Dave never sees.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import PutUp from '../../src/pages/PutUp.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const LOCATIONS = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', label: 'Meat deep freezer', kind: 'deep_freezer' },
]
// The live vocabulary, trimmed to what the walk touches. Blueberry has exactly one planting on prod
// (48 harvests, 37.2 lb) — the auto-resolution case — and tomato has several.
const CROP_TYPES = [
  { slug: 'blueberry', display_name: 'Blueberries', category: 'fruit', sort_order: 1 },
  { slug: 'tomato', display_name: 'Tomato', category: 'vegetable', sort_order: 2 },
  { slug: 'cucumber', display_name: 'Cucumber', category: 'vegetable', sort_order: 3 },
]
const PLANTS = [
  { id: 'p-blue', name: 'Blueberries', sown_at: '2024-05-01', variety_ref: { id: 'v-blue', name: 'Blueberries', crop_type_slug: 'blueberry' } },
  { id: 'p-tom-1', name: 'Sungold', sown_at: '2026-04-02', succession_order: 1, variety_ref: { id: 'v-sg', name: 'Sungold', crop_type_slug: 'tomato' } },
  { id: 'p-tom-2', name: 'San Marzano', sown_at: '2026-04-20', succession_order: 2, variety_ref: { id: 'v-sm', name: 'San Marzano', crop_type_slug: 'tomato' } },
]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
window.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  if (u.includes('/api/varieties/crop-types')) return ok(CROP_TYPES)
  if (u.includes('/api/storage-locations')) return ok(LOCATIONS)
  if (u.includes('/api/plants')) return ok(PLANTS)
  if (u.includes('/api/harvests')) return ok({ aggregates: { crops: [{ crop_type_slug: 'watermelon', crop_name: 'Watermelon' }] } })
  if (u.includes('/api/preservation/whats-put-up')) return ok({ groups: [] })
  if (u.includes('/api/preservation') && method === 'POST') return ok({ id: `pl-${Math.round(performance.now())}`, source_kind: 'own_garden', crop_type_slug: 'blueberry' })
  return ok({})
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/put-up?session=putup']}>
    <PutUp />
    <nav aria-label="Main navigation"
      style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX,
        zIndex: 100, background: '#fff', borderTop: '1px solid #d4c9be', display: 'flex',
        alignItems: 'center', justifyContent: 'center', font: '10px ui-monospace, monospace', color: '#8a8a8a' }}>
      real BottomNav element ({BOTTOM_NAV_HEIGHT_PX}px) — the walk must hide this
    </nav>
  </MemoryRouter>,
)

// ── measurement API ────────────────────────────────────────────────────────────────────────────
const q = (sel) => document.querySelector(sel)
const byTid = (t) => document.querySelector(`[data-testid="${t}"]`)
const rect = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) }
}
const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
const settle = () => new Promise(r => setTimeout(r, 60))

// The whole point of the harness: does anything actually receive the tap at each key's centre, or
// does the band? elementFromPoint is the only honest answer — a rect comparison misses a key that
// is on screen but painted under something (BUG-WEIGHPADSAVEBAND-001 was found exactly this way).
function padKeyHits() {
  const keys = [...document.querySelectorAll('[data-testid^="pu-bagpad-"]')]
  return keys.map(k => {
    const r = k.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    return {
      key: k.dataset.testid.replace('pu-bagpad-', ''),
      top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width),
      selfHit: !!hit && (hit === k || k.contains(hit)),
      hitTestId: hit ? (hit.dataset?.testid || hit.tagName.toLowerCase()) : null,
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
    }
  })
}

async function enterWalk() {
  await settle()
  const freezer = [...document.querySelectorAll('[data-testid="putup-walk-freezer"]')][0]
  click(freezer)
  const when = [...document.querySelectorAll('[data-testid="putup-walk-date"]')][0]
  click(when)
  await settle()
  click(byTid('putup-walk-start'))
  await settle(); await settle()
  return !!q('#pu-crop')
}

async function pickCrop(slug) {
  const sel = q('#pu-crop')
  if (!sel) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, slug)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  await settle(); await settle()
  return sel.value === slug
}

window.__h = {
  // The host polls ready() then stringifies all(), synchronously — so the run has to be finished
  // before ready() flips. measure() is kicked off once below and parks its result here.
  ready: () => !!window.__measured,
  all: () => window.__measured,
  enterWalk,
  pickCrop,
  padKeyHits,
  // The clearance question, answered three ways in one object so a partial pass cannot read as a
  // pass: the band's own geometry, the pad's keys under hit-testing, and the scroll headroom that
  // makes the pad reachable at all.
  // `?saved=1` measures the band at its TALLEST — once an item lands it grows a saved line and an
  // Undo. Measuring only the empty band would certify a clearance that stops holding on save 1 of
  // 60, which is the shape of BUG-WEIGHPADSAVEBAND-001 (a band that grew 48 -> 184px).
  async measure() {
    const started = !!q('#pu-crop') || await enterWalk()
    if (!started) return { error: 'could not enter the walk' }
    await pickCrop('blueberry')
    if (new URLSearchParams(location.search).get('saved') === '1') {
      const qty = q('#pu-qty')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(qty, '1')
      qty.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      click([...document.querySelectorAll('button[type="submit"]')][0])
      await settle(); await settle(); await settle()
    }
    const pad = q('[aria-label="How many bags or jars"][role="group"]')
    if (pad) pad.scrollIntoView({ block: 'end' })
    await settle()
    const band = byTid('putup-walk-band')
    const bandR = rect(band)
    const keys = padKeyHits()
    const lowest = keys.reduce((m, k) => Math.max(m, k.bottom), -Infinity)
    const scroller = document.scrollingElement
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      navSuppressed: !!document.getElementById('putup-walk-nav-suppress'),
      navVisibility: getComputedStyle(q('nav[aria-label="Main navigation"]')).visibility,
      bottomNavVar: document.documentElement.style.getPropertyValue('--bottom-nav-height'),
      band: bandR,
      bandCoversViewportPct: bandR ? Math.round((bandR.height / window.innerHeight) * 1000) / 10 : null,
      pad: rect(pad),
      padLowestKeyBottom: lowest,
      // POSITIVE = the pad's lowest key ends this many px ABOVE the band's top edge.
      clearancePx: bandR ? bandR.top - lowest : null,
      keysUnderBand: keys.filter(k => !k.selfHit).map(k => ({ key: k.key, hit: k.hitTestId })),
      allKeysTappable: keys.every(k => k.selfHit),
      keys,
      // Can the page scroll far enough that the pad is never trapped under the band?
      scrollHeight: scroller.scrollHeight,
      scrollTop: Math.round(scroller.scrollTop),
      maxScrollTop: Math.round(scroller.scrollHeight - window.innerHeight),
      autoPlantingLine: byTid('pu-auto-planting')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      saveButton: rect([...document.querySelectorAll('button[type="submit"]')][0]),
    }
  },
}

// Auto-run once so a --dump-dom driver (no Browser pane needed) gets a finished number rather than a
// pending promise. Re-runnable by hand: `__measured = null; __h.measure().then(v => __measured = v)`.
window.__measured = null
setTimeout(() => {
  // `?stage=setup` parks on the pre-flight screen instead — the two session questions and the
  // offline gate are their own thing to look at, and measure() walks straight past them.
  if (new URLSearchParams(location.search).get('stage') === 'setup') {
    window.__measured = { stage: 'setup', innerWidth: window.innerWidth, innerHeight: window.innerHeight }
    return
  }
  window.__h.measure().then(
    (v) => { window.__measured = v },
    (e) => { window.__measured = { error: String(e) } },
  )
}, 250)
