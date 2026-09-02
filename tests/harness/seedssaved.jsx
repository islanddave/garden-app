// V4-SEEDSAVEFLOW-001 — real-browser look at /seeds/saved, which shipped in v4.90.0 having never
// been rendered in a browser at any width.
//
// Why this entry exists: the page is covered by vitest and was verified in the deployed bundle by
// string-probe, but jsdom returns zero for every getBoundingClientRect(), so nothing in the suite
// can falsify "the 44-character variety name overflows its card next to the advance button at
// 390px". That is the whole question here.
//
// The EMPTY case is the important one and is the default. Prod has 0 of 260 seed packets staged
// (measured against prod Neon 2026-09-01), so on the day this shipped every visit renders the empty
// state — the populated cases show what the page becomes, not what it currently is.
//
// Fixture names are REAL rows from prod inventory (category=seeds, joined to public.cultivar the way
// lambda/inventory-items/index.js:581 does it), taken longest-first so the worst case for layout is
// actually on screen. An invented name would repeat nothing.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import SavedSeeds from '../../src/pages/SavedSeeds.jsx'

// The app's global stylesheet (box-sizing, font stack) arrives via the `harness-app-global-style`
// plugin in vite.harness.config.mjs — see tests/harness/appGlobalStyle.js. This entry injected its
// own copy while BUG-HARNESSGLOBALCSS-001 was being diagnosed here; that copy is gone now the fix is
// shared, because two sources for one cascade is how the next drift starts.

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'empty'

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()

// Real prod names. "Money Plant (self-saved, variety unrecorded)" is 44 chars — the longest
// displayed name in the whole seed set, and the one that has to sit beside a "Drying →" button.
//
// `status: 'active'` is not decoration. `inventory_items.status` is NOT NULL on every real row, and
// the candidate filter is a strict equality against it (SavedSeeds.jsx — "a `?? 'active'` fallback
// would quietly re-admit exactly the rows this excludes"). A fixture row without it is a row no
// real database can produce, and it silently emptied the picker: gate:seeds-saved caught it as
// "0 candidates offered, expected >=1" rather than passing a sheet with nothing in it.
const TRACKED = [
  { id: 'i1', name: 'Money Plant packet',   variety_name: 'Money Plant (self-saved, variety unrecorded)', status: 'active', seed_stage: 'fermenting', seed_process: 'wet', updated_at: daysAgo(4) },
  { id: 'i2', name: 'Cinderella packet',    variety_name: "Cinderella (Rouge Vif d'Etampes)",             status: 'active', seed_stage: 'fermenting', seed_process: 'wet', updated_at: daysAgo(0) },
  { id: 'i3', name: 'Red Mustard packet',   variety_name: 'Red Mustard (heirloom, unspecified variety)',  status: 'active', seed_stage: 'drying',     seed_process: 'dry', updated_at: daysAgo(12) },
  { id: 'i4', name: 'Crookneck packet',     variety_name: 'Pennsylvania Dutch Crookneck',                 status: 'active', seed_stage: 'stored',     seed_process: null,  updated_at: daysAgo(40) },
]
const UNTRACKED = [
  { id: 'u1', name: 'Megatron packet',  variety_name: 'Megatron F1 (jumbo jalapeno)',  status: 'active', seed_stage: null, updated_at: daysAgo(9) },
  { id: 'u2', name: 'Biquinho packet',  variety_name: 'Biquinho Red & Yellow Blend',   status: 'active', seed_stage: null, updated_at: daysAgo(9) },
  { id: 'u3', name: 'Straightneck pkt', variety_name: 'Early Prolific Straightneck',   status: 'active', seed_stage: null, updated_at: daysAgo(9) },
  { id: 'u4', name: '1884 tomato',      variety_name: '1884',                          status: 'active', seed_stage: null, updated_at: daysAgo(9) },
]

// V4-SEEDLINK-001 — candidates for the "Saved from" picker in the advance sheet. Deliberately
// UNSCOPED by variety: the fixture rows above carry no variety_id, so the picker's varietyId filter
// is inert here and every row is offered. That is the wide case, which is the one worth measuring —
// a one-row list would tell us nothing about how the panel sits over the date and note fields.
const PLANTINGS = [
  { id: 'p1', name: 'Money Plant', quantity: 1, variety_id: null, variety_ref: null, sown_at: null, succession_order: null },
  { id: 'p2', name: 'Cinderella', quantity: 2, variety_id: null, variety_ref: null, sown_at: '2026-05-18', succession_order: 1 },
  { id: 'p3', name: 'Red Mustard', quantity: 6, variety_id: null, variety_ref: null, sown_at: '2026-04-02', succession_order: null },
]

// Empty is the live prod state: 260 packets, none staged. The picker still has candidates, because
// untracked is "everything without a stage" — which on that day is all 260.
const ROWS = CASE === 'empty' ? UNTRACKED : [...TRACKED, ...UNTRACKED]

