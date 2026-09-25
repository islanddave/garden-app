// BUG-DETAILPAGESCARRYSCROLL-001 — MEASUREMENT entry (not a gate): does a page opened from a SCROLLED page
// land part-way down? Driven by tests/harness/detailscroll.measure.mjs, framed by viewport.html
// (?page=detailscroll.html&vw=426&vh=836).
//
// The claim under test (recon-lotpage-opens-at-form.md, measured for InventoryDetail only): the app's
// declarative <BrowserRouter> never resets window scroll on a push, so the previous page's offset rides
// through the arriving page's one-screen loading shell (clamped) and Chrome's scroll anchoring re-applies
// it when the content lands. This entry puts the OTHER pages that have no reset of their own behind the
// same doors Dave uses, so the landing offset can be read per page.
//
// WHAT IS REAL: every arriving page (EventDetail, PlantingDetail, LocationDetail, Locations, Inventory,
// Dashboard, Harvests, Achievements, ReleaseNotes, About) and the two real in-page doors (PlantingDetail's
// Event log rows → /events/:id, the Locations list's name links → /locations/:id), under BrowserRouter —
// every entry carries react-router's {usr, key, idx} as prod's does and Back is a real popstate. App.jsx's
// shell: a sticky top bar of TopChrome's BAR_H, the flex column minHeight 100dvh whose paddingBottom reserves
// --bottom-nav-height, the page tree rendered at the OverlayProvider's pageLocation, and a fixed nav of
// BOTTOM_NAV_HEIGHT_PX that writes that variable in a layout effect as BottomNav does. The providers are
// App.jsx's (Auth on the Clerk stub, Mode, Favorites, Toast, DismissRegistry, Overlay).
//
// THE DOORS, as BottomNav builds them:
//   tab   — a plain <Link> in the nav (BottomNav's tab links): a PUSH. Harvests and Today are on the bar.
//   More  — an ARMED Sheet (armsBack pushes a Back marker) whose rows are real SheetRowLinks: on tap the row
//           REPLACE-navigates into the marker's slot (SheetRowLink.jsx). A new entry key either way.
//   row   — a <Link> in a long list stand-in (/deep), one row per target, repeated down the page: a PUSH from
//           a scrolled page with no other variable. The list is a stand-in because the source page's
//           nodes are all removed by the swap; only the shell is common to both sides.
//
// WHAT IS A STAND-IN: /today (links in, so every source is itself a push) and /deep (above). Nothing else.
// TodayBand is off in prod (TODAY_BAND_HIDDEN), so --today-band-height is unset, as there.
//
// THE NETWORK is stubbed at window.fetch WITH LATENCY (every page's own data answers after ?ms=, 300 by
// default), so each page paints its loading state first, as on a phone against a real Lambda. Anything the
// fixture does not know answers [] after 20ms and is listed by __h.unstubbed(). /releases.json is the
// repo's real public file, delayed the same way.
//
//   http://localhost:5397/tests/harness/viewport.html?page=detailscroll.html&vw=426&vh=836
//     ms=300         latency of each page's own GETs
//     topbar=52      the top-bar stand-in's height (TopChrome's BAR_H)
//     anchor=none    MECHANISM CHECK: * { overflow-anchor: none !important } — scroll anchoring off
//     locphotos=12   photos in the zone's gallery (LocationDetail)
//     event=rich     every event detail carries 9 photos, a long note, a private note and Details rows,
//                    so EventDetail is taller than one screen (the default event fits in one)
//     reset=entry    MECHANISM CHECK of a fix shape, in THIS shell only (src/ untouched): one app-level
//                    window.scrollTo(0, 0) when the PAGE's history entry changes by PUSH/REPLACE (the page
//                    entry is the overlay's background while one is open — pageEntry.js's rule), never on POP
//     reset=location the naive variant: the same reset keyed on the REAL location's key (ignores overlays)
//     reset=both     reset=entry PLUS an app-level restore on POP: the offset is filed per page entry while
//                    that entry is current, and a POP re-applies it with a per-frame retry until reached (the
//                    Garden.jsx restore-driver idea), history.scrollRestoration = 'manual'
//
// THE OVERLAY: header Search is a real OverlayLink to /search, hosted by a copy of App.jsx's OverlayHost in
// the overlay tree (seedsscroll.jsx's copy); only the Search page inside it is a stand-in, whose result
// rows are plain <Link>s as Search.jsx's Row renders them — the everyday "Search → a result" door.
//
// EVERY LOAD IS A FIRST VISIT: sessionStorage is cleared before anything mounts (useScrollRestore's store).
import React, { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigationType } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ModeProvider } from '../../src/context/ModeContext.jsx'
import { FavoritesProvider } from '../../src/context/FavoritesContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import {
  OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss, OverlaySurfaceProvider, OverlayDirtyProvider,
} from '../../src/context/OverlayContext.jsx'
import Sheet from '../../src/components/forms/Sheet.jsx'
import SheetRowLink from '../../src/components/SheetRowLink.jsx'
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx'
import EventDetail from '../../src/pages/EventDetail.jsx'
import PlantingDetail from '../../src/pages/PlantingDetail.jsx'
import LocationDetail from '../../src/pages/LocationDetail.jsx'
import Locations from '../../src/pages/Locations.jsx'
import Inventory from '../../src/pages/Inventory.jsx'
import Dashboard from '../../src/pages/Dashboard.jsx'
import Harvests from '../../src/pages/Harvests.jsx'
import Achievements from '../../src/pages/Achievements.jsx'
import ReleaseNotes from '../../src/pages/ReleaseNotes.jsx'
import About from '../../src/pages/About.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const q = new URLSearchParams(location.search)
const TOP_CHROME_PX = Number(q.get('topbar') || 52)
const MS = Number(q.get('ms') ?? 300)
const ANCHOR_NONE = q.get('anchor') === 'none'
const LOC_PHOTOS = Number(q.get('locphotos') ?? 12)
const EVENT_RICH = q.get('event') === 'rich'
const RESET = ['entry', 'location', 'both'].includes(q.get('reset')) ? q.get('reset') : ''
// MECHANISM CHECK (?lock=off): neutralise Sheet's body scroll-lock (its inline overflow:hidden loses to an
// !important rule), to test whether releasing the lock in the same commit as a page swap drops the carry.
const LOCK_OFF = q.get('lock') === 'off'

