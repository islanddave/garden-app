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
// ?case=one (default) | two | four | mixname | blendfailed | named | list0 | list1 | list6 | addcounted |
//       addrefile | addrefused
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
// V5-SEEDLOTADDITION-001 (seed release 3) — "Put it in a seed lot I already started". The From block
// gained a link while it has exactly one row, and that link swaps the form for a LOT LIST and then an
// ADD FORM (src/components/planting/AddToLot.jsx). Reached the same way, by tapping: the link, then a
// row of the list, then "Add to this lot". The gate serves SEED_ADD_TO_LOT on beside SEED_MULTI_PARENT.
//   named        `one`, opened with ONE open lot of this plant's (`ownLots`): the link names the lot and
//                carries its facts on a second line. Still the new-lot form.
//   list0        the general link tapped, the read answers no lots: heading, the "none" line, the way back.
//   list1        one lot.
//   list6        six lots, two of them of another variety (so the "makes it a mix" line is drawn), one
//                carrying THE LONGEST LOT NAME the app generates: the longest mix name plus " — saved 2026".
//   addcounted   the NAMED link tapped: the add form on a counted lot, with no read of the list at all.
//   addrefile    the list, then a lot of two other varieties: the re-file sentence with the longest name.
//   addrefused   `addrefile`, then "Add to this lot" is tapped and the write answers 409 lot_used_up: the
//                re-file sentence AND the refusal are stacked over the button.
// `ownLots` rows have the shape of GET /api/plants/:id/seed-lots and the list's rows the shape of
// GET /api/inventory-items/seed-lots-open (tests/contracts/seed-mix.json). Every own lot is `drying`, so
// "is this lot still open" never depends on the day the gate runs.
//
// `quantity` IS ON EVERY PLANTING and is not decoration: the sheet asks for a plant count unless the
// one planting holds exactly 1 plant, and prints the hint only when every row states a whole number.
// Without it every case would show the field and none would show the hint.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import SaveSeedSheet from '../../src/components/planting/SaveSeedSheet.jsx'
import { cropWords, lotsNoneLine } from '../../src/components/seed/seedAdditions.js'

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

// ── Add to a lot already started ─────────────────────────────────────────────────────────────────────
// What each of those cases shows once driven: the list, or the add form. Absent = the new-lot form.
const VIEW = { list0: 'list', list1: 'list', list6: 'list', addcounted: 'add', addrefile: 'add', addrefused: 'add' }
const view = VIEW[CASE] ?? 'new'

const MIX2 = 'Biquinho Red & Yellow Blend + Bulgarian Carrot (Shipka) mix'
// The gate spells the same string (LONGEST_LOT_NAME) and reds if no row carries it.
const LONGEST_LOT_NAME = 'Biquinho Red & Yellow Blend + Bulgarian Carrot (Shipka) + Megatron F1 (jumbo jalapeno) mix — saved 2026'

// p-1's one open lot, as GET /api/plants/:id/seed-lots gives it. `named` and `addcounted` open with it.
const OWN_LOT = {
  id: 'lot-own', name: 'Megatron F1 (jumbo jalapeno) — saved 2026', seed_stage: 'drying', quantity_on_hand: '1.000',
  created_at: '2026-09-20T15:00:00.000Z', seed_count: 120, seed_count_estimated: true, seed_weight_g: null,
  variety_name: 'Megatron F1 (jumbo jalapeno)', other_parents: [],
}
const OWN_LOTS = { named: [OWN_LOT], addcounted: [OWN_LOT] }

const parent = (p) => ({
  id: p.id, name: p.name, variety_id: p.variety_ref.id, variety_name: p.variety_ref.name,
  breeding_system: p.variety_ref.breeding_system, variety_rank: p.variety_ref.variety_rank,
  crop_slug: 'pepper', archived: false, deleted: false,
})
const P5 = planting('p-5', 'Megatron F1 (jumbo jalapeno) — greenhouse bench', CULTIVARS.megatron, 2)
const openLot = (id, name, variety, parents, over = {}) => ({
  id, name, variety_id: variety.id, variety_name: variety.name, variety_rank: variety.variety_rank ?? 'cultivar',
  crop_slug: 'pepper', seed_stage: 'drying', seed_process: 'dry',
  stage_entered_at: '2026-09-20T15:00:00.000Z', created_at: '2026-09-20T15:00:00.000Z', updated_at: '2026-09-21T15:00:00.000Z',
  seed_count: null, seed_count_estimated: null, seed_weight_g: null, seed_parent_plant_count: parents.length || null,
  quantity_on_hand: '1.000', status: 'active', source_plant_id: parents[0]?.id ?? null,
  is_member: parents.some((x) => x.id === 'p-1'),
  same_variety: variety.id === CULTIVARS.megatron.id || parents.some((x) => x.variety_ref.id === CULTIVARS.megatron.id),
  source_plants: parents.map(parent),
  ...over,
})
const MIX2_VARIETY = { id: 'v-mix2', name: MIX2, variety_rank: 'blend' }
const MIX3_VARIETY = { id: 'v-mix3', name: LONGEST_LOT_NAME.replace(' — saved 2026', ''), variety_rank: 'blend' }
// A lot of two OTHER varieties whose name is still the automatic one: adding p-1 re-files it under the
// three-name mix and renames it, which is the longest re-file sentence the form can print.
const REFILE_LOT = openLot('lot-mix2', `${MIX2} — saved 2026`, MIX2_VARIETY, [P2, P3],
  { seed_stage: 'stored', seed_count: 7000, seed_count_estimated: true, seed_weight_g: '13.845' })
