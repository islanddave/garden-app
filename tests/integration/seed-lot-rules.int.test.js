// seed-lot-rules.int.test.js — V5-SEEDMULTIPARENT-001 release 2a on a real Postgres: the held verdict,
// the caller's precondition, the parent rules, the wide PUT's two guards and the plant count.
//
// WHY THIS FILE EXISTS. Release 2a's lane I built these against a stub that records SQL as text. Its
// report (lane-I-report.log section 4) lists what a stub cannot show, and the first item is the one
// everything else stands on:
//
//   THE HELD VERDICT. A refusal that depends on the caller's last-read set, or on the parent rules,
//   cannot be re-derived by each write the way release 1's three guards are — the retire changes the
//   set the INSERT after it would compare. So the transaction judges ONCE and keeps the answer in a
//   transaction-local setting, set_config('app.seed_lot_go', 'go' | 'stop', true), which every write
//   reads. Whether a setting made by one statement of the HTTP driver's sql.transaction([...]) is
//   visible to the next, and gone after the commit, is a fact about the driver and the pooler. It is
//   case A1 here, and it is proved before anything that depends on it.
//
// Then, each on real rows: the precondition under a concurrent writer (it must be judged by a statement
// that STARTS after the wait, and only once); every cell of the rules on BOTH doors (POST and PUT), with
// the write read back so a JavaScript pass that the SQL judge then refused shows up as a 2xx with
// nothing written; the re-test under the locks; the wide PUT keeping a parented lot's variety; and the
// plant count's untyped NULL against an integer column.
//
// The case labels (A1, B5, C7, ...) are lane I's, so its list can be ticked off against this file.
// PUT /:id/filing and the lock-order cases are in seed-lot-filing.int.test.js.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK, never the handler's echo (L-108).
// "Nothing was written" is everything() before === everything() after: both tables, timestamps as text.
//
// CONCURRENCY is _seedLotKit.js's twoSessions(): a psql session holds a row, the handler's statement
// shows in pg_blocking_pids(), then the session commits. No sleeps.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import {
  seedVarietyFixture, seedMixTeardown, twoSessions, HAS_PSQL, PSQL_REQUIRED, announcePsqlSkip, lit,
} from './_seedLotKit.js'
import { handler as invHandler } from '../../lambda/inventory-items/index.js'
import { handler as varietiesHandler } from '../../lambda/varieties/index.js'
import { insertSeedParentLinks, lockPlantings, replaceSourcePlants } from '../../lambda/inventory-items/seed-lot-parents.js'
import {
  judgeParentRules, checkParentRules, blendKeyOf, PARENT_WITHOUT_VARIETY, MIXED_CROP_PARENTS, BLEND_REQUIRED,
} from '../../lambda/inventory-items/seed-lot-rules.js'

const RUN = testRunId()
const USER = `slr-user-${RUN}`
const FOREIGN = `slr-foreign-${RUN}`

const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.'
const PLANTS_CHANGED = 'One of those plants changed just now. Reload and try again.'
const STAYS_IN_SEEDS = 'This item is filed under a seed variety, so it has to stay in Seeds.'
const PLANT_COUNT_RANGE = 'seed_parent_plant_count must be a whole number of plants from 1 to 9999, or null'

// What the handlers under test name in SQL and release 1 did not have. On a branch without one of
// them every case below is a 42P01 or a 42703; one failure that says what to apply reads better.
const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'plant_varieties' AND column_name = 'blend_key') AS blend_key,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'seed_parent_plant_count') AS plant_count`
const MISSING = [
  !present.links && 'public.seed_lot_parent_planting (migrations/v5-seedmultiparent-001/0a-additive-ddl.sql)',
  !present.blend_key && 'plant_varieties.blend_key (migrations/v5-varietyblend-001/0a-additive-ddl.sql)',
  !present.components && 'public.variety_blend_component (migrations/v5-varietyblend-001/0a-additive-ddl.sql)',
  !present.plant_count && 'inventory_items.seed_parent_plant_count (migrations/v5-seedplantcount-001/0a-additive-ddl.sql)',
].filter(Boolean)
const READY = MISSING.length === 0

describe('seed lot rules — the schema is on this branch', () => {
  it('the link table, the mix key, the component table and the plant count all exist (apply the three release 2a migrations before the code that names them)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })

  // Blocks B (concurrent) and C (under the locks) are describe.skipIf(!HAS_PSQL). See the kit.
  it.runIf(PSQL_REQUIRED)('psql is on the runner, so this file\'s concurrency cases did not silently skip', () => {
    expect(HAS_PSQL).toBe(true)
  })
})
announcePsqlSkip('seed-lot-rules.int.test.js')

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
const MIX = {}      // varieties made by POST /api/varieties/blend
const P = {}        // plantings every block may read; a block that changes a planting makes its own

async function planting(tag, { by = USER, variety = fx.v.a1, deleted = false } = {}) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id, deleted_at)
    VALUES (NULL, ${`${tag}-slr-${RUN}-${seq++}`}, ${by}, ${variety},
            CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return p.id
}
const setVariety = (plantId, varietyId) => directSql`UPDATE plants SET variety_id = ${varietyId} WHERE id = ${plantId}`

function blend(ids, { create = true, as = USER } = {}) {
  setTestUserId(as)
  return callHandler(varietiesHandler, {
    method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: ids, create },
  })
}
async function newMix(ids, as = USER) {
  const r = await blend(ids, { as })
  expect([200, 201], `POST /api/varieties/blend -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status)
  return r.body.id
}
// The audit trigger on plant_varieties reads the actor; bound the way lambda/varieties binds it.
const softDeleteVariety = (id, as = USER) => directSql.transaction([
  directSql`SELECT set_config('app.actor_clerk_sub', ${as}, true)`,
  directSql`UPDATE plant_varieties SET deleted_at = now() WHERE id = ${id}`,
])

