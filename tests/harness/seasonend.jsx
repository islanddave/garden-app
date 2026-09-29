// V5-SEASONEND-001 — real-browser look at /season-end at Dave's geometry (426x836).
//
// jsdom proves the list rule, the ticks, the PUT bodies and the confirm copy; it cannot show whether
// a thumb, a name, a status badge, a "Last logged" line and a tick box fit a 426px row, or whether
// the sticky bar actually sits ABOVE the tab bar. That bar is `position: fixed` at
// `bottom: var(--bottom-nav-height)`, and that variable is written by BottomNav's own layout effect
// — so the REAL BottomNav is mounted here (the navcustom.jsx chain: AuthProvider with Clerk stubbed
// by the harness config → PrefsProvider → NavPrefsProvider → BottomNav). A stand-in <nav> would not
// write the variable and the bar would measure against 0px.
//
// App chrome copied from App.jsx: TopChrome is a sticky 52px bar (TopChrome.jsx BAR_H) — a stand-in
// with the real height, like seeds.jsx — and the route sits in App.jsx's column wrapper, whose bottom
// padding reserves the nav.
//
// Fixture: prod's shape scaled down — finished rows in six outdoor locations, Bag Area the biggest
// and carrying the longest names; the still-growing group with a petunia (a light-frost crop whose
// crop is a tender perennial, listed since the integration fix) beside kale and lettuce; plus two
// rows that must NOT be listed (a tomato under the covered Stable, a hardy perennial).
//
// ?step=list (default) | ticked (Bag Area open, 2 rows ticked) | confirm (ticked + the confirm sheet
// open) | still (the still-growing group open, the petunia ticked). Measurements: window.__h.measure().
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ModeProvider } from '../../src/context/ModeContext.jsx'
import { PrefsProvider } from '../../src/context/PrefsContext.jsx'
import { NavPrefsProvider } from '../../src/context/NavPrefsContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import BottomNav from '../../src/components/BottomNav.jsx'
import SeasonEnd from '../../src/pages/SeasonEnd.jsx'

const TOP_CHROME_PX = 52

const LOCATIONS = [
  { id: 'pasture', name: 'Pasture', parent_id: null, covered: false, heated: false },
  { id: 'bag', name: 'Bag Area', parent_id: 'pasture', covered: false, heated: false },
  { id: 'trough', name: 'Trough', parent_id: null, covered: false, heated: false },
  { id: 'inground', name: 'In-Ground', parent_id: null, covered: false, heated: false },
  { id: 'driveshade', name: 'Drive-Shade', parent_id: null, covered: false, heated: false },
  { id: 'deck', name: 'Deck', parent_id: null, covered: false, heated: false },
  { id: 'drive', name: 'Drive', parent_id: null, covered: false, heated: false },
  { id: 'stable', name: 'Stable', parent_id: null, covered: true, heated: false },
]
const THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6a994e"/><circle cx="48" cy="52" r="26" fill="#bc4749"/></svg>')
// [name, crop slug, location, status, crop lifecycle, last logged]
const RAW = [
  ['Jamaican Yellow Mushroom', 'pepper', 'bag', 'fruiting', 'tender_perennial', '2026-09-27T21:30:00Z'],
  ['Ristra Cayenne II', 'pepper', 'bag', 'harvested', 'tender_perennial', '2026-09-21T14:00:00Z'],
  ['Biquinho Yellow F1', 'pepper', 'bag', 'fruiting', 'tender_perennial', '2026-09-26T16:00:00Z'],
  ['Hot Portugal', 'pepper', 'bag', 'fruiting', 'tender_perennial', '2026-09-25T12:00:00Z'],
  ['San Marzano Roma (paste, indeterminate)', 'tomato', 'bag', 'vegetative', 'tender_perennial', '2025-09-26T16:00:00Z'],
  ['Moskvich', 'tomato', 'bag', 'flowering', 'tender_perennial', null],
  ['Aji Amarillo', 'pepper', 'bag', 'fruiting', 'tender_perennial', '2026-09-28T01:10:00Z'],
  ['Genovese', 'basil', 'trough', 'vegetative', 'annual', '2026-09-20T16:00:00Z'],
  ['Suyo Long', 'cucumber', 'inground', 'fruiting', 'annual', '2026-09-24T16:00:00Z'],
  ['Zephyr', 'squash', 'inground', 'harvested', 'annual', '2026-09-19T16:00:00Z'],
  ['Pinto Gordo', 'bean', 'driveshade', 'harvested', 'annual', '2026-09-10T16:00:00Z'],
  ['Martha Washington', 'geranium', 'deck', 'flowering', 'tender_perennial', '2026-09-22T16:00:00Z'],
  ['Sungold', 'tomato', 'drive', 'fruiting', 'tender_perennial', '2026-09-27T16:00:00Z'],
  // Still growing through frost.
  ['Lacinato', 'kale', 'bag', 'vegetative', 'biennial', '2026-09-26T16:00:00Z'],
  ['Buttercrunch', 'lettuce', 'trough', 'vegetative', 'annual', '2026-09-23T16:00:00Z'],
  ['Wave Purple', 'petunia', 'deck', 'flowering', 'tender_perennial', '2026-09-18T16:00:00Z'],
  // Never listed.
  ['Shelf Tomato', 'tomato', 'stable', 'fruiting', 'tender_perennial', '2026-09-27T16:00:00Z'],
  ['Chives', 'chives', 'bag', 'vegetative', 'perennial', '2026-09-27T16:00:00Z'],
]
const plants = RAW.map(([name, slug, loc, status, lifecycle, logged], i) => ({
  id: `p-${i}`, name, status, kind: 'planting', location_id: loc, project_id: null,
  variety_ref: { name, crop_type_slug: slug, default_lifecycle: lifecycle },
  last_logged_at: logged,
  featured_photo_id: i % 3 === 0 ? `ph-${i}` : null,
  featured_photo_view_url: i % 3 === 0 ? THUMB : null,
  featured_photo_thumb_url: i % 3 === 0 ? THUMB : null,
}))

