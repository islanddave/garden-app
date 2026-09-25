// BUG-DETAILPAGESCARRYSCROLL-001 — the app-level page-scroll manager in a REAL browser, for
// scripts/layout-gate/page-scroll.mjs (gate:page-scroll). Framed by viewport.html
// (?page=pagescroll.html&vw=426&vh=836).
//
// PROMOTED from the measurement entry tests/harness/detailscroll.jsx (lane-detailscroll-measure-20260925),
// which showed 9 of 10 pages opening part-way down and measured the fix's shape in a harness-only
// prototype. That prototype is GONE from here: this entry mounts the REAL manager
// (src/hooks/usePageScrollManager.js, called exactly as AppShell calls it), so the gate proves the code
// that ships, not a copy of it.
//
// WHAT IS REAL: every arriving and returning page below, under BrowserRouter — every entry carries
// react-router's {usr, key, idx} as prod's does, and Back is a real history traversal (popstate): the
// planting page (PlantingDetail, its Event log the real door into EventDetail), Zones (Locations) and a
// zone (LocationDetail), Harvests (a useScrollRestore page), Achievements, About, Garden (its own restore
// driver, its +LOG "Add a planting" door), PutUp (the Going-now list and its ?batch= mode), the Seeds page
// (My seeds / Saved seeds, each with its real useScrollRestore), a seed lot (InventoryDetail) and the
// variety editor it opens (VarietyEdit). App.jsx's shell: a sticky top bar of TopChrome's BAR_H with header
// Search as a real OverlayLink, the flex column minHeight 100dvh whose paddingBottom reserves
// --bottom-nav-height, the page tree at OverlayProvider's pageLocation, the overlay tree hosted by a copy
// of App.jsx's OverlayHost (seedsscroll.jsx's; gate:seeds-scroll guards that copy against App.jsx), and a
// fixed nav of BOTTOM_NAV_HEIGHT_PX that writes that variable in a layout effect as BottomNav does. The
// providers are App.jsx's (Auth on the Clerk stub, Mode, Favorites, Toast, DismissRegistry, Overlay).
//
// THE DOORS, as BottomNav builds them: tab links (Today, Harvests, Garden) are plain PUSHes; the More
// sheet and the + sheet are ARMED Sheets (a Back marker is pushed) whose rows are real SheetRowLinks,
// which REPLACE into the marker's slot. + carries BottomNav's "Add a planting" → /garden?add=1.
//
// WHAT IS A STAND-IN: /today (links in, so every source is itself a push), /deep (a long list of links to
// the target pages, with a sticky same-page control that REPLACEs /deep?sort=… — the shape of Seeds' view
// switch, HarvestLog's mode switch and Garden's strips — and a row count the gate can shrink, the page
// "rendering shorter behind a sheet"), /chain/:n (25 long pages in a row, for the store's depth), and the
// Search page inside the overlay (its results are plain <Link>s, as Search.jsx's Row renders them).
//
// THE NETWORK is stubbed at window.fetch WITH LATENCY: every page's own data answers after ?ms= (300 by
// default; 5000 for the slow-content flow), so each page paints its loading state first, as on a phone
// against a real Lambda. Anything the fixture does not know answers [] after 20ms and is listed by
// __h.unstubbed().
//
//   http://localhost:5401/tests/harness/viewport.html?page=pagescroll.html&vw=426&vh=836
//     ms=300         latency of each page's own GETs
//     topbar=52      the top-bar stand-in's height (TopChrome's BAR_H)
//     auth=0         ms the user stays UNRESOLVED at every document load: the page tree is Protected's
//                    one-screen skeleton and the manager's `ready` is false, as App.jsx's `!loading` during the
//                    Clerk window (~2.5 s measured) — what a boot restore has to wait through (qa-built M9)
//
// A FLOW'S FIRST LOAD IS A FIRST VISIT: sessionStorage and localStorage are cleared before anything
// mounts (both scroll stores, every page's persisted filters), and Garden's crop groups are opened. The one
// exception is a reload the gate asks for (__h.reloadHere(), the app-owned reload flow): it reloads this
// document ON the current history entry and keeps sessionStorage, as the service worker's post-update
// reload and an Android tab restore do (the mechanism is seedsscroll.jsx's).
import React, { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ModeProvider } from '../../src/context/ModeContext.jsx'
import { FavoritesProvider } from '../../src/context/FavoritesContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import {
  OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss, useOverlaySwap, OverlaySurfaceProvider, OverlayDirtyProvider,
} from '../../src/context/OverlayContext.jsx'
// The REAL manager, as AppShell calls it (scripts/layout-gate/page-scroll.mjs checks both sides match).
import { usePageScrollManager, PageScrollProvider, applyBrowserScrollRestoration } from '../../src/hooks/usePageScrollManager.js'
import { __resetPageScrollStore, PAGE_SCROLL_STORE_KEY } from '../../src/lib/pageScroll.js'
import { __resetScrollRestoreStore } from '../../src/hooks/useScrollRestore.js'
import { SCROLL_MANAGER_ENABLED } from '../../src/lib/featureFlags.js'
import Sheet from '../../src/components/forms/Sheet.jsx'
import SheetRowLink from '../../src/components/SheetRowLink.jsx'
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx'
import EventDetail from '../../src/pages/EventDetail.jsx'
import PlantingDetail from '../../src/pages/PlantingDetail.jsx'
import LocationDetail from '../../src/pages/LocationDetail.jsx'
import Locations from '../../src/pages/Locations.jsx'
import Harvests from '../../src/pages/Harvests.jsx'
import Achievements from '../../src/pages/Achievements.jsx'
import About from '../../src/pages/About.jsx'
import Garden from '../../src/pages/Garden.jsx'
import PutUp from '../../src/pages/PutUp.jsx'
import Seeds from '../../src/pages/Seeds.jsx'
import InventoryDetail from '../../src/pages/InventoryDetail.jsx'
import VarietyEdit from '../../src/pages/VarietyEdit.jsx'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