try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ }
if (ANCHOR_NONE) {
  const s = document.createElement('style')
  s.textContent = '* { overflow-anchor: none !important; }'
  document.head.appendChild(s)
}
if (LOCK_OFF) {
  const s = document.createElement('style')
  s.textContent = 'body { overflow: visible !important; overscroll-behavior: auto !important; }'
  document.head.appendChild(s)
}

// ── fixture ──────────────────────────────────────────────────────────────────────────────────────────
const DAY = 86400000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString()
const dayKey = (daysAgo) => iso(daysAgo).slice(0, 10)

// The planting whose Event log is the real door into EventDetail. 60 events, newest first as the route
// orders them; one in six is a harvest, the rest waterings/feeds/observations, some with notes.
const PLANTING_ID = 'pl-ristra'
const PLANTING = {
  id: PLANTING_ID, name: 'Ristra Cayenne II, bed 4', project_id: null, project_name: null,
  quantity: 1, status: 'fruiting', notes: 'Heavy set after the August heat broke.',
  variety: 'Ristra Cayenne II', variety_id: 'var-ristra',
  variety_ref: { id: 'var-ristra', name: 'Ristra Cayenne II', species: 'Capsicum annuum', crop_type_slug: 'pepper' },
  crop_type_slug: 'pepper', location_id: 'loc-bed4', location_name: 'Bed 4', sown_at: '2026-03-02',
  created_at: iso(200), updated_at: iso(1), archived_at: null, deleted_at: null, grown_as: 'annual',
}
const EVENT_TYPES = ['watering', 'watering', 'observation', 'watering', 'fertilizing', 'harvest']
const NOTES = [null, 'Soaked the bag; top inch was dry.', null, 'Leaves perked up by evening.', null, 'Seven pods, two cracked.']
const PLANTING_EVENTS = Array.from({ length: 60 }, (_, i) => ({
  id: `ev-${String(i + 1).padStart(2, '0')}`, event_type: EVENT_TYPES[i % 6], title: '',
  event_date: iso(1 + i * 2), created_at: iso(1 + i * 2), notes: NOTES[i % 6],
  plant_id: PLANTING_ID, project_id: null, planting_name: PLANTING.name, batch_count: 1,
}))
// GET /api/events/:id — the detail row (eventdetail.jsx's harvest shape), with a note and three photos.
// ?event=rich: nine photos (three rows of thumbs), a long note, a private note and four Details rows.
const photosOf = (id, n) => Array.from({ length: n }, (_, i) => ({ id: `ph-${id}-${i + 1}`, storage_path: `x/${i + 1}.jpg`, cover_for: null }))
const RICH_NOTE = 'Picked the reddest pods from the south side; the north side is a week behind. Two cracked after the rain on Tuesday, set aside for the dehydrator. Plant is leaning, needs a second stake before the next storm.'
const eventDetail = (ev) => ({
  id: ev.id, project_id: null, plant_id: PLANTING_ID, location_id: null,
  event_type: ev.event_type, event_date: ev.event_date, title: '',
  notes: EVENT_RICH ? RICH_NOTE : (ev.notes || 'Picked the reddest pods; the rest need another week.'),
  private_notes: EVENT_RICH ? 'Try the neighbour\'s trellis idea next year.' : '', quantity: '', is_public: false,
  metadata: EVENT_RICH ? { count: 7, weight_g: 214, quality: 'good', health: 'fine' } : (ev.event_type === 'watering' ? { water_depth: 'deep' } : null),
  flagged_as_issue: false, severity: null, resolved_at: null,
  created_at: ev.created_at, updated_at: ev.created_at, project_name: null, planting_name: PLANTING.name,
  harvest: ev.event_type === 'harvest'
    ? { id: `h-${ev.id}`, quantity: 7, unit: 'count', quality_rating: null, weight_grams: 214, weight_estimated: false, weight_basis: null, disposition: null }
    : null,
  photos: photosOf(ev.id, EVENT_RICH ? 9 : 3),
})
const EVENTS_BY_ID = Object.fromEntries(PLANTING_EVENTS.map((e) => [e.id, eventDetail(e)]))
// The /deep list's EventDetail door opens this one: a harvest, the shape Dave taps most.
const DEEP_EVENT_ID = 'ev-06'