// A first launch on this device: the server's (default) bar layout, no pins.
for (const k of ['nav.barLayout.v1', 'nav.morePins.v1', 'nav.morePins.pending.v1']) localStorage.removeItem(k)

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.__puts = []
window.fetch = async (input, init = {}) => {
  const url = new URL(String(typeof input === 'string' ? input : input?.url ?? ''), location.origin)
  const method = init.method ?? 'GET'
  if (url.pathname === '/api/plants/season-end' && method === 'GET') return json({ plants })
  if (url.pathname === '/api/locations' && method === 'GET') return json({ locations: LOCATIONS, locations_with_path: [] })
  if (url.pathname.endsWith('/api/notifications/prefs')) return json({ critter_visit: 'in_app_only', more_pins: null, bar_layout: null, can_edit_bar: false })
  if (url.pathname.endsWith('/api/critters/active')) return json([])
  const m = /^\/api\/plants\/([^/]+)$/.exec(url.pathname)
  if (m && method === 'PUT') {
    window.__puts.push({ id: m[1], body: JSON.parse(init.body) })
    return json({ id: m[1] })
  }
  return realFetch(input, init)
}

const byTid = (t) => document.querySelector(`[data-testid="${t}"]`)
const later = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el && el.click()
const groupToggle = (label) => [...document.querySelectorAll('[data-testid="season-end-group"]')]
  .find((g) => g.getAttribute('data-group') === label)?.querySelector('button[aria-expanded]')
const rect = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }
}