// main.jsx's boot line, the real function: the browser's own scroll restoration as prod sets it ('manual' with
// the manager on). Without it this entry would measure Chrome's native restore, which prod does not run.
applyBrowserScrollRestoration(SCROLL_MANAGER_ENABLED)

const q = new URLSearchParams(location.search)
const TOP_CHROME_PX = Number(q.get('topbar') || 52)
const MS = Number(q.get('ms') ?? 300)
const AUTH_MS = Number(q.get('auth') || 0)

// This page's own URL, before the router moves it: where a reload has to land.
const HARNESS_URL = location.pathname + location.search
const RELOAD_TO_KEY = 'harness.pagescroll.reloadTo'
const RELOAD_TO = (() => {
  try {
    if (performance.getEntriesByType('navigation')[0]?.type !== 'reload') return null
    return window.sessionStorage.getItem(RELOAD_TO_KEY)
  } catch { return null }
})()

// ── fixture ──────────────────────────────────────────────────────────────────────────────────────────
const DAY = 86400000
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString()
const dayKey = (daysAgo) => iso(daysAgo).slice(0, 10)

// Garden's crop groups, OPENED (Garden is collapsed-first; a closed garden is one screen tall). Fourteen
// plantings each: under TileGrid's 24-tile window, so the page is its full height from the first paint and
// Garden's own restore is not also a window-growth test.
const GARDEN_CROPS = [['tomato', 'Tomato'], ['pepper', 'Pepper'], ['squash', 'Squash'], ['bean', 'Bean']]

if (RELOAD_TO) { try { window.sessionStorage.removeItem(RELOAD_TO_KEY) } catch { /* ignore */ } }
else {
  try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ }
  try {
    window.localStorage.clear()
    window.localStorage.setItem('garden.groupsExpanded.v1', JSON.stringify(GARDEN_CROPS.map(([slug]) => slug)))
  } catch { /* ignore */ }
}

// The planting whose Event log is the real door into EventDetail (detailscroll.jsx's): 60 events, newest
// first as the route orders them.
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
const eventsFor = (plantId, name, n) => Array.from({ length: n }, (_, i) => ({
  id: `${plantId === PLANTING_ID ? 'ev' : `ev-${plantId}`}-${String(i + 1).padStart(2, '0')}`, event_type: EVENT_TYPES[i % 6], title: '',
  event_date: iso(1 + i * 2), created_at: iso(1 + i * 2), notes: NOTES[i % 6],
  plant_id: plantId, project_id: null, planting_name: name, batch_count: 1,
}))
const PLANTING_EVENTS = eventsFor(PLANTING_ID, PLANTING.name, 60)
const photosOf = (id, n) => Array.from({ length: n }, (_, i) => ({ id: `ph-${id}-${i + 1}`, storage_path: `x/${i + 1}.jpg`, cover_for: null }))
const eventDetail = (ev) => ({
  id: ev.id, project_id: null, plant_id: ev.plant_id, location_id: null,
  event_type: ev.event_type, event_date: ev.event_date, title: '',
  notes: ev.notes || 'Picked the reddest pods; the rest need another week.', private_notes: '', quantity: '', is_public: false,
  metadata: ev.event_type === 'watering' ? { water_depth: 'deep' } : null,
  flagged_as_issue: false, severity: null, resolved_at: null,
  created_at: ev.created_at, updated_at: ev.created_at, project_name: null, planting_name: ev.planting_name,
  harvest: ev.event_type === 'harvest'
    ? { id: `h-${ev.id}`, quantity: 7, unit: 'count', quality_rating: null, weight_grams: 214, weight_estimated: false, weight_basis: null, disposition: null }
    : null,
  photos: photosOf(ev.id, 3),
})
const EVENTS_BY_ID = Object.fromEntries(PLANTING_EVENTS.map((e) => [e.id, eventDetail(e)]))
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
const locPhotos = (id) => Array.from({ length: 12 }, (_, i) => ({ id: `lp-${id}-${i}`, caption: null, thumb_url: null, view_url: null, created_at: iso(i) }))

// Harvests: the season's Totals, 20 crops.
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

