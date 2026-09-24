// V5-SEEDSTAB-001 follow-up — the seed detail page (/inventory/:id, src/pages/InventoryDetail.jsx) at
// Dave's geometry, for scripts/layout-gate/seed-detail-shot.mjs (gate:seed-detail).
//
// Why this entry exists: the Seeds release gave the packet page five controls and a card — "Sow this"
// (it opens THE Sow sheet in place), the "Sown ✓ · See the planting" line a sow from here leaves, "Edit
// sow details →", the "Sown from this packet" card with one 44px row link per planting, and the F2
// breeding fact on a lot saved off an F1 plant — and no gate rendered /inventory/:id at all (pre-ship
// QA, IMPORTANT #1). The only 360px look was a throwaway harness from before the card existed. jsdom
// returns 0 from every getBoundingClientRect(), so the unit suites can pin a style string and never a
// box: they cannot say whether the card's rows fit at 360px, or whether a row that wraps stays whole.
//
//   http://localhost:5311/tests/harness/seeddetail.html?case=packet
//     case=packet   a BOUGHT packet with stock, two plantings sown from it (sown_from), a germination
//                   record and a packet photo. The gate's "sown" state is this same page after a REAL
//                   sow: it taps Sow this, then the sheet's Add planting, and measures the page the
//                   create leaves ("Sown ✓ · See the planting").
//     case=f2       a lot SAVED off an F1 plant, still DRYING: no Sow this (the lot is in process), the
//                   Breeding fact reads the F2 words, "Change stage in Saved seeds →" is the way on,
//                   and nothing was sown from it yet (sown_from is [], so no card). No packet photo, so
//                   the box is the "Add packet photo" button.
//     topbar=52     the top-chrome stand-in's height; the gate passes TopChrome.jsx's BAR_H
//     verdict=0     hide the measurement bar, for a screenshot of the surface alone
//     remove=refuse the item's DELETE answers 409 with the sentence the Lambda sends when plantings were
//                   sown from the packet (BUG-INVREFSTRAND-001) — built by the Lambda's own
//                   blockingMessage, so the gate measures the real words' length. Without it a DELETE
//                   answers 200 and the page leaves (the "left the page" marker).
//
// THE APP'S CHROME IS MOUNTED, as in seeds.jsx: App.jsx renders TopChrome (sticky, BAR_H) above every
// signed-in route and <BottomNav /> fixed at BOTTOM_NAV_HEIGHT_PX below it. Both stand-ins carry the
// real elements' tag and label, no controls, and exactly the real heights; the gate checks the heights.
//
// THE REAL PAGE, THE REAL SHEET. <InventoryDetail /> is mounted at /inventory/:id in a MemoryRouter
// under the real AuthProvider (the Clerk stub signs a user in, so the page's Favorite toggle renders as
// it does for Dave) and the real ToastProvider. window.fetch is stubbed at the network layer, so the
// real useApiFetch, SowSheet, PlantingEditor, PlantingSelect and SeedStageHistory run and only the far
// side of the wire is faked. Any other route renders a marker the gate refuses ("left the page").
// No DismissRegistryProvider, like seeds.jsx: an armed Sheet would push window.history entries, and the
// harness has no router listening to them.
//
// FIXTURE — each property is here for a named check:
//   · sown_from carries TWO plantings, newest sowing first as the route orders them, one with the
//     longest planting-name shape (a cultivar, a bed and a note) so the row's name has to WRAP inside
//     the row at 360px — "whole" is then a real question — and one short.
//   · the packet's supplier is a registry row the palette knows (Johnny's: a stripe and a chip), with a
//     packet URL, a germination record (one counted sowing; see the note on it below), and a real
//     (local) packet photo.
//   · the F2 lot carries breeding_system 'f1', a parent planting and a seed_stage of drying, with
//     stock on hand, so "no Sow this" is decided by the process and not by an empty jar.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import InventoryDetail from '../../src/pages/InventoryDetail.jsx'
import { etDay } from '../../src/lib/harvestSummary.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { blockingMessage } from '../../lambda/inventory-items/delete-guard.js'

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'packet'
const TOP_CHROME_PX = Number(q.get('topbar') || 52)
const REMOVE_REFUSES = q.get('remove') === 'refuse'
// The longest shape the sentence takes for a packet: two plantings, one of them archived.
const REFUSAL = blockingMessage([{ table: 'plants', count: 2, archived: 1 }], 'seeds')

