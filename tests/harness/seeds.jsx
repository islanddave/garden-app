// V5-SEEDSTAB-001 — the WHOLE Seeds page at Dave's geometry: /seeds?view=mine|saved|sow.
//
// Why this entry exists: the Seeds page (src/pages/Seeds.jsx) is one shell over three views — a title
// with a per-view action slot, a SegmentedControl view switch, the ferment line, then ONE view body
// (My seeds, or Saved seeds / Sow now rendered `embedded`). Its vitest suites are green, and jsdom
// returns 0 from every getBoundingClientRect(), so none of them can say whether the switch fits on one
// line at 360px, whether the header's title and actions share a row, whether a My seeds row's second
// line wraps under a 44-character name with two chips, how many folded crop headers are on the first
// screen, or whether a packet thumbnail keeps its box when the image lands.
// scripts/layout-gate/seeds-page-shot.mjs asks exactly those questions of this entry.
//
// MY SEEDS STARTS FOLDED (V5-SEEDCARDS-001): a fresh session renders crop HEADERS and no rows. The
// gate taps the Pepper header, then Expand all, to reach the rows — so "arrived" for My seeds is the
// headers plus the supplier chip row, never "a row exists".
//
//   http://localhost:5311/tests/harness/seeds.html?view=mine
//     view=mine|saved|sow   the view the page opens on — it goes into the router URL, so the page
//                           resolves it exactly as prod does (Seeds.jsx resolveView)
//     topbar=52             height of the top-chrome stand-in; the gate passes TopChrome.jsx's BAR_H
//     verdict=0             hide the measurement bar, for a screenshot of the surface alone
//
// THE APP'S CHROME IS MOUNTED, because on /seeds it is on screen. App.jsx renders TopChrome — a
// sticky 52px bar (TopChrome.jsx BAR_H) — above every signed-in route, and <BottomNav /> fixed at
// BOTTOM_NAV_HEIGHT_PX below it; TodayBand is off (TODAY_BAND_HIDDEN). My seeds already says so in its
// own styles: its crop group headers stick at `top: 52`, under that bar. Leave both out and "how many
// rows are on the first screen" is answered for 640px of page that the phone never shows — 108px of
// it is chrome. Both stand-ins carry the real elements' tag and label (the same convention as
// putupclose.jsx), no controls, and exactly the real heights, and the gate checks those heights.
//
// FIXTURE — the brief's shape, and each property is here to exercise a named check:
//   · 28 seed rows over 8 crops, pepper-dominant then tomato, with a tail — the prod distribution's
//     shape (pepper 103 and tomato 52 of 327 on 2026-09-19), scaled down. Pepper and Tomato are the
//     two most-counted crops, so they are the crop chips pinned in the chip row AND the first two
//     folded headers (UX spec §3.2: pinned crops first, then A→Z).
//   · THE WORST ROW: "Money Plant (self-saved, variety unrecorded)" — 44 characters, the longest
//     displayed name in the real seed set (seedssaved.jsx) — as a saved lot FERMENTING FOR 5 DAYS
//     and ARCHIVED FOR THIS SEASON, so its second line carries two chips ("Ferment · day 5",
//     "Archived for this season") before its facts, and the ferment line under the switch names it.
//     Day 5 is FERMENT_ALARM_DAYS, so the line reads "overdue" — its longest wording, and the line
//     is two lines tall, which is the first-screen budget's worst day (UX spec §4.7).
//   · SUPPLIERS from the REGISTRY (source_id -> /api/varieties/sources) whose names hit the curated
//     palette (src/lib/supplierPalette.js) — Botanical Interests and Bentley Seeds lead by count, as
//     they do on prod (139 and 53), so they are the two pinned supplier chips — plus Johnny's,
//     Sandia, and ONE supplier the palette does not know (Fedco Seeds: a fallback slot, a
//     default-rule short label). `source` holds an ORDER REFERENCE, which is what prod keeps there
//     — the page must print the supplier, never the order text. Five rows have no supplier (four
//     saved lots and a packet whose vendor was never entered): no chip, no stripe, and the thumbnail
//     must still start at the same x as a striped row's.
//   · HEAT on the peppers, from the cultivar facts the list row carries: a sweet 0–0 ("Sweet · 0
//     SHU"), ranges up to the longest label ("1.2M–2M SHU"), a single known bound, a pepper with NO
//     figure (renders no heat), and the saved pepper lot (its heat is always an estimate: "est.").
//   · PACKET PHOTOS: hero_photo_id + a thumb and a full URL per photo, each DISTINCT (?p=<n>, as a
//     presigned URL is distinct per photo, so the HTTP cache cannot collapse N photos into one), on
//     three small local images of different shapes (tall, wide, square — a box that followed the
//     image would change size), plus ONE BROKEN URL (a path nothing serves) and rows with no photo
//     at all. Every URL also carries a per-LOAD token, so no navigation is ever answered from the
//     previous one's memory cache: the gate holds these requests to measure the boxes BEFORE any
//     image has landed, and a cached image would land synchronously and skip that state.
//     /api/photos/view-url/ answers 404, so the broken photo's one re-mint ends TERMINAL, as a
//     deleted photo does on prod, rather than retrying forever against the dev server.
//   · A used-up packet (quantity 0), which My seeds files under "Sowed previously".
//   · An identical pair (same cultivar, vendor, year and count) with a LONG name, so line 1 carries
//     the ordinal ("1 of 2 identical") beside a title that has to ellipsise to make room for it.
//   · A retired packet (status chip), a seeds-each packet, an ounce-unit packet, a drying lot, a
//     second fermenting lot at day 1 (under the warn threshold, so exactly ONE ferment is due), and
//     a stored saved lot with a counted yield. Saved seeds counts four saved lots in three stages;
//     no saved lot is added here, so that view's own expectations do not move.
//
// DATES are relative to the run, like seedssaved.jsx, and stage dates are pinned to MID-DAY Eastern:
// elapsedDays() counts CALENDAR days in Eastern (seedLots.js), so an instant 5x24h ago read at 00:30
// across a DST change could land on day 4 or 6. An Eastern date 5 days back, at 16:00Z, is day 5 at
// any hour this runs.
//
// SOW NOW is date-dependent by design (sowEngine buckets against today), so its candidates are built
// so the gate's floors rest only on the date-INDEPENDENT buckets: three packets with no sow profile
// (always "Needs a sow profile") and two lots in process (always "Still in process"). The timed
// packets land wherever today puts them, which is realism, not something the gate counts on.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import Seeds from '../../src/pages/Seeds.jsx'
import { etDay } from '../../src/lib/harvestSummary.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const q = new URLSearchParams(location.search)
const VIEW = q.get('view') || 'mine'
const TOP_CHROME_PX = Number(q.get('topbar') || 52)