// Achievements: 14 earned, 30 locked — a page taller than any offset the flows carry.
const ACHIEVEMENTS = {
  earned: Array.from({ length: 14 }, (_, i) => ({ id: `ach-e${i}`, emoji: '🏅', name: `Earned badge ${i + 1}`, description: 'Logged a lot of garden work.', xp_reward: 50, earned_at: iso(i * 5) })),
  locked: Array.from({ length: 30 }, (_, i) => ({ id: `ach-l${i}`, emoji: '🔒', name: `Locked badge ${i + 1}`, description: 'Keep going.', xp_reward: 100, trigger_type: 'event_count', trigger_value: { count: 2000 + i * 100 } })),
  total_earned: 14, total_visible: 44, secret_locked_count: 3,
}

// Garden: the ?view=grid projection (Garden.gridProjection.test.jsx's row shape), fourteen per crop.
const GARDEN_PLANTS = GARDEN_CROPS.flatMap(([slug, label], ci) => Array.from({ length: 14 }, (_, i) => ({
  id: `gp-${slug}-${i + 1}`, name: `${label} ${i + 1}`, quantity: 1, status: 'growing',
  project_id: null, location_id: null, assignee_user_id: null,
  featured_photo_id: null, featured_photo_view_url: null, featured_photo_thumb_url: null,
  variety_ref: { name: `${label} variety ${ci * 14 + i + 1}`, crop_type_slug: slug },
})))
const GARDEN_BY_ID = Object.fromEntries(GARDEN_PLANTS.map((p) => [p.id, p]))
const gardenPlanting = (p) => ({
  ...PLANTING, id: p.id, name: p.name, variety: p.variety_ref.name, variety_id: null,
  variety_ref: { id: null, name: p.variety_ref.name, species: null, crop_type_slug: p.variety_ref.crop_type_slug },
  crop_type_slug: p.variety_ref.crop_type_slug, notes: null,
})

// PutUp: twelve open kitchen batches (putupclose.jsx's row shape, the repo's own shipped fixtures), so the
// Going-now list runs well past the fold; one detail shape answers every ?batch= GET under its own id.
const LABELS = ['Kraut, first crock', 'Hot sauce mash', 'Dilly beans', 'Kimchi', 'Pepper mash', 'Pickled onions',
  'Blackberry shrub', 'Garlic honey', 'Corn relish', 'Plum butter', 'Cider vinegar', 'Salsa verde']
const batch = (i) => ({
  id: `kb-${i + 1}`, user_id: 'user_dave', label: LABELS[i], kind: i % 3 === 0 ? 'ferment' : i % 3 === 1 ? 'preserve' : 'infuse',
  kind_other: null, started_at: iso(40 - i * 3), start_precision: 'day', first_recorded_at: iso(40 - i * 3),
  expected_days_min: 21, expected_days_max: 42, suspended_at: null, closed_at: null, outcome: null, outcome_note: null,
  current_stage_kind: 'tended', current_stage_label: 'Skimmed', current_stage_entered_at: iso(2),
  input_count: '2', output_count: '0',
})
const GOING = LABELS.map((_, i) => batch(i))
const batchDetail = (id) => {
  const b = GOING.find((x) => x.id === id) || batch(0)
  return {
    ...b,
    inputs: [{ id: `${b.id}-in-1`, batch_id: b.id, input_kind: 'pantry', harvest_log_id: null, label: 'Kosher salt', qty: '40', qty_unit: 'g', is_byproduct: false, added_at: b.started_at }],
    stages: [{ id: `${b.id}-st-1`, batch_id: b.id, stage_kind: 'started', label: null, entered_at: b.started_at, cue_observed: null, note: null }],
    outputs: [],
  }
}