// Zones: six roots with children, so the Locations list is a long page and a zone's name link sits deep.
const ZONE_TREE = [
  ['House', ['Kitchen window', 'South porch', 'Grow shelf', 'Basement']],
  ['Stable', ['Stall 1', 'Stall 2', 'Tack room', 'Loft']],
  ['Bag Area', ['Bag row A', 'Bag row B', 'Bag row C', 'Bag row D', 'Bag row E']],
  ['Garden Beds', ['Bed 1', 'Bed 2', 'Bed 3', 'Bed 4', 'Bed 5', 'Bed 6']],
  ['Troughs', ['Trough north', 'Trough south', 'Trough east']],
  ['Orchard', ['Peach', 'Apple row', 'Fig corner', 'Blueberry hedge', 'Raspberry cane']],
]
const LOCATIONS = []
ZONE_TREE.forEach(([root, kids], ri) => {
  const rid = `loc-${root.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  LOCATIONS.push({ id: rid, name: root, slug: rid.slice(4), level: 0, type_label: 'zone', parent_id: null, sort_order: ri, description: ri === 2 ? 'Grow bags along the fence line, full sun from 9am.' : null, is_active: true, covered: ri < 2, heated: ri === 0 })
  kids.forEach((k, ki) => {
    const kid = `loc-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    LOCATIONS.push({ id: kid, name: k, slug: kid.slice(4), level: 1, type_label: 'area', parent_id: rid, sort_order: ki, description: null, is_active: true, covered: ri < 2, heated: false })
  })
})
const LOC_BY_ID = Object.fromEntries(LOCATIONS.map((l) => [l.id, l]))
const DEEP_LOCATION_ID = 'loc-bag-area'
const locPhotos = (id) => Array.from({ length: LOC_PHOTOS }, (_, i) => ({ id: `lp-${id}-${i}`, caption: null, thumb_url: null, view_url: null, created_at: iso(i) }))

// Inventory: 30 non-seed items over six categories, plus the seed rows the page counts and does not list.
const INV_CATS = ['growing_media', 'fertilizer', 'containers', 'tools', 'lighting', 'other']
const INVENTORY = [
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `inv-${i + 1}`, name: `${['Pro-Mix HP', 'Fish & Seaweed', '5 gal fabric bag', 'Hori hori', 'T5 light 4ft', 'Twine'][i % 6]} ${i + 1}`,
    type: i % 6 === 2 || i % 6 === 3 || i % 6 === 4 ? 'durable' : 'consumable', category: INV_CATS[i % 6], status: 'active',
    quantity_on_hand: (i * 7) % 13, reorder_threshold: i % 5 === 0 ? 3 : null, unit: 'each', unit_cost: 4 + (i % 9),
    quantity_purchased: 10, purchase_date: dayKey(40 + i), quantity: (i * 3) % 11, condition: 'good', source: null,
  })),
  { id: 'seed-1', name: 'Sungold packet', type: 'consumable', category: 'seeds', status: 'active', quantity_on_hand: 1, unit: 'packet' },
  { id: 'seed-2', name: 'Genovese Basil', type: 'consumable', category: 'seeds', status: 'active', quantity_on_hand: 2, unit: 'packet' },
]

