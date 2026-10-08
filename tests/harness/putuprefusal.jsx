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
//   ?sheet=door     Put something up, As is (the pantry-item route: POST /api/pantry/items)
//   ?sheet=recipe   New recipe (POST /api/recipes)
//
// THE WIRE, faked at window.fetch so the real useApiFetch, the real <Sheet> and the real sheet run:
//   the FIRST create is lost — the request goes out and no answer comes back (fetch rejects);
//   every LATER create is answered as the server answers a replayed key: `replayed: true` and the row
//   the first one made — stamped 30 minutes ago, so it is not this sitting's to write over
//   (kitchen/idempotencyKey.js REPLAY_FRESH_MS) and the sheet refuses.
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

const q = new URLSearchParams(location.search)
const SHEET = q.get('sheet') || 'door'

const PLACES = [
  { id: 'loc-cf1', user_id: 'harness_user', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-cf2', user_id: 'harness_user', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-meat', user_id: 'harness_user', label: 'Meat deep freezer', kind: 'deep_freezer' },
  { id: 'loc-fridge', user_id: 'harness_user', label: 'Fridge', kind: 'fridge' },
]

const calls = []
const creates = { n: 0 }
const earlier = () => new Date(Date.now() - 30 * 60 * 1000).toISOString()
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
const IDS = SHEET === 'recipe'
  ? { error: 'recipe-sheet-error', footer: 'recipe-sheet-footer', save: 'recipe-save' }
  : { error: 'door-error', footer: 'door-footer', save: 'door-save' }

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
        {SHEET === 'recipe' ? <Recipe /> : <PutSomethingUpSheet open onClose={() => {}} onSaved={() => { window.__saved = true }} />}
      </MemoryRouter>
    </AuthProvider>,
  )
  for (let i = 0; i < 100 && !byTid(IDS.save); i += 1) await new Promise(r => setTimeout(r, 50))
  try { await document.fonts.ready } catch { /* the font report says so */ }
  window.__h = {
    ready: () => !!byTid(IDS.save),
    measure,
    box: (t) => box(byTid(t)),
    testids: () => [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')),
  }
}

run()
