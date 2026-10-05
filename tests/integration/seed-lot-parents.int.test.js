// seed-lot-parents.int.test.js — V5-SEEDMULTIPARENT-001 (release 1) on a real Postgres.
//
// WHY THIS FILE EXISTS. A saved-seed lot can now record several parent plantings: one live
// role = 'seed_parent' row of seed_lot_parent_planting per planting, with inventory_items.source_plant_id
// kept beside the table as a MEMBER CACHE (NULL exactly when the lot has no live seed_parent row,
// otherwise the plant_id of one of them). Every unit test the three building lanes wrote runs against a
// stub that records SQL as text. None of the statements had executed anywhere, and the things that carry
// the risk are exactly the ones a stub cannot see:
//   · typing — `${ids}::uuid[]` empty and full, `NOT ${legacy}::boolean`, a jsonb aggregate coming back
//     through the driver as a JS array;
//   · the two views — garden_node has display_name / cultivar_id and NO name / variety_id
//     (BUG-SEEDDETAIL500-001 is a 42703 that only a real engine raises);
//   · the non-interactive sql.transaction([...]): a refusal is decided INSIDE the write statements, so
//     "nothing was written" has to be read back from both tables;
//   · locks — the set-replace takes the lot row first, and so must every other writer of link rows.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK, never the handler's echo (L-108). Timestamps are
// read `::text` so "unchanged" compares microseconds, not a JS Date rounded to the millisecond.
//
// THE TWO ROW-LEVEL INVARIANTS (the last two `post` gates in migrations/v5-seedmultiparent-001/gates.yml) are checked
// here as cacheRuleViolations(): the same two predicates without their stamp guard, over the lots a test
// touched, and once more at the end of the file over every lot this file created. A test that builds
// the drifted state ON PURPOSE (a column with no row, rows with no column) says so and removes or repairs
// it before it returns.
//
// CONCURRENCY. The handlers talk to Neon over HTTP, one request per statement or per transaction, so a
// test cannot hold one of their transactions open. A second REAL connection can: psql, as a child
// process, fed statements on stdin (the workflow's own migration step already depends on psql being on
// the runner). Nothing here sleeps and hopes — a psql session takes a lock, the first request is fired
// and the test waits until pg_blocking_pids() shows it stuck behind that session, the second request is
// fired and shown stuck behind the first, and only then is the lock released. Each case therefore runs
// in one known order, every time. Every such lock is a ROW lock on this file's own fixtures, so the other
// files of a parallel run never wait on it.
//
// ONE PROCESS IS NOT TWO CONNECTIONS BY ITSELF — measured 2026-10-05. On Node 26 (undici 8.5) every HTTP
// query this process sends through the global fetch shares one connection to Neon, and they are run one
// after another on ONE backend: a handler request stuck behind a lock stalls every other query of the
// test, the pg_blocking_pids() poll included, and two handler calls "in parallel" are in fact one after
// the other. (The first draft of this file hung for ten minutes on exactly that.) On Node 20.19 (undici
// 6.21, what CI and the Lambdas' runtimes use) a second query gets a second connection. The cases below
// must not depend on which, so a request that is meant to wait is sent on a connection of its own:
// onOwnConnection() runs it with a private https.Agent, routed through the driver's own
// neonConfig.fetchFunction hook. That gives each such request its own backend, which is what two Lambda
// instances have in production. The file passes on both Node versions.
//
// THREE RACES THIS FILE FOUND ON REAL POSTGRES, and what it now holds the handlers to (search "D-1",
// "D-2", "D-3", "F1.4"): a merge and a parents edit on one lot no longer deadlock (both lock the lot
// first); a parents write re-tests "may this lot use these plantings" INSIDE its transaction, behind a
// share lock on them, and answers 409 when one changed on the way; and a deadlock that still can happen
// (the merge against a photo delete) answers a 409 that says "run it again", not a 500. Where a case
// needs one particular transaction to be the deadlock victim it says how that is arranged — Postgres
// checks once per wait, deadlock_timeout after the wait began, so the victim is the one whose wait
// closes the cycle once the other's check has already run.
//
// THE CASES THAT ARE OFF BY DEFAULT: 0b-reconcile.sql against a parents edit and against a merge (the
// last describe). The reconcile takes a table lock and rewrites EVERY drifted lot in the database, so
// inside the parallel suite it would repair other files' deliberate drift mid-test and stall their
// writes. They run only with INT_SEED_PARENTS_RECONCILE=1, with this file alone:
//   INT_SEED_PARENTS_RECONCILE=1 npx vitest run --config vitest.integration.config.ts \
//     tests/integration/seed-lot-parents.int.test.js
//
// FIXTURES are this file's own. Both users carry the `int-test-` run id, so tests/integration/_cleanup.js
// sweeps whatever the afterAll below does not reach.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neonConfig } from '@neondatabase/serverless'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { handler as invHandler } from '../../lambda/inventory-items/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import {
  insertSeedParentLinks, readSourcePlants, lockPlantings, assertEveryParentLinked,
} from '../../lambda/inventory-items/seed-lot-parents.js'
import { softDeletePhoto } from '../../lambda/photos/photoDelete.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECONCILE_SQL = join(ROOT, 'migrations', 'v5-seedmultiparent-001', '0b-reconcile.sql')

const RUN = testRunId()
const USER = `slp-user-${RUN}`
const FOREIGN = `slp-foreign-${RUN}`
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

const UNUSABLE = 'source_plant_ids does not match plantings you can use'
const MULTI_PARENT = 'This seed came from more than one plant. Reload the app to change which.'
const CHANGED_AT_ONCE = 'This seed lot was changed at the same moment. Reload and try again.'
// A planting passed the route's gate and stopped being usable before the write ran. Nothing written.
const PLANTS_CHANGED = 'One of those plants changed just now. Reload and try again.'
// A merge that Postgres chose as a deadlock victim. Nothing merged; the same op_id can be sent again.
const MERGE_RETRY = 'Merge was stopped by a concurrent change to the same rows — nothing was merged, run it again'
// What chk_inventory_seed_source_plant has always been answered with (SEED_CONSTRAINT_MESSAGES in the
// handler). The parents routes now refuse in their own guards, and must use the same words.
const SHOP_AND_PLANT = 'This lot names the plant it was saved from, so it cannot also say it came from a shop, a gift or a farm stand. Clear one of the two.'