window.__h = {
  ready: () => !!byTid('season-end-list'),
  async drive(step) {
    if (step === 'ticked' || step === 'confirm') {
      click(groupToggle('Bag Area'))
      await later(50)
      const rows = [...document.querySelectorAll('[data-testid="season-end-row"]')]
      click(rows[0]); await later(30)
      click(rows[1]); await later(30)
    }
    if (step === 'confirm') {
      click(byTid('season-end-open-confirm'))
      await later(400)
    }
    if (step === 'still') {
      click(byTid('season-end-still-growing-group')?.querySelector('button[aria-expanded]'))
      await later(50)
      click([...document.querySelectorAll('[data-testid="season-end-row"]')].find((r) => r.textContent.includes('Wave Purple')))
    }
    await later(300)
  },
  measure() {
    const nav = document.querySelector('nav[aria-label="Main navigation"]')
    const bar = byTid('season-end-bar')
    const dialog = document.querySelector('[role="dialog"]')
    const top = document.querySelector('[data-app-chrome="top"]')
    const navR = rect(nav)
    const barR = rect(bar)
    const topR = rect(top)
    // Every control the page, its bar and its sheet draw (the tab bar has its own harness).
    const controls = [...document.querySelectorAll(
      '[data-harness-page] button, [data-harness-page] a, [role="dialog"] button, [role="dialog"] a')]
      .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const contentFloor = Math.min(barR?.top ?? Infinity, navR?.top ?? Infinity, innerHeight)
    const blocked = []
    const offscreen = []
    for (const c of controls) {
      const r = c.getBoundingClientRect()
      const inDialog = !!dialog && dialog.contains(c)
      const inBar = !!bar && bar.contains(c)
      if (r.left < 0 || r.right > innerWidth + 0.5) offscreen.push(c.textContent.trim().slice(0, 40))
      if (dialog && !inDialog) continue                 // behind the sheet's backdrop, by design
      if (!inDialog && !inBar && (r.top < (topR?.bottom ?? 0) || r.bottom > contentFloor)) continue // scrolled under chrome
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!c.contains(hit)) blocked.push({ control: c.textContent.trim().slice(0, 40), hit: `${hit?.tagName}${hit?.getAttribute('data-testid') ? '#' + hit.getAttribute('data-testid') : ''}` })
    }
    const heights = controls.map((c) => ({ t: c.textContent.trim().slice(0, 30), h: Math.round(c.getBoundingClientRect().height) }))
    const under48 = heights.filter((x) => x.h < 48)
    // Scroll to the end: the last thing in the list must clear the bar (the column's bottom pad).
    const list = byTid('season-end-list')
    let endClearance = null
    if (bar && list && !dialog) {
      const y = scrollY
      scrollTo(0, document.documentElement.scrollHeight)
      endClearance = Math.round(bar.getBoundingClientRect().top - list.getBoundingClientRect().bottom)
      scrollTo(0, y)
    }
    return {
      innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth,
      hscroll: document.documentElement.scrollWidth > innerWidth,
      nav: navR, bar: barR, topChrome: topR,
      navHeightVar: getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height').trim(),
      barAboveNav: barR && navR ? barR.bottom <= navR.top + 0.5 : null,
      dialog: rect(dialog),
      dialogInView: dialog ? (() => { const r = dialog.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5 })() : null,
      groups: [...document.querySelectorAll('[data-testid="season-end-group"]')].map((g) => g.getAttribute('data-group')),
      stillGrowing: byTid('season-end-still-growing-group')?.querySelector('button[aria-expanded]')?.textContent,
      rows: [...document.querySelectorAll('[data-testid="season-end-row"]')].map((r) => `${r.getAttribute('aria-checked') === 'true' ? '[x]' : '[ ]'} ${r.textContent}`),
      barText: bar?.textContent ?? null,
      dialogText: dialog?.textContent ?? null,
      controls: controls.length, minControlHeight: Math.min(...heights.map((x) => x.h)), under48,
      blocked, offscreen, endClearance,
      puts: window.__puts,
    }
  },
}

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ModeProvider>
      <MemoryRouter initialEntries={['/season-end']}>
        <PrefsProvider>
          <NavPrefsProvider>
            <ToastProvider>
              {/* TopChrome's box, exactly: sticky, BAR_H tall, border-box, above the route (App.jsx). */}
              <header data-app-chrome="top"
                style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
                  background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', alignItems: 'center',
                  padding: '0 14px', font: '10px ui-monospace, monospace', color: '#8a8a8a' }}>
                TopChrome stand-in ({TOP_CHROME_PX}px)
              </header>
              {/* App.jsx's column wrapper for a signed-in user. */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh',
                paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
                <div style={{ flex: 1 }} data-harness-page>
                  <SeasonEnd />
                </div>
              </div>
              <BottomNav />
            </ToastProvider>
          </NavPrefsProvider>
        </PrefsProvider>
      </MemoryRouter>
    </ModeProvider>
  </AuthProvider>
)