function postLot(extra = {}, as = USER) {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'POST', path: '/api/inventory-items',
    body: {
      name: `slr-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: fx.v.a1, ...extra,
    },
  })
}
async function newLot(extra = {}, as = USER) {
  const r = await postLot(extra, as)
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  return r.body.id
}
const put = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}/source-plants`, body })
}
const widePut = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}`, body })
}
const measure = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}/seed-measure`, body })
}
const filing = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}/filing`, body })
}
const getLot = (lotId, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'GET', path: `/api/inventory-items/${lotId}` })
}

const links = (lotId) => directSql`
  SELECT id, plant_id, role, created_by,
         created_at::text AS created_at, updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM seed_lot_parent_planting
   WHERE inventory_item_id = ${lotId}
   ORDER BY created_at, id`
const livePlants = async (lotId) => (await links(lotId))
  .filter((r) => r.deleted_at == null && r.role === 'seed_parent').map((r) => r.plant_id).sort()
const lotRow = async (lotId) => (await directSql`
  SELECT id, name, category, variety_id, source_plant_id, seed_parent_plant_count, quantity_on_hand::text AS quantity_on_hand,
         notes, updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM inventory_items WHERE id = ${lotId}`)[0]

// Both tables, as far as this file's two users reach, in one comparable string.
async function everything() {
  const lots = await directSql`
    SELECT id, name, category, variety_id, source_plant_id, source_kind, seed_parent_plant_count,
           updated_at::text AS updated_at, deleted_at::text AS deleted_at
      FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN}) ORDER BY id`
  const rows = await directSql`
    SELECT l.id, l.inventory_item_id, l.plant_id, l.role, l.created_by,
           l.created_at::text AS created_at, l.updated_at::text AS updated_at, l.deleted_at::text AS deleted_at
      FROM seed_lot_parent_planting l
     WHERE l.created_by IN (${USER}, ${FOREIGN})
        OR l.inventory_item_id IN (SELECT id FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN}))
     ORDER BY l.id`
  return JSON.stringify({ lots, rows })
}

// The member-cache rule (the two row-level gates of v5-seedmultiparent-001), over `lotIds`.
async function expectCacheRule(...lotIds) {
  const notMember = await directSql`
    SELECT i.id FROM public.inventory_items i
     WHERE i.id = ANY(${lotIds}::uuid[]) AND i.source_plant_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.seed_lot_parent_planting l
                        WHERE l.inventory_item_id = i.id AND l.plant_id = i.source_plant_id
                          AND l.role = 'seed_parent' AND l.deleted_at IS NULL)`
  const noCache = await directSql`
    SELECT DISTINCT l.inventory_item_id FROM public.seed_lot_parent_planting l
      JOIN public.inventory_items i ON i.id = l.inventory_item_id
     WHERE i.id = ANY(${lotIds}::uuid[]) AND l.role = 'seed_parent' AND l.deleted_at IS NULL
       AND i.source_plant_id IS NULL`
  expect({ cacheIsNotALiveParent: notMember.map((r) => r.id), parentsButNoCache: noCache.map((r) => r.inventory_item_id) })
    .toEqual({ cacheIsNotALiveParent: [], parentsButNoCache: [] })
}

const { openSession, onOwnConnection, waitBlockedBy, inOrder, closeAll } = twoSessions()

beforeAll(async () => {
  if (!READY) return
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'slr' })
  // The mixes. `pair` is the household's mix of the two same-crop cultivars; `foreign` has the SAME key
  // and belongs to someone outside the household (its automatic name is already taken by `pair`, so the
  // route gives it the " (2)" suffix); `gone` is the household's mix of another pair, soft-deleted.
  MIX.pair = await newMix([fx.v.a1, fx.v.a2])
  MIX.foreign = await newMix([fx.v.a1, fx.v.a2], FOREIGN)
  MIX.gone = await newMix([fx.v.a2, fx.v.a3])
  await softDeleteVariety(MIX.gone)

  for (const [key, variety] of [
    ['a1', fx.v.a1], ['a1b', fx.v.a1], ['a1c', fx.v.a1], ['a2', fx.v.a2], ['a3', fx.v.a3], ['b', fx.v.b],
    ['n1', fx.v.n1], ['n1b', fx.v.n1], ['n2', fx.v.n2], ['gone', fx.v.gone], ['bare', null], ['mix', MIX.pair],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    P[key] = await planting(key, { variety })
  }
}, 60000)

afterAll(async () => {
  closeAll()
  if (!READY) return
  const ids = assertFixtureId(USER, FOREIGN)
  await settle(`seed-lot-rules teardown ${RUN}`, seedMixTeardown(ids, fx?.crops))
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// A. THE HELD VERDICT
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('A — the held verdict (app.seed_lot_go) through the app\'s driver', () => {
  it('A1: a setting made by one statement of sql.transaction is read by a later one, and by none after the commit', async () => {
    const [, read] = await directSql.transaction([
      directSql`SELECT set_config('app.seed_lot_go', 'go', true) AS go`,
      directSql`SELECT current_setting('app.seed_lot_go', true) AS go`,
    ])
    expect(read).toEqual([{ go: 'go' }])
    // After the commit, on whatever pooled backend answers: NULL where the name was never used, '' where
    // it was (a custom setting, once seen by a backend, reads as the empty string outside the
    // transaction that set it). Never 'go' — which is all the writes test for.
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [after] = await directSql`SELECT current_setting('app.seed_lot_go', true) AS go`
      expect([null, '']).toContain(after.go)
    }
  })

  it('A1: insertSeedParentLinks ALONE in a transaction writes nothing though every planting is usable; with judgeParentRules(alone) ahead of it, it writes', async () => {
    const lot = await newLot()
    const args = { lotId: lot, ids: [P.a1, P.a1b], householdIds: [USER], userId: USER }

    const alone = await directSql.transaction([
      lockPlantings(directSql, args.ids),
      insertSeedParentLinks(directSql, args),
    ], { fullResults: true })
    expect(alone[1].rowCount).toBe(0)
    expect(await links(lot)).toEqual([])

    const judged = await directSql.transaction([
      lockPlantings(directSql, args.ids),
      judgeParentRules(directSql, { lotId: lot, ids: args.ids, householdIds: [USER], alone: true }),
      insertSeedParentLinks(directSql, args),
    ], { fullResults: true })
    expect(judged[1].rows).toEqual([{ rules_hold: true, go: 'go' }])
    expect(judged[2].rowCount).toBe(2)
    expect(await livePlants(lot)).toEqual([P.a1, P.a1b].sort())

    // A judge that is NOT the first of its chain cannot open the verdict: with nothing before it the
    // setting is not 'go', so it answers 'stop' although the rules hold, and the INSERT writes nothing.
    const other = await newLot()
    const notFirst = await directSql.transaction([
      judgeParentRules(directSql, { lotId: other, ids: args.ids, householdIds: [USER] }),
      insertSeedParentLinks(directSql, { ...args, lotId: other }),
    ], { fullResults: true })
    expect(notFirst[0].rows).toEqual([{ rules_hold: true, go: 'stop' }])
    expect(notFirst[1].rowCount).toBe(0)
    expect(await links(other)).toEqual([])
    // Tidy the hand-made state: the first lot has links and no cache.
    await directSql`UPDATE inventory_items SET source_plant_id = ${P.a1} WHERE id = ${lot}`
    await expectCacheRule(lot)
  })

  it('A1: a verdict of stop holds every write of the set route — a refused edit retires nothing', async () => {
    // The set route's own statements: an expected set that is wrong makes statement 2 store 'stop'.
    // The retire runs BEFORE the add; were the verdict re-asked per statement, C would be retired here.
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1c] })
    const before = await everything()
    const r = await put(lot, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [P.a1] })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(await everything()).toBe(before)
    expect(await livePlants(lot)).toEqual([P.a1, P.a1c].sort())
  })

  it('A3: POST with the legacy single key, and with source_plant_ids of one, each make a lot and one link (the one-parent judge opens the verdict and names no table)', async () => {
    for (const extra of [{ source_plant_id: P.a1 }, { source_plant_ids: [P.a1] }]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await postLot(extra)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.body.source_plant_id).toBe(P.a1)
      expect(r.body.source_plants.map((s) => s.id)).toEqual([P.a1])
      // eslint-disable-next-line no-await-in-loop
      expect(await livePlants(r.body.id)).toEqual([P.a1])
      // eslint-disable-next-line no-await-in-loop
      expect((await lotRow(r.body.id)).source_plant_id).toBe(P.a1)
      // eslint-disable-next-line no-await-in-loop
      await expectCacheRule(r.body.id)
    }
    // A planting with NO variety is still a fine single parent: the rules need two.
    const bare = await postLot({ source_plant_ids: [P.bare] })
    expect(bare.status, JSON.stringify(bare.body)).toBe(201)
    expect(await livePlants(bare.body.id)).toEqual([P.bare])
  })

  it('A4: the cache statement prepares with a NULL hint and keeps release 1\'s rule; a hint that is a member becomes the cache', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
    // No hint: `$n::uuid IS NOT NULL AND EXISTS(...)` is false and the kept member stays.
    const kept = await put(lot, { source_plant_ids: [P.a1, P.a1b, P.a1c] })
    expect(kept.status, JSON.stringify(kept.body)).toBe(200)
    expect(kept.body.source_plant_id).toBe(P.a1)
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
    // An explicit null is the same as no hint.
    const nulled = await put(lot, { source_plant_ids: [P.a1, P.a1b, P.a1c], source_plant_id: null })
    expect(nulled.status).toBe(200)
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
    // A hint that is a member, in capitals: it is the cache after the write.
    const hinted = await put(lot, { source_plant_ids: [P.a1, P.a1b, P.a1c], source_plant_id: P.a1c.toUpperCase() })
    expect(hinted.status, JSON.stringify(hinted.body)).toBe(200)
    expect(hinted.body.source_plant_id).toBe(P.a1c)
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1c)
    // A hint for a planting this same request ADDS is a member by the time the cache is written.
    const fresh = await planting('hint')
    const added = await put(lot, { source_plant_ids: [P.a1, fresh], source_plant_id: fresh })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect((await lotRow(lot)).source_plant_id).toBe(fresh)
    // Not one of the set: refused before any SQL, nothing written.
    const before = await everything()
    const stray = await put(lot, { source_plant_ids: [P.a1, fresh], source_plant_id: P.a1b })
    expect(stray.status).toBe(400)
    expect(stray.body).toEqual({ error: 'source_plant_id must be one of source_plant_ids' })
    expect(await everything()).toBe(before)
    await expectCacheRule(lot)
  })

  it('A4: the cache STATEMENT itself takes a hint only while it is a live member — handed one that is not (the route never does), it keeps release 1\'s rule and the cache stays a member', async () => {
    // The route refuses such a hint before any SQL, so only a direct call reaches the statement's own
    // membership test. It is the one id from a request that can land in the column: the test is what
    // keeps the member-cache rule true whatever a future caller sends.
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    const out = await replaceSourcePlants(directSql, {
      lotId: lot, ids: [P.a1, P.a1b], householdIds: [USER], userId: USER, cacheHint: P.a1c,
    })
    expect(out.outcome).toBe('ok')
    expect(out.source_plant_id).toBe(P.a1)
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
    await expectCacheRule(lot)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// B. THE PRECONDITION — expected_source_plant_ids
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('B — expected_source_plant_ids: the set the caller last read', () => {
  it('B1: lot {A,C}, PUT {A,B} expecting [A] -> 409 lot_changed carrying the cache and {A,C}; nothing written, C is NOT retired', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1c] })
    const before = await everything()
    const r = await put(lot, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [P.a1] })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'source_plant_id', 'source_plants'])
    expect(r.body.error).toBe(LOT_CHANGED)
    expect(r.body.code).toBe('lot_changed')
    expect(r.body.source_plant_id).toBe(P.a1)
    expect(r.body.source_plants.map((s) => s.id).sort()).toEqual([P.a1, P.a1c].sort())
    expect(await everything()).toBe(before)
    const c = (await links(lot)).find((x) => x.plant_id === P.a1c)
    expect(c.deleted_at).toBeNull()
    expect(c.updated_at).toBe(c.created_at)
  })

  it('B2: the comparison is of SETS — another order, a repeated id and capitals all match', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1c] })
    for (const expected of [[P.a1c, P.a1], [P.a1, P.a1c, P.a1], [P.a1.toUpperCase(), P.a1c.toUpperCase()]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await put(lot, { source_plant_ids: [P.a1, P.a1c], expected_source_plant_ids: expected })
      expect(r.status, `${JSON.stringify(expected)} -> ${JSON.stringify(r.body)}`).toBe(200)
    }
    // A superset, a subset, and a set of the SAME SIZE with one other member are each a different set
    // (the last is the one a count alone would pass).
    for (const expected of [[P.a1, P.a1c, P.a1b], [P.a1c], [P.a1, P.a1b]]) {
      // eslint-disable-next-line no-await-in-loop
      const before = await everything()
      // eslint-disable-next-line no-await-in-loop
      const r = await put(lot, { source_plant_ids: [P.a1], expected_source_plant_ids: expected })
      expect(r.status, `${JSON.stringify(expected)} -> ${JSON.stringify(r.body)}`).toBe(409)
      expect(r.body.code).toBe('lot_changed')
      // eslint-disable-next-line no-await-in-loop
      expect(await everything()).toBe(before)
    }
    // And when it does match, the write is the one asked for.
    const ok = await put(lot, { source_plant_ids: [P.a1], expected_source_plant_ids: [P.a1, P.a1c] })
    expect(ok.status).toBe(200)
    expect(await livePlants(lot)).toEqual([P.a1])
  })

  it('B3: [] is a real expectation ("no parents"), not absence', async () => {
    const withParents = await newLot({ source_plant_ids: [P.a1] })
    const before = await everything()
    const refused = await put(withParents, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [] })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.code).toBe('lot_changed')
    expect(refused.body.source_plants.map((s) => s.id)).toEqual([P.a1])
    expect(await everything()).toBe(before)

    const none = await newLot()
    const ok = await put(none, { source_plant_ids: [P.a1], expected_source_plant_ids: [] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await livePlants(none)).toEqual([P.a1])
    // A lot with none, told to expect one: stale the other way. source_plant_id null, source_plants [].
    const empty = await newLot()
    const stale = await put(empty, { source_plant_ids: [P.a1], expected_source_plant_ids: [P.a1b] })
    expect(stale.status).toBe(409)
    expect(stale.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', source_plant_id: null, source_plants: [] })
    expect(await links(empty)).toEqual([])
  })

  it('B4: an expected id whose planting was soft-deleted but is still a live member still matches (shape-checked only)', async () => {
    const leaving = await planting('B4')
    const lot = await newLot({ source_plant_ids: [P.a1, leaving] })
    await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${leaving}`
    const r = await put(lot, { source_plant_ids: [P.a1], expected_source_plant_ids: [P.a1, leaving] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await livePlants(lot)).toEqual([P.a1])
    // Malformed: named for the key that was wrong, before any SQL.
    const bad = await put(lot, { source_plant_ids: [P.a1], expected_source_plant_ids: ['nope'] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('expected_source_plant_ids must contain only planting ids')
  })
})