// Dashboard: tiles at their zero states, and the 20-entry Recent activity list the page grows into.
const DASHBOARD = {
  active_projects: [],
  recent_events: PLANTING_EVENTS.slice(0, 20).map((e) => ({ ...e, plant_name: PLANTING.name, project_name: null })),
  user_stats: { current_streak: 4, longest_streak: 19, last_active_date: dayKey(0), total_events: 1840, xp: 9200, level: 12 },
  water_due: [], inactive_projects_count: 0, harvest_ready: [], heads_up: [], give_attention: null,
}

// Harvests: the season's Totals (a bare arrival lands there), 20 crops.
const CROPS = ['Pepper', 'Tomato', 'Cucumber', 'Bean', 'Squash', 'Tomatillo', 'Basil', 'Lettuce', 'Kale', 'Okra',
  'Eggplant', 'Melon', 'Pea', 'Radish', 'Carrot', 'Beet', 'Chard', 'Garlic', 'Onion', 'Potato']
const HARVESTS = {
  entries: [],
  aggregates: {
    crops: CROPS.map((name, i) => ({ crop_type_slug: name.toLowerCase(), crop_name: name, units: [{ unit: 'count', total: 12 + i * 5 }], weight: null, unquantified: i % 4, hero_photo_id: null })),
    other: [], first_pick: [], weight: null,
  },
  cursor: null,
}

// Achievements: 14 earned, 30 locked.
const ACHIEVEMENTS = {
  earned: Array.from({ length: 14 }, (_, i) => ({ id: `ach-e${i}`, emoji: '🏅', name: `Earned badge ${i + 1}`, description: 'Logged a lot of garden work.', xp_reward: 50, earned_at: iso(i * 5) })),
  locked: Array.from({ length: 30 }, (_, i) => ({ id: `ach-l${i}`, emoji: '🔒', name: `Locked badge ${i + 1}`, description: 'Keep going.', xp_reward: 100, trigger_type: 'event_count', trigger_value: { count: 2000 + i * 100 } })),
  total_earned: 14, total_visible: 44, secret_locked_count: 3,
}

// ── network: the far side of the wire only ───────────────────────────────────────────────────────────
const realFetch = window.fetch
const json = (body, ms = 20, status = 200) => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), ms))
const unstubbed = []
window.fetch = (url, opts = {}, ...rest) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  if (u.includes('/releases.json')) return new Promise((r) => setTimeout(r, MS)).then(() => realFetch(url, opts, ...rest))
  if (!u.includes('/api/')) return realFetch(url, opts, ...rest)
  if (method !== 'GET') return json({ ok: true })
  const path = u.replace(location.origin, '')
  if (path.includes('/api/photos/view-url/')) return json({ error: 'not found' }, 0, 404)
  // Order matters: sub-routes also contain their parent's path.
  let m
  if ((m = path.match(/^\/api\/events\/([^/?]+)(\?|$)/))) return EVENTS_BY_ID[m[1]] ? json(EVENTS_BY_ID[m[1]], MS) : json({ error: 'Not found' }, 20, 404)
  if (/^\/api\/events\?/.test(path) && path.includes(`plant_id=${PLANTING_ID}`)) return json(PLANTING_EVENTS, MS)
  if (path.startsWith(`/api/plants/${PLANTING_ID}/seed-lots`)) return json([])
  if (path === `/api/plants/${PLANTING_ID}`) return json(PLANTING, MS)
  if (path.startsWith('/api/harvests')) return json(path.includes(`plant=${PLANTING_ID}`) ? { entries: [], aggregates: { first_pick: [] }, cursor: null } : HARVESTS, MS)
  if (path.startsWith('/api/photos?attachedTo=')) return json([])
  if ((m = path.match(/^\/api\/photos\?location_id=([^&]+)/))) return json(locPhotos(m[1]), MS)
  if (path === '/api/locations/with-path') return json([], MS)
  if (path === '/api/locations') return json({ locations: LOCATIONS }, MS)
  if ((m = path.match(/^\/api\/locations\/([^/?]+)$/))) return LOC_BY_ID[m[1]] ? json(LOC_BY_ID[m[1]], MS) : json({ error: 'Not found' }, 20, 404)
  if (path.startsWith('/api/inventory-items')) return json(INVENTORY, MS)
  if (path === '/api/dashboard') return json(DASHBOARD, MS)
  if (path === '/api/achievements') return json(ACHIEVEMENTS, MS)
  if (path.startsWith('/api/favorites')) return json([])
  if (path.startsWith('/api/projects')) return json([])
  unstubbed.push(`${method} ${path}`)
  return json([])
}