// Seeds: seedsscroll.jsx's fixture (16 saved lots, Ristra, three stored after it, two bought packets).
const seedBase = {
  type: 'consumable', category: 'seeds', status: 'active', unit: 'packet', quantity: null,
  reorder_threshold: null, reorder_quantity: null, condition: null, unit_cost: null, quantity_purchased: null,
  purchase_date: null, source: null, source_url: null, source_id: null, acquired_from_source_id: null,
  brand: null, model: null, location_text: null, notes: null, year_harvested: 2026,
  seed_stage: 'stored', seed_process: 'wet', stage_entered_at: null, source_plant_id: null, source_kind: 'own_garden',
  seed_count: null, seed_weight_g: null, seed_count_estimated: null, sow_archived_season: null, metadata: {},
  crop_slug: 'pepper', scoville_min: null, scoville_max: null, scoville_source: null, origin_country: null,
  origin_region: null, species: 'Capsicum annuum', breeding_system: null, days_to_maturity_min: null,
  days_to_maturity_max: null, dtm_basis: null, variety_source_url: null,
  featured_photo_id: null, hero_photo_id: null, hero_thumb_key: null, featured_is_explicit: false, featured_photo_view_url: null,
  germination: { sowings: [], seeds_sown: 0, seeds_germinated: 0, rate: null }, sown_from: [],
  created_at: iso(90), updated_at: iso(3), quantity_on_hand: 1, variety_name: null,
}
let seedN = 0
const seedLot = (name, crop, over = {}) => {
  seedN += 1
  return { ...seedBase, id: `lot-${String(seedN).padStart(2, '0')}`, name, crop_slug: crop, variety_id: `var-${seedN}`,
    stage_entered_at: iso(60 - seedN), source_plant_id: `pl-${seedN}`, seed_count: 40 + seedN, seed_count_estimated: true, ...over }
}
const SEED_NAMES = [
  ['Aji Charapita', 'pepper'], ['Hot Paper Lantern', 'pepper'], ['Thai Dragon', 'pepper'], ['Gong Bao', 'pepper'],
  ['Big Boy', 'tomato'], ['Cherokee Purple', 'tomato'], ['Porch 1884', 'tomato'], ['Sungold', 'tomato'],
  ['Aji Amarillo', 'pepper'], ['Bishop Crown', 'pepper'], ['Fish', 'pepper'], ['Datil', 'pepper'],
  ['Brandywine', 'tomato'], ['Hungarian Wax', 'pepper'], ['Jimmy Nardello', 'pepper'], ['Lemon Drop', 'pepper'],
]
const RISTRA_ID = 'lot-ristra'
const RISTRA = {
  ...seedBase, id: RISTRA_ID, name: 'Ristra Cayenne II Saved seed 2026', variety_id: 'var-ristra', variety_name: null,
  crop_slug: 'pepper', breeding_system: 'f1', seed_stage: 'stored', seed_process: 'wet', stage_entered_at: iso(1),
  source_plant_id: 'pl-ristra', source_kind: 'own_garden', seed_count: 175, seed_count_estimated: false,
  quantity_on_hand: 1, scoville_min: 30000, scoville_max: 50000, days_to_maturity_min: 75, days_to_maturity_max: 80,
}
const SEED_ROWS = [
  ...SEED_NAMES.map(([v, c]) => seedLot(`${v} saved seed 2026`, c)),
  RISTRA,
  ...[['Cherry Bomb', 0.6], ['Juliet', 0.4], ['San Marzano', 0.2]].map(([v, days]) => seedLot(`${v} saved seed 2026`, 'tomato', { stage_entered_at: iso(days) })),
  seedLot('Serrano packet', 'pepper', { id: 'pk-1', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null, year_harvested: null, breeding_system: null }),
  seedLot('Buttercrunch packet', 'lettuce', { id: 'pk-2', seed_stage: null, seed_process: null, source_plant_id: null, source_kind: null, year_harvested: null }),
]
const SEED_BY_ID = Object.fromEntries(SEED_ROWS.map((r) => [r.id, r]))
const STAGE_LOG = [
  { id: 'st-3', stage: 'stored', entered_at: iso(1), note: null },
  { id: 'st-2', stage: 'drying', entered_at: iso(6), note: null },
  { id: 'st-1', stage: 'fermenting', entered_at: iso(9), note: 'Water changed on day 2.' },
]
const PICKER = SEED_ROWS.filter((r) => r.source_plant_id).map((r) => ({
  id: r.source_plant_id, name: r.id === RISTRA_ID ? 'Ristra Cayenne II, bed 4' : `${r.name.split(' saved')[0]} plant`,
  quantity: 1, variety_id: r.variety_id, variety_ref: { name: r.name.split(' saved')[0] }, sown_at: '2026-03-02', succession_order: null, project_name: null,
}))
const CROP_TYPES = [{ slug: 'pepper', display_name: 'Pepper' }, { slug: 'tomato', display_name: 'Tomato' }, { slug: 'lettuce', display_name: 'Lettuce' }]
// The cultivar the lot's "Edit sow details →" opens.
const VARIETY = {
  id: 'var-ristra', name: 'Ristra Cayenne II', species: 'Capsicum annuum', crop_type_slug: 'pepper', crop_type: 'pepper',
  breeding_system: 'f1', days_to_maturity_min: 75, days_to_maturity_max: 80, dtm_basis: null, created_by: null, is_public: true,
  sow_depth_in: null, spacing_in: null, days_to_germinate_min: null, days_to_germinate_max: null, source_url: null, notes: null,
}