describe.skipIf(!READY || !HAS_PSQL)('B — the precondition under a concurrent writer', () => {
  it('B5: a parent is added to the lot while the PUT waits for it -> 409 lot_changed reporting the set as it now is; the lot is exactly what the other writer left', { timeout: 90000 }, async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const rival = openSession('adds C to the lot')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [P.a1] }))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      await rival.run(`INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
                       VALUES (${lit(lot)}, ${lit(P.a1c)}, 'seed_parent', '${USER}');`)
      await rival.end('COMMIT;')
      const left = await everything()

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body.code).toBe('lot_changed')
      expect(r.body.error).toBe(LOT_CHANGED)
      // Judged by a statement that STARTED after the wait: it reports C, which did not exist when the
      // request was sent.
      expect(r.body.source_plants.map((s) => s.id).sort()).toEqual([P.a1, P.a1c].sort())
      expect(r.body.source_plant_id).toBe(P.a1)
      expect(await everything()).toBe(left)
      expect(await livePlants(lot)).toEqual([P.a1, P.a1c].sort())
    } finally {
      await rival.end()
    }
  })

  it('B5, with two real requests: two devices replace {A} from the same page at once — the first writes, the second answers 409 lot_changed carrying what the first left, and retires nothing', { timeout: 90000 }, async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const [first, second] = await inOrder(
      `SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`,
      () => put(lot, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [P.a1] }),
      () => put(lot, { source_plant_ids: [P.a1c], expected_source_plant_ids: [P.a1], source_plant_id: P.a1c }),
      'B5 two devices')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.code).toBe('lot_changed')
    expect(second.body.source_plant_id).toBe(P.a1)
    expect(second.body.source_plants.map((s) => s.id).sort()).toEqual([P.a1, P.a1b].sort())
    // Without the precondition the second request would have been a 200 that retired A and B.
    expect(await livePlants(lot)).toEqual([P.a1, P.a1b].sort())
    expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
    await expectCacheRule(lot)
  })

  it('B6: the mirror — the other writer makes the expectation TRUE while the PUT waits -> 200 and the set asked for', { timeout: 90000 }, async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1c] })
    const rival = openSession('retires C')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      // Sent while the lot holds {A, C}: at that moment "expected [A]" is false.
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [P.a1, P.a1b], expected_source_plant_ids: [P.a1] }))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      await rival.run(`UPDATE seed_lot_parent_planting SET deleted_at = now(), updated_at = now()
                        WHERE inventory_item_id = ${lit(lot)} AND plant_id = ${lit(P.a1c)} AND deleted_at IS NULL;`)
      await rival.end('COMMIT;')

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(await livePlants(lot)).toEqual([P.a1, P.a1b].sort())
      expect((await lotRow(lot)).source_plant_id).toBe(P.a1)
      await expectCacheRule(lot)
    } finally {
      await rival.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// C. THE RULES — every cell on both doors
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const SENTENCE = {
  parent_without_variety: PARENT_WITHOUT_VARIETY,
  mixed_crop_parents: MIXED_CROP_PARENTS,
  blend_required: BLEND_REQUIRED,
}
const sorted = (...ids) => [...ids].sort()

// One cell through one door. POST: a new lot with the whole set. PUT: a lot that already has the FIRST
// planting, then the whole set — so the request ADDS the rest, which is what makes the rules apply.
async function throughDoor(door, { ids, filedUnder }) {
  if (door === 'POST') {
    const before = await everything()
    const r = await postLot({ source_plant_ids: ids, variety_id: filedUnder })
    return { door, r, before, lot: r.status === 201 ? r.body.id : null, ids }
  }
  const lot = await newLot({ source_plant_ids: [ids[0]], variety_id: filedUnder })
  const before = await everything()
  const r = await put(lot, { source_plant_ids: ids })
  return { door, r, before, lot, ids }
}
async function expectRefused({ r, before }, code, extra = {}) {
  expect(r.status, JSON.stringify(r.body)).toBe(400)
  expect(r.body).toEqual({ error: SENTENCE[code], code, ...extra })
  expect(await everything()).toBe(before)
}
// C9: a 2xx whose write did not happen is the JavaScript fast path and the SQL judge disagreeing.
async function expectWritten({ door, r, lot, ids }) {
  expect(r.status, `${door} -> ${JSON.stringify(r.body)}`).toBe(door === 'POST' ? 201 : 200)
  expect(await livePlants(lot), `${door}: the live parents`).toEqual(sorted(...ids))
  expect((await lotRow(lot)).source_plant_id, `${door}: the cache`).toBe(ids[0])
  expect(r.body.source_plants.map((s) => s.id).sort()).toEqual(sorted(...ids))
  await expectCacheRule(lot)
}

describe.skipIf(!READY)('C — the parent rules, each cell on POST and on PUT /:id/source-plants', () => {
  describe.each(['POST', 'PUT'])('through %s', (door) => {
    it('C1: a planting being ADDED has no variety -> 400 parent_without_variety naming that planting', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.a1, P.bare], filedUnder: fx.v.a1 }),
        'parent_without_variety', { plant_id: P.bare })
    })

    it('C2: two crops -> 400 mixed_crop_parents', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.a1, P.b], filedUnder: fx.v.a1 }), 'mixed_crop_parents')
    })

    it('C2: two varieties that BOTH have no crop are not mixed crop (NULL is one value); they go on to need a mix', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.n1, P.n2], filedUnder: fx.v.n1 }),
        'blend_required', { component_variety_ids: sorted(fx.v.n1, fx.v.n2) })
    })

    it('C2: no crop beside a crop -> 400 mixed_crop_parents (NULL differs from every crop)', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.n1, P.a1], filedUnder: fx.v.n1 }), 'mixed_crop_parents')
    })

    it('C2: two plantings of ONE crop-less variety -> written', async () => {
      await expectWritten(await throughDoor(door, { ids: [P.n1, P.n1b], filedUnder: fx.v.n1 }))
    })

    it('C3: two varieties, lot filed under one of them -> 400 blend_required with both ids in uuid order', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.a1, P.a2], filedUnder: fx.v.a1 }),
        'blend_required', { component_variety_ids: sorted(fx.v.a1, fx.v.a2) })
    })

    it('C3: two varieties, lot filed under the household\'s mix of them -> written', async () => {
      await expectWritten(await throughDoor(door, { ids: [P.a1, P.a2], filedUnder: MIX.pair }))
    })

    it('C3: filed under a mix with the SAME key that belongs to another household -> 400 blend_required', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.a1, P.a2], filedUnder: MIX.foreign }),
        'blend_required', { component_variety_ids: sorted(fx.v.a1, fx.v.a2) })
    })

    it('C3: filed under the household\'s own mix of them, soft-deleted -> 400 blend_required', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.a2, P.a3], filedUnder: MIX.gone }),
        'blend_required', { component_variety_ids: sorted(fx.v.a2, fx.v.a3) })
    })

    it('C4 FLATTEN: a planting of the mix beside a planting of one of its leaves, filed under the mix -> written (the leaves\' key IS the mix\'s key)', async () => {
      await expectWritten(await throughDoor(door, { ids: [P.mix, P.a1], filedUnder: MIX.pair }))
    })

    it('C4 FLATTEN: a planting of the mix beside a THIRD variety -> blend_required naming the mix and the third as stored; the mix the blend route makes of those two is then accepted', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.mix, P.a3], filedUnder: MIX.pair }),
        'blend_required', { component_variety_ids: sorted(MIX.pair, fx.v.a3) })

      // The route is handed exactly what the refusal named, flattens it to three leaves, and the lot
      // routes then accept its row. THIS is the proof that blendKeyOf (JavaScript) and the judge's
      // string_agg over unnest(string_to_array(blend_key, ',')::uuid[]) (SQL) build the same string:
      // the JS fast path and the SQL judge each compare their own key with the one the varieties Lambda
      // stored, and the write goes through.
      const made = await blend(sorted(MIX.pair, fx.v.a3))
      expect([200, 201], JSON.stringify(made.body)).toContain(made.status)
      const three = sorted(fx.v.a1, fx.v.a2, fx.v.a3).join(',')
      expect(made.body.blend_key).toBe(three)
      const [stored] = await directSql`SELECT blend_key FROM plant_varieties WHERE id = ${made.body.id}`
      expect(stored.blend_key).toBe(three)
      expect(blendKeyOf([{ id: MIX.pair, blend_key: `${sorted(fx.v.a1, fx.v.a2).join(',')}` }, { id: fx.v.a3, blend_key: null }])).toBe(three)
      await expectWritten(await throughDoor(door, { ids: [P.mix, P.a3], filedUnder: made.body.id }))
    })

    it('C5: a soft-deleted variety still counts as the planting\'s variety — beside another crop -> mixed_crop_parents; beside a live variety of its own crop -> blend_required naming it', async () => {
      await expectRefused(await throughDoor(door, { ids: [P.gone, P.b], filedUnder: fx.v.a1 }), 'mixed_crop_parents')
      await expectRefused(await throughDoor(door, { ids: [P.gone, P.a1], filedUnder: fx.v.a1 }),
        'blend_required', { component_variety_ids: sorted(fx.v.a1, fx.v.gone) })
    })

    it('one variety across several plantings needs no mix, whatever the lot is filed under -> written', async () => {
      await expectWritten(await throughDoor(door, { ids: [P.a1, P.a1b, P.a1c], filedUnder: fx.v.b }))
    })
  })

  it('the order of refusal is parent_without_variety, then mixed_crop_parents, then blend_required', async () => {
    // All three are true of {bare, a1, b}: no variety on one, two crops, two varieties and no mix.
    await expectRefused(await throughDoor('POST', { ids: [P.a1, P.b, P.bare], filedUnder: fx.v.a1 }),
      'parent_without_variety', { plant_id: P.bare })
    // Two crops and two varieties: the crop is reported, not the mix.
    await expectRefused(await throughDoor('POST', { ids: [P.a1, P.b], filedUnder: MIX.pair }), 'mixed_crop_parents')
  })

  it('C9, cell by cell: the SQL judge (the guarantee) and the JavaScript check (the fast path) reach the SAME verdict on every cell, each asked directly', { timeout: 90000 }, async () => {
    // Through the routes the fast path answers first, so the SQL judge is only ever reached by a
    // request the JavaScript passed — a wrong conjunct in it would show only in a race. Here both are
    // handed the same lot and the same plantings and asked separately: checkParentRules returns null
    // (go on) or a refusal; judgeParentRules, alone in a transaction, answers rules_hold and the verdict
    // it stored.
    const cropless = await newMix([fx.v.n1, fx.v.n2])
    const cells = [
      ['an added planting with no variety', [P.a1, P.bare], fx.v.a1, 'parent_without_variety'],
      ['two crops', [P.a1, P.b], fx.v.a1, 'mixed_crop_parents'],
      ['two crops, filed under a mix', [P.a1, P.b], MIX.pair, 'mixed_crop_parents'],
      ['no crop beside a crop', [P.n1, P.a1], fx.v.n1, 'mixed_crop_parents'],
      ['two crop-less varieties, no mix', [P.n1, P.n2], fx.v.n1, 'blend_required'],
      ['two crop-less varieties, under their mix', [P.n1, P.n2], cropless, null],
      ['two plantings of one crop-less variety', [P.n1, P.n1b], fx.v.n1, null],
      ['two varieties under one of them', [P.a1, P.a2], fx.v.a1, 'blend_required'],
      ['two varieties under their mix', [P.a1, P.a2], MIX.pair, null],
      ['two varieties under ANOTHER household\'s mix of them', [P.a1, P.a2], MIX.foreign, 'blend_required'],
      ['two varieties under their own mix, soft-deleted', [P.a2, P.a3], MIX.gone, 'blend_required'],
      ['two varieties under a mix of a different pair', [P.a1, P.a3], MIX.pair, 'blend_required'],
      ['a mix and one of its leaves, under the mix', [P.mix, P.a1], MIX.pair, null],
      ['a mix and a third variety, under the mix', [P.mix, P.a3], MIX.pair, 'blend_required'],
      ['a soft-deleted variety beside another crop', [P.gone, P.b], fx.v.a1, 'mixed_crop_parents'],
      ['a soft-deleted variety beside a live one of its crop', [P.gone, P.a1], fx.v.a1, 'blend_required'],
      ['three plantings of one variety', [P.a1, P.a1b, P.a1c], fx.v.b, null],
    ]
    const disagreements = []
    for (const [what, ids, filedUnder, expected] of cells) {
      // eslint-disable-next-line no-await-in-loop
      const lot = await newLot({ variety_id: filedUnder })
      // eslint-disable-next-line no-await-in-loop
      const js = await checkParentRules(directSql, { ids, householdIds: [USER], lotId: lot })
      // eslint-disable-next-line no-await-in-loop
      const [[sqlRow]] = await directSql.transaction([
        judgeParentRules(directSql, { lotId: lot, ids, householdIds: [USER], alone: true }),
      ])
      expect(js?.code ?? null, `JavaScript, ${what}`).toBe(expected)
      expect(sqlRow, `SQL, ${what}`).toEqual({ rules_hold: expected === null, go: expected === null ? 'go' : 'stop' })
      if ((js === null) !== sqlRow.rules_hold) disagreements.push(what)
    }
    expect(disagreements).toEqual([])

    // The variety the lot WILL be filed under, when the request says so (the set route's `filing`):
    // both read it in place of the stored one.
    const lot = await newLot({ variety_id: fx.v.a1 })
    const ids = [P.a1, P.a2]
    expect(await checkParentRules(directSql, { ids, householdIds: [USER], lotId: lot, varietyId: MIX.pair })).toBeNull()
    const [[told]] = await directSql.transaction([
      judgeParentRules(directSql, { lotId: lot, ids, householdIds: [USER], varietyId: MIX.pair, alone: true }),
    ])
    expect(told).toEqual({ rules_hold: true, go: 'go' })
    // A lot that is not the caller's: the SQL judge answers NO ROW (and so sets nothing).
    const [none] = await directSql.transaction([
      judgeParentRules(directSql, { lotId: lot, ids, householdIds: [FOREIGN], alone: true }),
    ])
    expect(none).toEqual([])
  })

  it('C6 (PUT only): a request that only REMOVES is never refused — a drifted lot can always be edited down', async () => {
    const a = await planting('C6a')
    const b = await planting('C6b')
    const c = await planting('C6c')
    const lot = await newLot({ source_plant_ids: [a, b, c] })
    // Drift, with no lot write: A loses its variety, B becomes another crop.
    await setVariety(a, null)
    await setVariety(b, fx.v.b)
    const r = await put(lot, { source_plant_ids: [a, b] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await livePlants(lot)).toEqual(sorted(a, b))
    await expectCacheRule(lot)
  })

  it('C6 (PUT only): a MEMBER whose variety was cleared is not the one refused when a planting with a variety is added', async () => {
    const a = await planting('C6d')
    const c = await planting('C6e')
    const lot = await newLot({ source_plant_ids: [a, c] })
    await setVariety(a, null)
    const r = await put(lot, { source_plant_ids: [a, c, P.a1] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await livePlants(lot)).toEqual(sorted(a, c, P.a1))
    // ...but adding ANOTHER bare planting to it is still refused, and names the added one, not the member.
    const before = await everything()
    const again = await put(lot, { source_plant_ids: [a, c, P.a1, P.bare] })
    expect(again.status).toBe(400)
    expect(again.body).toEqual({ error: PARENT_WITHOUT_VARIETY, code: 'parent_without_variety', plant_id: P.bare })
    expect(await everything()).toBe(before)
  })

  it('C6 (PUT only): the unchanged set re-sent on a lot that is not filed under its mix -> 200', async () => {
    const a = await planting('C6f')
    const b = await planting('C6g')
    const lot = await newLot({ source_plant_ids: [a, b] })
    await setVariety(b, fx.v.a2) // now two varieties, and the lot is filed under a1, not their mix
    const same = await put(lot, { source_plant_ids: [a, b] })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(await livePlants(lot)).toEqual(sorted(a, b))
    // The moment the request ADDS one, the rules apply to the whole resulting set.
    const before = await everything()
    const grow = await put(lot, { source_plant_ids: [a, b, P.a1] })
    expect(grow.status).toBe(400)
    expect(grow.body).toEqual({ error: BLEND_REQUIRED, code: 'blend_required', component_variety_ids: sorted(fx.v.a1, fx.v.a2) })
    expect(await everything()).toBe(before)
  })

  it('a lot that is not the caller\'s is not judged by the rules at all: the same bad set answers the ownership 400 or the 404, never a rule', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const theirs = await planting('theirs-1', { by: FOREIGN })
    const theirs2 = await planting('theirs-2', { by: FOREIGN, variety: fx.v.b })
    // The foreign household, with its own two plantings of two crops, aimed at USER's lot: 404.
    const r = await put(lot, { source_plant_ids: [theirs, theirs2] }, FOREIGN)
    expect(r.status, JSON.stringify(r.body)).toBe(404)
    expect(r.body).toEqual({ error: 'Not found' })
    expect(await livePlants(lot)).toEqual([P.a1])
  })
})