// The read's order: this plant's lots, then lots that hold its variety (the long mix has a Megatron
// parent), then the rest, which sit under the "makes it a mix" line.
const SIX = [
  openLot('lot-own', OWN_LOT.name, CULTIVARS.megatron, [P1], { seed_count: 120, seed_count_estimated: true }),
  openLot('lot-b', 'Porch peppers, first pick', CULTIVARS.megatron, [P5], { seed_stage: 'stored', seed_count: 40, seed_count_estimated: false }),
  openLot('lot-c', 'Megatron F1 (jumbo jalapeno) — saved 2025', CULTIVARS.megatron, []),
  openLot('lot-long', LONGEST_LOT_NAME, MIX3_VARIETY, [P2, P3, P5], { seed_stage: 'stored', seed_count: 7000, seed_count_estimated: true, seed_weight_g: '13.845' }),
  openLot('lot-d', 'Bulgarian Carrot (Shipka) — saved 2026', CULTIVARS.shipka, [P2], { seed_count: 85, seed_count_estimated: false }),
  openLot('lot-f', 'Kori Sitakame — saved 2026', CULTIVARS.kori, [P4], { seed_weight_g: '2.100' }),
]
const OPEN_LOTS = {
  list0: [],
  list1: [SIX[1]],
  list6: SIX,
  addrefile: [REFILE_LOT],
  addrefused: [REFILE_LOT],
}
const openLots = OPEN_LOTS[CASE] ?? []
// How many times the list was read, and whether it has answered. The named link's path makes NO read.
const wire = { lotsReads: 0, lotsAnswered: 0 }

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
    if (view === 'add') return json({ id: MIX3_VARIETY.id, name: MIX3_VARIETY.name, created: true })
    return CASE === 'blendfailed'
      ? json({ error: 'Method not allowed' }, 405)
      : json({ id: 'v-mix', name: 'Bulgarian Carrot (Shipka) + Megatron F1 (jumbo jalapeno) mix', created: true })
  }
  // The list's read. Named before the generic arms below: unnamed, it would be answered `{}`, which the
  // form reads as "could not load".
  if (u.includes('/api/inventory-items/seed-lots-open')) {
    wire.lotsReads += 1
    return json({ plant_id: 'p-1', crop_slug: 'pepper', open_lots: openLots }).finally(() => { wire.lotsAnswered += 1 })
  }
  // The write. Only `addrefused` taps "Add to this lot", and there the lot was used up somewhere else:
  // a coded refusal, so the form prints its own sentence and unlocks.
  if (u.includes('/seed-additions') && method === 'POST') {
    return json({ error: 'This seed lot is used up or no longer in use', code: 'lot_used_up' }, 409)
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
  view,
  expectRows: 1 + adds.length,
  lotsReads: () => wire.lotsReads,
}

async function run() {
  createRoot(document.getElementById('root')).render(
    <MemoryRouter initialEntries={['/plantings/p-1']}>
      <ToastProvider>
        <SaveSeedSheet planting={P1} ownLots={OWN_LOTS[CASE] ?? []} onSeedAdded={() => {}} onClose={() => {}} />
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

  if (view !== 'new') {
    await until('the link to a lot already started is offered', () => !!$('save-seed-put-in-lot'))
    $('save-seed-put-in-lot').click()
    if (CASE === 'addcounted') {
      await until('the add form opened straight from the named link', () => !!$('seed-add-going-into'))
    } else {
      await until('the lot list is open', () => !!$('seed-lot-list-heading'))
      await until('the list was read', () => wire.lotsAnswered >= 1)
      await until(`the list shows ${openLots.length} lot(s)`, () => $$('seed-lot-row').length === openLots.length)
      // Loading and "none" are both the state line; only the second is what `list0` measures.
      if (openLots.length === 0) {
        await until('the list says there are no lots', () => $('seed-lot-list-state')?.textContent === lotsNoneLine(cropWords('pepper')))
      } else {
        await until('the loading line is gone', () => !$('seed-lot-list-state'))
      }
    }
    if (CASE === 'addrefile' || CASE === 'addrefused') {
      $('seed-lot-row').click()
      await until('the add form says the lot will be re-filed', () => !!$('seed-add-refile'))
    }
    if (CASE === 'addrefused') {
      $('save-seed-submit').click()
      await until('the refusal sentence is on screen', () => !!$('seed-add-error'))
      await until('"Add to this lot" is back from "Adding…"', () => !$('save-seed-submit').disabled)
    }
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