// ── network: the far side of the wire only ───────────────────────────────────────────────────────────
const realFetch = window.fetch
const json = (body, ms = 20, status = 200) => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), ms))
const unstubbed = []
window.fetch = (url, opts = {}, ...rest) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  if (!u.includes('/api/')) return realFetch(url, opts, ...rest)
  if (method !== 'GET') return json({ ok: true })
  const path = u.replace(location.origin, '')
  if (path.includes('/api/photos/view-url/')) return json({ error: 'not found' }, 0, 404)
  // Order matters: sub-routes also contain their parent's path.
  let m
  if ((m = path.match(/^\/api\/events\/([^/?]+)(\?|$)/))) return EVENTS_BY_ID[m[1]] ? json(EVENTS_BY_ID[m[1]], MS) : json({ error: 'Not found' }, 20, 404)
  if ((m = path.match(/^\/api\/events\?.*plant_id=([^&]+)/))) {
    if (m[1] === PLANTING_ID) return json(PLANTING_EVENTS, MS)
    const p = GARDEN_BY_ID[m[1]]
    return json(p ? eventsFor(p.id, p.name, 6) : [], MS)
  }
  if (/^\/api\/plants\/[^/?]+\/seed-lots/.test(path)) return json([])
  if (path === `/api/plants/${PLANTING_ID}`) return json(PLANTING, MS)
  if ((m = path.match(/^\/api\/plants\/([^/?]+)$/))) return GARDEN_BY_ID[m[1]] ? json(gardenPlanting(GARDEN_BY_ID[m[1]]), MS) : json({ error: 'Not found' }, 20, 404)
  if (path.startsWith('/api/plants?view=grid')) return json(GARDEN_PLANTS, MS)
  if (path.startsWith('/api/plants?view=picker')) return json(PICKER)
  if (path.startsWith('/api/plants')) return json([])
  if (path.startsWith('/api/harvests')) return json(path.includes('plant=') ? { entries: [], aggregates: { first_pick: [] }, cursor: null } : HARVESTS, MS)
  if (path.startsWith('/api/photos?attachedTo=')) return json([])
  if ((m = path.match(/^\/api\/photos\?location_id=([^&]+)/))) return json(locPhotos(m[1]), MS)
  if (path === '/api/locations/with-path') return json([], MS)
  if (path === '/api/locations') return json({ locations: LOCATIONS }, MS)
  if ((m = path.match(/^\/api\/locations\/([^/?]+)$/))) return LOC_BY_ID[m[1]] ? json(LOC_BY_ID[m[1]], MS) : json({ error: 'Not found' }, 20, 404)
  if (path === '/api/achievements') return json(ACHIEVEMENTS, MS)
  if (path.startsWith('/api/kitchen-batches?state=going')) return json({ state: 'going', batches: GOING }, MS)
  if (path.startsWith('/api/kitchen-batches?state=')) return json({ state: 'closed', batches: [] }, MS)
  if ((m = path.match(/^\/api\/kitchen-batches\/([^/?]+)$/))) return json(batchDetail(m[1]), MS)
  if (path.startsWith('/api/preservation/whats-put-up')) return json({ group_by: 'crop', groups: [] })
  if (path.startsWith('/api/storage-locations')) return json([])
  if (/\/api\/inventory-items\/[^/?]+\/seed-stage/.test(path)) return json(STAGE_LOG)
  if ((m = path.match(/^\/api\/inventory-items\/([^/?]+)(\?|$)/))) return SEED_BY_ID[m[1]] ? json(SEED_BY_ID[m[1]], MS) : json({ error: 'Not found' }, 20, 404)
  if (/^\/api\/inventory-items(\?|$)/.test(path)) return json(SEED_ROWS, MS)
  if (path.includes('/sow-candidates')) return json({ items: [] })
  if (path.startsWith('/api/varieties/crop-types')) return json(CROP_TYPES)
  if (path.startsWith('/api/varieties/sources') || path.startsWith('/api/varieties/source-kinds')) return json([])
  if (path === '/api/varieties/var-ristra') return json(VARIETY, MS)
  if (path.startsWith('/api/varieties')) return json([])
  if (path.startsWith('/api/projects') || path.startsWith('/api/favorites') || path.startsWith('/api/members')) return json([])
  unstubbed.push(`${method} ${path}`)
  return json([])
}

// Anything the page throws on the way up is recorded; the gate refuses to measure past it.
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

// ── instruments: observation only, nothing here moves the page ─────────────────────────────────────
const T0 = performance.now()
const trace = []
window.addEventListener('scroll', () => {
  if (trace.length < 600) trace.push({ t: Math.round(performance.now() - T0), y: Math.round(window.scrollY), path: location.pathname })
}, { capture: true, passive: true })
// Per-frame sampler (rAF): one sample per frame, kept only when something changed.
let samples = null
let sampling = false
let sampleT0 = 0
function sampleFrame() {
  if (!sampling) return
  const s = { t: Math.round(performance.now() - sampleT0), y: Math.round(window.scrollY), docH: document.documentElement.scrollHeight, path: location.pathname, page: pageKeyOf(pagePath()) }
  const p = samples[samples.length - 1]
  if (!p || p.y !== s.y || p.docH !== s.docH || p.path !== s.path || p.page !== s.page) samples.push(s)
  if (samples.length < 1500) requestAnimationFrame(sampleFrame)
}
// The manager's decisions, as it reports them (observation only; App.jsx passes no onDecision).
const decisions = []
const onDecision = (d) => { if (decisions.length < 400) decisions.push({ t: Math.round(performance.now() - T0), row: d.row, action: d.action, y: d.y, path: d.path, entry: d.entry, nav: d.navType, at: Math.round(d.scrollY) }) }
// How each restore ended (DONE / EXHAUSTED + reason / TAKEOVER + what took over / SUPERSEDED / CLAIMED).
const restores = []
const onRestore = (r) => { if (restores.length < 400) restores.push({ t: Math.round(performance.now() - T0), outcome: r.outcome, reason: r.reason, target: Math.round(r.target), y: Math.round(r.y), max: Math.round(r.max), path: location.pathname }) }