// Stub at the network layer, so the REAL page, the REAL useApiFetch and the REAL Sheet all run and
// only the far side of the wire is faked. Aliasing src/lib/api.js would test the harness instead.
// Order matters: the POST path also contains "inventory-items".
const realFetch = window.fetch
const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
window.fetch = (url, ...rest) => {
  const u = String(url)
  if (u.includes('/seed-stage')) return json({ ok: true })
  if (u.includes('/source-plant')) return json({ ok: true })
  // V4-SEEDLINK-001 put a PlantingSelect in the advance sheet, and it self-fetches this path. Left
  // to fall through to realFetch it 404s against the harness server and the sheet renders its
  // load-failure copy — which would read as a layout finding rather than as a missing stub.
  if (u.includes('/api/plants')) return json(PLANTINGS)
  if (u.includes('inventory-items')) return json(ROWS)
  return realFetch(url, ...rest)
}

const settle = () => new Promise((r) => setTimeout(r, 160))

async function run() {
  createRoot(document.getElementById('root')).render(
    <MemoryRouter><ToastProvider><SavedSeeds /></ToastProvider></MemoryRouter>,
  )
  await settle()

  // Open the sheets by TAPPING the real controls rather than by forcing state — the question is
  // whether these surfaces are reachable and fit, and a forced mount answers neither.
  if (CASE === 'picker') {
    document.querySelector('[data-testid="track-a-lot"]')?.click()
    await settle()
  }
  if (CASE === 'advance') {
    document.querySelectorAll('[data-testid="advance-stage"]')[0]?.click()
    await settle()
  }

  window.__h = { ready: () => true, all: measure }
  paint()
}

// Every number is read from the live document. `visualViewport` is reported alongside innerWidth so
// a reader can see the frame really is 390 wide rather than trusting the screenshot.
function measure() {
  const de = document.documentElement
  const cards = [...document.querySelectorAll('[data-testid="seed-lot-card"]')]
  const tapTargets = [...document.querySelectorAll('button, a[href], input')]
    .filter((el) => el.getClientRects().length)
  const short = tapTargets
    .map((el) => ({ t: (el.textContent || el.getAttribute('data-testid') || el.type || '?').trim().slice(0, 26), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h > 0 && x.h < 48)
  return {
    case: CASE,
    vw: window.innerWidth,
    hscroll: de.scrollWidth > de.clientWidth,
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    pageH: Math.round(de.scrollHeight),
    empty: !!document.querySelector('[data-testid="saved-seeds-empty"]'),
    cards: cards.length,
    // Per-card horizontal overflow: the 44-char name is the reason this entry exists.
    cardOverflow: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
    // Does any card's text column clip its own content?
    nameClipped: cards.filter((c) => {
      const col = c.firstElementChild
      return col && col.scrollWidth > col.clientWidth + 1
    }).length,
    sheetOpen: !!document.querySelector('[role="dialog"], [data-testid="stage-save"], [data-testid="track-candidate"]'),
    // The sheet scrolls its own content, so a field wider than the panel does NOT show up as
    // document hscroll — it has to be asked for separately. This is the check that caught the
    // box-sizing gap above; keeping it means the entry stays honest if the global block drifts.
    sheetOverflowX: (() => {
      const f = document.querySelector('[data-testid="stage-date"], [data-testid="track-candidate"]')
      const panel = f?.closest('div')?.parentElement?.parentElement
      return panel ? panel.scrollWidth > panel.clientWidth + 1 : false
    })(),
    under48: short,
  }
}

function paint() {
  const m = measure()
  // `verdict=0` for a screenshot of the surface alone, same convention as plantingphotosheet.*.
  // The bar is fixed-position and runs to five lines on the populated cases, which is enough to
  // cover the h1 — a capture meant for a human to judge the page by must not have the instrument
  // sitting on top of the thing being judged.
  if (q.get('verdict') === '0') {
    document.getElementById('verdict').remove()
    document.getElementById('root').style.paddingTop = '0px'
    return
  }
  const fails = []
  if (m.hscroll) fails.push('HORIZONTAL SCROLL')
  if (m.sheetOverflowX) fails.push('SHEET OVERFLOWS X')
  if (m.cardOverflow) fails.push(`${m.cardOverflow} card(s) overflow`)
  if (m.nameClipped) fails.push(`${m.nameClipped} name(s) clipped`)
  if (m.under48.length) fails.push(`${m.under48.length} tap target(s) <48px: ` + m.under48.map((x) => `${x.t}=${x.h}`).join(', '))
  const el = document.getElementById('verdict')
  el.textContent = [
    `case=${m.case}  vw=${m.vw}px  scrollW=${m.scrollW}  hscroll=${m.hscroll ? 'YES' : 'no'}  pageH=${m.pageH}`,
    `empty-state=${m.empty}  cards=${m.cards}  sheet=${m.sheetOpen}`,
    fails.length ? 'FAIL: ' + fails.join(' | ') : 'PASS — no overflow, no clipped name, all tap targets >=48px',
  ].join('\n')
  el.style.background = fails.length ? '#b94a3a' : '#4a7c59'
}

run()
