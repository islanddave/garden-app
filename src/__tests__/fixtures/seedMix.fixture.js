// V5-SEEDMULTIPARENT-001 release 2b — the client's mocks for the seed-mix routes, BUILT FROM the contract
// file the server's seam test verifies (tests/contracts/seed-mix.json `examples`: one real reply per route).
// A mock typed by hand drifts from the server the day a key is renamed; one read out of the contract fails
// seedMixContract.test.js instead, which asserts the contract's `version` first.
//
// Every reply function returns a fresh deep copy of the route's example BODY, with `over` spread on top, so
// a test can change it freely. `refusal(code)` returns { status, body } because a refusal is told apart by
// both. The contract has NO example for the picker row or for GET /api/plants/:id/seed-lots; those mocks
// have no contract source and are each test's own.
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

// A refusal by its code, from the contract's two refusal tables: { status, body } with every key the
// contract promises for that code. The sentence is the contract's where it pins one; otherwise a marker
// no screen should ever print (the client words its own refusals).
export function refusal(code) {
  const lot = contract.refusals[code]
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
