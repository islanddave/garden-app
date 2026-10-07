// seed-lots-open.int.test.js — V5-SEEDLOTADDITION-001 (release 3) on a real Postgres:
// GET /api/inventory-items/seed-lots-open?plant_id=, "which seed lots could this planting's seed go into?"
//
// WHY THIS FILE EXISTS. The read is ONE statement with eleven conjuncts, three LATERALs and a CASE, and
// the unit suite can only show that the text is there. What decides whether the sheet offers the right
// lots is what the database does with it on real rows — and a filter that is wrong in ONE conjunct
// still returns a plausible list. So every lot here is SINGLE-FAULT: each one that must be left out is
// the "stored this year" lot in every respect but the one named, and each is a case of its own.
//
// The same rows then prove the other half of the read's job: what it says about a lot (is_member,
// same_variety, its plants) is exactly what the WRITE needs — a POST built from each returned row
// answers 200. The contract file's `filing_cases` hold the read and the client to one definition of
// same_variety, so each of those is built and read here too.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK (L-108).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { seedVarietyFixture, seedMixTeardown } from './_seedLotKit.js'
import { handler as invHandler } from '../../lambda/inventory-items/index.js'
import { handler as varietiesHandler } from '../../lambda/varieties/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'tests', 'contracts', 'seed-mix.json'), 'utf8'))

const RUN = testRunId()
const USER = `slo-user-${RUN}`
const FOREIGN = `slo-foreign-${RUN}`
const UNUSABLE = 'plant_id does not match a planting you can use'

const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_addition') IS NOT NULL AS additions,
         to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components`
const MISSING = [
  !present.additions && 'public.seed_lot_addition (migrations/v5-seedlotaddition-001/0a-additive-ddl.sql)',
  !present.links && 'public.seed_lot_parent_planting (v5-seedmultiparent-001)',
  !present.components && 'public.variety_blend_component (v5-varietyblend-001)',
].filter(Boolean)
const READY = MISSING.length === 0

describe('seed lots open — the schema is on this branch', () => {
  it('the picking table and the tables it hangs on exist (apply v5-seedlotaddition-001 before the code that names it)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
let YEAR                 // this year, in New York, as the database counts it
const measured = (line) => {
  console.log(`[R3-MEASURED] ${line}`)
  if (process.env.R3_MEASURE_LOG) appendFileSync(process.env.R3_MEASURE_LOG, `${line}\n`)
}

async function planting(tag, { by = USER, variety = fx.v.a1, sourceLot = null } = {}) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id, source_inventory_item_id)
    VALUES (NULL, ${`${tag}-slo-${RUN}-${seq++}`}, ${by}, ${variety}, ${sourceLot})
    RETURNING id`
  return p.id
}
const inv = (method, path, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method, path, body })
}
const open = (plantId, as = USER) => inv('GET', `/api/inventory-items/seed-lots-open?plant_id=${plantId}`, undefined, as)
async function newMix(ids) {
  setTestUserId(USER)
  const r = await callHandler(varietiesHandler, {
    method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: ids, create: true },
  })
  expect([200, 201], `POST /api/varieties/blend -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status)
  return r.body.id
}
// The "stored this year" lot: a live, active seed lot with one container, no source kind, stored,
// made on the given hour of this New York year, filed under `variety` with `parents` (through the
// route, so the links and the cache are what the app writes).
async function storedLot({ variety = fx.v.a1, parents = [], hour = 6, by = USER } = {}) {
  const r = await inv('POST', '/api/inventory-items', {
    name: `slo-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
    quantity_on_hand: 1, variety_id: variety, ...(parents.length ? { source_plant_ids: parents } : {}),
  }, by)
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  await directSql`
    UPDATE inventory_items
       SET seed_stage = 'stored', seed_process = 'dry',
           created_at = ${`${YEAR}-01-01T05:30:00Z`}::timestamptz + ${hour}::int * interval '1 hour'
     WHERE id = ${r.body.id}`
  return r.body.id
}
// A second link written directly: a set the parent rules would refuse today, as older data holds it.
const linkDirectly = (lot, plant) => directSql`
  INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
  VALUES (${lot}, ${plant}, 'seed_parent', ${USER})`

beforeAll(async () => {
  if (!READY) return
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'slo' })
  YEAR = (await directSql`SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/New_York'))::int AS y`)[0].y
}, 60000)