// Anything the page throws on the way up is recorded; the driver refuses to measure past it.
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

// ── instruments: observation only, nothing here moves the page ─────────────────────────────────────
const T0 = performance.now()
const trace = []
window.addEventListener('scroll', () => {
  if (trace.length < 600) trace.push({ t: Math.round(performance.now() - T0), y: Math.round(window.scrollY), path: location.pathname })
}, { capture: true, passive: true })
// Who scrolls: a script (scrollTo / scrollIntoView / focus without preventScroll) or only the browser.
const calls = []
const describe = (el) => (el && el.getAttribute ? `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}${el.getAttribute('aria-label') ? `[aria-label=${el.getAttribute('aria-label')}]` : ''}${el.isConnected ? '' : '(detached)'}` : null)
const wrap = (obj, name, label) => {
  const orig = obj[name]
  obj[name] = function (...args) {
    if (calls.length < 200) {
      calls.push({ t: Math.round(performance.now() - T0), call: label, path: location.pathname, y: Math.round(window.scrollY),
        args: args.length && typeof args[0] !== 'object' ? args.slice(0, 2) : (args[0] && typeof args[0] === 'object' ? [JSON.stringify(args[0])] : []),
        target: this === window ? null : describe(this) })
    }
    return orig.apply(this, args)
  }
}
// MECHANISM CHECK (?focus=noscroll): every focus() call gets preventScroll, to test whether a focus
// restored AFTER a page swap is what drops the carried offset (the Search-result door).
const FOCUS_NOSCROLL = q.get('focus') === 'noscroll'
if (FOCUS_NOSCROLL) {
  const origFocus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (opts) { return origFocus.call(this, { ...(opts || {}), preventScroll: true }) }
}
wrap(window, 'scrollTo', 'window.scrollTo')
wrap(Element.prototype, 'scrollIntoView', 'scrollIntoView')
wrap(HTMLElement.prototype, 'focus', 'focus')
// Per-frame sampler (rAF): one sample per frame, kept only when something changed.
let samples = null
let sampling = false
let sampleT0 = 0
const h1Top = () => { const h = document.querySelector('h1'); return h ? Math.round(h.getBoundingClientRect().top) : null }
const loadingShown = () => /Loading…/.test(document.querySelector('[data-harness-pages]')?.textContent || '')
function sampleFrame() {
  if (!sampling) return
  const s = { t: Math.round(performance.now() - sampleT0), y: Math.round(window.scrollY), docH: document.documentElement.scrollHeight, path: location.pathname, h1: h1Top(), loading: loadingShown() }
  const p = samples[samples.length - 1]
  if (!p || p.y !== s.y || p.docH !== s.docH || p.path !== s.path || p.h1 !== s.h1 || p.loading !== s.loading) samples.push(s)
  if (samples.length < 1500) requestAnimationFrame(sampleFrame)
}

