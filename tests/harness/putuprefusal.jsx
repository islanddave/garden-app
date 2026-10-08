// BUG-PUTUPREPLAYREST-001 — the Put-Up replay refusal line, in a real browser at Dave's 426×836.
//
// THE GAP THIS FILLS. BUG-PUTUPREPLAYDROPSEDIT-001 made a Save that cannot safely repair an earlier one
// say so on the sheet ("… was already saved earlier — … This Save did not change it. …"). That line is the
// LAST thing in the sheet's scroller and Save is pinned over the scroller's end, so whether the line can
// be read when it appears is a layout question. jsdom returns zeros from every getBoundingClientRect
// (tests/harness/README.md): PutUpReplayEdit*.test.jsx pin that scrollIntoView was CALLED, and cannot
// say where the line landed. This entry mounts the real sheet and leaves the driving to
// scripts/layout-gate/putup-refusal-view.mjs, which taps and types through CDP's Input domain.
//
//   ?sheet=door       Put something up, As is (the pantry-item route: POST /api/pantry/items)
//   ?sheet=recipe     New recipe (POST /api/recipes)
//   ?sheet=putupdoor  Put something up on a METHOD chip (the put-up route: POST /api/preservation)   — QA I-5
//   ?sheet=start      Start a batch (POST /api/kitchen-batches)                                     — QA I-5
//   ?sheet=putitup    Put it up (POST /api/kitchen-batches/:id/put-up)                              — QA I-5
//
// THE WIRE, faked at window.fetch so the real useApiFetch, the real <Sheet> and the real sheet run:
//   the FIRST create is lost — the request goes out and no answer comes back (fetch rejects);
//   every LATER create is answered as the server answers a replayed key: `replayed: true` and the row
//   the first one made. For door and recipe it is stamped 30 minutes ago, so it is not this sitting's to
//   write over (kitchen/idempotencyKey.js REPLAY_FRESH_MS) and the sheet refuses ("saved earlier"). For the
//   three QA I-5 sheets it is the row the FIRST body made, stamped as its table stamps a fresh row (a jar:
//   created_at now, updated_at NULL; a batch: both one instant) — this sitting's — and the driver changes a
//   part no update route carries (the date; when it started; a count), which is the refusal those sheets
//   added: "Already in the Pantry as … Set the date back to …", "This batch is already started …",
//   "This is already put up …".
// Row names and values are constructed, not seen in any database.
//
// FIRST IMPORT, on purpose: the Roboto pin (robotoPin.js), as tests/harness/putupferment.jsx has it.
import './robotoPin.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { useApiFetch } from '../../src/lib/api.js'
import PutSomethingUpSheet from '../../src/components/pantry/PutSomethingUpSheet.jsx'
import RecipeSheet from '../../src/components/recipes/RecipeSheet.jsx'
import StartBatchSheet from '../../src/components/kitchen/StartBatchSheet.jsx'
import PutItUpSheet from '../../src/components/putup/PutItUpSheet.jsx'

const q = new URLSearchParams(location.search)
const SHEET = q.get('sheet') || 'door'

const PLACES = [
  { id: 'loc-cf1', user_id: 'harness_user', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-cf2', user_id: 'harness_user', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-meat', user_id: 'harness_user', label: 'Meat deep freezer', kind: 'deep_freezer' },
  { id: 'loc-fridge', user_id: 'harness_user', label: 'Fridge', kind: 'fridge' },
]

// The batch Put it up is opened on (constructed): going, started nine days ago.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
const MASH = {
  id: 'kb-mash', label: 'Megatron mash', kind: 'ferment', user_id: 'harness_user', kind_other: null,
  started_at: daysAgo(9), start_precision: 'day', first_recorded_at: daysAgo(9),
  closed_at: null, current_stage_kind: 'tended', current_stage_entered_at: daysAgo(2),
}