// ── stand-ins ─────────────────────────────────────────────────────────────────────────────────────────
const TARGETS = [
  { key: 'event', to: `/events/${DEEP_EVENT_ID}`, label: 'A harvest event (EventDetail)' },
  { key: 'location', to: `/locations/${DEEP_LOCATION_ID}`, label: 'Bag Area zone (LocationDetail)' },
  { key: 'about', to: '/about', label: 'About' },
  { key: 'achievements', to: '/achievements', label: 'Achievements' },
]
function TodayStandIn() {
  const link = (to, id, text) => <Link to={to} data-testid={id} style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>{text}</Link>
  return (
    <div style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Today</h1>
      {link('/deep', 'harness-to-deep', 'A long list')}
      {link(`/plantings/${PLANTING_ID}`, 'harness-to-planting', 'Ristra planting')}
      {link('/locations', 'harness-to-locations', 'Zones')}
      {link('/put-up', 'harness-to-putup', 'Put-Up')}
      {link('/seeds?view=saved', 'harness-to-saved', 'Saved seeds')}
      {link(`/seeds?view=saved&lot=${RISTRA_ID}`, 'harness-to-saved-lot', 'Saved seeds, at the Ristra lot')}
      {link('/seeds?view=mine', 'harness-to-mine', 'My seeds')}
      {link(`/inventory/${RISTRA_ID}`, 'harness-to-lot', 'The Ristra lot')}
      {link('/chain/1', 'harness-to-chain', 'Page 1 of a chain')}
    </div>
  )
}
// The long list. `sort` is a same-page control, sticky under the top bar so it can be tapped from deep:
// it REPLACEs /deep?sort=… — a new history key on the same pathname, which must move nothing. The row
// count is the gate's to change (__h.setDeepRows): the page rendering shorter behind a sheet.
let setDeepRowsExternal = null
function DeepListStandIn() {
  const navigate = useNavigate()
  const loc = useLocation()
  const [rows, setRows] = useState(80)
  // `gen` re-keys every row: a refetch that blanks and re-renders the list, so no row node survives it.
  const [gen, setGen] = useState(0)
  setDeepRowsExternal = (n, regen) => { setRows(n); if (regen) setGen((g) => g + 1) }
  const sort = Number(new URLSearchParams(loc.search).get('sort') || 0)
  return (
    <div style={{ padding: '0 16px 20px' }}>
      <div style={{ position: 'sticky', top: TOP_CHROME_PX, zIndex: 5, background: '#faf8f3', padding: '8px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem', flex: 1 }}>A long list</h1>
        <button type="button" data-testid="deep-sort" onClick={() => navigate(`/deep?sort=${sort + 1}`, { replace: true })}
          style={{ minHeight: 44, minWidth: 88 }}>Sort ({sort})</button>
      </div>
      {Array.from({ length: rows }, (_, i) => {
        const t = TARGETS[i % TARGETS.length]
        return (
          <Link key={`${gen}-${i}`} to={t.to} data-testid="deep-row" data-target={t.key} data-row={i}
            style={{ display: 'flex', alignItems: 'center', minHeight: 64, boxSizing: 'border-box', padding: '0 12px', borderBottom: '1px solid #d4c9be', color: '#2f3b2f', textDecoration: 'none' }}>
            {i + 1}. {t.label}
          </Link>
        )
      })}
    </div>
  )
}
// Twenty-five long pages in a row: /chain/n → /chain/n+1 from any row. No fetch, so each page is its full
// height at once — what these measure is the store's depth, not a loading phase.
const CHAIN_ROWS = 50
function ChainStandIn() {
  const { n } = useParams()
  const next = Number(n) + 1
  return (
    <div style={{ padding: '0 16px 20px' }}>
      <h1 style={{ margin: '8px 0', fontSize: '1.3rem' }}>Chain page {n}</h1>
      {Array.from({ length: CHAIN_ROWS }, (_, i) => (
        <Link key={i} to={`/chain/${next}`} data-testid="chain-row" data-row={i}
          style={{ display: 'flex', alignItems: 'center', minHeight: 64, boxSizing: 'border-box', padding: '0 12px', borderBottom: '1px solid #d4c9be', color: '#2f3b2f', textDecoration: 'none' }}>
          Page {n}, row {i + 1} → page {next}
        </Link>
      ))}
    </div>
  )
}
function LeftThePage() {
  const loc = useLocation()
  return <div data-testid="harness-left-page">left the page for {loc.pathname}</div>
}

// App.jsx's OverlayHost, line for line (seedsscroll.jsx carries the same copy; gate:seeds-scroll checks that
// one for drift against App.jsx, and gate:page-scroll checks this one against it).
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
// Search's PEEK, as Search.jsx opens it (openPeek): a swap PUSH to /search?peek=… carrying the same
// background — the one in-overlay navigation that grows history, so the system Back returns to the results.
function SearchStandIn() {
  const swap = useOverlaySwap()
  const loc = useLocation()
  const peek = new URLSearchParams(loc.search).get('peek')
  return (
    <div data-testid="harness-search" style={{ padding: '8px 0' }}>
      {peek && <div data-testid="harness-search-peeked" style={{ padding: '8px 20px' }}>Peeking at {peek}</div>}
      {TARGETS.filter((t) => t.key === 'event' || t.key === 'location').map((t) => (
        <Link key={t.key} to={t.to} data-testid={`harness-search-${t.key}`}
          style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 20px', color: '#2f3b2f', textDecoration: 'none' }}>{t.label}</Link>
      ))}
      <button type="button" data-testid="harness-search-peek" onClick={() => swap(`/search?peek=${DEEP_EVENT_ID}`, { replace: false, state: { peekPushed: true } })}
        style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 20px', background: 'none', border: 'none' }}>Peek</button>
    </div>
  )
}