// ── stand-ins ─────────────────────────────────────────────────────────────────────────────────────────
// The arriving pages the /deep list and the More sheet open, one per candidate page.
const TARGETS = [
  { key: 'event', to: `/events/${DEEP_EVENT_ID}`, label: 'A harvest event (EventDetail)' },
  { key: 'planting', to: `/plantings/${PLANTING_ID}`, label: 'Ristra planting (PlantingDetail — resets)' },
  { key: 'location', to: `/locations/${DEEP_LOCATION_ID}`, label: 'Bag Area zone (LocationDetail)' },
  { key: 'locations', to: '/locations', label: 'Zones (Locations)' },
  { key: 'inventory', to: '/inventory', label: 'Inventory' },
  { key: 'dashboard', to: '/dashboard', label: 'Dashboard' },
  { key: 'harvests', to: '/harvests', label: 'Harvests' },
  { key: 'achievements', to: '/achievements', label: 'Achievements' },
  { key: 'releases', to: '/releases', label: 'Release notes' },
  { key: 'about', to: '/about', label: 'About' },
]
const DEEP_ROWS = 80
function TodayStandIn() {
  const link = (to, id, text) => <Link to={to} data-testid={id} style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>{text}</Link>
  return (
    <div style={{ padding: 20, display: 'grid', gap: 12 }}>
      {link('/deep', 'harness-to-deep', 'A long list')}
      {link(`/plantings/${PLANTING_ID}`, 'harness-to-planting', 'Ristra planting')}
      {link('/locations', 'harness-to-locations', 'Zones')}
    </div>
  )
}
function DeepListStandIn() {
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: '1.3rem' }}>A long list</h1>
      {Array.from({ length: DEEP_ROWS }, (_, i) => {
        const t = TARGETS[i % TARGETS.length]
        return (
          <Link key={i} to={t.to} data-testid="deep-row" data-target={t.key} data-row={i}
            style={{ display: 'flex', alignItems: 'center', minHeight: 64, boxSizing: 'border-box', padding: '0 12px', borderBottom: '1px solid #d4c9be', color: '#2f3b2f', textDecoration: 'none' }}>
            {i + 1}. {t.label}
          </Link>
        )
      })}
    </div>
  )
}
function LeftThePage() {
  const loc = useLocation()
  return <div data-testid="harness-left-page">left the page for {loc.pathname}</div>
}

// App.jsx's OverlayHost, line for line (seedsscroll.jsx carries the same copy; gate:seeds-scroll checks that
// one for drift against App.jsx).
function HarnessOverlayHost({ ariaLabel, size = 'peek', children }) {
  const dismiss = useOverlayDismiss()
  const [dirty, setDirty] = React.useState(false)
  return (
    <Sheet open onClose={dismiss} ariaLabel={ariaLabel} size={size} dirty={dirty} kind="route">
      <OverlaySurfaceProvider>
        <OverlayDirtyProvider onDirtyChange={setDirty}>{children}</OverlayDirtyProvider>
      </OverlaySurfaceProvider>
    </Sheet>
  )
}
// The Search page's stand-in: its results as Search.jsx's Row renders them, a plain <Link> each.
const SEARCH_RESULTS = ['event', 'location', 'planting'].map((k) => TARGETS.find((t) => t.key === k))
function SearchStandIn() {
  return (
    <div data-testid="harness-search" style={{ padding: '8px 0' }}>
      {SEARCH_RESULTS.map((t) => (
        <Link key={t.key} to={t.to} data-testid={`harness-search-${t.key}`}
          style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 20px', color: '#2f3b2f', textDecoration: 'none' }}>{t.label}</Link>
      ))}
    </div>
  )
}

// MECHANISM CHECK (?reset=entry|location), off in a plain run. `entry` is pageEntry.js's rule
// (cbacf94d:src/lib/pageEntry.js locationEntryKey, copied): the page tree's location — the overlay's
// background while one is open — answers with the entry it continues when stamped, else its own key.
const savedByEntry = new Map()
const currentEntry = { key: null }
if (RESET === 'both') {
  try { window.history.scrollRestoration = 'manual' } catch { /* ignore */ }
  window.addEventListener('scroll', () => { if (currentEntry.key) savedByEntry.set(currentEntry.key, window.scrollY) }, { passive: true })
}
// Re-apply `target` every frame until it holds, the user takes over, or 4s pass (Garden.jsx's driver shape).
function driveRestore(target) {
  let cancelled = false
  const t0 = performance.now()
  const stop = () => { cancelled = true }
  const opts = { passive: true, once: true }
  window.addEventListener('wheel', stop, opts)
  window.addEventListener('touchstart', stop, opts)
  window.addEventListener('keydown', stop, opts)
  const tick = () => {
    if (cancelled) return
    window.scrollTo(0, target)
    if (Math.abs(window.scrollY - target) < 1 && performance.now() - t0 > 600) return
    if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
  }
  tick()
}
function useHarnessReset(pageLocation) {
  const real = useLocation()
  const navType = useNavigationType()
  const entry = RESET === 'entry' || RESET === 'both' ? ((pageLocation.state && pageLocation.state.continuesEntry) || pageLocation.key)
    : RESET === 'location' ? real.key : null
  const last = useRef(entry)
  useLayoutEffect(() => {
    if (!RESET || entry === last.current) { currentEntry.key = entry; return }
    last.current = entry
    currentEntry.key = entry
    if (navType === 'POP') { if (RESET === 'both') driveRestore(savedByEntry.get(entry) ?? 0); return }
    window.scrollTo(0, 0)
  }, [entry, navType])
}

