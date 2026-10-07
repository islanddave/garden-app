// V5-SEEDMULTIPARENT-001 (release 2b, QA B4) — the Save seed sheet with a parent SET, in a real browser.
//
// WHAT ONLY A BROWSER ANSWERS. Release 2b put a "From" block above the sheet's fields: one row per
// parent planting with a remove control, an adder, a plant-count field with a hint under it, a mix
// name that is two or three variety names joined, and a reason line. All of it sits ABOVE Save in a
// panel capped at 85vh. vitest proves the right rows and strings render; jsdom returns 0 for every
// rect, so it cannot say whether a remove control is a full tap target beside a two-line planting
// name, whether the 90-character mix name pushes anything sideways, or whether Save can still be
// reached once four rows and a refusal sentence are stacked over it. seedwarning.jsx mounts this same
// sheet for one planting and is driven by nothing; this entry is the one
// scripts/layout-gate/save-seed-sheet-clearance.mjs drives.
//
// THE PARENT SET IS SESSION STATE, so it is produced the way a user produces it: the sheet opens for
// one planting (the `planting` prop, exactly as a planting page opens it) and every further row is
// added by TAPPING "+ Add seed from another plant" and then the planting in the real PlantingSelect.
// Nothing is forced through props or state, so "can the second plant be added at all at this width"
// is answered before "does the result fit". The gate serves featureFlags.js with SEED_MULTI_PARENT on,
// whichever way it ships (tests/harness/vite.harness.seedon.mjs).
//
// ?case=one (default) | two | four | mixname | blendfailed
//   one          the page's own planting, which holds exactly one plant: no plant-count field, the
//                Variety row with "Change", the one-variety F1 line above Save.
//   two          a second planting of a different variety: the mix row, the reason line, the plant
//                count with its "hold N plants today" hint.
//   four         four plantings of four varieties: the tallest "From" block and the "+ 2 more" name.
//   mixname      three plantings whose varieties make THE LONGEST NAME previewMixName can generate.
//                Four or more varieties collapse to "A + B + N more", so three joined names plus
//                " mix" is the ceiling: 90 characters here.
//   blendfailed  `two`, then Save is tapped and the mix route answers 405: the refusal sentence is on
//                screen above Save with everything typed still in place.
//
// NAMES. The four cultivars are the pepper rows already carried by seedwarning.jsx and seedssaved.jsx
// as real prod rows, longest first, all one crop so the adder (which lists the set's crop only) offers
// them. Planting names are the cultivar plus where it grows, the shape seeddetail.jsx's longest row has,
// so a row name wraps to two lines beside its remove control at 360px.
//
// `quantity` IS ON EVERY PLANTING and is not decoration: the sheet asks for a plant count unless the
// one planting holds exactly 1 plant, and prints the hint only when every row states a whole number.
// Without it every case would show the field and none would show the hint.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import SaveSeedSheet from '../../src/components/planting/SaveSeedSheet.jsx'

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'one'