// The table is created by migrations/v5-seedmultiparent-001/0a-additive-ddl.sql, and the handlers under
// test name it in SQL: on a branch without it every case below is a 42P01. One plain failure that says
// what to apply reads better than seventy of those, so the rest of the file stands down behind it.
const HAS_TABLE = (await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS ok`)[0].ok

describe('seed lot parents — the table is on this branch', () => {
  it('seed_lot_parent_planting exists (apply v5-seedmultiparent-001/0a before the code that names it)', () => {
    expect(HAS_TABLE, 'public.seed_lot_parent_planting is missing: apply migrations/v5-seedmultiparent-001/0a-additive-ddl.sql to the database this suite forks').toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let varietyId
let seq = 0
const VARIETY_NAME = `slp-variety-${RUN}`

async function planting(tag, { by = USER, variety = varietyId, projectId = null, archived = false, deleted = false, name } = {}) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id, archived_at, deleted_at)
    VALUES (${projectId}, ${name ?? `${tag}-slp-${RUN}`}, ${by}, ${variety},
            CASE WHEN ${archived}::boolean THEN NOW() END,
            CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return p.id
}
const softDeletePlanting = (id) => directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${id}`
// A planting whose id is CHOSEN. The handlers lock the plantings a request names in id order, so a case
// that must know which of two is locked first needs to know how their ids sort.
const idStarting = (hex) => `${hex}${randomUUID().slice(hex.length)}`
async function plantingWithId(id, tag) {
  await directSql`
    INSERT INTO plants (id, project_id, name, created_by, variety_id)
    VALUES (${id}::uuid, NULL, ${`${tag}-slp-${RUN}`}, ${USER}, ${varietyId})`
  return id
}

function postLot(extra = {}, as = USER) {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'POST', path: '/api/inventory-items',
    body: {
      name: `slp-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: varietyId, ...extra,
    },
  })
}
async function newLot(extra = {}, as = USER) {
  const r = await postLot(extra, as)
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  return r.body.id
}
const put = (lotId, ids, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'PUT', path: `/api/inventory-items/${lotId}/source-plants`, body: { source_plant_ids: ids },
  })
}
const patchParent = (lotId, plantId, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'PATCH', path: `/api/inventory-items/${lotId}/source-plant`, body: { source_plant_id: plantId },
  })
}
const patchKind = (lotId, kind, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'PATCH', path: `/api/inventory-items/${lotId}/source-kind`, body: { source_kind: kind },
  })
}
const getLot = (lotId, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'GET', path: `/api/inventory-items/${lotId}` })
}
const softDeleteLot = (lotId, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'DELETE', path: `/api/inventory-items/${lotId}` })
}
const seedLotsOf = (plantId, as = USER) => {
  setTestUserId(as)
  return callHandler(plantsHandler, { method: 'GET', path: `/api/plants/${plantId}/seed-lots` })
}
const merge = (winner, losers, opId = randomUUID()) => {
  setTestUserId(USER)
  return callHandler(plantsHandler, {
    method: 'POST', path: `/api/plants/${winner}/merge`, body: { loser_ids: losers, op_id: opId },
  })
}

// Hand-written rows, for the states no route can produce: another household's lot on a planting the
// caller can see, a pollen_parent row, a retired row, and the drifted states the reconcile exists for.
async function sqlLot({ by = USER, sourcePlant = null, deleted = false } = {}) {
  const [row] = await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit,
                                 quantity_on_hand, variety_id, status, source_plant_id, deleted_at)
    VALUES (${by}, ${by}, 'consumable', ${`slp-sqllot-${RUN}-${seq++}`}, 'seeds', 'packet',
            0, ${varietyId}, 'active', ${sourcePlant}, CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return row.id
}
async function sqlLink(lotId, plantId, { by = USER, role = 'seed_parent', retired = false } = {}) {
  const [row] = await directSql`
    INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by, deleted_at)
    VALUES (${lotId}, ${plantId}, ${role}, ${by}, CASE WHEN ${retired}::boolean THEN NOW() END)
    RETURNING id`
  return row.id
}
async function dropLot(lotId) {
  await directSql`DELETE FROM seed_lot_parent_planting WHERE inventory_item_id = ${lotId}`
  await directSql`DELETE FROM inventory_items WHERE id = ${lotId}`
}

const links = (lotId) => directSql`
  SELECT id, plant_id, role, created_by,
         created_at::text AS created_at, updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM seed_lot_parent_planting
   WHERE inventory_item_id = ${lotId}
   ORDER BY created_at, id`
const liveSeed = (rows) => rows.filter((r) => r.deleted_at == null && r.role === 'seed_parent')
const livePlants = async (lotId) => liveSeed(await links(lotId)).map((r) => r.plant_id).sort()
const lotRow = async (lotId) => (await directSql`
  SELECT id, source_plant_id, source_kind, category,
         updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM inventory_items WHERE id = ${lotId}`)[0]

// Both tables, as far as this file's two users reach, in one comparable string. "Nothing was written"
// is this string before === this string after.
async function everything() {
  const lots = await directSql`
    SELECT id, source_plant_id, source_kind, category, updated_at::text AS updated_at, deleted_at::text AS deleted_at
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

// The two row-level gates in gates.yml, both queries, without the 001b stamp guard and narrowed to `lotIds`.
async function cacheRuleViolations(lotIds) {
  const notMember = await directSql`
    SELECT i.id FROM public.inventory_items i
     WHERE i.id = ANY(${lotIds}::uuid[])
       AND i.source_plant_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.seed_lot_parent_planting l
                        WHERE l.inventory_item_id = i.id
                          AND l.plant_id = i.source_plant_id
                          AND l.role = 'seed_parent'
                          AND l.deleted_at IS NULL)`
  const noCache = await directSql`
    SELECT DISTINCT l.inventory_item_id FROM public.seed_lot_parent_planting l
      JOIN public.inventory_items i ON i.id = l.inventory_item_id
     WHERE i.id = ANY(${lotIds}::uuid[])
       AND l.role = 'seed_parent'
       AND l.deleted_at IS NULL
       AND i.source_plant_id IS NULL`
  return { cacheIsNotALiveParent: notMember.map((r) => r.id), parentsButNoCache: noCache.map((r) => r.inventory_item_id) }
}
async function expectCacheRule(...lotIds) {
  expect(await cacheRuleViolations(lotIds)).toEqual({ cacheIsNotALiveParent: [], parentsButNoCache: [] })
}

// What the contract says one element of source_plants is, for a planting made by planting() above.
const sourcePlant = (id, name, { archived = false, deleted = false, variety = true } = {}) => ({
  id, name,
  variety_id: variety ? varietyId : null,
  variety_name: variety ? VARIETY_NAME : null,
  breeding_system: variety ? 'landrace' : null,
  archived, deleted,
})
const byNameThenId = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// Plantings every block may link. Names start with a distinct capital so their order is the same under
// any collation the database might use.
const P = {}

beforeAll(async () => {
  if (!HAS_TABLE) return
  setTestUserId(USER)
  const [v] = await directSql`
    INSERT INTO plant_varieties (name, created_by, breeding_system, breeding_source)
    VALUES (${VARIETY_NAME}, ${USER}, 'landrace', 'grower_record') RETURNING id`
  varietyId = v.id

  for (const tag of ['A', 'B', 'C', 'D']) {
    // eslint-disable-next-line no-await-in-loop
    P[tag] = await planting(tag)
  }
  P.archived = await planting('E', { archived: true })
  P.noVariety = await planting('F', { variety: null })
  P.foreign = await planting('G', { by: FOREIGN })
  P.deleted = await planting('H', { deleted: true })
})

const sessions = new Set()
const agents = new Set()
const connection = new AsyncLocalStorage()
const fetchBefore = neonConfig.fetchFunction

afterAll(async () => {
  for (const s of sessions) s.kill()
  for (const a of agents) a.destroy()
  neonConfig.fetchFunction = fetchBefore
  if (!HAS_TABLE) return
  const ids = assertFixtureId(USER, FOREIGN)
  await settle(`seed-lot-parents teardown ${RUN}`, [
    // Both foreign keys on a link row are RESTRICT, so it goes before its lot AND before its planting.
    () => directSql`
      DELETE FROM seed_lot_parent_planting
       WHERE created_by = ANY(${ids})
          OR inventory_item_id IN (SELECT id FROM inventory_items WHERE created_by = ANY(${ids}))
          OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM photos WHERE created_by = ANY(${ids})`,
    // One D-3 case seeds two ready_impression rows; their plant_id key is NO ACTION.
    () => directSql`DELETE FROM ready_impression WHERE user_id = ANY(${ids}) OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    // plants.source_inventory_item_id is RESTRICT the other way round: a planting sown from a lot goes
    // before the lot (one concurrency case sows one).
    () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}) AND source_inventory_item_id IS NOT NULL)`,
    () => directSql`DELETE FROM plants WHERE created_by = ANY(${ids}) AND source_inventory_item_id IS NOT NULL`,
    () => directSql`DELETE FROM inventory_items WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM merge_event WHERE merged_by = ANY(${ids}) OR winner_plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids})) OR project_id IN (SELECT id FROM plant_projects WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM event_log WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids})) OR project_id IN (SELECT id FROM plant_projects WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plants WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM audit_events WHERE actor_clerk_sub = ANY(${ids})`,
    () => directSql`DELETE FROM event_batches WHERE created_by = ANY(${ids})`,
  ])
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The table itself — its constraints are ARMED, not merely declared (the catalog gates read
// pg_constraint; this makes each one refuse a row)
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('seed_lot_parent_planting — what the table refuses by itself', () => {
  const code = (c) => expect.objectContaining({ code: c })

  it('one LIVE row per (lot, planting, role); a retired twin and the other role are allowed', async () => {
    const lot = await newLot({ source_plant_ids: [P.A] })
    await expect(sqlLink(lot, P.A)).rejects.toEqual(code('23505'))
    await expect(sqlLink(lot, P.A)).rejects.toThrow(/uq_slpp_item_plant_role_live/)
    await sqlLink(lot, P.A, { retired: true })
    await sqlLink(lot, P.A, { retired: true })
    await sqlLink(lot, P.A, { role: 'pollen_parent' })
    expect(await links(lot)).toHaveLength(4)
    await expectCacheRule(lot)
  })

  it('role is one of two values and has no default; created_by is required', async () => {
    const lot = await newLot()
    await expect(sqlLink(lot, P.A, { role: 'grandparent' })).rejects.toThrow(/chk_slpp_role/)
    await expect(directSql`
      INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, created_by)
      VALUES (${lot}, ${P.A}, ${USER})`).rejects.toEqual(code('23502'))
    await expect(directSql`
      INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role)
      VALUES (${lot}, ${P.A}, 'seed_parent')`).rejects.toEqual(code('23502'))
    expect(await links(lot)).toEqual([])
  })

  it('both foreign keys are RESTRICT: neither the lot nor the planting can be hard-deleted from under a link, live or retired', async () => {
    const parent = await planting('FK')
    const lot = await newLot({ source_plant_ids: [parent] })
    expect((await put(lot, [])).status).toBe(200) // the link is now RETIRED and the cache NULL: only the link's own keys hold
    await expect(directSql`DELETE FROM inventory_items WHERE id = ${lot}`)
      .rejects.toThrow(/seed_lot_parent_planting_inventory_item_id_fkey/)
    // A planting is also held by its registry row (entity_planting_ref_id_fkey, older, so it would be the
    // one named). With that row gone the link is the only thing left pointing at the planting.
    await directSql`DELETE FROM entity WHERE planting_ref_id = ${parent}`
    await expect(directSql`DELETE FROM plants WHERE id = ${parent}`)
      .rejects.toThrow(/seed_lot_parent_planting_plant_id_fkey/)
    await expect(sqlLink(lot, randomUUID())).rejects.toEqual(code('23503'))
    await expect(sqlLink(randomUUID(), parent)).rejects.toEqual(code('23503'))
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/inventory-items with source_plant_ids
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('POST — a lot created with its parent plantings', () => {
  it('two parents: one lot, two live seed_parent rows, the cache is the first id, 201 carries source_plants', async () => {
    const r = await postLot({ source_plant_ids: [P.B, P.A] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.source_plant_id).toBe(P.B)
    // The driver hands the jsonb aggregate back as an array of objects, in name-then-id order.
    expect(Array.isArray(r.body.source_plants)).toBe(true)
    expect(r.body.source_plants).toEqual([
      sourcePlant(P.A, `A-slp-${RUN}`), sourcePlant(P.B, `B-slp-${RUN}`),
    ])

    const rows = await links(r.body.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((x) => x.plant_id).sort()).toEqual([P.A, P.B].sort())
    for (const row of rows) {
      expect(row).toMatchObject({ role: 'seed_parent', created_by: USER, deleted_at: null })
      expect(row.updated_at).toBe(row.created_at)
    }
    expect((await lotRow(r.body.id)).source_plant_id).toBe(P.B)
    await expectCacheRule(r.body.id)
  })

  it('source_plant_id beside the array picks which member the column caches', async () => {
    const r = await postLot({ source_plant_ids: [P.A, P.B, P.C], source_plant_id: P.C })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect((await lotRow(r.body.id)).source_plant_id).toBe(P.C)
    expect(await livePlants(r.body.id)).toEqual([P.A, P.B, P.C].sort())
    await expectCacheRule(r.body.id)
  })

  it('the legacy single key alone is a set of one: exactly one link row', async () => {
    const r = await postLot({ source_plant_id: P.A })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.source_plant_id).toBe(P.A)
    expect(r.body.source_plants).toEqual([sourcePlant(P.A, `A-slp-${RUN}`)])
    const rows = await links(r.body.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ plant_id: P.A, role: 'seed_parent', created_by: USER, deleted_at: null })
    await expectCacheRule(r.body.id)
  })

  it('the same planting twice, once in capitals, is one parent and one row', async () => {
    const r = await postLot({ source_plant_ids: [P.A, P.A.toUpperCase()] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(await livePlants(r.body.id)).toEqual([P.A])
    expect((await lotRow(r.body.id)).source_plant_id).toBe(P.A)
  })

  it('an empty array and an absent key both create a lot with no parents and name no link row', async () => {
    const empty = await postLot({ source_plant_ids: [] })
    const absent = await postLot()
    for (const r of [empty, absent]) {
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.body.source_plants).toEqual([])
      expect(r.body.source_plant_id).toBeNull()
      // eslint-disable-next-line no-await-in-loop
      expect(await links(r.body.id)).toEqual([])
    }
  })

  it.each([
    ['one foreign planting among owned ones', () => [P.A, P.foreign]],
    ['one soft-deleted planting among owned ones', () => [P.A, P.deleted]],
    ['a planting that does not exist', () => [P.A, randomUUID()]],
  ])('refuses %s: 400, and neither table gains a row', async (_label, ids) => {
    const asked = ids()
    const before = await everything()
    const r = await postLot({ source_plant_ids: asked })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toBe(UNUSABLE)
    for (const id of asked) expect(JSON.stringify(r.body)).not.toContain(id)
    expect(await everything()).toBe(before)
  })

  it('refuses a source_plant_id that is not one of source_plant_ids, a shop origin with parents, and 13 parents', async () => {
    const before = await everything()
    const notMember = await postLot({ source_plant_ids: [P.A, P.B], source_plant_id: P.C })
    expect(notMember.status).toBe(400)
    expect(notMember.body.error).toBe('source_plant_id must be one of source_plant_ids')
    const shop = await postLot({ source_plant_ids: [P.A], source_kind: 'gift' })
    expect(shop.status).toBe(400)
    expect(shop.body.error).toMatch(/own_garden/)
    const thirteen = await postLot({ source_plant_ids: Array.from({ length: 13 }, () => randomUUID()) })
    expect(thirteen.status).toBe(400)
    expect(thirteen.body.error).toMatch(/at most 12/)
    expect(await everything()).toBe(before)
  })

  it('THE CREATE IS ONE TRANSACTION: when the links are not all written, the batch fails and no lot row is left behind', async () => {
    // The route cannot be made to fail here without a second session (its gate refuses an unusable
    // planting before the transaction starts; the cases that get past the gate are in the concurrency
    // blocks below). So the FIVE statements the POST arm issues are run through the driver's transaction
    // with a planting id no row has: the lot INSERT, then the module's own share lock, link INSERT,
    // assertion and read.
    // The link INSERT is all-or-none: one id that is not usable and it inserts NOTHING, and raises
    // nothing. So it is assertEveryParentLinked that has to fail the batch — a division by zero, 22012,
    // which the route answers 409 — and that failure must take the lot INSERT back with it.
    const ghost = randomUUID()
    const lotInsert = (lotId) => directSql`
      INSERT INTO inventory_items (id, user_id, created_by, type, name, category, unit,
                                   quantity_on_hand, variety_id, status, source_plant_id)
      VALUES (${lotId}::uuid, ${USER}, ${USER}, 'consumable', ${`slp-atomic-${RUN}`}, 'seeds', 'packet',
              1, ${varietyId}, 'active', ${P.A})`
    const before = await everything()

    const lotId = randomUUID()
    const failed = directSql.transaction([
      lotInsert(lotId),
      lockPlantings(directSql, [P.A, ghost]),
      insertSeedParentLinks(directSql, { lotId, ids: [P.A, ghost], householdIds: [USER], userId: USER }),
      assertEveryParentLinked(directSql, { lotId, ids: [P.A, ghost], householdIds: [USER] }),
      readSourcePlants(directSql, [USER], lotId),
    ])
    await expect(failed).rejects.toMatchObject({ code: '22012' })
    await expect(failed).rejects.toThrow(/division by zero/)
    expect(await directSql`SELECT id FROM inventory_items WHERE id = ${lotId}`).toEqual([])
    expect(await directSql`SELECT id FROM seed_lot_parent_planting WHERE inventory_item_id = ${lotId}`).toEqual([])
    expect(await everything()).toBe(before)

    // WHY THE ASSERTION IS THERE, shown rather than argued: the same batch WITHOUT it commits — a lot
    // whose column names a parent and which has no link row at all, the cache rule broken at birth.
    const orphan = randomUUID()
    await directSql.transaction([
      lotInsert(orphan),
      lockPlantings(directSql, [P.A, ghost]),
      insertSeedParentLinks(directSql, { lotId: orphan, ids: [P.A, ghost], householdIds: [USER], userId: USER }),
    ])
    try {
      expect((await cacheRuleViolations([orphan])).cacheIsNotALiveParent).toEqual([orphan])
      expect(await links(orphan)).toEqual([])
    } finally {
      await dropLot(orphan)
    }

    // And when every planting IS usable the assertion lets the create through, answering one row.
    const good = randomUUID()
    const [, , , asserted] = await directSql.transaction([
      lotInsert(good),
      lockPlantings(directSql, [P.A, P.B]),
      insertSeedParentLinks(directSql, { lotId: good, ids: [P.A, P.B], householdIds: [USER], userId: USER }),
      assertEveryParentLinked(directSql, { lotId: good, ids: [P.A, P.B], householdIds: [USER] }),
    ])
    expect(asserted).toEqual([{ every_parent_linked: 1 }])
    expect(await livePlants(good)).toEqual([P.A, P.B].sort())
    await expectCacheRule(good)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// PUT /api/inventory-items/:id/source-plants — the set route
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('PUT /:id/source-plants — replace the set, keep the cache a member', () => {
  it('{A} -> {A,B}: A\'s row is untouched, B gets a row, the cache stays A', async () => {
    const lot = await newLot({ source_plant_ids: [P.A] })
    const [rowA] = await links(lot)
    const r = await put(lot, [P.A, P.B])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      id: lot, source_plant_id: P.A,
      source_plants: [sourcePlant(P.A, `A-slp-${RUN}`), sourcePlant(P.B, `B-slp-${RUN}`)],
    })
    const rows = await links(lot)
    expect(rows).toHaveLength(2)
    expect(rows.find((x) => x.id === rowA.id)).toEqual(rowA)
    expect(rows.find((x) => x.id !== rowA.id)).toMatchObject({ plant_id: P.B, role: 'seed_parent', created_by: USER, deleted_at: null })
    expect((await lotRow(lot)).source_plant_id).toBe(P.A)
    await expectCacheRule(lot)
  })

  it('the cache is KEPT when it is still a member, even when it is not the earliest row', async () => {
    // A's row is the earliest. The cache is pointed at B by hand — a legal state, B is a live parent —
    // so "kept" and "earliest" give different answers on the next write.
    const lot = await newLot({ source_plant_ids: [P.A] })
    expect((await put(lot, [P.A, P.B])).status).toBe(200)
    await directSql`UPDATE inventory_items SET source_plant_id = ${P.B} WHERE id = ${lot}`
    await expectCacheRule(lot)
    const r = await put(lot, [P.A, P.B, P.C])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.source_plant_id).toBe(P.B)
    expect((await lotRow(lot)).source_plant_id).toBe(P.B)
    await expectCacheRule(lot)
  })

  it('{A,B} with cache A -> {B}: A\'s row is retired (deleted_at and updated_at), the cache moves to B', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const before = await links(lot)
    const lotBefore = await lotRow(lot)
    expect(lotBefore.source_plant_id).toBe(P.A)
    const r = await put(lot, [P.B])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ id: lot, source_plant_id: P.B, source_plants: [sourcePlant(P.B, `B-slp-${RUN}`)] })

    const after = await links(lot)
    expect(after).toHaveLength(2) // retired, not deleted
    const a = after.find((x) => x.plant_id === P.A)
    const b = after.find((x) => x.plant_id === P.B)
    expect(a.deleted_at).not.toBeNull()
    expect(a.updated_at).toBe(a.deleted_at)
    expect(a.updated_at).not.toBe(before.find((x) => x.plant_id === P.A).updated_at)
    expect(b).toEqual(before.find((x) => x.plant_id === P.B))
    const lotAfter = await lotRow(lot)
    expect(lotAfter.source_plant_id).toBe(P.B)
    expect(lotAfter.updated_at).not.toBe(lotBefore.updated_at)
    await expectCacheRule(lot)
  })

  it('{A,B} -> {C,D}: both old rows retired, the cache is the earliest new row by created_at then id', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const r = await put(lot, [P.C, P.D])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const rows = await links(lot)
    expect(rows).toHaveLength(4)
    const live = liveSeed(rows)
    expect(live.map((x) => x.plant_id).sort()).toEqual([P.C, P.D].sort())
    // Sorted here, not by the database: created_at as text (fixed-width, one time zone), then the row id.
    const earliest = [...live].sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : (x.id < y.id ? -1 : 1)))[0]
    expect((await lotRow(lot)).source_plant_id).toBe(earliest.plant_id)
    expect(r.body.source_plant_id).toBe(earliest.plant_id)
    await expectCacheRule(lot)
  })

  it('-> []: every row retired, the cache NULL, and the empty uuid[] binds', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const r = await put(lot, [])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ id: lot, source_plant_id: null, source_plants: [] })
    const rows = await links(lot)
    expect(rows).toHaveLength(2)
    expect(rows.every((x) => x.deleted_at != null)).toBe(true)
    expect((await lotRow(lot)).source_plant_id).toBeNull()
    await expectCacheRule(lot)
  })

  it('re-adding a removed planting inserts a NEW row and leaves the retired one retired', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    expect((await put(lot, [P.B])).status).toBe(200)
    const retired = (await links(lot)).find((x) => x.plant_id === P.A)
    const r = await put(lot, [P.B, P.A])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const forA = (await links(lot)).filter((x) => x.plant_id === P.A)
    expect(forA).toHaveLength(2)
    expect(forA.find((x) => x.id === retired.id)).toEqual(retired)
    expect(forA.find((x) => x.id !== retired.id).deleted_at).toBeNull()
    expect(r.body.source_plant_id).toBe(P.B)
    await expectCacheRule(lot)
  })

  it('the same set twice inserts nothing and retires nothing', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const before = await links(lot)
    const r = await put(lot, [P.B, P.A])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await links(lot)).toEqual(before)
    expect((await lotRow(lot)).source_plant_id).toBe(P.A)
  })

  it('twelve parents are accepted and thirteen refused', async () => {
    const twelve = []
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      twelve.push(await planting(`T${String(i).padStart(2, '0')}`))
    }
    const lot = await newLot()
    const ok = await put(lot, twelve)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.source_plants).toHaveLength(12)
    expect(await livePlants(lot)).toEqual([...twelve].sort())
    const before = await everything()
    const tooMany = await put(lot, [...twelve, P.A])
    expect(tooMany.status).toBe(400)
    expect(await everything()).toBe(before)
    await expectCacheRule(lot)
  })

  it.each([
    ['one foreign planting among owned ones', () => [P.A, P.foreign]],
    ['one soft-deleted planting among owned ones', () => [P.A, P.deleted]],
  ])('refuses %s: 400, and both tables are unchanged', async (_label, ids) => {
    const lot = await newLot({ source_plant_ids: [P.B] })
    const before = await everything()
    const r = await put(lot, ids())
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toBe(UNUSABLE)
    expect(await everything()).toBe(before)
  })

  it('a lot it must not touch answers 404 and writes nothing: foreign, missing, soft-deleted, not seeds, malformed id', async () => {
    const foreignPlanting = await planting('X', { by: FOREIGN })
    const foreignLot = await newLot({ source_plant_ids: [foreignPlanting] }, FOREIGN)
    const deletedLot = await newLot({ source_plant_ids: [P.A] })
    expect((await softDeleteLot(deletedLot)).status).toBe(200)
    setTestUserId(USER)
    const tool = await callHandler(invHandler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: `slp-tool-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(tool.status, JSON.stringify(tool.body)).toBe(201)

    const before = await everything()
    for (const [label, id] of [
      ['foreign', foreignLot], ['missing', randomUUID()], ['soft-deleted', deletedLot],
      ['not seeds', tool.body.id], ['malformed', 'not-a-uuid'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const viaPut = await put(id, [P.B])
      expect(viaPut.status, `PUT ${label} -> ${JSON.stringify(viaPut.body)}`).toBe(404)
      // eslint-disable-next-line no-await-in-loop
      const viaPatch = await patchParent(id, P.B)
      expect(viaPatch.status, `PATCH ${label} -> ${JSON.stringify(viaPatch.body)}`).toBe(404)
      // eslint-disable-next-line no-await-in-loop
      const viaClear = await put(id, [])
      expect(viaClear.status, `PUT [] ${label} -> ${JSON.stringify(viaClear.body)}`).toBe(404)
    }
    expect(await everything()).toBe(before)
  })

  it('a shop-origin lot refuses a non-empty set on both routes (400, the CHECK\'s own sentence) and accepts []', async () => {
    const lot = await newLot({ source_kind: 'gift' })
    const before = await everything()
    const r = await put(lot, [P.A])
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toBe(SHOP_AND_PLANT)
    const legacy = await patchParent(lot, P.A)
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(400)
    expect(legacy.body.error).toBe(SHOP_AND_PLANT)
    expect(await everything()).toBe(before)

    const clear = await put(lot, [])
    expect(clear.status, JSON.stringify(clear.body)).toBe(200)
    expect(clear.body).toEqual({ id: lot, source_plant_id: null, source_plants: [] })
    expect((await lotRow(lot)).source_kind).toBe('gift')
  })

  it('MEMBER EXEMPTION: a parent whose planting was soft-deleted afterwards can be re-sent unchanged, and the lot stays editable', async () => {
    // The set is gated by "a live planting the household owns OR already a live parent of THIS lot".
    // Without the second arm a lot that keeps such a parent could only ever be edited by dropping it.
    const gone = await planting('Z')
    const lot = await newLot({ source_plant_ids: [P.A, gone] })
    await softDeletePlanting(gone)
    const rowGone = (await links(lot)).find((r) => r.plant_id === gone)
    const goneAs = sourcePlant(gone, `Z-slp-${RUN}`, { deleted: true })
    expect((await getLot(lot)).body.source_plants).toEqual([sourcePlant(P.A, `A-slp-${RUN}`), goneAs])

    // The unchanged id beside a NEW parent: accepted, and the old link is not touched.
    const add = await put(lot, [P.A, gone, P.B])
    expect(add.status, JSON.stringify(add.body)).toBe(200)
    expect(add.body.source_plants).toEqual([sourcePlant(P.A, `A-slp-${RUN}`), sourcePlant(P.B, `B-slp-${RUN}`), goneAs])
    expect(await livePlants(lot)).toEqual([P.A, P.B, gone].sort())
    expect((await links(lot)).find((r) => r.id === rowGone.id)).toEqual(rowGone)

    // The deleted planting as the ONLY parent: accepted, and the cache moves onto it.
    const only = await put(lot, [gone])
    expect(only.status, JSON.stringify(only.body)).toBe(200)
    expect(only.body).toEqual({ id: lot, source_plant_id: gone, source_plants: [goneAs] })
    expect((await links(lot)).find((r) => r.id === rowGone.id)).toEqual(rowGone)
    await expectCacheRule(lot)

    // It can still be dropped ...
    expect((await put(lot, [P.A, gone])).status).toBe(200)
    const dropped = await put(lot, [P.A])
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200)
    expect(await livePlants(lot)).toEqual([P.A])
    expect((await links(lot)).find((r) => r.id === rowGone.id).deleted_at).not.toBeNull()

    // ... and once it is no longer a member it is a NEW id again, and a deleted planting is refused.
    const before = await everything()
    const back = await put(lot, [P.A, gone])
    expect(back.status, JSON.stringify(back.body)).toBe(400)
    expect(back.body.error).toBe(UNUSABLE)
    expect(await everything()).toBe(before)
    await expectCacheRule(lot)
  })

  it('a NEW id naming a soft-deleted planting is still 400 — also when it is a live parent of ANOTHER lot, and on POST', async () => {
    const gone = await planting('ZZ')
    const other = await newLot({ source_plant_ids: [gone] }) // `gone` is a member of THIS lot only
    await softDeletePlanting(gone)
    const lot = await newLot({ source_plant_ids: [P.A] })
    // And another household's lot, with ITS deleted parent: the member arm is scoped through the caller's
    // own lot, so that lot's members admit nothing to this caller.
    const theirs = await planting('ZF', { by: FOREIGN })
    const theirLot = await newLot({ source_plant_ids: [theirs] }, FOREIGN)
    await softDeletePlanting(theirs)
    const before = await everything()

    const viaPut = await put(lot, [P.A, gone])
    expect(viaPut.status, JSON.stringify(viaPut.body)).toBe(400)
    expect(viaPut.body.error).toBe(UNUSABLE)
    const viaTheirLot = await put(theirLot, [theirs])
    expect(viaTheirLot.status, JSON.stringify(viaTheirLot.body)).toBe(400)
    expect(viaTheirLot.body.error).toBe(UNUSABLE)
    const viaPost = await postLot({ source_plant_ids: [gone] }) // a lot that does not exist yet has no members
    expect(viaPost.status, JSON.stringify(viaPost.body)).toBe(400)
    expect(viaPost.body.error).toBe(UNUSABLE)
    // The legacy single-parent route's own gate was not widened: re-sending its one parent is the 400 it
    // always was. (Clearing works, as it always did.)
    const viaLegacy = await patchParent(other, gone)
    expect(viaLegacy.status, JSON.stringify(viaLegacy.body)).toBe(400)
    expect(viaLegacy.body.error).toBe('source_plant_id does not match a planting you can use')
    expect(await everything()).toBe(before)

    const cleared = await patchParent(other, null)
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(await livePlants(other)).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory-items/:id/source-plant — the legacy single-parent route, now a dual write
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('legacy PATCH /:id/source-plant — writes the row AND the column', () => {
  it('none -> A -> B -> none', async () => {
    const lot = await newLot()
    const toA = await patchParent(lot, P.A)
    expect(toA.status, JSON.stringify(toA.body)).toBe(200)
    expect(toA.body).toEqual({ id: lot, source_plant_id: P.A, source_plants: [sourcePlant(P.A, `A-slp-${RUN}`)] })
    expect(await livePlants(lot)).toEqual([P.A])
    expect((await lotRow(lot)).source_plant_id).toBe(P.A)
    await expectCacheRule(lot)

    const toB = await patchParent(lot, P.B)
    expect(toB.status, JSON.stringify(toB.body)).toBe(200)
    expect(toB.body.source_plant_id).toBe(P.B)
    const rows = await links(lot)
    expect(rows).toHaveLength(2)
    expect(rows.find((x) => x.plant_id === P.A).deleted_at).not.toBeNull()
    expect(liveSeed(rows).map((x) => x.plant_id)).toEqual([P.B])
    expect((await lotRow(lot)).source_plant_id).toBe(P.B)
    await expectCacheRule(lot)

    const cleared = await patchParent(lot, null)
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(cleared.body).toEqual({ id: lot, source_plant_id: null, source_plants: [] })
    expect(await livePlants(lot)).toEqual([])
    expect((await lotRow(lot)).source_plant_id).toBeNull()
    await expectCacheRule(lot)
  })

  it('DRIFT, made on purpose — a column with no row (what the old Lambda leaves): PATCH null clears the column', async () => {
    const lot = await sqlLot({ sourcePlant: P.A })
    expect((await cacheRuleViolations([lot])).cacheIsNotALiveParent).toEqual([lot])
    const r = await patchParent(lot, null)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await lotRow(lot)).source_plant_id).toBeNull()
    expect(await links(lot)).toEqual([])
    await expectCacheRule(lot)
  })

  it('DRIFT, made on purpose — a column with no row: PATCH to B leaves one live row B and the column B', async () => {
    const lot = await sqlLot({ sourcePlant: P.A })
    const r = await patchParent(lot, P.B)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.source_plant_id).toBe(P.B)
    expect(await livePlants(lot)).toEqual([P.B])
    expect((await lotRow(lot)).source_plant_id).toBe(P.B)
    await expectCacheRule(lot)
  })

  it('a lot with TWO parents: an id, one of its own parents, and null are each 409 multi_parent_lot, and nothing moves', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const before = await everything()
    for (const value of [P.C, P.A, null]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await patchParent(lot, value)
      expect(r.status, `PATCH ${value} -> ${JSON.stringify(r.body)}`).toBe(409)
      expect(r.body.error).toBe(MULTI_PARENT)
      expect(r.body.code).toBe('multi_parent_lot')
      expect([...r.body.source_plant_ids].sort()).toEqual([P.A, P.B].sort())
    }
    // source_plant_id, every link row and the lot's own updated_at, to the microsecond.
    expect(await everything()).toBe(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory-items/:id/source-kind — reads the link rows as well as the column
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('PATCH /:id/source-kind — a lot with parents cannot claim a shop origin', () => {
  it('live link rows: gift is 400 and source_kind is unchanged; after PUT [] it is accepted', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    const refused = await patchKind(lot, 'gift')
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error).toMatch(/own_garden/)
    expect((await lotRow(lot)).source_kind).toBeNull()
    const own = await patchKind(lot, 'own_garden')
    expect(own.status, JSON.stringify(own.body)).toBe(200)

    expect((await put(lot, [])).status).toBe(200)
    const accepted = await patchKind(lot, 'gift')
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect((await lotRow(lot)).source_kind).toBe('gift')
  })

  it('DRIFT, made on purpose — link rows live and the column NULL: still 400, which the CHECK alone could not say', async () => {
    const lot = await newLot({ source_plant_ids: [P.A, P.B] })
    await directSql`UPDATE inventory_items SET source_plant_id = NULL WHERE id = ${lot}`
    expect((await cacheRuleViolations([lot])).parentsButNoCache).toEqual([lot])
    const refused = await patchKind(lot, 'gift')
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error).toMatch(/own_garden/)
    expect((await lotRow(lot)).source_kind).toBeNull()
    // Repaired the way a person would: send the set again.
    expect((await put(lot, [P.A, P.B])).status).toBe(200)
    await expectCacheRule(lot)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The read — source_plants on the detail, the list and the wide PUT
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('source_plants — one element per live seed_parent row, whatever state the planting is in', () => {
  let lot
  let twinLow
  let twinHigh
  let later
  let expected

  beforeAll(async () => {
    // Two plantings with the SAME name, so the id is what orders them.
    const t1 = await planting('twin', { name: `M-twin-slp-${RUN}` })
    const t2 = await planting('twin', { name: `M-twin-slp-${RUN}` })
    ;[twinLow, twinHigh] = [t1, t2].sort()
    later = await planting('N')
    const removed = await planting('O')
    const pollen = await planting('Q')

    lot = await newLot({ source_plant_ids: [P.C, P.archived, P.noVariety, t2, t1, later, removed] })
    expect((await put(lot, [P.C, P.archived, P.noVariety, t2, t1, later])).status).toBe(200) // retires `removed`
    await sqlLink(lot, pollen, { role: 'pollen_parent' })
    await softDeletePlanting(later)

    expected = [
      sourcePlant(P.C, `C-slp-${RUN}`),
      sourcePlant(P.archived, `E-slp-${RUN}`, { archived: true }),
      sourcePlant(P.noVariety, `F-slp-${RUN}`, { variety: false }),
      sourcePlant(twinLow, `M-twin-slp-${RUN}`),
      sourcePlant(twinHigh, `M-twin-slp-${RUN}`),
      sourcePlant(later, `N-slp-${RUN}`, { deleted: true }),
    ]
    expect([...expected].sort(byNameThenId)).toEqual(expected)
  })

  it('detail: archived and soft-deleted plantings are reported, a retired link and a pollen_parent row are not; ordered by name then id', async () => {
    const { status, body } = await getLot(lot)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(Array.isArray(body.source_plants)).toBe(true)
    expect(body.source_plants).toEqual(expected)
    expect(Object.keys(body.source_plants[0]).sort()).toEqual(
      ['archived', 'breeding_system', 'deleted', 'id', 'name', 'variety_id', 'variety_name'])
    expect(body.source_plant_id).toBe(P.C)
  })

  it('list: the lot appears ONCE with all six, a lot with no parents carries [], and so does a non-seed row', async () => {
    const bare = await newLot()
    setTestUserId(USER)
    const tool = await callHandler(invHandler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: `slp-list-tool-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(tool.status).toBe(201)
    for (const path of ['/api/inventory-items?category=seeds', '/api/inventory-items']) {
      setTestUserId(USER)
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await callHandler(invHandler, { method: 'GET', path })
      expect(status, `${path} -> ${JSON.stringify(body).slice(0, 200)}`).toBe(200)
      const mine = body.filter((r) => r.id === lot)
      expect(mine, `${path}: a lot must not be returned once per parent`).toHaveLength(1)
      expect(mine[0].source_plants).toEqual(expected)
      expect(mine[0].source_plant_id).toBe(P.C)
      expect(body.find((r) => r.id === bare).source_plants).toEqual([])
      expect(new Set(body.map((r) => r.id)).size).toBe(body.length)
      expect(body.every((r) => Array.isArray(r.source_plants))).toBe(true)
      if (path === '/api/inventory-items') expect(body.find((r) => r.id === tool.body.id).source_plants).toEqual([])
    }
  })

  it('another household sees none of it: 404 on the detail, absent from its list', async () => {
    const detail = await getLot(lot, FOREIGN)
    expect(detail.status).toBe(404)
    setTestUserId(FOREIGN)
    const { body } = await callHandler(invHandler, { method: 'GET', path: '/api/inventory-items?category=seeds' })
    expect(body.map((r) => r.id)).not.toContain(lot)
    expect(JSON.stringify(body)).not.toContain(P.C)
  })

  it('a soft-deleted lot keeps its live link rows and the read returns nothing for it', async () => {
    const gone = await newLot({ source_plant_ids: [P.A, P.B] })
    expect((await softDeleteLot(gone)).status).toBe(200)
    // A link row follows its lot: it is NOT soft-deleted with it.
    expect(await livePlants(gone)).toEqual([P.A, P.B].sort())
    expect(await readSourcePlants(directSql, [USER], gone)).toEqual([])
    const all = await readSourcePlants(directSql, [USER])
    expect(all.map((r) => r.inventory_item_id)).not.toContain(gone)
    expect(all.map((r) => r.inventory_item_id)).toContain(lot)
    await expectCacheRule(gone)
  })

  it('the wide PUT ignores source_plants and source_plant_ids in its body, and its 200 carries the set as it is', async () => {
    const edited = await newLot({ source_plant_ids: [P.A, P.B] })
    const before = await links(edited)
    setTestUserId(USER)
    const { status, body } = await callHandler(invHandler, {
      method: 'PUT', path: `/api/inventory-items/${edited}`,
      body: {
        name: `slp-edited-${RUN}`, type: 'consumable', category: 'seeds', unit: 'packet',
        quantity_on_hand: 2, variety_id: varietyId,
        source_plant_ids: [P.C], source_plants: [{ id: P.D }],
      },
    })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.source_plants).toEqual([sourcePlant(P.A, `A-slp-${RUN}`), sourcePlant(P.B, `B-slp-${RUN}`)])
    expect(await links(edited)).toEqual(before)
    expect((await lotRow(edited)).source_plant_id).toBe(P.A)
    await expectCacheRule(edited)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/plants/:id/seed-lots — the reverse read, on either representation
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('GET /api/plants/:id/seed-lots — lots by link row OR by the column', () => {
  const lotIds = (body) => body.seed_lots.map((l) => l.id)
  const other = (body, lot) => body.seed_lots.find((l) => l.id === lot).other_parents

  it('a lot is listed under a parent that is NOT its cache parent', async () => {
    const p1 = await planting('R1')
    const p2 = await planting('R2')
    const lot = await newLot({ source_plant_ids: [p1, p2] })
    expect((await lotRow(lot)).source_plant_id).toBe(p1)
    const { status, body } = await seedLotsOf(p2)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.plant_id).toBe(p2)
    expect(lotIds(body)).toEqual([lot])
    expect(other(body, lot)).toEqual([{ id: p1, name: `R1-slp-${RUN}`, variety_name: VARIETY_NAME }])
  })

  it('one row per lot whatever its parent count; other_parents leaves :id out and keeps archived, deleted and variety-less plantings, name then id', async () => {
    const me = await planting('S0')
    const t1 = await planting('twin', { name: `S5-twin-slp-${RUN}` })
    const t2 = await planting('twin', { name: `S5-twin-slp-${RUN}` })
    const [low, high] = [t1, t2].sort()
    const arch = await planting('S1', { archived: true })
    const noVar = await planting('S2', { variety: null })
    const gone = await planting('S3')
    const lot = await newLot({ source_plant_ids: [me, t2, gone, noVar, arch, t1], source_plant_id: me })
    await softDeletePlanting(gone)

    const { status, body } = await seedLotsOf(me)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(lotIds(body)).toEqual([lot]) // column arm AND link arm both match: still one row
    const others = other(body, lot)
    expect(Array.isArray(others)).toBe(true)
    expect(others).toEqual([
      { id: arch, name: `S1-slp-${RUN}`, variety_name: VARIETY_NAME },
      { id: noVar, name: `S2-slp-${RUN}`, variety_name: null },
      { id: gone, name: `S3-slp-${RUN}`, variety_name: VARIETY_NAME },
      { id: low, name: `S5-twin-slp-${RUN}`, variety_name: VARIETY_NAME },
      { id: high, name: `S5-twin-slp-${RUN}`, variety_name: VARIETY_NAME },
    ])
    // The existing fields still ride beside it.
    const row = body.seed_lots[0]
    expect(row.variety_name).toBe(VARIETY_NAME)
    expect(Number(row.quantity_on_hand)).toBe(1)
  })

  it('a one-parent lot carries other_parents as an empty ARRAY, not null and not a string', async () => {
    const solo = await planting('U1')
    const lot = await newLot({ source_plant_ids: [solo] })
    const { body } = await seedLotsOf(solo)
    expect(other(body, lot)).toStrictEqual([])
  })

  it('a retired link no longer lists the lot, and a retired co-parent leaves other_parents', async () => {
    const keep = await planting('V1')
    const dropped = await planting('V2')
    const lot = await newLot({ source_plant_ids: [keep, dropped] })
    expect((await put(lot, [keep])).status).toBe(200)
    expect(lotIds((await seedLotsOf(dropped)).body)).toEqual([])
    const kept = (await seedLotsOf(keep)).body
    expect(lotIds(kept)).toEqual([lot])
    expect(other(kept, lot)).toEqual([])
  })

  it('a pollen_parent row neither lists the lot nor appears among other_parents', async () => {
    const seedParent = await planting('W1')
    const pollen = await planting('W2')
    const lot = await newLot({ source_plant_ids: [seedParent] })
    await sqlLink(lot, pollen, { role: 'pollen_parent' })
    expect(lotIds((await seedLotsOf(pollen)).body)).toEqual([])
    expect(other((await seedLotsOf(seedParent)).body, lot)).toEqual([])
    await expectCacheRule(lot)
  })

  it('a soft-deleted lot is not listed, by its link or by its column', async () => {
    const parent = await planting('Y1')
    const lot = await newLot({ source_plant_ids: [parent] })
    expect((await softDeleteLot(lot)).status).toBe(200)
    expect(await livePlants(lot)).toEqual([parent])
    expect((await lotRow(lot)).source_plant_id).toBe(parent)
    expect(lotIds((await seedLotsOf(parent)).body)).toEqual([])
  })

  it('ANOTHER HOUSEHOLD\'S lot on a planting the caller can see is not listed — with a link row, and with the column alone', async () => {
    // Hand-written: no route would let FOREIGN link USER's planting. The second lot is the case the
    // parentheses round the OR exist for: unparenthesised, the column arm escapes both filters.
    const parent = await planting('Y2')
    const linked = await sqlLot({ by: FOREIGN, sourcePlant: parent })
    await sqlLink(linked, parent, { by: FOREIGN })
    const columnOnly = await sqlLot({ by: FOREIGN, sourcePlant: parent })
    const deletedColumnOnly = await sqlLot({ sourcePlant: parent, deleted: true })
    try {
      const { status, body } = await seedLotsOf(parent)
      expect(status).toBe(200)
      expect(lotIds(body)).toEqual([])
    } finally {
      await dropLot(columnOnly)
      await dropLot(deletedColumnOnly)
    }
  })

  it('DRIFT, made on purpose — a column with NO link row still lists the lot, with other_parents []', async () => {
    const parent = await planting('Y3')
    const lot = await sqlLot({ sourcePlant: parent })
    try {
      const { status, body } = await seedLotsOf(parent)
      expect(status).toBe(200)
      expect(lotIds(body)).toEqual([lot])
      expect(other(body, lot)).toStrictEqual([])
    } finally {
      await dropLot(lot)
    }
  })

  it('DRIFT, made on purpose — the column names A and the only live link is B: listed for both; A\'s page shows [B], B\'s shows []', async () => {
    const a = await planting('Y4')
    const b = await planting('Y5')
    const lot = await sqlLot({ sourcePlant: a })
    await sqlLink(lot, b)
    try {
      const forA = (await seedLotsOf(a)).body
      expect(lotIds(forA)).toEqual([lot])
      expect(other(forA, lot)).toEqual([{ id: b, name: `Y5-slp-${RUN}`, variety_name: VARIETY_NAME }])
      const forB = (await seedLotsOf(b)).body
      expect(lotIds(forB)).toEqual([lot])
      expect(other(forB, lot)).toEqual([])
    } finally {
      await dropLot(lot)
    }
  })

  it('DRIFT, made on purpose — the column names P and its only link to P is retired: still listed, through the column', async () => {
    const parent = await planting('Y6')
    const lot = await sqlLot({ sourcePlant: parent })
    await sqlLink(lot, parent, { retired: true })
    try {
      const { body } = await seedLotsOf(parent)
      expect(lotIds(body)).toEqual([lot])
      expect(other(body, lot)).toEqual([])
    } finally {
      await dropLot(lot)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The planting merge — seed_lot_parent_planting.plant_id as a merge surface
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('planting merge — parent links are pruned, then moved, and the cache stays a member', () => {
  // A container with a winner and three sibling losers, alike on every guarded column (the shape
  // plant-merge-surfaces.int.test.js merges).
  async function group(tag) {
    const proj = await insertProject({ name: `slp-mrg-${tag}-${RUN}`, createdBy: USER })
    const out = {}
    for (const who of ['W', 'L1', 'L2', 'L3']) {
      // eslint-disable-next-line no-await-in-loop
      const [p] = await directSql`
        INSERT INTO plants (project_id, name, created_by)
        VALUES (${proj.id}, ${`slp-mrg-${tag}-${who}-${RUN}`}, ${USER}) RETURNING id`
      out[who] = p.id
    }
    return out
  }
  const onLosers = async (losers) => (await directSql`
    SELECT count(*)::int AS n FROM seed_lot_parent_planting WHERE plant_id = ANY(${losers}::uuid[])`)[0].n
  async function mergeRecord(id) {
    const [m] = await directSql`
      SELECT snapshot, snapshot_version, merged_at::text AS merged_at FROM merge_event WHERE id = ${id}`
    const snap = typeof m.snapshot === 'string' ? JSON.parse(m.snapshot) : m.snapshot
    return {
      version: m.snapshot_version,
      mergedAt: m.merged_at,
      pruned: [...(snap.seed_lot_parents_pruned ?? [])].sort(),
      repoints: snap.repoints
        .filter((r) => r.table === 'seed_lot_parent_planting')
        .map((r) => ({ id: r.row_id, old: r.old_value, column: r.column }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      cacheRepoints: snap.repoints
        .filter((r) => r.table === 'inventory_items')
        .map((r) => ({ id: r.row_id, old: r.old_value }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    }
  }

  it.each([
    ['the cache names the LOSER', 'a-loser', (g) => g.L1],
    ['the cache names the WINNER', 'a-winner', (g) => g.W],
  ])('(a) winner and loser both parents of one lot, %s: the loser\'s row is retired, the winner\'s is untouched', async (_label, tag, cacheOf) => {
    const g = await group(tag)
    const lot = await newLot({ source_plant_ids: [g.W, g.L1], source_plant_id: cacheOf(g) })
    const before = await links(lot)
    const rowW = before.find((x) => x.plant_id === g.W)
    const rowL = before.find((x) => x.plant_id === g.L1)

    const r = await merge(g.W, [g.L1])
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const after = await links(lot)
    expect(after).toHaveLength(2) // retired, not deleted
    expect(after.find((x) => x.id === rowW.id)).toEqual(rowW)
    const moved = after.find((x) => x.id === rowL.id)
    expect(moved.plant_id).toBe(g.W)
    expect(moved.deleted_at).not.toBeNull()
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    expect(await onLosers([g.L1])).toBe(0)
    await expectCacheRule(lot)

    const rec = await mergeRecord(r.body.merge_event_id)
    expect(rec.version).toBe(2)
    expect(rec.pruned).toEqual([rowL.id])
    expect(rec.repoints).toEqual([{ id: rowL.id, old: g.L1, column: 'plant_id' }])
    // The retired row carries the merge's own instant, as its updated_at does.
    expect(moved.deleted_at).toBe(rec.mergedAt)
    expect(moved.updated_at).toBe(rec.mergedAt)
  })

  it('(b) two losers on one lot and the winner absent: the LOWER row id survives and now names the winner', async () => {
    const g = await group('b')
    const lot = await newLot({ source_plant_ids: [g.L1, g.L2], source_plant_id: g.L2 })
    const before = await links(lot)
    const [low, high] = [...before].sort((x, y) => (x.id < y.id ? -1 : 1))

    const r = await merge(g.W, [g.L1, g.L2])
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const after = await links(lot)
    expect(after).toHaveLength(2)
    expect(after.every((x) => x.plant_id === g.W)).toBe(true)
    expect(liveSeed(after).map((x) => x.id)).toEqual([low.id])
    expect(after.find((x) => x.id === high.id).deleted_at).not.toBeNull()
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    expect(await onLosers([g.L1, g.L2])).toBe(0)
    await expectCacheRule(lot)

    const rec = await mergeRecord(r.body.merge_event_id)
    expect(rec.pruned).toEqual([high.id])
    expect(rec.repoints).toEqual(
      before.map((x) => ({ id: x.id, old: x.plant_id, column: 'plant_id' })).sort((a, b) => (a.id < b.id ? -1 : 1)))
    // The survivor moved in this merge too: a new updated_at, the merge's instant.
    expect(after.find((x) => x.id === low.id).updated_at).toBe(rec.mergedAt)
    expect(after.find((x) => x.id === low.id).updated_at).not.toBe(low.updated_at)
  })

  it('(c) the loser is the only parent: the row moves, nothing is retired, the cache moves', async () => {
    const g = await group('c')
    const lot = await newLot({ source_plant_ids: [g.L1] })
    const [row] = await links(lot)
    const r = await merge(g.W, [g.L1])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const after = await links(lot)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: row.id, plant_id: g.W, deleted_at: null })
    expect(after[0].updated_at).not.toBe(row.updated_at)
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    expect(await onLosers([g.L1])).toBe(0)
    await expectCacheRule(lot)
    const rec = await mergeRecord(r.body.merge_event_id)
    expect(rec.pruned).toEqual([])
    expect(rec.cacheRepoints).toEqual([{ id: lot, old: g.L1 }])
  })

  it('(d) the loser on lot X and the winner on lot Y: nothing is retired on either', async () => {
    const g = await group('d')
    const x = await newLot({ source_plant_ids: [g.L1] })
    const y = await newLot({ source_plant_ids: [g.W] })
    const [rowY] = await links(y)
    const r = await merge(g.W, [g.L1])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(liveSeed(await links(x)).map((l) => l.plant_id)).toEqual([g.W])
    expect(await links(y)).toEqual([rowY])
    expect((await lotRow(x)).source_plant_id).toBe(g.W)
    expect((await lotRow(y)).source_plant_id).toBe(g.W)
    expect(await onLosers([g.L1])).toBe(0)
    await expectCacheRule(x, y)
    expect((await mergeRecord(r.body.merge_event_id)).pruned).toEqual([])
  })

  it('three losers on one lot: exactly one live row survives, the lowest id', async () => {
    const g = await group('three')
    const lot = await newLot({ source_plant_ids: [g.L1, g.L2, g.L3], source_plant_id: g.L3 })
    const lowest = [...await links(lot)].sort((x, y) => (x.id < y.id ? -1 : 1))[0]
    const r = await merge(g.W, [g.L1, g.L2, g.L3])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const after = await links(lot)
    expect(after).toHaveLength(3)
    expect(liveSeed(after).map((x) => x.id)).toEqual([lowest.id])
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    expect(await onLosers([g.L1, g.L2, g.L3])).toBe(0)
    await expectCacheRule(lot)
    expect((await mergeRecord(r.body.merge_event_id)).pruned).toHaveLength(2)
  })

  it('NEAR MISS — the winner holds only a RETIRED row for the lot: the loser\'s live row is not retired, it moves', async () => {
    const g = await group('near')
    const lot = await newLot({ source_plant_ids: [g.W, g.L1], source_plant_id: g.L1 })
    expect((await put(lot, [g.L1])).status).toBe(200) // the winner is taken off the lot: its row is retired
    const before = await links(lot)
    const retiredW = before.find((x) => x.plant_id === g.W)
    const liveL = before.find((x) => x.plant_id === g.L1)
    expect(retiredW.deleted_at).not.toBeNull()

    const r = await merge(g.W, [g.L1])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const after = await links(lot)
    expect(after.find((x) => x.id === retiredW.id)).toEqual(retiredW)
    expect(after.find((x) => x.id === liveL.id)).toMatchObject({ plant_id: g.W, deleted_at: null })
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    await expectCacheRule(lot)
    expect((await mergeRecord(r.body.merge_event_id)).pruned).toEqual([])
  })

  it('a loser\'s row that was ALREADY retired moves, stays retired, is in repoints, is not in the pruned list, and retires nothing', async () => {
    const g = await group('old')
    const lot = await newLot({ source_plant_ids: [g.L1, g.L2], source_plant_id: g.L2 })
    expect((await put(lot, [g.L2])).status).toBe(200) // L1 taken off by hand, before any merge
    const before = await links(lot)
    const oldRetired = before.find((x) => x.plant_id === g.L1)
    const liveL2 = before.find((x) => x.plant_id === g.L2)

    const r = await merge(g.W, [g.L1, g.L2])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const after = await links(lot)
    const movedOld = after.find((x) => x.id === oldRetired.id)
    expect(movedOld.plant_id).toBe(g.W)
    expect(movedOld.deleted_at).toBe(oldRetired.deleted_at) // retired when the person removed it, not now
    expect(after.find((x) => x.id === liveL2.id)).toMatchObject({ plant_id: g.W, deleted_at: null })
    expect(await onLosers([g.L1, g.L2])).toBe(0)
    await expectCacheRule(lot)

    const rec = await mergeRecord(r.body.merge_event_id)
    expect(rec.pruned).toEqual([])
    expect(rec.repoints.map((x) => x.id)).toEqual([oldRetired.id, liveL2.id].sort())
  })

  it('winner a seed parent and loser a pollen parent of one lot (and the reverse): nothing retired, no collision', async () => {
    const g = await group('role')
    const lot = await newLot({ source_plant_ids: [g.W] })
    await sqlLink(lot, g.L1, { role: 'pollen_parent' })
    const other = await newLot({ source_plant_ids: [g.L2] })
    await sqlLink(other, g.W, { role: 'pollen_parent' })

    const r = await merge(g.W, [g.L1, g.L2])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    for (const id of [lot, other]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await links(id)
      expect(rows.map((x) => `${x.role}:${x.plant_id}:${x.deleted_at == null}`).sort())
        .toEqual([`pollen_parent:${g.W}:true`, `seed_parent:${g.W}:true`])
      // eslint-disable-next-line no-await-in-loop
      expect((await lotRow(id)).source_plant_id).toBe(g.W)
    }
    await expectCacheRule(lot, other)
    expect((await mergeRecord(r.body.merge_event_id)).pruned).toEqual([])
  })

  it('a SOFT-DELETED lot\'s links are pruned and moved like any other, and its cache still names a member', async () => {
    const g = await group('gone')
    const lot = await newLot({ source_plant_ids: [g.W, g.L1], source_plant_id: g.L1 })
    expect((await softDeleteLot(lot)).status).toBe(200)
    const r = await merge(g.W, [g.L1])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const after = await links(lot)
    expect(after.every((x) => x.plant_id === g.W)).toBe(true)
    expect(liveSeed(after)).toHaveLength(1)
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    await expectCacheRule(lot)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Concurrency — two real connections
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const HAS_PSQL = spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0

// The connection is handed to psql through PG* variables: never on its command line, never printed.
function pgEnv() {
  const u = new URL(process.env.INT_DATABASE_URL)
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'require',
    PGCONNECT_TIMEOUT: '20',
  }
  const binding = u.searchParams.get('channel_binding')
  if (binding) env.PGCHANNELBINDING = binding
  return env
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const lit = (id) => {
  if (!UUID_RE.test(String(id))) throw new Error(`refusing to put "${id}" into SQL text: not a uuid`)
  return `'${id}'::uuid`
}

// One psql process = one session = one transaction a test controls. run() sends statements and comes
// back when psql has finished them (it echoes a marker after the last one).
function openSession(label) {
  const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { env: pgEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let exit = null
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const closed = new Promise((res) => { child.on('close', (code) => { exit = code ?? -1; res(exit) }) })
  let n = 0
  const session = {
    async run(sqlText, { timeoutMs = 20000 } = {}) {
      n += 1
      const mark = `--slp-done-${n}--`
      const from = out.length
      child.stdin.write(`${sqlText}\n\\echo ${mark}\n`)
      const started = Date.now()
      while (!out.slice(from).includes(mark)) {
        if (exit !== null) throw new Error(`psql session "${label}" ended (exit ${exit}): ${err.trim()}`)
        if (Date.now() - started > timeoutMs) throw new Error(`psql session "${label}" gave no answer in ${timeoutMs} ms: ${err.trim()}`)
        // eslint-disable-next-line no-await-in-loop
        await sleep(20)
      }
      return out.slice(from).split('\n').map((s) => s.trim()).filter((s) => s && s !== mark)
    },
    async pid() { return Number((await session.run('SELECT pg_backend_pid();'))[0]) },
    async end(finalSql = 'ROLLBACK;') {
      if (exit === null) child.stdin.end(`${finalSql}\n\\q\n`)
      await closed
      sessions.delete(session)
      return { code: exit, err: err.trim() }
    },
    kill() { if (exit === null) child.kill('SIGKILL') },
  }
  sessions.add(session)
  return session
}

// A request that is expected to WAIT goes out on a connection of its own (see the header): the driver's
// fetchFunction hook sends it through a private https.Agent, so Neon gives it its own backend and the
// rest of the test — the polls below, the other request — is not queued behind it.
function viaAgent(agent, target, init) {
  return new Promise((resolve, reject) => {
    const t = new URL(target)
    const req = https.request({
      host: t.hostname, port: t.port || 443, path: `${t.pathname}${t.search}`,
      method: init.method, headers: init.headers, agent,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
neonConfig.fetchFunction = (target, init) => {
  const agent = connection.getStore()
  if (agent) return viaAgent(agent, target, init)
  return (fetchBefore ?? globalThis.fetch)(target, init)
}
function onOwnConnection(request) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
  agents.add(agent)
  return connection.run(agent, request)
}

// The backend that is waiting for a lock `pid` holds. Polls until there is one. A poll that gets no
// answer at all means this process's queries are queued behind the very request being watched.
async function waitBlockedBy(pid, what, { timeoutMs = 25000 } = {}) {
  const started = Date.now()
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await Promise.race([
      directSql`
        SELECT a.pid FROM pg_stat_activity a
         WHERE a.pid <> pg_backend_pid() AND ${pid}::int = ANY(pg_blocking_pids(a.pid))`,
      sleep(8000).then(() => null),
    ])
    if (rows === null) throw new Error(`the poll for "${what}" got no answer in 8 s: it is queued behind the request it is watching (was that request sent with onOwnConnection?)`)
    if (rows.length) return rows[0].pid
    if (Date.now() - started > timeoutMs) throw new Error(`nothing became blocked behind backend ${pid} (${what}) in ${timeoutMs} ms`)
    // eslint-disable-next-line no-await-in-loop
    await sleep(60)
  }
}

describe('concurrency needs psql', () => {
  it.runIf(process.env.GITHUB_ACTIONS)('psql is on the runner, so the concurrency cases below did not silently skip', () => {
    expect(HAS_PSQL).toBe(true)
  })
})

describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — two parents writes on one lot run one after the other', () => {
  it('PUT first, legacy PATCH second: the PATCH sees the two parents the PUT committed and answers 409', { timeout: 90000 }, async () => {
    const a = await planting('K1')
    const b = await planting('K2')
    const c = await planting('K3')
    const lot = await newLot({ source_plant_ids: [a] })
    const blocker = openSession('holds planting K2')
    try {
      const blockerPid = await blocker.pid()
      // After the lot, the PUT share-locks the plantings it names (lockPlantings). With K2 held here it
      // stops there: inside its transaction, the lot row locked.
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(b)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, [a, b]))
      const putPid = await waitBlockedBy(blockerPid, 'the PUT, at its planting locks')
      const patching = onOwnConnection(() => patchParent(lot, c))
      await waitBlockedBy(putPid, 'the legacy PATCH, at the lot lock')
      await blocker.end('COMMIT;')

      const [putR, patchR] = await Promise.all([putting, patching])
      expect(putR.status, JSON.stringify(putR.body)).toBe(200)
      expect(patchR.status, JSON.stringify(patchR.body)).toBe(409)
      expect(patchR.body.code).toBe('multi_parent_lot')
      expect([...patchR.body.source_plant_ids].sort()).toEqual([a, b].sort())
      expect(await livePlants(lot)).toEqual([a, b].sort())
      expect((await lotRow(lot)).source_plant_id).toBe(a)
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
    }
  })

  it('legacy PATCH first, PUT second: both complete, and the cache is a live member of the set the PUT left', { timeout: 90000 }, async () => {
    const a = await planting('K4')
    const b = await planting('K5')
    const c = await planting('K6')
    const lot = await newLot({ source_plant_ids: [a] })
    const blocker = openSession('holds planting K5')
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(b)} FOR UPDATE;`)
      const patching = onOwnConnection(() => patchParent(lot, b)) // A -> B: takes the lot, then stops at B's share lock
      const patchPid = await waitBlockedBy(blockerPid, 'the legacy PATCH, at its planting lock')
      const putting = onOwnConnection(() => put(lot, [a, c]))
      await waitBlockedBy(patchPid, 'the PUT, at the lot lock')
      await blocker.end('COMMIT;')

      const [patchR, putR] = await Promise.all([patching, putting])
      expect(patchR.status, JSON.stringify(patchR.body)).toBe(200)
      expect(patchR.body.source_plant_id).toBe(b)
      expect(putR.status, JSON.stringify(putR.body)).toBe(200)
      expect(await livePlants(lot)).toEqual([a, c].sort())
      const cache = (await lotRow(lot)).source_plant_id
      expect([a, c]).toContain(cache)
      expect(putR.body.source_plant_id).toBe(cache)
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
    }
  })

  it('23505 -> 409: a writer that moves a link onto the lot WITHOUT the lot lock, and commits while the PUT is inserting that planting', { timeout: 90000 }, async () => {
    // The only writer that can do this is one that UPDATEs plant_id on an existing row — the planting
    // merge's repoint. (An INSERT cannot: see the next case.) The lot has {A, X} with the cache on A;
    // the rival moves X's row to B and has not committed; the PUT asks for {A, X, B}.
    const a = await planting('K7')
    const x = await planting('K8')
    const b = await planting('K9')
    const lot = await newLot({ source_plant_ids: [a, x] })
    const rowX = (await links(lot)).find((r) => r.plant_id === x)
    const lotBefore = await lotRow(lot)
    const rival = openSession('moves X to B')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; UPDATE seed_lot_parent_planting SET plant_id = ${lit(b)}, updated_at = now() WHERE id = ${lit(rowX.id)};`)
      const putting = onOwnConnection(() => put(lot, [a, x, b]))
      await waitBlockedBy(rivalPid, 'the PUT, at the unique index')
      await rival.end('COMMIT;')

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body.error).toBe(CHANGED_AT_ONCE)
      expect(r.body.code).toBeUndefined()
      // The PUT wrote nothing: the lot is exactly what the rival left.
      const rows = await links(lot)
      expect(rows).toHaveLength(2)
      expect(liveSeed(rows).map((l) => l.plant_id).sort()).toEqual([a, b].sort())
      expect(await lotRow(lot)).toEqual(lotBefore)
      await expectCacheRule(lot)
    } finally {
      await rival.end()
    }
  })

  it('an INSERTING rival cannot cause that 409: its foreign-key check holds the lot row, so the PUT waits and then sees its row', { timeout: 90000 }, async () => {
    const a = await planting('KA')
    const b = await planting('KB')
    const lot = await newLot({ source_plant_ids: [a] })
    const rival = openSession('inserts (lot, B)')
    try {
      const rivalPid = await rival.pid()
      await rival.run(`BEGIN; INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
                       VALUES (${lit(lot)}, ${lit(b)}, 'seed_parent', '${USER.replace(/'/g, "''")}');`)
      const putting = onOwnConnection(() => put(lot, [a, b]))
      await waitBlockedBy(rivalPid, 'the PUT, at the lot lock')
      await rival.end('COMMIT;')
      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const rows = await links(lot)
      expect(rows).toHaveLength(2) // the rival's B row, not a second one
      expect(liveSeed(rows).map((l) => l.plant_id).sort()).toEqual([a, b].sort())
      await expectCacheRule(lot)
    } finally {
      await rival.end()
    }
  })

  it('/source-kind against a parents write that lands between its read and its UPDATE: 400 with the sentence, kind unchanged', { timeout: 90000 }, async () => {
    // The route reads "no parents", then updates. Here the parents write is a psql session doing what
    // replaceSourcePlants does (lot lock, link row, cache) and committing while the route's UPDATE waits
    // on the lot row. The UPDATE then meets a row whose source_plant_id is set, and
    // chk_inventory_seed_source_plant refuses it.
    const a = await planting('KC')
    const lot = await newLot()
    const writer = openSession('adds a parent')
    try {
      const writerPid = await writer.pid()
      await writer.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      const kind = onOwnConnection(() => patchKind(lot, 'gift'))
      await waitBlockedBy(writerPid, 'the source-kind UPDATE, at the lot row')
      await writer.run(`INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
                        VALUES (${lit(lot)}, ${lit(a)}, 'seed_parent', '${USER.replace(/'/g, "''")}');
                        UPDATE inventory_items SET source_plant_id = ${lit(a)} WHERE id = ${lit(lot)};`)
      await writer.end('COMMIT;')
      const r = await kind
      expect(r.status, JSON.stringify(r.body)).toBe(400)
      expect(r.body.error).toBe(SHOP_AND_PLANT)
      expect((await lotRow(lot)).source_kind).toBeNull()
      await expectCacheRule(lot)
    } finally {
      await writer.end()
    }
  })
})

// A winner and one sibling loser in a container of their own.
async function pair(tag) {
  const proj = await insertProject({ name: `slp-race-${tag}-${RUN}`, createdBy: USER })
  const mk = async (who) => (await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${proj.id}, ${`slp-race-${tag}-${who}-${RUN}`}, ${USER}) RETURNING id`)[0].id
  return { W: await mk('W'), L: await mk('L') }
}

// THE MERGE'S CUTOVER, AS IT IS ORDERED NOW (lambda/plants/merge.js): set_config; the LOT locks (FOR NO
// KEY UPDATE, by id); six hard prunes of other surfaces; the repoints of other surfaces, photos among
// the first; then the PLANTING locks (FOR NO KEY UPDATE on the winner and every loser, by id) and,
// directly behind them, the parent-link prune, the source_plant_id repoint and the link repoint; then
// the winner, the losers' soft-delete, the merge_event. Two places to stop it:
//
// EARLY — at its photos repoint, by a row lock on a photo of the loser. A merge stopped there holds its
// lots and has touched neither a planting nor the link table.
async function stoppedMerge(g, opId) {
  const [photo] = await directSql`
    INSERT INTO photos (plant_id, storage_path, created_by)
    VALUES (${g.L}, ${`plants/${g.L}/slp-race-${RUN}.jpg`}, ${USER}) RETURNING id`
  const blocker = openSession('holds the loser\'s photo')
  const blockerPid = await blocker.pid()
  await blocker.run(`BEGIN; SELECT id FROM photos WHERE id = ${lit(photo.id)} FOR UPDATE;`)
  const merging = onOwnConnection(() => merge(g.W, [g.L], opId))
  const mergePid = await waitBlockedBy(blockerPid, 'the merge, at its photos repoint')
  return { blocker, merging, mergePid, release: () => blocker.end('COMMIT;') }
}
// LATE — at a parent link the loser has on `lot`, by a row lock on that link. A merge stopped there
// holds its lots AND its plantings, and has already taken the link table for writing.
async function mergeStoppedAtItsLinks(g, lot) {
  const row = (await links(lot)).find((r) => r.plant_id === g.L && r.deleted_at == null)
  const blocker = openSession('holds a link the merge will write')
  const blockerPid = await blocker.pid()
  await blocker.run(`BEGIN; SELECT id FROM seed_lot_parent_planting WHERE id = ${lit(row.id)} FOR UPDATE;`)
  const merging = onOwnConnection(() => merge(g.W, [g.L]))
  const mergePid = await waitBlockedBy(blockerPid, 'the merge, at a parent link, its plantings held')
  return { blocker, merging, mergePid, release: () => blocker.end('COMMIT;') }
}
// EARLIEST — at a hard prune, before its photos repoint and before any repoint at all: a ready_impression
// row of the loser on the winner's key, which the merge's fourth hard prune deletes, held by a session.
// A merge stopped there holds its lots and nothing else.
async function mergeStoppedAtAHardPrune(g, opId) {
  const impression = async (plant) => String((await directSql`
    INSERT INTO ready_impression (user_id, plant_id, shown_on, slot, region, source, model_version)
    VALUES (${USER}, ${plant}, '2026-09-01'::date, 0, 'tray', 'recent', 'int-test') RETURNING id`)[0].id)
  await impression(g.W)
  const losers = await impression(g.L)
  if (!/^\d+$/.test(losers)) throw new Error(`ready_impression id is not a number: ${losers}`)
  const blocker = openSession('holds the loser\'s impression row')
  const blockerPid = await blocker.pid()
  await blocker.run(`BEGIN; SELECT id FROM ready_impression WHERE id = ${losers} FOR UPDATE;`)
  const merging = onOwnConnection(() => merge(g.W, [g.L], opId))
  const mergePid = await waitBlockedBy(blockerPid, 'the merge, lots held, at a hard prune')
  return { blocker, merging, mergePid, release: () => blocker.end('COMMIT;') }
}
const onLoser = async (g) => (await directSql`
  SELECT count(*)::int AS n FROM seed_lot_parent_planting WHERE plant_id = ${g.L}`)[0].n
// softDeletePhoto is the photos Lambda's delete, taken whole: what it answered, or the code it threw.
const deletePhoto = (photoId) => onOwnConnection(() => softDeletePhoto(directSql, { photoId, householdIds: [USER], userId: USER }))
  .then((r) => ({ answered: r.status }), (e) => ({ threw: e.code ?? e.message }))
// The handler's "this was a retry" log lines, parsed, from a console.warn spy.
const retryLines = (spy) => spy.mock.calls
  .map((c) => String(c[0]))
  .filter((line) => line.includes('inv-source-plants-retry'))
  .map((line) => JSON.parse(line))
// Postgres checks for a deadlock ONCE per lock wait, deadlock_timeout after that wait began. So of two
// transactions in a cycle, the victim is the one whose check runs while the cycle exists: hold the first
// waiter past its own check (it finds nothing and goes on waiting), and the transaction that then closes
// the cycle is the one that is aborted. Every "X is the victim" case below arranges exactly that.
let deadlockCheckMs = 1000
const pastItsDeadlockCheck = () => sleep(deadlockCheckMs + 700)

describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — a planting merge against a parents edit on the same lot (D-1, D-2)', () => {
  beforeAll(async () => {
    deadlockCheckMs = (await directSql`
      SELECT (extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000)::int AS ms`)[0].ms
  })

  // D-1. Both shapes of lot. As first committed the merge pruned L's link, and only much later rewrote
  // the lot row, while a PUT takes the lot row first and then L's link: opposite orders, a deadlock, and
  // Postgres aborted the PUT with 40P01 (it answered 500). The merge now locks every lot it can touch
  // before anything else, so the two simply wait for each other. With the cache on the WINNER the
  // source_plant_id repoint never touches the lot at all; only that explicit lock covers it.
  const SHAPES = [
    ['the cache names the LOSER', 'l', (g) => g.L],
    ['the cache names the WINNER', 'w', (g) => g.W],
  ]

  it.each(SHAPES)('merge first, PUT second, %s: the PUT waits behind the merge and neither is aborted', async (_label, tag, cacheOf) => {
    const g = await pair(`m1${tag}`)
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: cacheOf(g) })
    const stopped = await stoppedMerge(g)
    try {
      const putting = onOwnConnection(() => put(lot, [g.W]))
      await waitBlockedBy(stopped.mergePid, 'the PUT, behind the merge')
      await stopped.release()

      const [mergeR, putR] = await Promise.all([stopped.merging, putting])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(200)
      expect(await livePlants(lot)).toEqual([g.W])
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      expect(await onLoser(g)).toBe(0)
      await expectCacheRule(lot)
    } finally {
      await stopped.blocker.end()
    }
  }, 90000)

  it.each(SHAPES)('PUT first, merge second, %s: the merge waits for the lot, then both complete', async (_label, tag, cacheOf) => {
    const g = await pair(`m2${tag}`)
    const c = await planting(`KD${tag}`)
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: cacheOf(g) })
    const blocker = openSession('holds planting KD')
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(c)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, [g.W, c])) // takes L off and adds KD: stops at KD's share lock, lot row held
      const putPid = await waitBlockedBy(blockerPid, 'the PUT, at its planting locks')
      const merging = onOwnConnection(() => merge(g.W, [g.L]))
      await waitBlockedBy(putPid, 'the merge, behind the PUT')
      await blocker.end('COMMIT;')

      const [putR, mergeR] = await Promise.all([putting, merging])
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(200)
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(await livePlants(lot)).toEqual([g.W, c].sort())
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      expect(await onLoser(g)).toBe(0)
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
    }
  }, 90000)

  it('two merges whose lots overlap on two lots: the second waits for the first, and both complete', { timeout: 90000 }, async () => {
    const g1 = await pair('mm1')
    const g2 = await pair('mm2')
    const lotA = await newLot({ source_plant_ids: [g1.L, g2.L] })
    const lotB = await newLot({ source_plant_ids: [g2.L, g1.L] })
    const stopped = await stoppedMerge(g1)
    try {
      const second = onOwnConnection(() => merge(g2.W, [g2.L]))
      await waitBlockedBy(stopped.mergePid, 'the second merge, at its lot locks')
      await stopped.release()
      const [r1, r2] = await Promise.all([stopped.merging, second])
      expect(r1.status, `first merge -> ${JSON.stringify(r1.body)}`).toBe(200)
      expect(r2.status, `second merge -> ${JSON.stringify(r2.body)}`).toBe(200)
      for (const lot of [lotA, lotB]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await livePlants(lot)).toEqual([g1.W, g2.W].sort())
        // eslint-disable-next-line no-await-in-loop
        expect([g1.W, g2.W]).toContain((await lotRow(lot)).source_plant_id)
      }
      expect(await onLoser(g1)).toBe(0)
      expect(await onLoser(g2)).toBe(0)
      await expectCacheRule(lotA, lotB)
    } finally {
      await stopped.blocker.end()
    }
  })

  it('the lot lock\'s strength: FOR KEY SHARE on a merge lot (the reconcile\'s lock) does not hold the merge up', { timeout: 90000 }, async () => {
    const g = await pair('ks')
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const holder = openSession('holds the lot FOR KEY SHARE')
    try {
      await holder.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR KEY SHARE;`)
      const r = await Promise.race([
        onOwnConnection(() => merge(g.W, [g.L])),
        sleep(20000).then(() => ({ status: 'still waiting after 20 s', body: null })),
      ])
      // Answered while the other session's transaction, and its lock, were still open.
      expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
      expect(await holder.run('SELECT 1;')).toEqual(['1'])
      expect(await livePlants(lot)).toEqual([g.W])
      await expectCacheRule(lot)
    } finally {
      await holder.end()
    }
  })

  it('the lot lock\'s strength: FOR UPDATE on a merge lot (a parents edit\'s lock) makes the merge wait, and no lot is left locked', { timeout: 90000 }, async () => {
    const g = await pair('fu')
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const holder = openSession('holds the lot FOR UPDATE')
    try {
      const holderPid = await holder.pid()
      await holder.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`)
      const merging = onOwnConnection(() => merge(g.W, [g.L]))
      await waitBlockedBy(holderPid, 'the merge, at its lot locks')
      await holder.end('COMMIT;')
      const r = await merging
      expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
      expect(await livePlants(lot)).toEqual([g.W])
      await expectCacheRule(lot)
      // The merge's locks ended with its transaction: a second session takes the lot at once.
      const probe = openSession('probes the lot')
      try {
        expect(await probe.run(`BEGIN; SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE NOWAIT;`)).toEqual([lot])
      } finally {
        await probe.end()
      }
    } finally {
      await holder.end()
    }
  })

  it('while a merge holds a lot, a planting can still be sown from that packet (the lot\'s key is not locked)', { timeout: 90000 }, async () => {
    const g = await pair('sow')
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const stopped = await stoppedMerge(g)
    try {
      const sown = await Promise.race([
        directSql`
          INSERT INTO plants (project_id, name, created_by, source_inventory_item_id)
          VALUES (NULL, ${`sown-during-merge-slp-${RUN}`}, ${USER}, ${lot}) RETURNING id`,
        sleep(15000).then(() => null),
      ])
      expect(sown, 'the INSERT waited on the merge: its foreign-key check on the lot was held off').not.toBeNull()
      expect(sown).toHaveLength(1)
      await stopped.release()
      const r = await stopped.merging
      expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
    } finally {
      await stopped.blocker.end()
    }
  })

  // ── D-2, CLOSED ────────────────────────────────────────────────────────────────────────────────────
  // The parents routes used to ask "may the caller use every one of these plantings" once, BEFORE their
  // transaction, and never again. A request that then waited for its lot behind a merge acted on the
  // pre-merge answer: re-saving the lot's unchanged set {A, L} while L was being merged into W answered
  // 200, retired W's row and linked the planting the merge had just soft-deleted; the lot vanished from
  // the winner's page. (This file held that as a known, expected failure until the handler changed.)
  // The write now asks again INSIDE the transaction, under the lot lock and a share lock on the plantings,
  // and an id passes when it is a live planting of the household OR already a live parent of this lot.
  // After the merge L is neither. Nothing is written and the answer is a 409 that says to reload.
  describe('a PUT that names the loser and waited behind the merge', () => {
    let g
    let a
    let lot
    let lotBefore
    let rowA
    let rowL
    let mergeR
    let putR

    beforeAll(async () => {
      g = await pair('stale')
      a = await planting('KE')
      lot = await newLot({ source_plant_ids: [a, g.L] })
      lotBefore = await lotRow(lot)
      const rows = await links(lot)
      rowA = rows.find((r) => r.plant_id === a)
      rowL = rows.find((r) => r.plant_id === g.L)
      const stopped = await stoppedMerge(g)
      try {
        const putting = onOwnConnection(() => put(lot, [a, g.L])) // its gate passes: L is still live
        await waitBlockedBy(stopped.mergePid, 'the PUT, behind the merge')
        await stopped.release()
        ;[mergeR, putR] = await Promise.all([stopped.merging, putting])
      } finally {
        await stopped.blocker.end()
      }
    }, 90000)

    it('the merge answers 200 and the PUT 409 "one of those plants changed", with no ids in it', async () => {
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(409)
      expect(putR.body).toEqual({ error: PLANTS_CHANGED })
      const [loser] = await directSql`SELECT deleted_at IS NOT NULL AS gone FROM plants WHERE id = ${g.L}`
      expect(loser.gone).toBe(true)
    })

    it('the lot is exactly as the merge left it: parents {A, W}, still on the winner\'s page, nothing naming the loser', async () => {
      const rows = await links(lot)
      expect(rows).toHaveLength(2) // the PUT inserted nothing and retired nothing
      expect(rows.find((r) => r.id === rowA.id)).toEqual(rowA)
      expect(rows.find((r) => r.id === rowL.id)).toMatchObject({ plant_id: g.W, deleted_at: null })
      expect(await livePlants(lot)).toEqual([a, g.W].sort())
      expect(await onLoser(g)).toBe(0)
      // The cache was on A, so neither the merge nor the refused PUT had any reason to write the lot row.
      expect(await lotRow(lot)).toEqual(lotBefore)
      const page = await seedLotsOf(g.W)
      expect(page.body.seed_lots.map((l) => l.id)).toEqual([lot])
      await expectCacheRule(lot)
    })
  })

  it('the planting lock\'s strength: FOR SHARE on a loser (a parents write\'s lock) makes the merge wait; FOR KEY SHARE (a foreign-key check) does not', { timeout: 90000 }, async () => {
    const waits = await pair('ps')
    const lotW = await newLot({ source_plant_ids: [waits.L] })
    const holder = openSession('holds the loser FOR SHARE')
    try {
      const holderPid = await holder.pid()
      await holder.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(waits.L)} FOR SHARE;`)
      const merging = onOwnConnection(() => merge(waits.W, [waits.L]))
      await waitBlockedBy(holderPid, 'the merge, at its planting locks')
      await holder.end('COMMIT;')
      const r = await merging
      expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
      expect(await livePlants(lotW)).toEqual([waits.W])
    } finally {
      await holder.end()
    }

    const passes = await pair('pk')
    const lotK = await newLot({ source_plant_ids: [passes.L] })
    const keyHolder = openSession('holds the loser FOR KEY SHARE')
    try {
      await keyHolder.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(passes.L)} FOR KEY SHARE;`)
      const r = await Promise.race([
        onOwnConnection(() => merge(passes.W, [passes.L])),
        sleep(20000).then(() => ({ status: 'still waiting after 20 s', body: null })),
      ])
      expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
      expect(await keyHolder.run('SELECT 1;')).toEqual(['1'])
      expect(await livePlants(lotK)).toEqual([passes.W])
      await expectCacheRule(lotW, lotK)
    } finally {
      await keyHolder.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// A planting that changes while a parents write is on its way (the write's share lock, and its in-
// transaction re-test)
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — a planting changes under a parents write', () => {
  it('PUT, the delete first: the planting is being soft-deleted when the PUT arrives; the PUT waits, then 409, and the lot is untouched', { timeout: 90000 }, async () => {
    const a = await planting('C1')
    const b = await planting('C2')
    const c = await planting('C3')
    const lot = await newLot({ source_plant_ids: [c] })
    const before = await everything()
    const deleter = openSession('soft-deletes planting C2')
    try {
      const deleterPid = await deleter.pid()
      await deleter.run(`BEGIN; UPDATE plants SET deleted_at = now() WHERE id = ${lit(b)};`)
      const putting = onOwnConnection(() => put(lot, [a, b])) // its gate passes: C2 is live to every reader
      await waitBlockedBy(deleterPid, 'the PUT, at its planting locks')
      await deleter.end('COMMIT;')
      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED })
      // All or nothing: C's link not retired, A's not inserted, the cache and updated_at as they were.
      expect(await everything()).toBe(before)
    } finally {
      await deleter.end()
    }
  })

  it('POST, the delete first: 409, and no lot row and no link row exists afterwards', { timeout: 90000 }, async () => {
    const a = await planting('C4')
    const b = await planting('C5')
    const before = await everything()
    const deleter = openSession('soft-deletes planting C5')
    try {
      const deleterPid = await deleter.pid()
      await deleter.run(`BEGIN; UPDATE plants SET deleted_at = now() WHERE id = ${lit(b)};`)
      const posting = onOwnConnection(() => postLot({ source_plant_ids: [a, b] }))
      await waitBlockedBy(deleterPid, 'the POST, at its planting locks')
      await deleter.end('COMMIT;')
      const r = await posting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED })
      expect(await everything()).toBe(before)
    } finally {
      await deleter.end()
    }
  })

  it('PUT, the PUT first: it holds its share lock, a soft-delete of that planting waits behind it, the PUT answers 200 and the planting then reads deleted', { timeout: 90000 }, async () => {
    const b = await planting('C6')
    const high = await plantingWithId(idStarting('ffffffff'), 'C7')
    expect(high > b).toBe(true) // so the PUT locks C6 first and is stopped at C7
    const lot = await newLot()
    const blocker = openSession('holds planting C7')
    const deleter = openSession('soft-deletes planting C6')
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(high)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, [b, high]))
      const putPid = await waitBlockedBy(blockerPid, 'the PUT, holding C6, at C7')
      const deleting = deleter.run(`UPDATE plants SET deleted_at = now() WHERE id = ${lit(b)};`, { timeoutMs: 60000 })
        .then(() => 'deleted', (e) => `failed: ${e.message}`)
      await waitBlockedBy(putPid, 'the soft-delete, behind the PUT\'s share lock')
      await blocker.end('COMMIT;')
      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.source_plants.map((x) => [x.id, x.deleted])).toEqual([[b, false], [high, false]])
      expect(await deleting).toBe('deleted')
      expect(await livePlants(lot)).toEqual([b, high].sort())
      const after = (await getLot(lot)).body.source_plants
      expect(after.map((x) => [x.id, x.deleted])).toEqual([[b, true], [high, false]])
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
      await deleter.end()
    }
  })

  it('another session\'s FOR SHARE on the same planting does not hold a parents write up', { timeout: 90000 }, async () => {
    const b = await planting('C8')
    const lot = await newLot()
    const holder = openSession('holds planting C8 FOR SHARE')
    try {
      await holder.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(b)} FOR SHARE;`)
      const r = await Promise.race([
        onOwnConnection(() => put(lot, [b])),
        sleep(20000).then(() => ({ status: 'still waiting after 20 s', body: null })),
      ])
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(await holder.run('SELECT 1;')).toEqual(['1'])
      expect(await livePlants(lot)).toEqual([b])
    } finally {
      await holder.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// A parents write as the deadlock victim — 40P01 answers 409, not 500
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — a parents write that Postgres aborts as a deadlock victim answers 409', () => {
  beforeAll(async () => {
    deadlockCheckMs = (await directSql`
      SELECT (extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000)::int AS ms`)[0].ms
  })

  it('PUT: 409 "changed at the same moment", nothing written, and the other session carries on', { timeout: 120000 }, async () => {
    // The other session holds planting DC and then asks for the LOT. The PUT holds the lot and is kept
    // at its first planting lock (DA, the lower id) until the other session's own deadlock check has run
    // and found nothing; released, it locks DA and asks for DC. That request closes the cycle, so the
    // PUT is the one aborted.
    const low = await plantingWithId(idStarting('00000000'), 'DA')
    const c = await planting('DC')
    expect(low < c).toBe(true)
    const lot = await newLot({ source_plant_ids: [P.A] })
    const before = await everything()
    const holdLow = openSession('holds planting DA')
    const rival = openSession('holds planting DC, then wants the lot')
    const warn = vi.spyOn(console, 'warn')
    try {
      const holdLowPid = await holdLow.pid()
      await holdLow.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(low)} FOR UPDATE;`)
      await rival.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(c)} FOR UPDATE;`)
      const putting = onOwnConnection(() => put(lot, [low, c]))
      const putPid = await waitBlockedBy(holdLowPid, 'the PUT, lot held, at its first planting lock')
      const wanting = rival.run(`SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`, { timeoutMs: 60000 })
        .then((rows) => ({ got: rows }), (e) => ({ failed: e.message }))
      await waitBlockedBy(putPid, 'the other session, at the lot row')
      await pastItsDeadlockCheck()
      await holdLow.end('COMMIT;')

      const r = await putting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: CHANGED_AT_ONCE })
      // A 409 that used to be a 500 is logged, once, with the code: a lock-order regression must not hide.
      expect(retryLines(warn)).toEqual([{ tag: 'inv-source-plants-retry', item: lot, code: '40P01' }])
      // The other session was NOT the one aborted: it got the lot and its transaction is still usable.
      expect(await wanting).toEqual({ got: [lot] })
      expect(await rival.run('SELECT 1;')).toEqual(['1'])
      await rival.end()
      expect(await everything()).toBe(before)
    } finally {
      warn.mockRestore()
      await holdLow.end()
      await rival.end()
    }
  })

  it('POST: 409 "one of those plants changed", and no lot row is left', { timeout: 120000 }, async () => {
    // Three plantings by id: DL < DM < DH. The other session holds DH and then asks for DL. The POST has
    // share-locked DL and is kept at DM until the other session's check has run; released, it locks DM
    // and asks for DH, closing the cycle.
    const low = await plantingWithId(idStarting('00000000'), 'DL')
    const mid = await plantingWithId(idStarting('88888888'), 'DM')
    const high = await plantingWithId(idStarting('ffffffff'), 'DH')
    const before = await everything()
    const holdMid = openSession('holds planting DM')
    const rival = openSession('holds planting DH, then wants DL')
    const warn = vi.spyOn(console, 'warn')
    try {
      const holdMidPid = await holdMid.pid()
      await holdMid.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(mid)} FOR UPDATE;`)
      await rival.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(high)} FOR UPDATE;`)
      const posting = onOwnConnection(() => postLot({ source_plant_ids: [low, mid, high] }))
      const postPid = await waitBlockedBy(holdMidPid, 'the POST, DL share-locked, at DM')
      const wanting = rival.run(`SELECT id FROM plants WHERE id = ${lit(low)} FOR UPDATE;`, { timeoutMs: 60000 })
        .then((rows) => ({ got: rows }), (e) => ({ failed: e.message }))
      await waitBlockedBy(postPid, 'the other session, at planting DL')
      await pastItsDeadlockCheck()
      await holdMid.end('COMMIT;')

      const r = await posting
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body).toEqual({ error: PLANTS_CHANGED })
      expect(retryLines(warn)).toEqual([expect.objectContaining({ tag: 'inv-source-plants-retry', code: '40P01', create: true })])
      expect(await wanting).toEqual({ got: [low] })
      await rival.end()
      expect(await everything()).toBe(before) // the lot INSERT went back with the rest
    } finally {
      warn.mockRestore()
      await holdMid.end()
      await rival.end()
    }
  })

  // The legacy PATCH runs the same replaceSourcePlants and so the same catch as the PUT above. It is not
  // provoked on its own: it names ONE planting, so there is no point between its lot lock and its single
  // planting lock at which it can be held while the other session's deadlock check runs. Without that,
  // which of the two Postgres aborts depends on which began waiting first inside the same second.
  it.skip('legacy PATCH as the deadlock victim — not provoked: with one planting there is nowhere to hold it between its two locks', () => {})
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// F1.4 — a parents write that adds a merge's LOSER to a lot the merge did not lock
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — F1.4: a NEW parent that is a merge\'s loser, on a lot outside the merge\'s lot locks', () => {
  // The merge locks the lots that ALREADY link to its plantings. A lot that is only now gaining the loser
  // is not one of them, so the lot lock cannot order the two. What does: the write's FOR SHARE on the
  // plantings it names, against the merge's FOR NO KEY UPDATE on its own plantings — and the merge's three
  // seed-lot statements running BEHIND that lock, so that whichever is second sees what the first
  // committed. Before the merge locked its plantings a write that committed after the merge's link
  // repoint had run was never seen by it: a live link to a soft-deleted loser, the lot missing from the
  // winner's page, and no error anywhere.
  //
  // HANDLER FIRST is arranged by naming a second planting with a HIGHER id that a session holds: the
  // write share-locks the loser, then stops at that one. The merge reaches its planting locks and waits.
  async function handlerFirst(g, send) {
    const high = await plantingWithId(idStarting('ffffffff'), `F1-${seq++}`)
    expect(high > g.L && high > g.W).toBe(true)
    const blocker = openSession('holds the higher planting')
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(high)} FOR UPDATE;`)
      const writing = onOwnConnection(() => send(high))
      const writePid = await waitBlockedBy(blockerPid, 'the parents write, loser share-locked, at the higher planting')
      const merging = onOwnConnection(() => merge(g.W, [g.L]))
      await waitBlockedBy(writePid, 'the merge, at its planting locks')
      await blocker.end('COMMIT;')
      const [writeR, mergeR] = await Promise.all([writing, merging])
      return { high, writeR, mergeR }
    } finally {
      await blocker.end()
    }
  }
  const onWinnersPage = async (g) => (await seedLotsOf(g.W)).body.seed_lots.map((l) => l.id)

  // KNOWN LIMIT, ASSERTED AS IT IS TODAY (lane L2 report, section 15(d)) — flip these when it is fixed.
  // The merge reads its snapshot's seed-lot entries BEFORE its transaction: every link row on a loser,
  // every lot whose cache names a loser, and the links its prune will retire. In the handler-first order
  // the parents write commits AFTER those reads and BEFORE the merge's seed-lot statements run, so the
  // merge moves (or retires) a link, and may rewrite a lot's source_plant_id, that its own snapshot
  // never saw. Seen on Neon 2026-10-05 in all three handler-first cases below: no seed_lot_parent_planting
  // entry and no inventory_items entry in `repoints`, and `seed_lot_parents_pruned` empty. A restore
  // built from that snapshot would bring the loser back and leave this lot's link and cache on the
  // winner. The day the reads move inside the transaction this expectation fails; change it then.
  const whatTheSnapshotHoldsOfSeedLots = async (mergeR) => {
    const [m] = await directSql`SELECT snapshot FROM merge_event WHERE id = ${mergeR.body.merge_event_id}`
    const snap = typeof m.snapshot === 'string' ? JSON.parse(m.snapshot) : m.snapshot
    return {
      linksMoved: snap.repoints.filter((r) => r.table === 'seed_lot_parent_planting'),
      cachesMoved: snap.repoints.filter((r) => r.table === 'inventory_items'),
      linksRetired: snap.seed_lot_parents_pruned,
    }
  }
  const NOTHING_OF_WHAT_THE_MERGE_DID = { linksMoved: [], cachesMoved: [], linksRetired: [] }

  it('HANDLER FIRST, PUT: both complete, the link the PUT wrote is moved to the winner, and the lot is on the WINNER\'s page', { timeout: 90000 }, async () => {
    const g = await pair('f14a')
    const lot = await newLot() // no parents: nothing ties it to the group, so the merge does not lock it
    const { high, writeR, mergeR } = await handlerFirst(g, (h) => put(lot, [g.L, h]))
    expect(writeR.status, `PUT -> ${JSON.stringify(writeR.body)}`).toBe(200)
    expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
    expect(await livePlants(lot)).toEqual([g.W, high].sort())
    expect([g.W, high]).toContain((await lotRow(lot)).source_plant_id)
    expect(await onLoser(g)).toBe(0)
    expect(await onWinnersPage(g)).toEqual([lot])
    await expectCacheRule(lot)

    // The merge moved the PUT's link (and its cache, when the PUT put it on the loser). Its snapshot
    // records none of it: the known limit described above the helper.
    expect(await whatTheSnapshotHoldsOfSeedLots(mergeR)).toEqual(NOTHING_OF_WHAT_THE_MERGE_DID)
  })

  it('HANDLER FIRST, POST with the cache on the loser: the new lot ends up with the cache on the winner', { timeout: 90000 }, async () => {
    const g = await pair('f14b')
    const { high, writeR, mergeR } = await handlerFirst(g, (h) => postLot({ source_plant_ids: [g.L, h], source_plant_id: g.L }))
    expect(writeR.status, `POST -> ${JSON.stringify(writeR.body)}`).toBe(201)
    expect(writeR.body.source_plant_id).toBe(g.L) // what the create wrote, before the merge moved it
    expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
    const lot = writeR.body.id
    expect(await livePlants(lot)).toEqual([g.W, high].sort())
    // This is the case the source_plant_id repoint had to move behind the planting lock for.
    expect((await lotRow(lot)).source_plant_id).toBe(g.W)
    expect(await onLoser(g)).toBe(0)
    expect(await onWinnersPage(g)).toEqual([lot])
    await expectCacheRule(lot)
    // Known limit: the merge moved a link AND rewrote this lot's cache; its snapshot has neither.
    expect(await whatTheSnapshotHoldsOfSeedLots(mergeR)).toEqual(NOTHING_OF_WHAT_THE_MERGE_DID)
  })

  it('HANDLER FIRST, PUT adding BOTH the loser and the winner: the loser\'s new link is retired, the winner\'s stays, no collision', { timeout: 90000 }, async () => {
    const g = await pair('f14c')
    const lot = await newLot()
    const { high, writeR, mergeR } = await handlerFirst(g, (h) => put(lot, [g.L, g.W, h]))
    expect(writeR.status, `PUT -> ${JSON.stringify(writeR.body)}`).toBe(200)
    // This is the case the prune had to move behind the planting lock for: run earlier, it would not
    // have seen the loser's link, and the repoint would have met the winner's on the unique key.
    expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
    const rows = await links(lot)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.plant_id === g.W || r.plant_id === high)).toBe(true)
    expect(liveSeed(rows).map((r) => r.plant_id).sort()).toEqual([g.W, high].sort())
    expect(rows.filter((r) => r.plant_id === g.W && r.deleted_at != null)).toHaveLength(1)
    expect(await onWinnersPage(g)).toEqual([lot])
    await expectCacheRule(lot)
    // Known limit: the merge RETIRED a link here; `seed_lot_parents_pruned` does not name it.
    expect(await whatTheSnapshotHoldsOfSeedLots(mergeR)).toEqual(NOTHING_OF_WHAT_THE_MERGE_DID)
  })

  it('MERGE FIRST, PUT: the write waits at its share lock, then answers 409, and its lot is untouched', { timeout: 90000 }, async () => {
    const g = await pair('f14d')
    const inSet = await newLot({ source_plant_ids: [g.L] }) // a lot the merge does lock; the merge is stopped on its link
    const lot = await newLot({ source_plant_ids: [P.A] }) // outside the merge's lot locks
    const before = { row: await lotRow(lot), links: await links(lot) }
    const stopped = await mergeStoppedAtItsLinks(g, inSet)
    try {
      const putting = onOwnConnection(() => put(lot, [P.A, g.L])) // its gate passes: the loser is live to every reader
      await waitBlockedBy(stopped.mergePid, 'the PUT, at its planting locks')
      await stopped.release()
      const [mergeR, putR] = await Promise.all([stopped.merging, putting])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(409)
      expect(putR.body).toEqual({ error: PLANTS_CHANGED })
      expect({ row: await lotRow(lot), links: await links(lot) }).toEqual(before)
      expect(await livePlants(inSet)).toEqual([g.W])
      expect(await onLoser(g)).toBe(0)
      await expectCacheRule(lot, inSet)
    } finally {
      await stopped.blocker.end()
    }
  })

  it('MERGE FIRST, POST: 409, and no lot is created', { timeout: 90000 }, async () => {
    const g = await pair('f14e')
    const inSet = await newLot({ source_plant_ids: [g.L] })
    const countLots = async () => (await directSql`
      SELECT count(*)::int AS n FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN})`)[0].n
    const lotsBefore = await countLots()
    const stopped = await mergeStoppedAtItsLinks(g, inSet)
    try {
      const posting = onOwnConnection(() => postLot({ source_plant_ids: [g.L] }))
      await waitBlockedBy(stopped.mergePid, 'the POST, at its planting locks')
      await stopped.release()
      const [mergeR, postR] = await Promise.all([stopped.merging, posting])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(postR.status, `POST -> ${JSON.stringify(postR.body)}`).toBe(409)
      expect(postR.body).toEqual({ error: PLANTS_CHANGED })
      expect(await countLots()).toBe(lotsBefore)
      expect(await onLoser(g)).toBe(0)
      await expectCacheRule(inSet)
    } finally {
      await stopped.blocker.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// D-3 — the merge against a photo delete: still a deadlock, now answered
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — D-3: the merge against a photo delete (opposite orders on a photo row and a lot row)', () => {
  // softDeletePhoto takes the PHOTO row and later the rows that feature it, seed lots among them. The
  // merge takes its LOTS first and the losers' photos later. A photo of the loser that is also the
  // featured photo of a lot in the merge's set is therefore held from both ends. Taking lots first is
  // what closed D-1, and the order was kept; a deadlocked merge now answers 409 and says it can be run
  // again. Both outcomes are driven here, one victim each.
  beforeAll(async () => {
    deadlockCheckMs = (await directSql`
      SELECT (extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000)::int AS ms`)[0].ms
  })

  async function jarWithTheLosersPhoto(g) {
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const [photo] = await directSql`
      INSERT INTO photos (plant_id, inventory_item_id, storage_path, created_by)
      VALUES (${g.L}, ${lot}, ${`plants/${g.L}/slp-d3-${RUN}.jpg`}, ${USER}) RETURNING id`
    await directSql`UPDATE inventory_items SET featured_photo_id = ${photo.id} WHERE id = ${lot}`
    return { lot, photo: photo.id }
  }
  // Everything of the group a merge writes: both plantings, the lot's cache, every link row.
  const groupState = async (g, lot) => ({
    plantings: await directSql`
      SELECT id, name, status, quantity, version, updated_at::text AS updated_at, deleted_at::text AS deleted_at
        FROM plants WHERE id IN (${g.W}, ${g.L}) ORDER BY id`,
    cache: (await lotRow(lot)).source_plant_id,
    links: await links(lot),
  })

  it('the MERGE is the victim: 409 "nothing was merged, run it again", nothing of the group changed, and the same op_id then merges', { timeout: 120000 }, async () => {
    const g = await pair('d3a')
    const { lot, photo } = await jarWithTheLosersPhoto(g)
    const before = await groupState(g, lot)
    const opId = randomUUID()
    // Held at a hard prune: BEFORE its photos repoint, with its lots already locked.
    const stopped = await mergeStoppedAtAHardPrune(g, opId)
    const { blocker, merging, mergePid } = stopped
    try {
      const deleting = deletePhoto(photo) // takes the photo row, then waits for the lot the merge holds
      await waitBlockedBy(mergePid, 'the photo delete, at the lot row')
      await pastItsDeadlockCheck() // the photo delete's own check runs and finds nothing
      await blocker.end('COMMIT;') // the merge goes on to its photos repoint: that wait closes the cycle

      const [mergeR, del] = await Promise.all([merging, deleting])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(409)
      expect(mergeR.body.error).toBe(MERGE_RETRY)
      expect(JSON.stringify(mergeR.body)).not.toMatch(/Process \d+|ShareLock|transaction \d+/) // Postgres's detail stays out
      expect(del).toEqual({ answered: 200 })

      // Rolled back WHOLE: both plantings, the lot's cache and every link row are byte for byte as they
      // were before the merge was sent, and it left no merge_event.
      expect(await groupState(g, lot)).toEqual(before)
      expect((await directSql`SELECT count(*)::int AS n FROM merge_event WHERE op_id = ${opId}`)[0].n).toBe(0)
      await expectCacheRule(lot)

      // "Run it again": the same op_id is a first attempt, not a replay, and it merges.
      const again = await merge(g.W, [g.L], opId)
      expect(again.status, `merge again -> ${JSON.stringify(again.body)}`).toBe(200)
      expect(again.body.replayed).toBeUndefined()
      expect(await livePlants(lot)).toEqual([g.W])
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
    }
  })

  it('the PHOTO DELETE is the victim: the merge completes with 200', { timeout: 120000 }, async () => {
    const g = await pair('d3b')
    const { lot, photo } = await jarWithTheLosersPhoto(g)
    // A third planting features the same photo: photo delete clears planting pointers before lot
    // pointers, so a lock on that planting holds it between the photo row and the lot row.
    const featuring = await planting('KQ')
    await directSql`UPDATE plants SET featured_photo_id = ${photo} WHERE id = ${featuring}`
    const blocker = openSession('holds the planting that features the photo')
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM plants WHERE id = ${lit(featuring)} FOR UPDATE;`)
      const deleting = deletePhoto(photo)
      const deletePid = await waitBlockedBy(blockerPid, 'the photo delete, photo held, at a planting pointer')
      const merging = onOwnConnection(() => merge(g.W, [g.L]))
      await waitBlockedBy(deletePid, 'the merge, lots held, at its photos repoint')
      await pastItsDeadlockCheck() // the merge's own check runs and finds nothing
      await blocker.end('COMMIT;') // the photo delete goes on to the lot row: that wait closes the cycle

      const [del, mergeR] = await Promise.all([deleting, merging])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(await livePlants(lot)).toEqual([g.W])
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      expect(await onLoser(g)).toBe(0)
      await expectCacheRule(lot)
      // What the photo delete itself answers is lambda/photos' business and is NOT held still here.
      // OBSERVED on Neon 2026-10-05: softDeletePhoto rejects with 40P01, which lambda/photos/index.js
      // does not map — its route answers 500, with the photo not deleted. Open, and outside this file's
      // two Lambdas; the assertion only says it was one of the two things it can be.
      expect([{ answered: 200 }, { threw: '40P01' }]).toContainEqual(del)
    } finally {
      await blocker.end()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Why the merge takes its plantings LATE — the writers that take another row first and a planting second
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE || !HAS_PSQL)('concurrency — the merge holds no planting until late in its cutover', () => {
  // A photo delete takes the photo row and THEN the planting that features it. A batch event takes the
  // planting's entity_memory row and THEN the planting. An event delete takes the event row and THEN
  // (for a loss event) the planting whose count it restores. The merge takes photos, event rows and
  // entity_memory first and its plantings after them — the same order — so each of these queues behind
  // it or goes ahead of it, and none can cross it. Had the merge's planting lock been placed straight
  // behind its lot lock (the first proposal), each would be an opposite-order pair and a 40P01; a run of
  // this block against that placement leaves the "goes straight through" cases waiting.
  //
  // Each writer is driven both ways:
  //   · the merge stopped EARLY (lots held, no repoint run): it holds no planting, so the writer must go
  //     STRAIGHT THROUGH, writing the loser's planting row under the stopped merge;
  //   · the merge stopped LATE (plantings held, the other surfaces already repointed): the writer WAITS
  //     behind it, and when the merge commits both complete. No 40P01 either way.
  const withoutWaiting = (promise) => Promise.race([promise, sleep(20000).then(() => 'STILL WAITING after 20 s')])
  const eventsCall = (method, path, body = null) => {
    setTestUserId(USER)
    return callHandler(eventsHandler, { method, path, body })
  }
  async function heroPhotoOf(g) {
    const [photo] = await directSql`
      INSERT INTO photos (plant_id, storage_path, created_by)
      VALUES (${g.L}, ${`plants/${g.L}/slp-hero-${RUN}.jpg`}, ${USER}) RETURNING id`
    await directSql`UPDATE plants SET featured_photo_id = ${photo.id} WHERE id = ${g.L}`
    return photo.id
  }
  const germinate = (g, key) => eventsCall('POST', '/api/events/batch', {
    idempotency_key: `slp-${key}-${RUN}`, event_type: 'germination', event_date: '2026-08-15',
    scope: { type: 'ids', plant_ids: [g.L] },
  })
  // One plant of five lost to a pest, logged through the events route: quantity 5 -> 4, qty_lost 0 -> 1.
  async function lossEventOn(g) {
    await directSql`UPDATE plants SET quantity = 5 WHERE id = ${g.L}`
    const r = await eventsCall('POST', '/api/events', {
      plant_id: g.L, event_type: 'reduction_lost', event_date: '2026-08-10T16:00:00.000Z',
      metadata: { qty_reduced: 1, loss_reason: 'pest' },
    })
    expect(r.status, `loss event -> ${JSON.stringify(r.body)}`).toBe(201)
    const [after] = await directSql`SELECT quantity::int AS quantity, qty_lost::int AS qty_lost FROM plants WHERE id = ${g.L}`
    expect(after).toEqual({ quantity: 4, qty_lost: 1 })
    return r.body.id ?? r.body.eventId
  }
  const mergedCleanly = async (stopped, g, lot) => {
    const r = await stopped.merging
    expect(r.status, `merge -> ${JSON.stringify(r.body)}`).toBe(200)
    expect(await livePlants(lot)).toEqual([g.W])
    await expectCacheRule(lot)
  }

  describe('the merge stopped EARLY: each writer goes straight through', () => {
    it('a photo delete of the loser\'s hero photo', { timeout: 120000 }, async () => {
      const g = await pair('early1')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const photo = await heroPhotoOf(g)
      const stopped = await mergeStoppedAtAHardPrune(g)
      try {
        expect(await withoutWaiting(deletePhoto(photo))).toEqual({ answered: 200 })
        const [hero] = await directSql`SELECT featured_photo_id FROM plants WHERE id = ${g.L}`
        expect(hero.featured_photo_id).toBeNull() // it wrote the loser's planting row under the stopped merge
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
      } finally {
        await stopped.blocker.end()
      }
    })

    it('a batch event that stamps the loser (germination)', { timeout: 120000 }, async () => {
      const g = await pair('early2')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const stopped = await mergeStoppedAtAHardPrune(g)
      try {
        const batch = await withoutWaiting(onOwnConnection(() => germinate(g, 'early2')))
        expect(batch.status, `batch -> ${JSON.stringify(batch.body)}`).toBeLessThan(300)
        const [stamped] = await directSql`SELECT germinated_at IS NOT NULL AS done FROM plants WHERE id = ${g.L}`
        expect(stamped.done).toBe(true) // it wrote the loser's planting row under the stopped merge
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
      } finally {
        await stopped.blocker.end()
      }
    })

    it('a delete of a loss event on the loser, which gives the planting its plant back', { timeout: 120000 }, async () => {
      const g = await pair('early3')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const eventId = await lossEventOn(g)
      const stopped = await mergeStoppedAtAHardPrune(g)
      try {
        const del = await withoutWaiting(onOwnConnection(() => eventsCall('DELETE', `/api/events/${eventId}`)))
        expect(del.status, `event delete -> ${JSON.stringify(del.body)}`).toBeLessThan(300)
        const [restored] = await directSql`SELECT quantity::int AS quantity, qty_lost::int AS qty_lost FROM plants WHERE id = ${g.L}`
        expect(restored).toEqual({ quantity: 5, qty_lost: 0 }) // it wrote the loser's planting row under the stopped merge
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
      } finally {
        await stopped.blocker.end()
      }
    })
  })

  describe('the merge stopped LATE: each writer waits behind it, then both complete', () => {
    it('a photo delete of the loser\'s hero photo', { timeout: 120000 }, async () => {
      const g = await pair('late1')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const photo = await heroPhotoOf(g)
      const stopped = await mergeStoppedAtItsLinks(g, lot)
      try {
        const deleting = deletePhoto(photo)
        await waitBlockedBy(stopped.mergePid, 'the photo delete, at the photo row the merge has moved')
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
        expect(await deleting).toEqual({ answered: 200 })
        const [ph] = await directSql`SELECT deleted_at IS NOT NULL AS deleted FROM photos WHERE id = ${photo}`
        expect(ph.deleted).toBe(true)
      } finally {
        await stopped.blocker.end()
      }
    })

    it('a batch event that stamps the loser (germination)', { timeout: 120000 }, async () => {
      const g = await pair('late2')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const stopped = await mergeStoppedAtItsLinks(g, lot)
      try {
        const batching = onOwnConnection(() => germinate(g, 'late2'))
        await waitBlockedBy(stopped.mergePid, 'the batch event, at the loser\'s planting row')
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
        const batch = await batching
        expect(batch.status, `batch -> ${JSON.stringify(batch.body)}`).toBeLessThan(300)
      } finally {
        await stopped.blocker.end()
      }
    })

    it('a delete of a loss event on the loser', { timeout: 120000 }, async () => {
      const g = await pair('late3')
      const lot = await newLot({ source_plant_ids: [g.L] })
      const eventId = await lossEventOn(g)
      const stopped = await mergeStoppedAtItsLinks(g, lot)
      try {
        const deleting = onOwnConnection(() => eventsCall('DELETE', `/api/events/${eventId}`))
        await waitBlockedBy(stopped.mergePid, 'the event delete, at the event row the merge has moved')
        await stopped.release()
        await mergedCleanly(stopped, g, lot)
        const del = await deleting
        expect(del.status, `event delete -> ${JSON.stringify(del.body)}`).toBeLessThan(300)
        const [ev] = await directSql`SELECT deleted_at IS NOT NULL AS deleted FROM event_log WHERE id = ${eventId}`
        expect(ev.deleted).toBe(true)
      } finally {
        await stopped.blocker.end()
      }
    })
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The whole file, read back once: nothing a route wrote here broke the rule
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_TABLE)('at the end of the file', () => {
  it('every lot this file created obeys the member-cache rule (both gates-rowlevel queries, unarmed, return nothing)', async () => {
    const lots = (await directSql`
      SELECT id FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN})`).map((r) => r.id)
    expect(lots.length).toBeGreaterThan(0)
    await expectCacheRule(...lots)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 0b-reconcile.sql against a parents edit on the same lot. OFF BY DEFAULT — see the header: the reconcile
// locks the table and rewrites every drifted lot in the database, so it may only run with this file
// alone. INT_SEED_PARENTS_RECONCILE=1 turns it on.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const RUN_RECONCILE = process.env.INT_SEED_PARENTS_RECONCILE === '1'

function reconcile() {
  const child = spawn('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', RECONCILE_SQL], { env: pgEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise((res) => { child.on('close', (code) => res({ code, out, err: err.trim() })) })
  return { done, kill: () => child.kill('SIGKILL') }
}

describe.skipIf(!HAS_TABLE || !HAS_PSQL || !RUN_RECONCILE)('0b-reconcile.sql against a parents edit and against a merge — both complete, neither aborted', () => {
  // A lot the reconcile WILL write for: the column names A and there is no link row (R2 inserts one).
  async function driftedLot(a) {
    const lot = await sqlLot({ sourcePlant: a })
    expect((await cacheRuleViolations([lot])).cacheIsNotALiveParent).toEqual([lot])
    return lot
  }

  it('the PUT is in flight (lot row held) when the reconcile starts: the reconcile waits for the lot, then both commit', { timeout: 120000 }, async () => {
    const a = await planting('RA')
    const b = await planting('RB')
    const lot = await driftedLot(a)
    const blocker = openSession('holds the link table')
    let rec
    try {
      const blockerPid = await blocker.pid()
      // The PUT locks the lot (statement 0), share-locks its plantings (1) and then reads the link table
      // (2). An ACCESS EXCLUSIVE lock on that table stops it exactly there: lot row held, no table lock
      // of its own yet. With the reconcile's locks the other way round, this is the interleaving that
      // deadlocks.
      await blocker.run('BEGIN; LOCK TABLE seed_lot_parent_planting IN ACCESS EXCLUSIVE MODE;')
      const putting = onOwnConnection(() => put(lot, [a, b]))
      const putPid = await waitBlockedBy(blockerPid, 'the PUT, at its first read of the link table')
      rec = reconcile()
      await waitBlockedBy(putPid, 'the reconcile, at its lot locks')
      await blocker.end('COMMIT;')

      const [putR, recR] = await Promise.all([putting, rec.done])
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(200)
      expect(recR.code, `0b-reconcile.sql -> ${recR.err}`).toBe(0)
      expect(recR.err).not.toMatch(/deadlock|lock timeout/i)
      expect(recR.out).toMatch(/COMMIT/)
      expect(await livePlants(lot)).toEqual([a, b].sort())
      expect((await lotRow(lot)).source_plant_id).toBe(a)
      await expectCacheRule(lot)
    } finally {
      await blocker.end()
      rec?.kill()
    }
  })

  it('the reconcile is in flight (both its locks held) when the PUT arrives: the PUT waits, then both commit', { timeout: 120000 }, async () => {
    const a = await planting('RC')
    const b = await planting('RD')
    const lot = await driftedLot(a)
    // A second lot the reconcile must retire a row on (column NULL, one live row): R1's UPDATE of that
    // row is where the reconcile is held, after it has taken its lot locks and its table lock.
    const stuck = await sqlLot()
    const stuckRow = await sqlLink(stuck, a)
    const blocker = openSession('holds a row R1 will retire')
    let rec
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM seed_lot_parent_planting WHERE id = ${lit(stuckRow)} FOR UPDATE;`)
      rec = reconcile()
      const recPid = await waitBlockedBy(blockerPid, 'the reconcile, at R1')
      const putting = onOwnConnection(() => put(lot, [a, b]))
      await waitBlockedBy(recPid, 'the PUT, at the lot lock')
      await blocker.end('COMMIT;')

      const [recR, putR] = await Promise.all([rec.done, putting])
      expect(recR.code, `0b-reconcile.sql -> ${recR.err}`).toBe(0)
      expect(recR.err).not.toMatch(/deadlock|lock timeout/i)
      expect(putR.status, `PUT -> ${JSON.stringify(putR.body)}`).toBe(200)
      // The reconcile wrote the drifted lot's one row (R2) and retired the other lot's (R1); the PUT then
      // added B beside it.
      expect(await livePlants(lot)).toEqual([a, b].sort())
      expect((await lotRow(lot)).source_plant_id).toBe(a)
      expect(await livePlants(stuck)).toEqual([])
      await expectCacheRule(lot, stuck)
    } finally {
      await blocker.end()
      rec?.kill()
    }
  })

  it('the reconcile is in flight when a MERGE starts on one of its lots: the merge takes the lot, waits at the table, then both commit', { timeout: 120000 }, async () => {
    const g = await pair('rm1')
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const a = await planting('RG')
    const stuck = await sqlLot()
    const stuckRow = await sqlLink(stuck, a)
    const blocker = openSession('holds a row R1 will retire')
    let rec
    try {
      const blockerPid = await blocker.pid()
      await blocker.run(`BEGIN; SELECT id FROM seed_lot_parent_planting WHERE id = ${lit(stuckRow)} FOR UPDATE;`)
      rec = reconcile()
      const recPid = await waitBlockedBy(blockerPid, 'the reconcile, at R1')
      const merging = onOwnConnection(() => merge(g.W, [g.L]))
      await waitBlockedBy(recPid, 'the merge, at its first link write')
      await blocker.end('COMMIT;')
      const [recR, mergeR] = await Promise.all([rec.done, merging])
      expect(recR.code, `0b-reconcile.sql -> ${recR.err}`).toBe(0)
      expect(recR.err).not.toMatch(/deadlock|lock timeout/i)
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(await livePlants(lot)).toEqual([g.W])
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      await expectCacheRule(lot, stuck)
    } finally {
      await blocker.end()
      rec?.kill()
    }
  })

  it('a MERGE is in flight when the reconcile starts: the reconcile takes its lot locks, waits at the table, then both commit', { timeout: 120000 }, async () => {
    // The merge is stopped LATE, at a parent link: only from its planting locks on has it taken the link
    // table for writing, which is the lock the reconcile's table lock has to wait for.
    const g = await pair('rm2')
    const lot = await newLot({ source_plant_ids: [g.W, g.L], source_plant_id: g.L })
    const stopped = await mergeStoppedAtItsLinks(g, lot)
    let rec
    try {
      rec = reconcile()
      await waitBlockedBy(stopped.mergePid, 'the reconcile, at its table lock')
      await stopped.release()
      const [mergeR, recR] = await Promise.all([stopped.merging, rec.done])
      expect(mergeR.status, `merge -> ${JSON.stringify(mergeR.body)}`).toBe(200)
      expect(recR.code, `0b-reconcile.sql -> ${recR.err}`).toBe(0)
      expect(recR.err).not.toMatch(/deadlock|lock timeout/i)
      expect(await livePlants(lot)).toEqual([g.W])
      expect((await lotRow(lot)).source_plant_id).toBe(g.W)
      await expectCacheRule(lot)
    } finally {
      await stopped.blocker.end()
      rec?.kill()
    }
  })

  it('five unsteered rounds, the PUT and the reconcile started together: every one completes', { timeout: 180000 }, async () => {
    const a = await planting('RE')
    const b = await planting('RF')
    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const lot = await driftedLot(a)
      const rec = reconcile()
      // eslint-disable-next-line no-await-in-loop
      const [putR, recR] = await Promise.all([onOwnConnection(() => put(lot, [a, b])), rec.done])
      expect(putR.status, `round ${round} PUT -> ${JSON.stringify(putR.body)}`).toBe(200)
      expect(recR.code, `round ${round} 0b-reconcile.sql -> ${recR.err}`).toBe(0)
      // eslint-disable-next-line no-await-in-loop
      expect(await livePlants(lot)).toEqual([a, b].sort())
      // eslint-disable-next-line no-await-in-loop
      await expectCacheRule(lot)
    }
  })
})