// The More sheet and two tab links, as BottomNav builds them (see the header).
const MORE_ROWS = ['dashboard', 'locations', 'inventory', 'achievements', 'releases', 'about'].map((k) => TARGETS.find((t) => t.key === k))
function BottomNavStandIn() {
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', `${BOTTOM_NAV_HEIGHT_PX}px`)
  }, [])
  const tab = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, color: '#2f3b2f', textDecoration: 'none', fontSize: '0.8rem' }
  return (
    <>
      <nav aria-label="Main navigation"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100,
          background: '#fff', borderTop: '1px solid #d4c9be', boxSizing: 'border-box', display: 'flex', alignItems: 'center' }}>
        <Link to="/today" data-testid="harness-tab-today" style={tab}>Today</Link>
        <Link to="/harvests" data-testid="harness-tab-harvests" style={tab}>Harvests</Link>
        <button type="button" data-testid="harness-more" onClick={() => setMore((s) => !s)} style={{ ...tab, background: 'none', border: 'none' }}>More</button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} ariaLabel="More navigation options" armsBack>
        {MORE_ROWS.map((t) => (
          <SheetRowLink key={t.key} to={t.to} onClick={() => setMore(false)} data-testid={`harness-more-${t.key}`}
            style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 24px' }}>{t.label}</SheetRowLink>
        ))}
      </Sheet>
    </>
  )
}
// Every page in a route boundary with a visible marker, so a page that throws is named, never measured.
// No wrapper element: the page's own root is the first node under the shell, as in App.jsx.
const routeEl = (el) => (
  <ErrorBoundary scope="route" fallback={<div data-testid="harness-route-fallback">route fallback</div>}>{el}</ErrorBoundary>
)
// Which page the tree is showing, by path (the attribute below is on App.jsx's own flex:1 div).
const PAGE_OF = [
  [/^\/today$/, 'today'], [/^\/deep$/, 'deep'], [/^\/events\/[^/]+$/, 'event'], [/^\/plantings\/[^/]+$/, 'planting'],
  [/^\/locations$/, 'locations'], [/^\/locations\/[^/]+$/, 'location'], [/^\/inventory$/, 'inventory'],
  [/^\/dashboard$/, 'dashboard'], [/^\/harvests$/, 'harvests'], [/^\/achievements$/, 'achievements'],
  [/^\/releases$/, 'releases'], [/^\/about$/, 'about'],
]
const pageKeyOf = (path) => (PAGE_OF.find(([re]) => re.test(path)) || [null, null])[1]
// The page tree's path: the overlay's background while one is open (history.state.usr.background).
const pagePath = () => { try { return window.history.state?.usr?.background?.pathname || location.pathname } catch { return location.pathname } }

// AppShell's shape: the top bar (with header Search), the page tree at pageLocation, the overlay tree at the
// real location only while an overlay has a background, and the bottom nav.
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  useHarnessReset(pageLocation)
  return (
    <>
      <header data-app-chrome="top"
        style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
          background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 8 }}>
        <OverlayLink to="/search" aria-label="Search your garden" data-testid="harness-open-search"
          style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⌕</OverlayLink>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh',
        paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
        <div data-harness-pages="" style={{ flex: 1 }}>
          <Routes location={pageLocation}>
            <Route path="/today" element={routeEl(<TodayStandIn />)} />
            <Route path="/deep" element={routeEl(<DeepListStandIn />)} />
            <Route path="/events/:eventId" element={routeEl(<EventDetail />)} />
            <Route path="/plantings/:plantingId" element={routeEl(<PlantingDetail />)} />
            <Route path="/locations" element={routeEl(<Locations />)} />
            <Route path="/locations/:id" element={routeEl(<LocationDetail />)} />
            <Route path="/inventory" element={routeEl(<Inventory />)} />
            <Route path="/dashboard" element={routeEl(<Dashboard />)} />
            <Route path="/harvests" element={routeEl(<Harvests />)} />
            <Route path="/achievements" element={routeEl(<Achievements />)} />
            <Route path="/releases" element={routeEl(<ReleaseNotes />)} />
            <Route path="/about" element={routeEl(<About />)} />
            <Route path="*" element={<LeftThePage />} />
          </Routes>
        </div>
      </div>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<HarnessOverlayHost ariaLabel="Search your garden" size="peek"><SearchStandIn /></HarnessOverlayHost>} />
        </Routes>
      )}
      <BottomNavStandIn />
    </>
  )
}