// BottomNav's shape: three tab links, the + sheet (its "Add a planting" row, a page navigation) and the
// More sheet, both ARMED. Rows are real SheetRowLinks.
const MORE_ROWS = [['locations', '/locations', 'Zones'], ['achievements', '/achievements', 'Achievements'], ['about', '/about', 'About']]
function BottomNavStandIn() {
  const [more, setMore] = useState(false)
  const [create, setCreate] = useState(false)
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--bottom-nav-height', `${BOTTOM_NAV_HEIGHT_PX}px`)
  }, [])
  const tab = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, color: '#2f3b2f', textDecoration: 'none', fontSize: '0.8rem', background: 'none', border: 'none' }
  const row = { display: 'flex', alignItems: 'center', minHeight: 48, padding: '12px 24px' }
  return (
    <>
      <nav aria-label="Main navigation"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX, zIndex: 100,
          background: '#fff', borderTop: '1px solid #d4c9be', boxSizing: 'border-box', display: 'flex', alignItems: 'center' }}>
        <Link to="/today" data-testid="harness-tab-today" style={tab}>Today</Link>
        <Link to="/harvests" data-testid="harness-tab-harvests" style={tab}>Harvests</Link>
        <Link to="/garden" data-testid="harness-tab-garden" style={tab}>Garden</Link>
        <button type="button" data-testid="harness-plus" onClick={() => setCreate((s) => !s)} style={tab}>+</button>
        <button type="button" data-testid="harness-more" onClick={() => setMore((s) => !s)} style={tab}>More</button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} ariaLabel="More navigation options" armsBack>
        {MORE_ROWS.map(([k, to, label]) => (
          <SheetRowLink key={k} to={to} onClick={() => setMore(false)} data-testid={`harness-more-${k}`} style={row}>{label}</SheetRowLink>
        ))}
      </Sheet>
      <Sheet open={create} onClose={() => setCreate(false)} ariaLabel="Create new" armsBack>
        <SheetRowLink to="/garden?add=1" onClick={() => setCreate(false)} data-testid="harness-create-planting" style={row}>Add a planting</SheetRowLink>
      </Sheet>
    </>
  )
}
// Every page in a route boundary with a visible marker, so a page that throws is named, never measured.
const routeEl = (el) => (
  <ErrorBoundary scope="route" fallback={<div data-testid="harness-route-fallback">route fallback</div>}>{el}</ErrorBoundary>
)
// Which page the tree is showing, by path.
const PAGE_OF = [
  [/^\/today$/, 'today'], [/^\/deep$/, 'deep'], [/^\/chain\/\d+$/, 'chain'], [/^\/events\/[^/]+$/, 'event'],
  [/^\/plantings\/[^/]+$/, 'planting'], [/^\/locations$/, 'locations'], [/^\/locations\/[^/]+$/, 'location'],
  [/^\/harvests$/, 'harvests'], [/^\/achievements$/, 'achievements'], [/^\/about$/, 'about'], [/^\/garden$/, 'garden'],
  [/^\/put-up$/, 'putup'], [/^\/seeds$/, 'seeds'], [/^\/inventory\/[^/]+$/, 'lot'], [/^\/varieties\/[^/]+\/edit$/, 'variety'],
]
const pageKeyOf = (path) => (PAGE_OF.find(([re]) => re.test(path)) || [null, null])[1]
// The page tree's path: the overlay's background while one is open (history.state.usr.background).
const pagePath = () => { try { return window.history.state?.usr?.background?.pathname || location.pathname } catch { return location.pathname } }

// AppShell's shape, with AppShell's manager call.
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  const navigationType = useNavigationType()
  // ?auth=: the user is unresolved for AUTH_MS at every load (Protected's skeleton; App.jsx passes !loading).
  const [authed, setAuthed] = useState(AUTH_MS <= 0)
  React.useEffect(() => {
    if (authed) return undefined
    const t = setTimeout(() => setAuthed(true), AUTH_MS)
    return () => clearTimeout(t)
  }, [authed])
  const pageScroll = usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready: authed, onDecision, onRestore })
  return (
    <PageScrollProvider value={pageScroll}>
      <header data-app-chrome="top"
        style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
          background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 8, gap: 8 }}>
        <Link to="/deep" data-testid="harness-header-deep" style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 8px' }}>List</Link>
        <OverlayLink to="/search" aria-label="Search your garden" data-testid="harness-open-search"
          style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⌕</OverlayLink>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh',
        paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' }}>
        <div data-harness-pages="" style={{ flex: 1 }}>
          {!authed ? <div data-testid="harness-skeleton" style={{ minHeight: `calc(100dvh - ${TOP_CHROME_PX}px)` }}>Loading…</div> : (
          <Routes location={pageLocation}>
            <Route path="/today" element={routeEl(<TodayStandIn />)} />
            <Route path="/deep" element={routeEl(<DeepListStandIn />)} />
            <Route path="/chain/:n" element={routeEl(<ChainStandIn />)} />
            <Route path="/events/:eventId" element={routeEl(<EventDetail />)} />
            <Route path="/plantings/:plantingId" element={routeEl(<PlantingDetail />)} />
            <Route path="/locations" element={routeEl(<Locations />)} />
            <Route path="/locations/:id" element={routeEl(<LocationDetail />)} />
            <Route path="/harvests" element={routeEl(<Harvests />)} />
            <Route path="/achievements" element={routeEl(<Achievements />)} />
            <Route path="/about" element={routeEl(<About />)} />
            <Route path="/garden" element={routeEl(<Garden />)} />
            <Route path="/put-up" element={routeEl(<PutUp />)} />
            <Route path="/seeds" element={routeEl(<Seeds />)} />
            <Route path="/inventory/:id" element={routeEl(<InventoryDetail />)} />
            <Route path="/varieties/:varietyId/edit" element={routeEl(<VarietyEdit />)} />
            <Route path="*" element={<LeftThePage />} />
          </Routes>
          )}
        </div>
      </div>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<HarnessOverlayHost ariaLabel="Search your garden" size="peek"><SearchStandIn /></HarnessOverlayHost>} />
        </Routes>
      )}
      <BottomNavStandIn />
    </PageScrollProvider>
  )
}