describe.skipIf(!READY || !HAS_PSQL)('C — the rules are judged again under the locks', () => {
  it.each([
    ['is moved to a variety of another crop', () => fx.v.b],
    ['loses its variety', () => null],
  ])('C7: a planting being added %s while the PUT waits for its lot -> 409 parents_changed, nothing written', { timeout: 90000 }, async (_label, becomes) => {
    const a = await planting('C7a')
    const b = await planting('C7b')
    const lot = await newLot({ source_plant_ids: [a] })
    const rival = openSession('changes B\'s variety')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      // The fast path passes: at this moment A and B are two plantings of one variety.
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [a, b] }))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      const to = becomes()
      await rival.run(`UPDATE plants SET variety_id = ${to ? lit(to) : 'NULL'} WHERE id = ${lit(b)};`)
      await rival.end('COMMIT;')
      const left = await everything()

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED, code: 'parents_changed' })
      expect(await everything()).toBe(left)
      expect(await livePlants(lot)).toEqual([a])
    } finally {
      await rival.end()
    }
  })

  it('C7: the lot is re-filed from the mix to a plain variety while a two-variety PUT waits -> 409 parents_changed, nothing written', { timeout: 90000 }, async () => {
    const lot = await newLot({ source_plant_ids: [P.a1], variety_id: MIX.pair })
    const rival = openSession('re-files the lot')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [P.a1, P.a2] }))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      await rival.run(`UPDATE inventory_items SET variety_id = ${lit(fx.v.a1)} WHERE id = ${lit(lot)};`)
      await rival.end('COMMIT;')
      const left = await everything()

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED, code: 'parents_changed' })
      expect(await everything()).toBe(left)
    } finally {
      await rival.end()
    }
  })

  it('C7: a parent\'s VARIETY loses its crop while the PUT waits (no planting and no lot changed) -> 409 parents_changed: the SQL judge counts "no crop" as a crop of its own, as the JavaScript does', { timeout: 90000 }, async () => {
    // The only road to the SQL judge's crop count that the fast path does not close first: a set that
    // IS filed under its mix, one of whose varieties has its crop cleared during the wait. With the
    // crop gone the two parents are a crop and a no-crop; the mix's key still matches, so nothing but
    // the crop rule refuses this write.
    const mk = async (tag) => (await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank)
      VALUES (${`slr-c7-${tag}-${RUN}`}, ${USER}, ${fx.crops.a}, 'cultivar') RETURNING id`)[0].id
    const [x1, x2] = [await mk('x1'), await mk('x2')]
    const mix = await newMix([x1, x2])
    const a = await planting('C7x1', { variety: x1 })
    const b = await planting('C7x2', { variety: x2 })
    const lot = await newLot({ source_plant_ids: [a], variety_id: mix })
    const rival = openSession('clears a variety\'s crop')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [a, b] }))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      await rival.run(`SELECT set_config('app.actor_clerk_sub', '${USER}', true);
                       UPDATE plant_varieties SET crop_type_slug = NULL WHERE id = ${lit(x2)};`)
      await rival.end('COMMIT;')
      const left = await everything()

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED, code: 'parents_changed' })
      expect(await everything()).toBe(left)
      expect(await livePlants(lot)).toEqual([a])
      // And with no wait the fast path says the same thing in its own words.
      const now = await put(lot, { source_plant_ids: [a, b] })
      expect(now.status).toBe(400)
      expect(now.body).toEqual({ error: MIXED_CROP_PARENTS, code: 'mixed_crop_parents' })
    } finally {
      await rival.end()
    }
  })

  it('C8: POST has no lot to hold, so the planting is held — its variety is cleared while the create waits at its share lock -> 409 parents_changed and NO lot row', { timeout: 90000 }, async () => {
    const a = await planting('C8a')
    const b = await planting('C8b')
    const rival = openSession('clears B\'s variety')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(b)} FOR UPDATE;`)
      const before = await everything()
      const name = `slr-c8-${RUN}`
      const posting = onOwnConnection(() => postLot({ name, source_plant_ids: [a, b] }))
      await waitBlockedBy(rivalPid, 'the create, at its planting share lock')
      await rival.run(`UPDATE plants SET variety_id = NULL WHERE id = ${lit(b)};`)
      await rival.end('COMMIT;')

      const r = await posting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED, code: 'parents_changed' })
      expect(await directSql`SELECT id FROM inventory_items WHERE name = ${name}`).toEqual([])
      expect(await directSql`SELECT id FROM seed_lot_parent_planting WHERE plant_id IN (${a}, ${b})`).toEqual([])
      expect(await everything()).toBe(before)
    } finally {
      await rival.end()
    }
  })

  it('C8 for PUT: the PUT has its lot and waits at a planting\'s share lock — that planting\'s variety is cleared during the wait -> 409 parents_changed, nothing written (the rules are judged by a statement that starts AFTER the share lock is granted)', { timeout: 90000 }, async () => {
    // C7 holds the LOT, so the rival has committed before the PUT holds anything: it passes whether or
    // not the judge comes after the planting locks. Here the lot is free and the PLANTING is held, so
    // the PUT stops between its two locks — and a judge placed ahead of lockPlantings would read B
    // while B still had its variety, write the link, and answer 200.
    const a = await planting('C8pa')
    const b = await planting('C8pb')
    const lot = await newLot({ source_plant_ids: [a] })
    const rival = openSession('holds B, then clears its variety')
    const third = openSession('asks for the lot the PUT holds')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(b)} FOR UPDATE;`)
      const before = await everything()
      // The fast path passes: at this moment A and B are two plantings of one variety.
      const putting = onOwnConnection(() => put(lot, { source_plant_ids: [a, b] }))
      const putPid = await waitBlockedBy(rivalPid, 'the PUT, at B\'s share lock')
      // WHERE it waits: with the lot row already its own. A third session asking for that row queues
      // behind the PUT's backend — not behind the rival, which holds only the planting.
      const wanting = third.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`, { timeoutMs: 60000 })
        .then((rows) => ({ got: rows }), (e) => ({ failed: e.message }))
      const thirdPid = await waitBlockedBy(putPid, 'a third session, at the lot row the PUT holds')
      expect(thirdPid).not.toBe(rivalPid)
      await rival.run(`UPDATE plants SET variety_id = NULL WHERE id = ${lit(b)};`)
      await rival.end('COMMIT;')

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED, code: 'parents_changed' })
      // The PUT's transaction is over and took nothing with it: the third session now has the lot.
      expect(await wanting).toEqual({ got: [lot] })
      await third.end()
      expect(await everything()).toBe(before)
      expect(await livePlants(lot)).toEqual([a])
      // B really did lose its variety, and with no wait the fast path says so in its own words.
      const now = await put(lot, { source_plant_ids: [a, b] })
      expect(now.status).toBe(400)
      expect(now.body).toEqual({ error: PARENT_WITHOUT_VARIETY, code: 'parent_without_variety', plant_id: b })
    } finally {
      await rival.end()
      await third.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// F. THE WIDE PUT
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('F — PUT /api/inventory-items/:id keeps a saved lot\'s filing and keeps a variety\'s row in Seeds', () => {
  const seedBody = (extra = {}) => ({
    name: `slr-wide-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 3, ...extra,
  })

  it('F1: a lot with a parent — a body carrying another variety_id answers 200, the stored variety stays, the other fields are written', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const body = seedBody({ variety_id: fx.v.a2, notes: 'edited through the wide PUT' })
    const r = await widePut(lot, body)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const row = await lotRow(lot)
    expect(row.variety_id).toBe(fx.v.a1)
    expect(row.name).toBe(body.name)
    expect(row.notes).toBe('edited through the wide PUT')
    expect(Number(row.quantity_on_hand)).toBe(3)
    expect(r.body.variety_id).toBe(fx.v.a1)
    expect(row.source_plant_id).toBe(P.a1)
  })

  it('F2: a plain packet (no parent) — a body carrying a new variety_id answers 200 and the variety changes', async () => {
    const lot = await newLot()
    const r = await widePut(lot, seedBody({ variety_id: fx.v.a2 }))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
    // Absent key: kept.
    const kept = await widePut(lot, seedBody())
    expect(kept.status).toBe(200)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
  })

  it.each([
    ['without variety_id', {}],
    ['with variety_id: null beside it', { variety_id: null }],
  ])('F3: a plain packet, a body that moves it to Tools %s -> 400 with the sentence, the row unchanged', async (_label, extra) => {
    const lot = await newLot()
    const before = await everything()
    const r = await widePut(lot, { name: `slr-tool-${RUN}`, type: 'durable', category: 'tools', quantity: 1, ...extra })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body).toEqual({ error: STAYS_IN_SEEDS })
    expect(await everything()).toBe(before)
    // Someone else's row, and a row that does not exist, are still the 404: nothing is learned from the 400.
    const foreign = await widePut(lot, { name: 'x', type: 'durable', category: 'tools', quantity: 1, ...extra }, FOREIGN)
    expect(foreign.status).toBe(404)
    const absent = await widePut(randomUUID(), { name: 'x', type: 'durable', category: 'tools', quantity: 1, ...extra })
    expect(absent.status).toBe(404)
  })

  it('F3, the STORED cell: a row that is not seeds and holds a variety (no route can make one; this one is made by SQL) is frozen through the wide PUT — its own +/- tap is the 400 with the Seeds sentence, the row unchanged — and a seeds body moves it into Seeds', async () => {
    // Pre-push QA review F3. The two F3 cases above start from a SEEDS row; the guard is judged on
    // the stored variety_id alone, so the same refusal meets a tool row that holds one.
    setTestUserId(USER)
    const tool = await callHandler(invHandler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: `slr-tool-with-variety-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(tool.status, JSON.stringify(tool.body)).toBe(201)
    // Nothing in the schema refuses this: there is no CHECK tying variety_id to the seeds category.
    await directSql`UPDATE inventory_items SET variety_id = ${fx.v.a1} WHERE id = ${tool.body.id}`
    expect(await lotRow(tool.body.id)).toMatchObject({ category: 'tools', variety_id: fx.v.a1 })

    const before = await everything()
    const tap = await widePut(tool.body.id, { name: `slr-tool-with-variety-${RUN}`, type: 'durable', category: 'tools', quantity: 2 })
    expect(tap.status, JSON.stringify(tap.body)).toBe(400)
    expect(tap.body).toEqual({ error: STAYS_IN_SEEDS })
    expect(await everything()).toBe(before)

    // The exit the verb leaves: a body that says Seeds satisfies the guard, and the row keeps its variety.
    const moved = await widePut(tool.body.id, seedBody())
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(await lotRow(tool.body.id)).toMatchObject({ category: 'seeds', variety_id: fx.v.a1 })
    expect(moved.body.variety_rank).toBe('cultivar')
  })

  it('F4 + F5: the +/- tap on a tool and on a seed packet still answer 200, and RETURNING\'s variety_rank subquery executes on INSERT and on UPDATE — "blend" under a mix, the cultivar\'s under a cultivar, null for a tool', async () => {
    setTestUserId(USER)
    const tool = await callHandler(invHandler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: `slr-tool-row-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(tool.status, JSON.stringify(tool.body)).toBe(201)
    expect(tool.body.variety_rank).toBeNull()
    const toolEdit = await widePut(tool.body.id, { name: `slr-tool-row-${RUN}`, type: 'durable', category: 'tools', quantity: 2 })
    expect(toolEdit.status, JSON.stringify(toolEdit.body)).toBe(200)
    expect(toolEdit.body.variety_rank).toBeNull()
    expect(Number(toolEdit.body.quantity)).toBe(2)

    const packet = await postLot()
    expect(packet.status).toBe(201)
    expect(packet.body.variety_rank).toBe('cultivar')
    const packetEdit = await widePut(packet.body.id, seedBody({ quantity_on_hand: 2 }))
    expect(packetEdit.status, JSON.stringify(packetEdit.body)).toBe(200)
    expect(packetEdit.body.variety_rank).toBe('cultivar')

    const mixed = await postLot({ variety_id: MIX.pair, source_plant_ids: [P.a1, P.a2] })
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201)
    expect(mixed.body.variety_rank).toBe('blend')
    const mixedEdit = await widePut(mixed.body.id, seedBody({ variety_id: fx.v.a1 }))
    expect(mixedEdit.status).toBe(200)
    expect(mixedEdit.body.variety_rank).toBe('blend')
    expect(mixedEdit.body.variety_id).toBe(MIX.pair)
    // The same rank on the detail read and on both list reads.
    expect((await getLot(mixed.body.id)).body.variety_rank).toBe('blend')
    for (const path of ['/api/inventory-items?category=seeds', '/api/inventory-items']) {
      setTestUserId(USER)
      // eslint-disable-next-line no-await-in-loop
      const list = await callHandler(invHandler, { method: 'GET', path })
      expect(list.status).toBe(200)
      expect(list.body.find((x) => x.id === mixed.body.id).variety_rank, path).toBe('blend')
      expect(list.body.find((x) => x.id === packet.body.id).variety_rank, path).toBe('cultivar')
      if (path === '/api/inventory-items') expect(list.body.find((x) => x.id === tool.body.id).variety_rank).toBeNull()
    }
  })

  it('F6: after a re-file, a LIST ROW captured before it and sent back through the wide PUT does not undo the re-file', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    setTestUserId(USER)
    const list = await callHandler(invHandler, { method: 'GET', path: '/api/inventory-items?category=seeds' })
    const stale = list.body.find((x) => x.id === lot)
    expect(stale.variety_id).toBe(fx.v.a1)

    const refiled = await filing(lot, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 })
    expect(refiled.status, JSON.stringify(refiled.body)).toBe(200)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)

    // What every shipped client does: the whole stale row, with one field changed.
    const r = await widePut(lot, { ...stale, quantity_on_hand: 5 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
    expect(Number((await lotRow(lot)).quantity_on_hand)).toBe(5)
    const read = await getLot(lot)
    expect(read.body.variety_id).toBe(fx.v.a2)
    expect(await livePlants(lot)).toEqual(sorted(P.a1, P.a1b))
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// G. THE PLANT COUNT
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('G — seed_parent_plant_count, written by PUT /:id/seed-measure and by nothing else', () => {
  it('G1: 6 is stored and echoed; an absent key leaves it; null clears it (an untyped NULL binds against the integer column)', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const set = await measure(lot, { seed_parent_plant_count: 6 })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect(set.body.seed_parent_plant_count).toBe(6)
    expect((await lotRow(lot)).seed_parent_plant_count).toBe(6)

    const other = await measure(lot, { seed_weight_g: 12.5 })
    expect(other.status, JSON.stringify(other.body)).toBe(200)
    expect(other.body.seed_parent_plant_count).toBe(6)
    expect((await lotRow(lot)).seed_parent_plant_count).toBe(6)

    const cleared = await measure(lot, { seed_parent_plant_count: null })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(Object.prototype.hasOwnProperty.call(cleared.body, 'seed_parent_plant_count')).toBe(true)
    expect(cleared.body.seed_parent_plant_count).toBeNull()
    expect((await lotRow(lot)).seed_parent_plant_count).toBeNull()

    for (const edge of [1, 9999]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await measure(lot, { seed_parent_plant_count: edge })
      expect(r.status, `${edge} -> ${JSON.stringify(r.body)}`).toBe(200)
      // eslint-disable-next-line no-await-in-loop
      expect((await lotRow(lot)).seed_parent_plant_count).toBe(edge)
    }
  })

  it('G1: anything that is not a whole number from 1 to 9999 is one 400 sentence, and nothing is written', async () => {
    const lot = await newLot()
    await measure(lot, { seed_parent_plant_count: 4 })
    const before = await everything()
    for (const bad of [0, -3, 2.5, '3', 10000, true, [4]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await measure(lot, { seed_parent_plant_count: bad })
      expect(r.status, `${JSON.stringify(bad)} -> ${JSON.stringify(r.body)}`).toBe(400)
      expect(r.body).toEqual({ error: PLANT_COUNT_RANGE })
    }
    expect(await everything()).toBe(before)
  })

  it('G2: a wide PUT round trip leaves it set, and POST with the key ignores it', async () => {
    const lot = await newLot()
    expect((await measure(lot, { seed_parent_plant_count: 7 })).status).toBe(200)
    const read = await getLot(lot)
    expect(read.body.seed_parent_plant_count).toBe(7)
    // The whole row back, with the count changed in the body: the verb does not write it.
    const r = await widePut(lot, { ...read.body, seed_parent_plant_count: 99, quantity_on_hand: 2 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await lotRow(lot)).seed_parent_plant_count).toBe(7)
    expect(r.body.seed_parent_plant_count).toBe(7)

    const made = await postLot({ seed_parent_plant_count: 5 })
    expect(made.status).toBe(201)
    expect((await lotRow(made.body.id)).seed_parent_plant_count).toBeNull()
  })

  it('G3: the two CHECKs are armed — 0 is refused by ..._positive, and a non-seeds row with a count by ..._seeds_only', async () => {
    const lot = await newLot()
    await expect(directSql`UPDATE inventory_items SET seed_parent_plant_count = 0 WHERE id = ${lot}`)
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_inventory_seed_parent_plant_count_positive' })
    await expect(directSql`
      INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity, status, seed_parent_plant_count)
      VALUES (${USER}, ${USER}, 'durable', ${`slr-g3-${RUN}`}, 'tools', 1, 'active', 3)`)
      .rejects.toMatchObject({ code: '23514', constraint: 'chk_inventory_seed_parent_plant_count_seeds_only' })
    expect((await lotRow(lot)).seed_parent_plant_count).toBeNull()
  })
})