afterAll(async () => {
  if (!READY) return
  const ids = assertFixtureId(USER, FOREIGN)
  await settle(`seed-lots-open teardown ${RUN}`, [
    // The own-source-lot case: a planting sown FROM a lot. plants and inventory_items then hold each
    // other (both keys RESTRICT), so this file lets go of its own pointer first.
    () => directSql`UPDATE plants SET source_inventory_item_id = NULL WHERE created_by = ANY(${ids}) AND source_inventory_item_id IS NOT NULL`,
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T10 — the filter, one fault at a time
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T10 — which lots are offered, and in what order', () => {
  const lot = {}
  let plant            // the planting asked about: variety a1, crop a
  let reply

  beforeAll(async () => {
    const [pA, pB, pCropB, pBare, pOther] = [
      await planting('p-a1'), await planting('p-a2', { variety: fx.v.a2 }), await planting('p-b', { variety: fx.v.b }),
      await planting('p-bare', { variety: null }), await planting('p-a1-other'),
    ]
    plant = await planting('asked')

    // ── IN ──────────────────────────────────────────────────────────────────────────────────────
    lot.storedThisYear = await storedLot({ parents: [pA], hour: 10 })
    lot.dryingLastYear = await storedLot({ parents: [pA], hour: 11 })
    await directSql`UPDATE inventory_items SET seed_stage = 'drying', created_at = ${`${YEAR - 1}-06-15T12:00:00Z`}::timestamptz WHERE id = ${lot.dryingLastYear}`
    lot.noParentSameVariety = await storedLot({ hour: 12 })
    // 05:30 UTC on 1 January is 00:30 in New York: the first half hour of THIS year there.
    lot.firstHalfHour = await storedLot({ parents: [pA], hour: 0 })
    lot.bareParentThisCrop = await storedLot({ parents: [pBare], hour: 13 })
    lot.otherVarietyWithParent = await storedLot({ variety: fx.v.a2, parents: [pB], hour: 14 })
    lot.member = await storedLot({ parents: [plant], hour: 1 })

    // ── OUT: each is "stored this year" but for the one thing its name says ─────────────────────────
    lot.storedLastYear = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET created_at = ${`${YEAR - 1}-06-15T12:00:00Z`}::timestamptz WHERE id = ${lot.storedLastYear}`
    lot.fermenting = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET seed_stage = 'fermenting' WHERE id = ${lot.fermenting}`
    // A gift cannot name a plant (chk_inventory_seed_source_plant), so it is the no-parent lot + its kind.
    lot.gift = await storedLot()
    await directSql`UPDATE inventory_items SET source_kind = 'gift' WHERE id = ${lot.gift}`
    lot.usedUp = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET quantity_on_hand = 0 WHERE id = ${lot.usedUp}`
    lot.depleted = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET status = 'depleted' WHERE id = ${lot.depleted}`
    lot.softDeleted = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET deleted_at = now() WHERE id = ${lot.softDeleted}`
    lot.ownSource = await storedLot({ parents: [pA] })
    await directSql`UPDATE plants SET source_inventory_item_id = ${lot.ownSource} WHERE id = ${plant}`
    lot.noParentOtherVariety = await storedLot({ variety: fx.v.a2 })
    lot.otherCrop = await storedLot({ variety: fx.v.b, parents: [pCropB] })
    // 04:30 UTC on 1 January is 23:30 on 31 December in New York: LAST year there.
    lot.lastHalfHour = await storedLot({ parents: [pA] })
    await directSql`UPDATE inventory_items SET created_at = ${`${YEAR}-01-01T04:30:00Z`}::timestamptz WHERE id = ${lot.lastHalfHour}`
    lot.bareParentOtherCrop = await storedLot({ variety: fx.v.b, parents: [pBare] })
    lot.twoCrops = await storedLot({ parents: [pOther] })
    await linkDirectly(lot.twoCrops, pCropB)
    // Not a fault of the lot: someone else's.
    const theirs = await planting('theirs', { by: FOREIGN })
    lot.foreign = await storedLot({ parents: [theirs], by: FOREIGN })

    reply = await open(plant)
  }, 120000)

  const IN = ['member', 'otherVarietyWithParent', 'bareParentThisCrop', 'noParentSameVariety', 'storedThisYear', 'firstHalfHour', 'dryingLastYear']
  const OUT = ['storedLastYear', 'fermenting', 'gift', 'usedUp', 'depleted', 'softDeleted', 'ownSource', 'noParentOtherVariety',
    'otherCrop', 'lastHalfHour', 'bareParentOtherCrop', 'twoCrops', 'foreign']
  const nameOf = (id) => Object.entries(lot).find(([, v]) => v === id)?.[0] ?? `UNKNOWN ${id}`

  it('200, with the planting, its crop, and the list', () => {
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(Object.keys(reply.body).sort()).toEqual([...CONTRACT.seed_lots_open_get.required].sort())
    expect(reply.body).toMatchObject({ plant_id: plant, crop_slug: fx.crops.a })
    for (const row of reply.body.open_lots) {
      expect(Object.keys(row).sort(), nameOf(row.id)).toEqual([...CONTRACT.seed_lots_open_get.row_required].sort())
    }
  })

  for (const name of IN) {
    it(`IN: ${name}`, () => {
      expect(reply.body.open_lots.map((r) => nameOf(r.id))).toContain(name)
    })
  }
  for (const name of OUT) {
    it(`OUT: ${name}`, () => {
      expect(reply.body.open_lots.map((r) => nameOf(r.id))).not.toContain(name)
    })
  }

  it('every fixture lot is one or the other, and the list is exactly the seven', () => {
    expect([...IN, ...OUT].sort()).toEqual(Object.keys(lot).sort())
    expect(reply.body.open_lots.map((r) => nameOf(r.id)).sort()).toEqual([...IN].sort())
    measured(`T10 IN  | ${reply.body.open_lots.map((r) => nameOf(r.id)).join(', ')}`)
    measured(`T10 OUT | ${OUT.join(', ')}`)
  })

  it('the exact ORDER: a lot this plant is in, then lots of its variety newest first, then the rest', () => {
    // is_member DESC, same_variety DESC, created_at DESC, id DESC. The hours the fixture gave each
    // this-year lot make the middle group's order a matter of record: 13, 12, 10, then 00:30, and the
    // lot drying since last year is the oldest of all.
    expect(reply.body.open_lots.map((r) => nameOf(r.id))).toEqual([
      'member',
      'bareParentThisCrop', 'noParentSameVariety', 'storedThisYear', 'firstHalfHour', 'dryingLastYear',
      'otherVarietyWithParent',
    ])
    const flags = Object.fromEntries(reply.body.open_lots.map((r) => [nameOf(r.id), [r.is_member, r.same_variety]]))
    expect(flags).toEqual({
      member: [true, true],
      bareParentThisCrop: [false, true],
      noParentSameVariety: [false, true],
      storedThisYear: [false, true],
      firstHalfHour: [false, true],
      dryingLastYear: [false, true],
      otherVarietyWithParent: [false, false],
    })
    measured(`T10 ORDER | ${reply.body.open_lots.map((r) => `${nameOf(r.id)}[member=${r.is_member},same=${r.same_variety}]`).join(' > ')}`)
  })

  it('each row is the lot: its filing, its measure, its stage, and its plants as the lot page lists them', async () => {
    const byName = Object.fromEntries(reply.body.open_lots.map((r) => [nameOf(r.id), r]))
    expect(byName.storedThisYear).toMatchObject({
      variety_id: fx.v.a1, variety_name: fx.names.a1, variety_rank: 'cultivar', crop_slug: fx.crops.a,
      seed_stage: 'stored', seed_process: 'dry', stage_entered_at: null, status: 'active', quantity_on_hand: '1.000',
      seed_count: null, seed_count_estimated: null, seed_weight_g: null, seed_parent_plant_count: null,
    })
    expect(byName.storedThisYear.source_plants).toHaveLength(1)
    expect(Object.keys(byName.storedThisYear.source_plants[0]).sort()).toEqual([...CONTRACT.seed_lot.source_plant_required].sort())
    expect(byName.storedThisYear.source_plant_id).toBe(byName.storedThisYear.source_plants[0].id)
    expect(byName.noParentSameVariety.source_plants).toEqual([])
    expect(byName.noParentSameVariety.source_plant_id).toBeNull()
    expect(byName.member.source_plants.map((p) => p.id)).toEqual([plant])
    expect(byName.bareParentThisCrop.source_plants[0]).toMatchObject({ variety_id: null, crop_slug: null })
    expect(byName.dryingLastYear.seed_stage).toBe('drying')
    expect(new Date(byName.firstHalfHour.created_at).toISOString()).toBe(`${YEAR}-01-01T05:30:00.000Z`)
    // What the GET of the lot itself says about its plants is what this row says.
    const detail = await inv('GET', `/api/inventory-items/${lot.storedThisYear}`)
    expect(byName.storedThisYear.source_plants).toEqual(detail.body.source_plants)
  })

  it('a POST built from each returned row — its plants, its variety — answers 200', async () => {
    const mix = await newMix([fx.v.a1, fx.v.a2])
    for (const row of reply.body.open_lots) {
      const name = nameOf(row.id)
      const body = {
        addition_key: randomUUID(), plant_id: plant, expected_source_plant_ids: row.source_plants.map((p) => p.id),
        picked_on: `${YEAR}-01-02`, add_seed_count: 3, add_estimated: true,
        // Only the lot of another variety has to move to the mix: that is what same_variety false says.
        ...(name === 'otherVarietyWithParent' ? { filing: { variety_id: mix, expect_variety_id: row.variety_id } } : {}),
      }
      expect(row.same_variety, name).toBe(name !== 'otherVarietyWithParent')
      // eslint-disable-next-line no-await-in-loop
      const r = await inv('POST', `/api/inventory-items/${row.id}/seed-additions`, body)
      expect(r.status, `${name} -> ${JSON.stringify(r.body)}`).toBe(200)
      expect(r.body.addition, name).toMatchObject({ replayed: false, plant_was_added: !row.is_member })
      measured(`T10 POST from row | ${name} | HTTP ${r.status} | plant_was_added ${r.body.addition.plant_was_added}`)
    }
    // Now the plant is in all seven: every one of them is offered as its own.
    const after = await open(plant)
    expect(after.body.open_lots.map((r) => nameOf(r.id)).sort()).toEqual([...IN].sort())
    for (const row of after.body.open_lots) expect(row.is_member, nameOf(row.id)).toBe(true)
    expect(after.body.open_lots.find((r) => r.id === lot.otherVarietyWithParent)).toMatchObject({ variety_id: mix, variety_rank: 'blend', same_variety: true })
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The contract's filing cases: one definition of same_variety, read here and mocked in the client
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T10 — same_variety and the re-file, case by case from the contract file', () => {
  const V = {}
  const mixOf = async (symbols) => newMix(symbols.map((s) => V[s]))
  const resolve = async (symbol) => {
    if (symbol == null) return null
    const m = symbol.match(/^mix\((.+)\)$/)
    return m ? mixOf(m[1].split(',')) : V[symbol]
  }

  beforeAll(() => { Object.assign(V, { A: fx.v.a1, B: fx.v.a2, C: fx.v.a3 }) })

  it('the file has cases on both sides of each answer', () => {
    const cases = CONTRACT.filing_cases.cases
    expect(cases.length).toBeGreaterThanOrEqual(6)
    expect(cases.some((c) => c.same_variety)).toBe(true)
    expect(cases.some((c) => !c.same_variety)).toBe(true)
    expect(cases.some((c) => c.refile)).toBe(true)
    expect(cases.some((c) => !c.refile && !c.same_variety)).toBe(true)
  })

  for (const c of CONTRACT.filing_cases.cases) {
    it(`${c.name}: same_variety ${c.same_variety}, re-file ${c.refile}`, { timeout: 60000 }, async () => {
      // The lot, with its parents (one of each variety named; null = a parent planting with no variety).
      const parents = []
      for (const v of c.parent_varieties) {
        // eslint-disable-next-line no-await-in-loop
        parents.push(await planting('fc-parent', { variety: await resolve(v) }))
      }
      // Built as the oldest variety's lot, then filed where the case says: a lot filed by hand under a
      // mix its parents do not make is exactly what one case here is.
      const made = await storedLot({ variety: await resolve(c.parent_varieties.find((v) => v != null) ?? c.lot_variety), parents: parents.slice(0, 1), hour: 20 })
      for (const p of parents.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        await linkDirectly(made, p)
      }
      const filedUnder = await resolve(c.lot_variety)
      await directSql`UPDATE inventory_items SET variety_id = ${filedUnder} WHERE id = ${made}`
      const plant = await planting('fc-plant', { variety: V[c.plant_variety] })

      const r = await open(plant)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const row = r.body.open_lots.find((x) => x.id === made)
      expect(row, 'the case\'s lot is offered to the case\'s plant').toBeDefined()
      expect(row.is_member).toBe(false)
      expect(row.same_variety).toBe(c.same_variety)
      expect(row.variety_id).toBe(filedUnder)
      measured(`T10 filing case | ${c.name} | same_variety ${row.same_variety} (file says ${c.same_variety}) | re-file needed ${c.refile}`)

      const base = {
        plant_id: plant, expected_source_plant_ids: row.source_plants.map((p) => p.id), picked_on: `${YEAR}-01-02`,
      }
      const post = (extra = {}) => inv('POST', `/api/inventory-items/${made}/seed-additions`, { addition_key: randomUUID(), ...base, ...extra })
      if (c.refile) {
        // Without the filing the write asks for the mix — which is what "re-file" means…
        const bare = await post()
        expect(bare.status, JSON.stringify(bare.body)).toBe(400)
        expect(bare.body.code).toBe('blend_required')
        // …and with it, built from the row, it is a 200 and the lot is filed there.
        const target = await resolve(c.refile_to)
        const ok = await post({ filing: { variety_id: target, expect_variety_id: row.variety_id } })
        expect(ok.status, JSON.stringify(ok.body)).toBe(200)
        expect(ok.body).toMatchObject({ variety_id: target, filing: { changed: true } })
      } else {
        const ok = await post()
        expect(ok.status, JSON.stringify(ok.body)).toBe(200)
        expect(ok.body.variety_id).toBe(filedUnder)
        expect(ok.body).not.toHaveProperty('filing')
      }
    })
  }
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The planting asked about
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T10 — the planting: required, the household\'s, live', () => {
  it('no plant_id, or one that is not an id, is 400 before anything is read', async () => {
    for (const path of ['/api/inventory-items/seed-lots-open', '/api/inventory-items/seed-lots-open?plant_id=tomato', '/api/inventory-items/seed-lots-open?crop_slug=tomato']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await inv('GET', path)
      expect(r.status, path).toBe(400)
      expect(r.body, path).toEqual({ error: 'plant_id must be the id of a planting' })
    }
    expect((await inv('POST', `/api/inventory-items/seed-lots-open?plant_id=${randomUUID()}`, {})).status).toBe(405)
  })

  it('a foreign planting, a deleted one and one that does not exist are the same 400, and it names no lot', async () => {
    const mine = await planting('mine')
    const myLot = await storedLot({ parents: [mine] })
    const theirs = await planting('theirs', { by: FOREIGN })
    const gone = await planting('gone')
    await directSql`UPDATE plants SET deleted_at = now() WHERE id = ${gone}`
    for (const [label, id] of [['foreign', theirs], ['deleted', gone], ['absent', randomUUID()]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await open(id)
      expect(r.status, label).toBe(400)
      expect(r.body, label).toEqual({ error: UNUSABLE })
      expect(JSON.stringify(r.body), label).not.toContain(myLot)
      measured(`T10 planting | ${label} -> HTTP ${r.status} ${JSON.stringify(r.body)}`)
    }
    // The same planting, asked by its own household, is a 200 — and the other household sees none of USER's lots.
    const asTheirs = await open(theirs, FOREIGN)
    expect(asTheirs.status).toBe(200)
    expect(asTheirs.body.open_lots.map((r) => r.id)).not.toContain(myLot)
  })

  it('a planting with no variety, and one whose variety has no crop: 200, an empty list, crop_slug null', async () => {
    const bare = await planting('no-variety', { variety: null })
    const noCrop = await planting('no-crop', { variety: fx.v.n1 })
    // A lot filed under that very no-crop variety, with that variety's planting: still not offered —
    // "same crop" has nothing to compare when the planting's variety names no crop.
    await storedLot({ variety: fx.v.n1 })
    for (const [label, id] of [['no variety', bare], ['variety with no crop', noCrop]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await open(id)
      expect(r.status, label).toBe(200)
      expect(r.body, label).toEqual({ plant_id: id, crop_slug: null, open_lots: [] })
      measured(`T10 planting | ${label} -> HTTP 200 open_lots [] crop_slug null`)
    }
  })
})