const calls = []
const creates = { n: 0 }
// The row the FIRST create made, kept so every later one is answered with it (a replay never re-reads a body).
const made = { row: null }
const earlier = () => new Date(Date.now() - 30 * 60 * 1000).toISOString()
const justNow = () => new Date(Date.now() - 20 * 1000).toISOString()
const dayInstant = (d) => (d == null ? null : `${String(d).slice(0, 10)}T00:00:00.000Z`)
// A jar as POST /api/preservation answers a replay with it: the raw row. updated_at is NULL on a jar nothing
// has written to since its create (migrations/v4-putup-001/0a:97; QA B-1).
const jarOf = (b) => ({
  id: 'jar-first', user_id: 'harness_user', label: b.label, method: b.method, method_other_text: null,
  package_count: b.package_count ?? 1, remaining_count: b.package_count ?? 1,
  quantity_value: b.quantity_value == null ? null : Number(b.quantity_value).toFixed(2), quantity_unit: b.quantity_unit ?? null, remaining_amount: null,
  storage_location_id: b.storage_location_id ?? null, plant_id: null, crop_type_slug: b.crop_type_slug ?? null, variety_id: null, harvest_log_id: null,
  preserved_at: dayInstant(b.preserved_at), preserved_at_precision: b.preserved_at_precision ?? null, preserved_at_approx: b.preserved_at_approx ?? null,
  use_by_target: dayInstant('2027-10-01'), use_by_basis: 'table', is_raw: b.is_raw ?? null, in_oil: b.in_oil ?? null, texture: b.texture ?? null,
  notes: b.notes ?? null, source_kind: b.source_kind ?? null, source_label: b.source_label ?? null,
  idempotency_key: b.idempotency_key, created_at: justNow(), updated_at: null, deleted_at: null,
})
// A batch as POST /api/kitchen-batches answers a replay with it (SELECT * over v_kitchen_batch_current).
const batchOf = (b) => {
  const at = justNow()
  return {
    id: 'kb-first', user_id: 'harness_user', label: b.label, kind: b.kind ?? null, kind_other: b.kind_other ?? null,
    started_at: b.started_at ?? null, start_precision: b.start_precision ?? null, cover_photo_id: null, recipe_id: b.recipe_id ?? null,
    recipe_ref: b.recipe_ref ?? null, vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, input_count: 0, output_count: 0,
    idempotency_key: b.idempotency_key, closed_at: null, created_at: at, updated_at: at, deleted_at: null,
  }
}
// A sitting as POST /:id/put-up answers a replay with it (kitchenRoutes.js readSitting): one jar per row.
const sittingOf = (b) => ({
  stage: { id: 'ksl-1', batch_id: MASH.id, stage_kind: 'put_up' },
  jars: (b.rows ?? []).map((r, i) => {
    const place = PLACES.find(p => p.id === r.place?.id) ?? { label: r.place?.label ?? null, kind: r.place?.kind ?? null }
    return {
      id: `pl-${i + 1}`, label: r.name ?? MASH.label, container_label: r.container_label ?? null, package_count: r.count,
      storage_label: place.label, storage_kind: place.kind, preserved_at: b.when?.date ?? null, preserved_at_precision: b.when?.precision ?? null,
      use_by_target: '2027-03-29', use_by_basis: 'table',
    }
  }),
  inputs: [], batch: MASH,
})
const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
const realFetch = window.fetch
window.fetch = (url, init, ...rest) => {
  const u = String(url)
  if (!u.includes('/api/')) return realFetch(url, init, ...rest)
  const method = String(init?.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, '')}`)
  let body = null
  try { body = init?.body ? JSON.parse(init.body) : null } catch { /* not JSON */ }
  if (method === 'POST' && (u.includes('/api/pantry/items') || /\/api\/recipes(\?|$)/.test(u))) {
    creates.n += 1
    if (creates.n === 1) return Promise.reject(new TypeError('Failed to fetch'))
    const at = earlier()
    if (u.includes('/api/pantry/items')) {
      return json({ replayed: true, item: { id: 'item-first', user_id: 'harness_user', name: body?.name ?? 'Sweet corn, cut off the cob',
        notes: null, created_at: at, updated_at: at, deleted_at: null } })
    }
    return json({ replayed: true, recipe: { id: 'rc-first', user_id: 'harness_user', name: body?.name ?? 'Recipe', created_at: at, updated_at: at } })
  }
  // QA I-5: the put-up, the start and the sitting — the first lands with its answer lost, the rest replay it.
  const path = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const keyed = method === 'POST' && (path === '/api/preservation' ? jarOf : path === '/api/kitchen-batches' ? batchOf : /^\/api\/kitchen-batches\/[^/]+\/put-up$/.test(path) ? sittingOf : null)
  if (keyed) {
    creates.n += 1
    if (creates.n === 1) { made.row = keyed(body ?? {}); return Promise.reject(new TypeError('Failed to fetch')) }
    return json({ ...made.row, replayed: true })
  }
  if (u.includes('/api/storage-locations')) return json(PLACES)
  if (method === 'GET') return json({})
  return Promise.resolve(new Response(JSON.stringify({ error: 'the harness has no answer for this write' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
}

function Recipe() {
  const { fetch } = useApiFetch()
  return <RecipeSheet open recipe={null} types={[]} usedTypeIds={[]} fetch={fetch} onClose={() => {}} onSaved={() => { window.__saved = true }} />
}

const byTid = (t) => document.querySelector(`[data-testid="${t}"]`)
const box = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), height: +r.height.toFixed(1) }
}
const IDS = {
  recipe: { error: 'recipe-sheet-error', footer: 'recipe-sheet-footer', save: 'recipe-save' },
  start: { error: 'start-error', footer: 'start-footer', save: 'start-submit' },
  putitup: { error: 'putup-error', footer: 'putup-footer', save: 'putup-finish' },
}[SHEET] ?? { error: 'door-error', footer: 'door-footer', save: 'door-save' }

// Every number is read from the live document. `hits` asks the browser what is painted on top at nine
// points of the line: a point the pinned footer covers answers with the footer, not the line.
function measure() {
  const line = byTid(IDS.error)
  const footer = byTid(IDS.footer)
  const panel = document.querySelector('[role="dialog"]')
  const l = box(line)
  const hits = []
  if (line && l) {
    for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.05, 0.5, 0.95]) {
      const x = l.left + (l.right - l.left) * fx; const y = l.top + l.height * fy
      const top = document.elementFromPoint(x, y)
      hits.push({ x: Math.round(x), y: Math.round(y), line: !!top && (top === line || line.contains(top)), footer: !!top && !!footer && footer.contains(top) })
    }
  }
  return {
    sheet: SHEET, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    font: window.__fontPin ? { faces: window.__fontPin.faces, failed: window.__fontPin.failed?.length ?? 0 } : null,
    text: line?.textContent ?? null,
    line: l, footer: box(footer), save: box(byTid(IDS.save)), panel: box(panel),
    // The sheet's own header row (its title and Close; it scrolls with the sheet): the line is below it.
    header: box(panel?.querySelector('[data-sheet-close]')?.parentElement ?? null),
    scroll: panel ? { top: Math.round(panel.scrollTop), height: panel.scrollHeight, client: panel.clientHeight } : null,
    hits, creates: creates.n, calls: calls.slice(), saved: !!window.__saved,
  }
}

async function run() {
  // No draft from an earlier run in the same profile: a restored one would carry `sent` and change the path.
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('garden:putup-draft:v1:')) localStorage.removeItem(k)
  } catch { /* no storage: nothing to clear */ }
  createRoot(document.getElementById('root')).render(
    <AuthProvider>
      <MemoryRouter>
        {SHEET === 'recipe' ? <Recipe />
          : SHEET === 'start' ? <StartBatchSheet open onClose={() => {}} onStarted={() => { window.__saved = true }} />
            : SHEET === 'putitup' ? <PutItUpSheet open batch={MASH} onClose={() => {}} onDone={() => { window.__saved = true }} />
              : <PutSomethingUpSheet open onClose={() => {}} onSaved={() => { window.__saved = true }} />}
      </MemoryRouter>
    </AuthProvider>,
  )
  for (let i = 0; i < 100 && !byTid(IDS.save); i += 1) await new Promise(r => setTimeout(r, 50))
  try { await document.fonts.ready } catch { /* the font report says so */ }
  window.__h = {
    ready: () => !!byTid(IDS.save),
    measure,
    box: (t) => box(byTid(t)),
    // Whether the control with this test id is painted, whole, between the scroller's top and the pinned footer.
    onScreen: (t) => {
      const el = byTid(t); const footer = byTid(IDS.footer); const panel = document.querySelector('[role="dialog"]')
      if (!el || !footer || !panel) return { drawn: !!el, whole: false }
      const r = el.getBoundingClientRect()
      const floor = Math.min(footer.getBoundingClientRect().top, panel.getBoundingClientRect().bottom, innerHeight)
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { drawn: true, whole: r.top >= Math.max(panel.getBoundingClientRect().top, 0) - 0.5 && r.bottom <= floor + 0.5 && !!top && (top === el || el.contains(top) || top.contains(el)), box: box(el) }
    },
    testids: () => [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')),
  }
}

run()