// Start on /today, so every source page is itself a PUSH from an earlier entry. A requested reload goes back
// to the router URL it was on, keeping the entry's state (see the header).
if (RELOAD_TO) window.history.replaceState(window.history.state, '', RELOAD_TO)
else window.history.replaceState(null, '', '/today')
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

// What "the page's content has landed" means per page — the gate waits on it, then for the scroll to hold
// still. Each reads the page's real DOM, never a harness flag.
const page = () => document.querySelector('[data-harness-pages]')
const text = () => page()?.textContent || ''
const count = (sel) => document.querySelectorAll(sel).length
const READY = {
  today: () => !!document.querySelector('[data-testid="harness-to-deep"]'),
  deep: () => count('[data-testid="deep-row"]') > 0,
  chain: () => count('[data-testid="chain-row"]') === CHAIN_ROWS,
  event: () => !!document.querySelector('h1') && !!document.querySelector('[data-testid="event-photos"]'),
  planting: () => !!document.querySelector('h1') && !!document.querySelector('a[href^="/events/"]'),
  location: () => !!document.querySelector('h1') && !!document.querySelector('[data-testid="location-photo-grid"]'),
  locations: () => count('a[href^="/locations/"]') === LOCATIONS.length,
  harvests: () => /Pepper/.test(text()) && /Potato/.test(text()),
  achievements: () => /Locked badge 30/.test(text()),
  about: () => !!document.querySelector('h1'),
  garden: () => count('[data-testid="planting-tile"]') === GARDEN_PLANTS.length,
  putup: () => count('[data-testid="going-batch"]') === GOING.length || !!document.querySelector('[data-testid="batch-detail-view"][data-batch-id]'),
  seeds: () => !!document.querySelector('[data-testid="saved-seeds-view"] [data-testid="seed-lot-card"]') || !!document.querySelector('[data-testid="my-seeds-view"] [data-testid="facet-group-header"]'),
  lot: () => !!document.querySelector('form') && !!document.querySelector('h1') && !!document.querySelector('[data-testid="edit-sow-details"]'),
  variety: () => /Edit Ristra Cayenne II/.test(text()) && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Cancel'),
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
  key: () => { try { return window.history.state?.key ?? null } catch { return null } },
  idx: () => { try { return window.history.state?.idx ?? null } catch { return null } },
  mode: () => { try { return window.history.scrollRestoration } catch { return null } },
  mark: () => { trace.length = 0; decisions.length = 0; restores.length = 0; return true },
  trace: () => trace.slice(),
  decisions: () => decisions.slice(),
  restores: () => restores.slice(),
  authed: () => !document.querySelector('[data-testid="harness-skeleton"]'),
  startSampling: () => { samples = []; sampleT0 = performance.now(); sampling = true; requestAnimationFrame(sampleFrame); return true },
  stopSampling: () => { sampling = false; return samples ? samples.slice() : [] },
  // The manager's mirror, for failure messages only.
  store: () => { try { return JSON.parse(window.sessionStorage.getItem(PAGE_SCROLL_STORE_KEY)) } catch { return null } },
  // The page rendering shorter (and back) while a sheet covers it.
  setDeepRows: (n, regen = false) => { if (!setDeepRowsExternal) return false; setDeepRowsExternal(n, regen); return true },
  // The manager's store emptied, both halves: the state of every entry the previous bundle wrote.
  forgetPageScroll: () => { __resetPageScrollStore(); return true },
  // useScrollRestore's store emptied, both halves: an entry the hook cannot restore (evicted past its 20, or
  // written before the hook existed), so the manager is the one restoring it.
  forgetScrollRestore: () => { __resetScrollRestoreStore(); return true },
  reloadHere: () => {
    window.sessionStorage.setItem(RELOAD_TO_KEY, location.pathname + location.search + location.hash)
    window.history.replaceState(window.history.state, '', HARNESS_URL)
    location.reload()
    return true
  },
  reloadedDoc: () => !!RELOAD_TO,
  fixture: () => ({ manager: SCROLL_MANAGER_ENABLED, ms: MS, auth: AUTH_MS, gardenPlants: GARDEN_PLANTS.length, going: GOING.length, locations: LOCATIONS.length, plantingEvents: PLANTING_EVENTS.length, chainRows: CHAIN_ROWS }),
}