// EVERY LOAD IS A FIRST VISIT. The views' Back-restore (useScrollRestore) files offsets in
// sessionStorage under window.history.state.key — which BrowserRouter writes per entry and
// MemoryRouter never does — so here every load shares the key 'default' and RESTORES THE PREVIOUS
// LOAD'S SCROLL. Measured before this line existed: the gate scrolled one viewport's 44-char row
// into view for its evidence shot, and the next viewport's "first screen" was read 591px down the
// page. My seeds' remembered filters and the add form's just-added note live there too.
try { window.sessionStorage.clear() } catch { /* private mode: nothing was remembered either */ }

const DAY = 86400000
const YEAR = new Date().getFullYear()
const TODAY_ET = etDay(new Date())
// An Eastern calendar date `n` days back, at 16:00Z (noon EDT / 11:00 EST) — see DATES above.
const stageDaysAgo = (n) => `${new Date(Date.parse(`${TODAY_ET}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10)}T16:00:00Z`
const createdDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString()

// Four names the palette knows (supplierPalette.js SUPPLIER_COLORS, keyed by the folded name) and one
// it does not: Fedco gets a FALLBACK_SLOTS pair and the default short label ("Fedco").
const SOURCES = [
  { id: 'src-botanical', name: 'Botanical Interests' },
  { id: 'src-bentley', name: 'Bentley Seeds' },
  { id: 'src-johnny', name: "Johnny's Selected Seeds" },
  { id: 'src-sandia', name: 'Sandia Seed Company' },
  { id: 'src-fedco', name: 'Fedco Seeds' },
]
const CROP_TYPES = [
  { slug: 'pepper', display_name: 'Pepper' }, { slug: 'tomato', display_name: 'Tomato' },
  { slug: 'lettuce', display_name: 'Lettuce' }, { slug: 'winter_squash', display_name: 'Winter Squash' },
  { slug: 'summer_squash', display_name: 'Summer Squash' }, { slug: 'money_plant', display_name: 'Money Plant' },
  { slug: 'mustard', display_name: 'Mustard' }, { slug: 'bean', display_name: 'Bean' },
]

// One row of GET /api/inventory-items?category=seeds: `i.*` plus the list query's projections
// (variety_name, crop_slug, stage_entered_at, the cultivar facts, the packet photo — lambda/
// inventory-items/index.js). Every column the Seeds views read is present, nulled when unset, because
// an ABSENT key and a NULL one are different facts to the sow engine (isUnstartedSave's un-widened-view
// guard reads hasOwnProperty) and to the detail facts (heatFact reads `'scoville_source' in item`, a
// column this list does not project yet — so it is deliberately absent here too).
let n = 0
// Keyed by the cultivar, not the row: two packets of one cultivar share a variety_id in prod, which is
// exactly what makes the identical pair below a real collision rather than a fixture accident.
const varietyId = (v) => `var-${v.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
const seed = (variety, crop, over = {}) => ({
  id: `seed-${String(++n).padStart(2, '0')}`, name: `${variety} packet`, variety_name: variety,
  variety_id: varietyId(variety), crop_slug: crop, category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, seed_stage: null, seed_process: null, stage_entered_at: null,
  source_plant_id: null, source_kind: null, source_id: null, source: null, source_url: null, purchase_date: null,
  year_harvested: null, seed_count: null, seed_weight_g: null, seed_count_estimated: null,
  sow_archived_season: null, created_at: createdDaysAgo(60 - n), updated_at: createdDaysAgo(3),
  // The cultivar facts (the `cultivar` view, joined on variety_id).
  scoville_min: null, scoville_max: null, origin_country: null, origin_region: null, species: null,
  breeding_system: null, days_to_maturity_min: null, days_to_maturity_max: null, dtm_basis: null,
  variety_source_url: null,
  // The packet photo: `i.*`'s raw pointer, the effective hero, and its two presigned URLs.
  featured_photo_id: null, featured_is_explicit: false, hero_photo_id: null,
  featured_photo_view_url: null, featured_photo_thumb_url: null,
  ...over,
})
// A bought packet: the vendor is the REGISTRY row; `source` holds what prod keeps there, an order note.
const bought = (variety, crop, vendor, date, over = {}) => seed(variety, crop, {
  source_id: vendor, purchase_date: date, source: `Order #${4400 + n} rec'd ${date.slice(5).replace('-', '/')}`, ...over,
})

// Packet photos. Served by the harness's own Vite from tests/harness/seeds-packets/ (a query string
// does not change which file Vite serves). LOAD makes every URL unique to this page load — see the
// header — and `p` to the photo, as a presigned URL is.
const LOAD = Date.now().toString(36)
const IMG = '/tests/harness/seeds-packets'
let photoN = 0
const photoUrls = (file) => {
  const p = ++photoN
  return {
    hero_photo_id: `photo-${String(p).padStart(2, '0')}`,
    featured_photo_thumb_url: `${IMG}/${file}?p=${p}&tier=thumb&load=${LOAD}`,
    featured_photo_view_url: `${IMG}/${file}?p=${p}&tier=full&load=${LOAD}`,
  }
}
const photo = (shape) => {
  const u = photoUrls(`packet-${shape}.png`)
  return { ...u, featured_photo_id: u.hero_photo_id, featured_is_explicit: true }
}
// Both URLs point at a file that does not exist: the thumb fails, PhotoView degrades to the full
// URL, that fails, the one re-mint 404s (the fetch stub below) and the photo ends terminal.
const brokenPhoto = () => ({ ...photoUrls('missing-packet.png'), featured_is_explicit: true })
const heat = (min, max) => ({ scoville_min: min, scoville_max: max })
const annuum = { species: 'Capsicum annuum' }

const LONG_NAME = 'Money Plant (self-saved, variety unrecorded)'   // 44 characters
const IDENTICAL = 'Megatron F1 (jumbo jalapeno)'
const ROWS = [
  // pepper — the dominant crop: every heat shape, the identical pair, the broken photo.
  bought('Serrano', 'pepper', 'src-fedco', '2026-01-14', { ...heat(null, 23000), ...annuum, ...photo('square') }),
  bought(IDENTICAL, 'pepper', 'src-johnny', '2026-02-11', { ...heat(2500, 8000), ...annuum, ...photo('tall') }),
  bought(IDENTICAL, 'pepper', 'src-johnny', '2026-02-11', { ...heat(2500, 8000), ...annuum, ...photo('tall') }),
  bought('Hot Portugal', 'pepper', 'src-bentley', '2025-12-30', { quantity_on_hand: 2, ...heat(5000, 15000), ...annuum, ...photo('wide') }),
  bought('Biquinho Red & Yellow Blend', 'pepper', 'src-botanical', '2026-02-11', { ...heat(500, 1000), species: 'Capsicum chinense' }),
  bought('Jimmy Nardello', 'pepper', 'src-botanical', '2026-01-14', { ...heat(0, 0), ...annuum, origin_country: 'Italy', origin_region: 'Basilicata', ...photo('tall') }),
  bought('Carolina Reaper', 'pepper', 'src-sandia', '2025-03-02', {
    unit: 'each', quantity_on_hand: 25, ...heat(1200000, 2000000), species: 'Capsicum chinense',
    source_url: 'https://www.sandiaseed.com/products/carolina-reaper', ...photo('wide'),
  }),
  bought('Fish', 'pepper', 'src-bentley', '2024-01-20', { ...heat(5000, 30000), ...annuum, ...brokenPhoto() }),
  bought('Shishito', 'pepper', 'src-botanical', '2026-01-14', { quantity_on_hand: 3, ...heat(50, 200), ...annuum }),
  seed('Lemon Drop', 'pepper', { species: 'Capsicum baccatum' }),          // no vendor, no date, NO heat on record
  seed('Aji Charapita', 'pepper', {                                         // a saved lot, drying — its heat is "est."
    name: 'Aji Charapita — saved 2026', seed_stage: 'drying', seed_process: 'wet',
    stage_entered_at: stageDaysAgo(3), source_plant_id: 'pl-charapita',
    ...heat(30000, 50000), species: 'Capsicum chinense', origin_country: 'Peru',
    days_to_maturity_min: 90, days_to_maturity_max: 100,
    variety_source_url: 'https://en.wikipedia.org/wiki/Aji_charapita', ...photo('square'),
  }),
  // tomato
  seed('1884', 'tomato', {                                                  // stored, with its counted yield
    name: 'Porch 1884, big jar', seed_stage: 'stored', stage_entered_at: stageDaysAgo(20),
    source_kind: 'own_garden', year_harvested: 2025, seed_count: 185, seed_count_estimated: false,
  }),
  seed('Cherokee Purple', 'tomato', {                                       // fermenting, day 1: not yet due
    name: 'Cherokee Purple — saved 2026', seed_stage: 'fermenting', seed_process: 'wet',
    stage_entered_at: stageDaysAgo(1), source_plant_id: 'pl-cherokee',
  }),
  bought('Sungold F1', 'tomato', 'src-johnny', '2026-01-14', photo('square')),
  bought("Brandywine (Sudduth's Strain)", 'tomato', 'src-bentley', '2025-01-05', photo('tall')),
  bought('Green Zebra', 'tomato', 'src-fedco', '2026-01-14'),
  bought('Amish Paste', 'tomato', 'src-botanical', '2024-12-01', { quantity_on_hand: 2 }),
  bought('Sunrise Bumble Bee', 'tomato', 'src-bentley', '2026-02-11', { status: 'retired' }),
  // lettuce — including the used-up packet.
  bought('Black Seeded Simpson', 'lettuce', 'src-botanical', '2026-06-09'),
  bought('Winter Density', 'lettuce', 'src-fedco', '2026-01-14', photo('wide')),
  bought('Buttercrunch', 'lettuce', 'src-botanical', '2026-06-09'),
  bought('Salad Bowl Blend', 'lettuce', 'src-botanical', '2025-02-01', { quantity_on_hand: 0 }),
  // the tail — its photos sit past the first image-window page (useImageWindow, 24 rows), so they
  // only mount once the page is scrolled toward them.
  bought("Cinderella (Rouge Vif d'Etampes)", 'winter_squash', 'src-bentley', '2025-12-30', photo('square')),
  seed(LONG_NAME, 'money_plant', {                                          // THE WORST ROW — see the header
    name: `${LONG_NAME} — saved ${YEAR}`, seed_stage: 'fermenting', seed_process: 'wet',
    stage_entered_at: stageDaysAgo(5), source_plant_id: 'pl-money', sow_archived_season: YEAR,
    seed_count: 120, seed_count_estimated: true,
  }),
  bought('Pennsylvania Dutch Crookneck', 'summer_squash', 'src-bentley', '2025-12-30', photo('tall')),
  bought('Early Prolific Straightneck', 'summer_squash', 'src-fedco', '2026-01-14'),
  bought('Red Mustard (heirloom, unspecified variety)', 'mustard', 'src-botanical', '2026-01-14'),
  bought('Provider Bush Bean', 'bean', 'src-johnny', '2026-03-01', { unit: 'oz', quantity_on_hand: 2 }),
]

// The parents the saved lots came off, for Saved seeds' "Saved from …" line (its picker projection).
const PLANTINGS = [
  { id: 'pl-money', name: 'Money Plant by the porch', quantity: 1, variety_id: null, variety_ref: null, sown_at: null, succession_order: null },
  { id: 'pl-cherokee', name: 'Cherokee Purple, bed 3', quantity: 2, variety_id: null, variety_ref: null, sown_at: '2026-04-20', succession_order: 1 },
  { id: 'pl-charapita', name: 'Aji Charapita pot', quantity: 1, variety_id: null, variety_ref: null, sown_at: '2026-03-02', succession_order: null },
]

// v_sow_candidates rows for the Sow now view: the ACTIVE rows, keyed the way the view keys them, with
// the variety's sow profile joined on. Three packets carry NO profile (always needs_profile) — the
// gate's date-independent floor, with the longest names in the set so the card's squeezed title
// column is the one measured. Numerics as strings: the neon driver serializes them so.
const PROFILE = {
  pepper: { lifecycle: 'annual', sow_season: 'warm', start_method: 'start_indoors', start_indoor_weeks_min: '8', start_indoor_weeks_max: '10', days_to_maturity_min: '75', days_to_maturity_max: '90', direct_sow_timing: null, sow_depth_in: '0.25', seed_spacing_in: '18' },
  tomato: { lifecycle: 'annual', sow_season: 'warm', start_method: 'start_indoors', start_indoor_weeks_min: '6', start_indoor_weeks_max: '8', days_to_maturity_min: '70', days_to_maturity_max: '80', direct_sow_timing: null, sow_depth_in: '0.25', seed_spacing_in: '24' },
  lettuce: { lifecycle: 'annual', sow_season: 'cool', start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null, days_to_maturity_min: '46', days_to_maturity_max: '50', direct_sow_timing: 'as soon as soil can be worked; succession sow every 2 weeks', sow_depth_in: '0.25', seed_spacing_in: '6' },
  summer_squash: { lifecycle: 'annual', sow_season: 'warm', start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null, days_to_maturity_min: '50', days_to_maturity_max: '55', direct_sow_timing: 'direct sow after last frost', sow_depth_in: '1', seed_spacing_in: '24' },
  winter_squash: { lifecycle: 'annual', sow_season: 'warm', start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null, days_to_maturity_min: '95', days_to_maturity_max: '110', direct_sow_timing: 'direct sow after last frost', sow_depth_in: '1', seed_spacing_in: '36' },
}
const NO_PROFILE = new Set(['Red Mustard (heirloom, unspecified variety)', 'Lemon Drop', 'Provider Bush Bean'])
const blankProfile = { lifecycle: null, sow_season: null, start_method: null, start_indoor_weeks_min: null, start_indoor_weeks_max: null, days_to_maturity_min: null, days_to_maturity_max: null, direct_sow_timing: null, sow_depth_in: null, seed_spacing_in: null }
const SOW_CANDIDATES = ROWS.filter((r) => r.status === 'active').map((r) => ({
  inventory_item_id: r.id, item_name: r.name, variety_name: r.variety_name, variety_id: r.variety_id,
  quantity_on_hand: String(r.quantity_on_hand), unit: r.unit, purchase_date: r.purchase_date, source: r.source,
  crop_type_slug: r.crop_slug, grown_as: null, sun_requirements: null, row_spacing_in: null,
  days_to_germ_min: null, days_to_germ_max: null, metadata: {},
  sow_notes: r.variety_name.startsWith('Red Mustard') ? 'Sow in early spring or late summer; thin to 6 in apart.' : null,
  seed_stage: r.seed_stage, seed_process: r.seed_process, source_plant_id: r.source_plant_id,
  source_kind: r.source_kind, seed_count: r.seed_count, seed_weight_g: r.seed_weight_g,
  sow_archived_season: r.sow_archived_season,
  ...(NO_PROFILE.has(r.variety_name) ? blankProfile : (PROFILE[r.crop_slug] ?? blankProfile)),
}))

// Stub at the network layer, so the REAL page, the REAL useApiFetch and the REAL Sheet all run and
// only the far side of the wire is faked. Order matters: sow-candidates and every write path also
// contain "inventory-items".
const realFetch = window.fetch
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
const hits = {}
window.fetch = (url, ...rest) => {
  const u = String(url)
  const hit = (k, body, status) => { hits[k] = (hits[k] ?? 0) + 1; return json(body, status) }
  // PhotoImg's one re-mint for a photo whose URLs failed. 404 = the photo is gone: terminal, as prod.
  if (u.includes('/api/photos/view-url/')) return hit('view-url', { error: 'not found' }, 404)
  if (u.includes('/sow-candidates')) return hit('sow-candidates', { items: SOW_CANDIDATES })
  if (u.includes('/seed-stage') || u.includes('/source-plant') || u.includes('/sow-archive')) return hit('write', { ok: true })
  if (u.includes('/api/projects')) return hit('projects', [{ id: 'proj-beds', name: 'Raised beds' }])
  if (u.includes('/api/plants')) return hit('plants', PLANTINGS)
  if (u.includes('/api/varieties/crop-types')) return hit('crop-types', CROP_TYPES)
  if (u.includes('/api/varieties/sources')) return hit('sources', SOURCES)
  if (u.includes('/api/inventory-items?category=seeds')) return hit('seed-rows', ROWS)
  return realFetch(url, ...rest)
}

// Anything the page throws on the way up is recorded, and the gate refuses to measure past it.
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`))

const settle = () => new Promise((r) => setTimeout(r, 160))

// What "the view's body has arrived" looks like, per view — read by ready(), never by the gate's
// assertions (the gate asks its own questions through its own selectors).
// My seeds opens FOLDED, so its body is the crop headers — and the supplier chip row, which renders
// only once the source registry has resolved the vendors and would otherwise land 56px later, under
// a gate that had already measured the first screen.
const ARRIVED = {
  mine: () => document.querySelectorAll('[data-testid="my-seeds-view"] [data-testid="facet-group-header"]').length > 0
    && !!document.querySelector('[data-testid="my-seeds-supplier-filter"]'),
  saved: () => document.querySelectorAll('[data-testid="seed-lot-card"]').length > 0,
  sow: () => !!document.querySelector('[data-testid="sow-now-view"] h2'),
}

async function run() {
  createRoot(document.getElementById('root')).render(
    <MemoryRouter initialEntries={[`/seeds?view=${encodeURIComponent(VIEW)}`]}>
      <ToastProvider>
        {/* TopChrome's box, exactly: sticky, BAR_H tall, border-box, above the route (App.jsx). */}
        <header data-app-chrome="top"
          style={{ position: 'sticky', top: 0, zIndex: 80, height: TOP_CHROME_PX, boxSizing: 'border-box',
            background: '#e8efe4', borderBottom: '1px solid #d4c9be', display: 'flex', alignItems: 'center',
            padding: '0 14px', font: '10px ui-monospace, monospace', color: '#8a8a8a' }}>
          TopChrome stand-in ({TOP_CHROME_PX}px)
        </header>
        <Seeds />
        {/* The real element's tag and label, like putupclose.jsx: App.jsx renders <BottomNav /> fixed. */}
        <nav aria-label="Main navigation"
          style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: BOTTOM_NAV_HEIGHT_PX,
            zIndex: 100, background: '#fff', borderTop: '1px solid #d4c9be', display: 'flex',
            alignItems: 'center', justifyContent: 'center', font: '10px ui-monospace, monospace',
            color: '#8a8a8a' }}>
          BottomNav stand-in ({BOTTOM_NAV_HEIGHT_PX}px)
        </nav>
      </ToastProvider>
    </MemoryRouter>,
  )
  await settle()
  const arrived = ARRIVED[VIEW] ?? (() => true)
  for (let i = 0; i < 40 && !arrived(); i++) await settle()
  await settle()

  window.__h = {
    ready: () => true,
    arrived: () => arrived(),
    errors: () => [...errors],
    hits: () => ({ ...hits }),
    fixture: () => ({ rows: ROWS.length, sowCandidates: SOW_CANDIDATES.length, longName: LONG_NAME, year: YEAR, photos: photoN, load: LOAD }),
    all: measure,
  }
  paint()
}

// The human-facing bar only. The assertions live in scripts/layout-gate/seeds-page-shot.mjs, which
// reads the same DOM through CDP.
function measure() {
  const de = document.documentElement
  const sw = document.querySelector('[data-testid="seeds-view-switch"]')
  const radios = sw ? [...sw.querySelectorAll('[role="radio"]')] : []
  const tops = radios.map((r) => Math.round(r.getBoundingClientRect().top))
  return {
    view: VIEW,
    vw: window.innerWidth, vh: window.innerHeight,
    hscroll: de.scrollWidth > de.clientWidth, scrollW: de.scrollWidth,
    switchOneLine: tops.length === 3 && Math.max(...tops) - Math.min(...tops) <= 2,
    headers: document.querySelectorAll('[data-testid="my-seeds-view"] [data-testid="facet-group-header"]').length,
    rows: document.querySelectorAll('[data-testid="my-seed-row"]').length,
    cards: document.querySelectorAll('[data-testid="seed-lot-card"]').length,
    ferment: !!document.querySelector('[data-testid="seeds-ferment-line"]'),
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
    `view=${m.view}  vw=${m.vw}x${m.vh}  scrollW=${m.scrollW}  hscroll=${m.hscroll ? 'YES' : 'no'}  errors=${m.errors}`,
    `switch one line=${m.switchOneLine}  headers=${m.headers}  rows=${m.rows}  cards=${m.cards}  ferment line=${m.ferment}`,
  ].join('\n')
  el.style.background = m.hscroll || !m.switchOneLine || m.errors ? '#b94a3a' : '#4a7c59'
}

run()