window.history.replaceState(null, '', '/today')
createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ModeProvider>
      <FavoritesProvider>
        <ToastProvider>
          <BrowserRouter>
            <DismissRegistryProvider>
              <OverlayProvider>
                <Shell />
              </OverlayProvider>
            </DismissRegistryProvider>
          </BrowserRouter>
        </ToastProvider>
      </FavoritesProvider>
    </ModeProvider>
  </AuthProvider>,
)

// What "the page's content has landed" means per page — the driver waits on it, then for the scroll to
// hold still. Each reads the page's real DOM, never a harness flag.
const page = () => document.querySelector('[data-harness-pages]')
const text = () => page()?.textContent || ''
const READY = {
  today: () => !!document.querySelector('[data-testid="harness-to-deep"]'),
  deep: () => document.querySelectorAll('[data-testid="deep-row"]').length === DEEP_ROWS,
  event: () => !!document.querySelector('h1') && !!document.querySelector('[data-testid="event-photos"]'),
  planting: () => !!document.querySelector('h1') && !!document.querySelector('a[href^="/events/"]'),
  location: () => !!document.querySelector('h1') && (LOC_PHOTOS === 0 || !!document.querySelector('[data-testid="location-photo-grid"]')),
  locations: () => document.querySelectorAll('a[href^="/locations/"]').length === LOCATIONS.length,
  inventory: () => document.querySelectorAll('[data-testid="inv-row"]').length > 0,
  dashboard: () => /Recent activity/.test(text()),
  harvests: () => /Pepper/.test(text()) && /Potato/.test(text()),
  achievements: () => /Locked badge 30/.test(text()),
  releases: () => (page()?.querySelectorAll('li').length || 0) > 3,
  about: () => !!document.querySelector('h1'),
}

// One id per document: a reload mid-flow (Vite re-optimizing a dependency) is named, never measured.
const BOOT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
window.__h = {
  boot: () => BOOT,
  ready: () => READY.today() || location.pathname !== '/today',
  pageKey: () => pageKeyOf(pagePath()),
  pageReady: (key) => { try { return pageKeyOf(pagePath()) === key && !document.querySelector('[data-testid="harness-route-fallback"]') && !!READY[key]?.() } catch { return false } },
  overlayOpen: () => !!document.querySelector('[role="dialog"][aria-label="Search your garden"]'),
  errors: () => [...errors],
  unstubbed: () => [...unstubbed],
  calls: () => calls.slice(),
  key: () => { try { return window.history.state?.key ?? null } catch { return null } },
  idx: () => { try { return window.history.state?.idx ?? null } catch { return null } },
  mark: () => { trace.length = 0; calls.length = 0; return true },
  trace: () => trace.slice(),
  startSampling: () => { samples = []; sampleT0 = performance.now(); sampling = true; requestAnimationFrame(sampleFrame); return true },
  stopSampling: () => { sampling = false; return samples ? samples.slice() : [] },
  // What sits at the top of the visible band (just under the top bar): the first labelled thing there.
  topOfView: () => {
    const bandTop = document.querySelector('header[data-app-chrome="top"]')?.getBoundingClientRect().bottom ?? 0
    let el = document.elementFromPoint(window.innerWidth / 2, bandTop + 12)
    const hit = el
    while (el && el !== document.body && !(el.getAttribute('data-testid') || /^(H1|H2|H3|LABEL|BUTTON|A|LI|FORM|P)$/.test(el.tagName))) el = el.parentElement
    const pick = el && el !== document.body ? el : hit
    if (!pick) return null
    return { tag: pick.tagName.toLowerCase(), testid: pick.getAttribute?.('data-testid') || null, text: (pick.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) }
  },
  fixture: () => ({ ms: MS, anchorNone: ANCHOR_NONE, lockOff: LOCK_OFF, focusNoScroll: FOCUS_NOSCROLL, eventRich: EVENT_RICH, reset: RESET, locPhotos: LOC_PHOTOS, deepRows: DEEP_ROWS, plantingEvents: PLANTING_EVENTS.length, locations: LOCATIONS.length, targets: TARGETS.map((t) => t.key) }),
}