const CULTIVARS = {
  megatron: { id: 'v-megatron', name: 'Megatron F1 (jumbo jalapeno)', crop_type_slug: 'pepper', breeding_system: 'f1', variety_rank: 'cultivar' },
  shipka:   { id: 'v-shipka',   name: 'Bulgarian Carrot (Shipka)',    crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' },
  biquinho: { id: 'v-biquinho', name: 'Biquinho Red & Yellow Blend',  crop_type_slug: 'pepper', breeding_system: 'open_pollinated', variety_rank: 'cultivar' },
  kori:     { id: 'v-kori',     name: 'Kori Sitakame',                crop_type_slug: 'pepper', breeding_system: 'landrace', variety_rank: 'cultivar' },
}
const planting = (id, name, variety, quantity) => ({
  id, name, quantity, variety_id: variety.id, variety_ref: variety,
  project_id: 'proj-1', sown_at: '2026-03-02', succession_order: null, project_name: null,
})
// p-1 holds ONE plant, so `one` shows no plant-count field. The others hold more than one, so every
// multi-row case shows the field AND its hint.
const P1 = planting('p-1', 'Megatron F1 (jumbo jalapeno)', CULTIVARS.megatron, 1)
const P2 = planting('p-2', 'Bulgarian Carrot (Shipka) — raised bed 3, north end, second sowing', CULTIVARS.shipka, 3)
const P3 = planting('p-3', 'Biquinho Red & Yellow Blend — grow bag by the shed', CULTIVARS.biquinho, 2)
const P4 = planting('p-4', 'Kori Sitakame, bed 1', CULTIVARS.kori, 4)
const PLANTINGS = [P1, P2, P3, P4]

// Which plantings each case ADDS to p-1, in tap order.
const ADDS = {
  one: [],
  two: ['p-2'],
  four: ['p-2', 'p-3', 'p-4'],
  mixname: ['p-2', 'p-3'],
  blendfailed: ['p-2'],
}
const adds = ADDS[CASE] ?? ADDS.one

// Stub the wire, not the module: the sheet runs its real fetch path, its real error handling and its
// real PlantingSelect, and only the far side is faked. Real Response objects, so a refusal travels
// through useApiFetch's own `!res.ok` arm and arrives at the sheet with `status` and `body` on it.
const json = (body, status = 200) => Promise.resolve(
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
)
window.fetch = (url, opts = {}) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  // The mix route. Only `blendfailed` taps Save, and there it answers as a varieties Lambda older
  // than the route does (contract X5); the sheet prints its own sentence and makes no lot.
  if (u.includes('/api/varieties/blend')) {
    return CASE === 'blendfailed'
      ? json({ error: 'Method not allowed' }, 405)
      : json({ id: 'v-mix', name: 'Bulgarian Carrot (Shipka) + Megatron F1 (jumbo jalapeno) mix', created: true })
  }
  if (u.includes('/api/varieties')) return json(Object.values(CULTIVARS))
  if (u.includes('/api/projects')) return json([{ id: 'proj-1', name: 'Peppers 2026', status: 'growing' }])
  if (u.includes('/api/locations')) return json([])
  if (u.includes('/api/plants')) return json(PLANTINGS)
  if (u.includes('/api/inventory-items') && method === 'POST') return json({ id: 'lot-1' })
  return json({})
}

const $ = (testid) => document.querySelector(`[data-testid="${testid}"]`)
const $$ = (testid) => [...document.querySelectorAll(`[data-testid="${testid}"]`)]
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
// Waits for a state the page has to reach, and says which one it never reached: a harness that
// reports ready() over a half-driven sheet would have the gate measuring the wrong case.
async function until(what, test, ms = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (test()) return
    await pause(50)
  }
  throw new Error(`case=${CASE}: never reached "${what}"`)
}

const state = { ready: false, error: null }
window.__h = {
  ready: () => state.ready,
  error: () => state.error,
  case: CASE,
  expectRows: 1 + adds.length,
}

async function run() {
  createRoot(document.getElementById('root')).render(
    <MemoryRouter initialEntries={['/plantings/p-1']}>
      <ToastProvider>
        <SaveSeedSheet planting={P1} onClose={() => {}} />
      </ToastProvider>
    </MemoryRouter>,
  )
  await until('the sheet is open on its first row', () => $$('save-seed-from-row').length === 1)

  for (const id of adds) {
    const before = $$('save-seed-from-row').length
    await until('the adder is offered', () => !!$('save-seed-add-plant'))
    $('save-seed-add-plant').click()
    await until(`the adder lists ${id}`, () => !!$(`ps-opt-${id}`))
    $(`ps-opt-${id}`).click()
    await until(`${id} is a row`, () => $$('save-seed-from-row').length === before + 1)
  }

  if (CASE === 'blendfailed') {
    $('save-seed-submit').click()
    await until('the refusal sentence is on screen', () => !!$('save-seed-error'))
    await until('Save is back from "Saving…"', () => !$('save-seed-submit').disabled)
  }
  // The adder closed itself after each pick and the sheet's transition is done.
  await pause(300)
}

function paint() {
  const el = document.getElementById('verdict')
  if (q.get('verdict') === '0') {
    // Same convention as seedssaved.jsx: the bar is fixed at z-index 99999 and a gate that hit-tests
    // with it in place measures its own instrument.
    el.remove()
    document.getElementById('root').style.paddingTop = '0px'
    return
  }
  const de = document.documentElement
  const panel = document.querySelector('[role="dialog"]')
  el.textContent = state.error
    ? `FAIL: ${state.error}`
    : `case=${CASE}  rows=${$$('save-seed-from-row').length}  vw=${window.innerWidth}  hscroll=${de.scrollWidth > de.clientWidth ? 'YES' : 'no'}`
      + `  panelScrolls=${panel ? panel.scrollHeight > panel.clientHeight + 1 : '(no panel)'}`
      + `\nvariety="${$('save-seed-variety-name')?.textContent ?? ''}"`
  el.style.background = state.error ? '#b94a3a' : '#2f5d43'
}

run()
  .catch((err) => { state.error = err.message })
  .finally(() => { paint(); state.ready = true })