// Every load is a first visit: the page's Sow sheet stash ('sow-packet') lives in sessionStorage, and
// a stash left by an interrupted earlier load would reopen the sheet on this one.
try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ }

const DAY = 86400000
// An Eastern calendar date `n` days back, at 16:00Z (seeds.jsx's stageDaysAgo).
const stageDaysAgo = (n) => `${new Date(Date.parse(`${etDay(new Date())}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10)}T16:00:00Z`
const LOAD = Date.now().toString(36)

const SOURCES = [{ id: 'src-johnny', name: "Johnny's Selected Seeds" }, { id: 'src-bentley', name: 'Bentley Seeds' }]

// GET /api/inventory-items/:id — `i.*`, the cultivar facts the route joins, the effective packet photo
// and the two seeds-only reads (germination, sown_from). Every column the page reads is present,
// nulled when unset.
const row = (over) => ({
  type: 'consumable', category: 'seeds', status: 'active', unit: 'packet', quantity: null,
  reorder_threshold: null, reorder_quantity: null, condition: null, unit_cost: null, quantity_purchased: null,
  purchase_date: null, source: null, source_url: null, source_id: null, acquired_from_source_id: null,
  brand: null, model: null, location_text: null, notes: null, year_harvested: null,
  seed_stage: null, seed_process: null, stage_entered_at: null, source_plant_id: null, source_kind: null,
  seed_count: null, seed_weight_g: null, seed_count_estimated: null, sow_archived_season: null, metadata: {},
  crop_slug: null, scoville_min: null, scoville_max: null, scoville_source: null, origin_country: null,
  origin_region: null, species: null, breeding_system: null, days_to_maturity_min: null,
  days_to_maturity_max: null, dtm_basis: null, variety_source_url: null,
  featured_photo_id: null, hero_photo_id: null, featured_is_explicit: false, featured_photo_view_url: null,
  germination: null, sown_from: null,
  created_at: stageDaysAgo(250), updated_at: stageDaysAgo(3),
  ...over,
})

const PACKET = row({
  id: 'pkt-sungold', name: 'Sungold F1 tomato seeds', variety_id: 'var-sungold', variety_name: 'Sungold F1',
  quantity_on_hand: 1, unit_cost: '4.95', quantity_purchased: 1, purchase_date: '2026-01-14',
  source_id: 'src-johnny', source: "Order #4411 rec'd 01/14",
  source_url: 'https://www.johnnyseeds.com/vegetables/tomatoes/cherry-tomatoes/sungold-f1-tomato-seed-2525.html',
  location_text: 'Seed tin, shelf 2',
  crop_slug: 'tomato', species: 'Solanum lycopersicum', breeding_system: 'f1',
  days_to_maturity_min: 57, days_to_maturity_max: 65, dtm_basis: 'from-transplant',
  featured_photo_id: 'photo-sungold', hero_photo_id: 'photo-sungold', featured_is_explicit: true,
  featured_photo_view_url: `/tests/harness/seeds-packets/packet-tall.png?p=sungold&tier=full&load=${LOAD}`,
  // ONE counted sowing, so the panel shows its rate and counts and not its per-sowing list. That list
  // (2+ counted sowings) WIDENS THE PAGE when a planting's name is long: its rows are nowrap flex rows in
  // a `display: grid` with no template, so the grid's auto column takes a row's full min-content (477px
  // measured at 360 and 390 with the bed's name below) and the document scrolls sideways. Latent on prod
  // (0 counted sowings on 2026-09-23), outside this gate's brief, and reported as a finding
  // (lane-seedpolish-20260924); give the bed a count here once it is fixed.
  germination: {
    sowings: [
      { id: 'pl-sungold-pot', name: 'Sungold pot 4', sown_at: '2026-06-18', seeds_sown: 10, seeds_germinated: 6 },
    ],
    seeds_sown: 10, seeds_germinated: 6, rate: 60,
  },
  // Newest sowing first, as the route's ORDER BY p.sown_at DESC NULLS LAST returns them.
  sown_from: [
    { id: 'pl-sungold-pot', name: 'Sungold pot 4', sown_at: '2026-06-18', status: 'vegetative' },
    { id: 'pl-sungold-bed', name: 'Sungold F1 — raised bed 3, north end, second sowing', sown_at: '2026-04-02', status: 'harvested' },
  ],
})

const F2_LOT = row({
  id: 'lot-thai', name: 'Thai Dragon — saved 2026', variety_id: 'var-thai', variety_name: 'Thai Dragon',
  quantity_on_hand: 1, year_harvested: new Date().getFullYear(),
  seed_stage: 'drying', seed_process: 'wet', stage_entered_at: stageDaysAgo(4), source_plant_id: 'pl-thai',
  seed_count: 175, seed_count_estimated: false,
  crop_slug: 'pepper', scoville_min: 50000, scoville_max: 100000, species: 'Capsicum annuum',
  origin_country: 'Thailand', breeding_system: 'f1', days_to_maturity_min: 90, days_to_maturity_max: 90,
  germination: { sowings: [], seeds_sown: 0, seeds_germinated: 0, rate: null },
  sown_from: [],
})

const ITEMS = { [PACKET.id]: PACKET, [F2_LOT.id]: F2_LOT }
const CASES = { packet: PACKET.id, f2: F2_LOT.id }
const ITEM_ID = CASES[CASE] ?? PACKET.id

// The lot's processing log (GET /:id/seed-stage), newest entry first as the route orders it.
const STAGE_LOG = {
  [F2_LOT.id]: [
    { id: 'st-2', stage: 'drying', entered_at: stageDaysAgo(4), note: null },
    { id: 'st-1', stage: 'fermenting', entered_at: stageDaysAgo(7), note: 'Water changed on day 2.' },
  ],
  [PACKET.id]: [],
}

// The picker projection (/api/plants?view=picker): the parent of the F2 lot and the plantings sown
// from the packet, so "Saved from" resolves a name for the lot and offers the packet's cultivar.
const PLANTINGS = [
  { id: 'pl-thai', name: 'Thai Dragon, bed 1', quantity: 1, variety_id: 'var-thai', variety_ref: { name: 'Thai Dragon' }, sown_at: '2026-03-02', succession_order: null, project_name: null },
  { id: 'pl-sungold-pot', name: 'Sungold pot 4', quantity: 1, variety_id: 'var-sungold', variety_ref: { name: 'Sungold F1' }, sown_at: '2026-06-18', succession_order: 2, project_name: null },
  { id: 'pl-sungold-bed', name: 'Sungold F1 — raised bed 3, north end, second sowing', quantity: 3, variety_id: 'var-sungold', variety_ref: { name: 'Sungold F1' }, sown_at: '2026-04-02', succession_order: 1, project_name: null },
]
const VARIETIES = {
  'var-sungold': { id: 'var-sungold', name: 'Sungold F1', display_name: 'Sungold F1', crop_type_slug: 'tomato' },
  'var-thai': { id: 'var-thai', name: 'Thai Dragon', display_name: 'Thai Dragon', crop_type_slug: 'pepper' },
}
const LOCATIONS = [
  { id: 'loc-beds', name: 'Raised beds', path: 'Raised beds', covered: false },
  { id: 'loc-house', name: 'House', path: 'House', covered: true },
]

// Stub at the network layer. Order matters: /seed-stage and every sub-route also contain the item path.
const realFetch = window.fetch
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
const hits = {}
const posts = []
const unstubbed = []
window.fetch = (url, opts = {}, ...rest) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  const hit = (k, body, status) => { hits[k] = (hits[k] ?? 0) + 1; return json(body, status) }
  if (!u.includes('/api/')) return realFetch(url, opts, ...rest)
  if (u.includes('/api/photos/view-url/')) return hit('view-url', { view_url: PACKET.featured_photo_view_url, expires_in: 900, tier: 'full' })
  // The sow: PlantingEditor's create. The row it answers is what the page's "See the planting" links to.
  if (method === 'POST' && /\/api\/plants(\?|$)/.test(u)) {
    posts.push(JSON.parse(opts.body || '{}'))
    return hit('plant-create', { id: 'pl-new', name: JSON.parse(opts.body || '{}').name ?? null, status: 'seed' }, 201)
  }
  // The page's own delete. Refused on remove=refuse, exactly as the Lambda answers a sown packet.
  if (method === 'DELETE' && /\/api\/inventory-items\/[^/?]+(\?|$)/.test(u)) {
    return REMOVE_REFUSES
      ? hit('item-delete', { error: REFUSAL, blocking: [{ table: 'plants', column: 'source_inventory_item_id', count: 2 }] }, 409)
      : hit('item-delete', { ok: true })
  }
  if (method !== 'GET') return hit('write', { ok: true })
  const stage = u.match(/\/api\/inventory-items\/([^/?]+)\/seed-stage/)
  if (stage) return hit('seed-stage', STAGE_LOG[stage[1]] ?? [])
  const item = u.match(/\/api\/inventory-items\/([^/?]+)(\?|$)/)
  if (item) return ITEMS[item[1]] ? hit('item', ITEMS[item[1]]) : hit('item-404', { error: 'Not found' }, 404)
  // The inventory list useInventory loads for its update/delete helpers.
  if (/\/api\/inventory-items(\?|$)/.test(u)) return hit('inventory-list', Object.values(ITEMS))
  if (u.includes('/api/varieties/sources')) return hit('sources', SOURCES)
  if (u.includes('/api/varieties/source-kinds')) return hit('source-kinds', [])
  if (u.includes('/api/varieties/crop-types')) return hit('crop-types', [{ slug: 'tomato', display_name: 'Tomato' }, { slug: 'pepper', display_name: 'Pepper' }])
  const variety = u.match(/\/api\/varieties\/([^/?]+)(\?|$)/)
  if (variety) return VARIETIES[variety[1]] ? hit('variety', VARIETIES[variety[1]]) : hit('variety-404', { error: 'Not found' }, 404)
  if (u.includes('/api/varieties')) return hit('varieties', Object.values(VARIETIES))
  if (u.includes('/api/locations')) return hit('locations', LOCATIONS)
  if (u.includes('/api/projects')) return hit('projects', [{ id: 'proj-beds', name: 'Raised beds' }])
  if (u.includes('/api/plants')) return hit('plants', PLANTINGS)
  if (u.includes('/api/favorites')) return hit('favorites', [])
  // Anything else the page (or the boot-time cache warm) asks for answers an empty list, and is
  // RECORDED: the gate prints the list, so a new request this fixture does not know is visible.
  unstubbed.push(`${method} ${u.replace(location.origin, '')}`)
  return hit('unstubbed', [])
}

// Anything the page throws on the way up is recorded, and the gate refuses to measure past it.
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

const settle = () => new Promise((r) => setTimeout(r, 160))

// A route the page should never reach under the gate: a tap that navigated leaves this marker.
function LeftThePage() {
  const loc = useLocation()
  return <div data-testid="harness-left-page">left the page for {loc.pathname}</div>
}

// "The page has arrived": the form is up (its Name field carries the item's name) and, on a seed row,
// the sources registry has resolved the supplier chip's name, and the stage history has answered.
const arrived = () => {
  const item = ITEMS[ITEM_ID]
  const name = [...document.querySelectorAll('input')].some((i) => i.value === item.name)
  const hist = document.querySelector('[data-testid="seed-stage-history"]')
  const history = !!hist && !/Loading/.test(hist.textContent || '')
  const supplier = !item.source_id || hits.sources > 0
  return name && history && supplier
}

async function run() {
  createRoot(document.getElementById('root')).render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/inventory/${ITEM_ID}`]}>
        <ToastProvider>
          {/* TopChrome's box, exactly: sticky, BAR_H tall, border-box, above the route (App.jsx). */}
          <header data-app-chrome="top"
            style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
              background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', alignItems: 'center',
              padding: '0 14px', font: '10px ui-monospace, monospace', color: '#8a8a8a' }}>
            TopChrome stand-in ({TOP_CHROME_PX}px)
          </header>
          <Routes>
            <Route path="/inventory/:id" element={<InventoryDetail />} />
            <Route path="*" element={<LeftThePage />} />
          </Routes>
          {/* The real element's tag and label, like seeds.jsx: App.jsx renders <BottomNav /> fixed. */}
          <nav aria-label="Main navigation"
            style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX,
              zIndex: 100, background: '#fff', borderTop: '1px solid #d4c9be', display: 'flex',
              alignItems: 'center', justifyContent: 'center', font: '10px ui-monospace, monospace',
              color: '#8a8a8a' }}>
            BottomNav stand-in ({BOTTOM_NAV_HEIGHT_PX}px)
          </nav>
        </ToastProvider>
      </MemoryRouter>
    </AuthProvider>,
  )
  await settle()
  for (let i = 0; i < 40 && !arrived(); i++) await settle()
  await settle()

  window.__h = {
    ready: () => true,
    arrived: () => arrived(),
    errors: () => [...errors],
    hits: () => ({ ...hits }),
    posts: () => posts.map((p) => ({ ...p })),
    unstubbed: () => [...unstubbed],
    refusal: () => (REMOVE_REFUSES ? REFUSAL : null),
    fixture: () => ({ case: CASE, itemId: ITEM_ID, name: ITEMS[ITEM_ID].name, sownFrom: ITEMS[ITEM_ID].sown_from.length }),
    all: measure,
  }
  paint()
}

