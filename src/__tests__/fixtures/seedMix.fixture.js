// V5-SEEDMULTIPARENT-001 release 2b — the client's mocks for the seed-mix routes, BUILT FROM the contract
// file the server's seam test verifies (tests/contracts/seed-mix.json `examples`: one real reply per route).
// A mock typed by hand drifts from the server the day a key is renamed; one read out of the contract fails
// seedMixContract.test.js instead, which asserts the contract's `version` first.
//
// Every reply function returns a fresh deep copy of the route's example BODY, with `over` spread on top, so
// a test can change it freely. `refusal(code)` returns { status, body } because a refusal is told apart by
// both. The contract has NO example for the picker row; that mock has no contract source and is each
// test's own.
//
// Release 3 (V5-SEEDLOTADDITION-001, contract version 3) — the "put it in a seed lot I already started"
// replies are here too, each from its recorded example: the additions POST (first, and replayed), the
// open-lots read, and GET /api/plants/:id/seed-lots (the sheet's `ownLots` source).
import contract from '../../../tests/contracts/seed-mix.json'

const copy = (v) => JSON.parse(JSON.stringify(v))
const example = (route) => copy(contract.examples[route].body)

// POST /api/varieties/blend
export function blendReply(over = {}) {
  return { ...example('POST /api/varieties/blend'), ...over }
}

// POST /api/inventory-items and GET /api/inventory-items/:id (the two examples carry the same keys):
// a jar filed as a mix, three plantings of two cultivars.
export function lotReply(over = {}) {
  return { ...example('GET /api/inventory-items/:id'), ...over }
}

// PUT /api/inventory-items/:id/source-plants. The reply carries `filing` only when the request sent one:
// pass { filing: true } for the contract's example block, or an object to spread over it.
export function sourcePlantsPutReply({ filing, ...over } = {}) {
  const { filing: exampleFiling, ...body } = example('PUT /api/inventory-items/:id/source-plants')
  const out = { ...body, ...over }
  if (filing) out.filing = filing === true ? exampleFiling : { ...exampleFiling, ...filing }
  return out
}

// PUT /api/inventory-items/:id/filing
export function filingReply(over = {}) {
  return { ...example('PUT /api/inventory-items/:id/filing'), ...over }
}

// PUT /api/inventory-items/:id/seed-measure
export function measureReply(over = {}) {
  return { ...example('PUT /api/inventory-items/:id/seed-measure'), ...over }
}

// A refusal by its code, from the contract's three refusal tables: { status, body } with every key the
// contract promises for that code. The sentence is the contract's where it pins one; otherwise a marker
// no screen should ever print (the client words its own refusals).
export function refusal(code) {
  // The additions route's own table (release 3) has the same entry shape as the shared one.
  const lot = contract.refusals[code] ?? contract.seed_additions_post.refusals[code]
  const blendStatus = contract.varieties_blend.refusals[code]
  if (!lot && blendStatus == null) throw new Error(`seedMix.fixture: the contract has no refusal "${code}"`)
  const body = { error: lot?.error ?? `server sentence for ${code}`, code }
  const required = lot?.required ?? ['error', 'code']
  const plantIds = example('GET /api/inventory-items/:id').source_plants.map((p) => p.id)
  if (required.includes('plant_id')) body.plant_id = plantIds[0]
  if (required.includes('source_plant_ids')) body.source_plant_ids = plantIds
  if (required.includes('component_variety_ids')) {
    body.component_variety_ids = example('POST /api/varieties/blend').components.map((c) => c.id)
  }
  return { status: lot?.status ?? blendStatus, body }
}

// ── Release 3: adding seed to a lot that already exists ──────────────────────────────────────────────

// POST /api/inventory-items/:id/seed-additions, FIRST time. The recorded example is an addition from a
// plant new to the lot that also re-filed it as a mix, so it carries `filing`. Like sourcePlantsPutReply:
// no `filing` unless asked — pass { filing: true } for the example's block, or an object to spread over
// it. `addition` is spread over the example's (replayed false), so { addition: { plant_was_added: false } }
// is a same-plant addition.
export function additionReply({ filing, addition, ...over } = {}) {
  const { filing: exampleFiling, addition: exampleAddition, ...body } = example(contract.seed_additions_post.route)
  const out = { ...body, ...over, addition: { ...exampleAddition, ...addition } }
  if (filing) out.filing = filing === true ? exampleFiling : { ...exampleFiling, ...filing }
  return out
}

// The same request sent again: 200, `addition.replayed` true, the lot as it stands, and never `filing`.
export function additionReplayReply({ addition, ...over } = {}) {
  const { addition: exampleAddition, ...body } = example(contract.seed_additions_post.replay_example)
  return { ...body, ...over, addition: { ...exampleAddition, ...addition } }
}

// GET /api/inventory-items/seed-lots-open?plant_id= — { plant_id, crop_slug, open_lots }. One lot in the
// example: drying, counted, one parent of another variety (is_member false, same_variety false).
export function openLotsReply(over = {}) {
  return { ...example(contract.seed_lots_open_get.route), ...over }
}

// One row of open_lots, from the example's, with `over` on top — for building a list of several.
export function openLotRow(over = {}) {
  return { ...example(contract.seed_lots_open_get.route).open_lots[0], ...over }
}

// GET /api/plants/:id/seed-lots — { plant_id, seed_lots }: what the sheet's `ownLots` is read from.
export function plantSeedLotsReply(over = {}) {
  return { ...example(contract.plants_seed_lots_get.route), ...over }
}

// One row of seed_lots, from the example's (it has one other parent), with `over` on top.
export function plantSeedLot(over = {}) {
  return { ...example(contract.plants_seed_lots_get.route).seed_lots[0], ...over }
}

// PUT /api/inventory-items/:id/seed-measure answering 409: the lot no longer holds what the page loaded.
// { status, body } with the four measure keys the route hands back; the values are the additions
// example's unless `over` says otherwise.
export function measureChangedRefusal(over = {}) {
  const now = example(contract.seed_additions_post.route)
  const { status, body } = refusal('lot_changed')
  return {
    status,
    body: {
      ...body,
      seed_count: now.seed_count,
      seed_count_estimated: now.seed_count_estimated,
      seed_weight_g: now.seed_weight_g,
      seed_parent_plant_count: now.seed_parent_plant_count,
      ...over,
    },
  }
}

// The contract's filing cases: (lot variety, parent varieties, plant variety) -> same_variety, refile.
export function filingCases() {
  return copy(contract.filing_cases.cases)
}

// The three ways a lot can carry NO readable parent set, as `source_plants` values. All three are GEN row
// 0. `undefined` is an old fixture or a Lambda from before release 1; `null` is a parents read that failed
// (never cached); `[]` is a lot with no parents.
export const PARENTS_UNDEFINED = undefined
export const PARENTS_NULL = null
export const PARENTS_EMPTY = Object.freeze([])

// The release-1 default: one element mirroring the lot's cache column and its filed variety. [] for a lot
// with no parent plant.
export function PARENTS_R1(lot) {
  if (lot?.source_plant_id == null || lot.source_plant_id === '') return []
  return [{
    id: lot.source_plant_id,
    name: lot.source_plant_name ?? '',
    variety_id: lot.variety_id ?? null,
    variety_name: lot.variety_name ?? null,
    breeding_system: lot.breeding_system ?? null,
    variety_rank: lot.variety_rank ?? null,
    crop_slug: lot.crop_slug ?? null,
    archived: false,
    deleted: false,
  }]
}