// The human-facing bar only. The assertions live in scripts/layout-gate/seed-detail-shot.mjs, which
// reads the same DOM through CDP.
function measure() {
  const de = document.documentElement
  return {
    case: CASE,
    vw: window.innerWidth, vh: window.innerHeight,
    hscroll: de.scrollWidth > de.clientWidth, scrollW: de.scrollWidth,
    sowThis: !!document.querySelector('[data-testid="sow-this"]'),
    sown: !!document.querySelector('[data-testid="sow-this-sown"]'),
    sownFromRows: document.querySelectorAll('[data-testid="sown-from-link"]').length,
    errors: errors.length,
  }
}

function paint() {
  const m = measure()
  if (q.get('verdict') === '0') {
    document.getElementById('verdict').remove()
    document.getElementById('root').style.paddingTop = '0px'
    return
  }
  const el = document.getElementById('verdict')
  el.textContent = [
    `case=${m.case}  vw=${m.vw}x${m.vh}  scrollW=${m.scrollW}  hscroll=${m.hscroll ? 'YES' : 'no'}  errors=${m.errors}`,
    `sow this=${m.sowThis}  sown line=${m.sown}  sown-from rows=${m.sownFromRows}`,
  ].join('\n')
  el.style.background = m.hscroll || m.errors ? '#b94a3a' : '#4a7c59'
}

run()
