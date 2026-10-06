// variety-blend.int.test.js — V5-VARIETYBLEND-001 on a real Postgres: POST /api/varieties/blend, the
// route that finds or creates the ONE variety row standing for "seed saved from these varieties together".
//
// WHY THIS FILE EXISTS. lambda/varieties/blend-route.test.js runs the handler against an in-memory
// table: it proves which statements are issued and what the JavaScript decides. Its own report
// (lane-V-report.log, "NOT PROVEN") lists what that cannot show, and each item is a case here:
//   · the INSERT through the auto-updatable view public.cultivar, naming id + variety_rank + blend_key;
//   · the component INSERT (INSERT .. SELECT .. FROM unnest($1::uuid[]));
//   · `ORDER BY (deleted_at IS NOT NULL), created_at, id` — live first, then oldest;
//   · that err.constraint carries the INDEX name for both bare unique indexes (no pg_constraint row);
//   · that the key built in JavaScript is the string Postgres builds with
//     string_agg(u::text, ',' ORDER BY u) — uuid order against code-unit order;
//   · the find-then-write race, both endings, which no stub can stage.
// And the four ROW-LEVEL gates of migrations/v5-varietyblend-001/gates.yml — the whole relation between
// a mix row and its component rows — are evaluated HERE, after this route has created, revived and
// renamed mixes: the migration lane proved them against hand-made rows, not against this writer.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK (L-108). "Writes nothing" is footprint() before
// === footprint() after: every row this file's users own in the three tables the route writes, plus
// their rate-limit buckets and their audit rows.
//
// THE REAL GATE RUNNER, off by default. The last block can also hand the file to
// scripts/gate_runner.py itself. That needs python3 with psycopg and PyYAML, which the integration
// job does not install, so it runs only when asked:
//   INT_BLEND_GATE_RUNNER=1 npx vitest run --config vitest.integration.config.ts \
//     tests/integration/variety-blend.int.test.js
// The in-file evaluation of the same gates is always on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import {
  seedVarietyFixture, seedMixTeardown, twoSessions, HAS_PSQL, lit,
} from './_seedLotKit.js'
import { handler } from '../../lambda/varieties/index.js'
import {
  blendKey, BLEND_ERRORS, BLEND_PROFILE, RESTORE_CONFLICT_MESSAGES,
} from '../../lambda/varieties/blend.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATES_FILE = join(ROOT, 'migrations', 'v5-varietyblend-001', 'gates.yml')
const CADENCE_GATES_FILE = join(ROOT, 'migrations', 'v4-cadencerefill-001', 'gates.yml')
const REKEY_GATES_FILE = join(ROOT, 'migrations', 'v5-rekeystrand-001', 'gates.yml')
const RUN_GATE_RUNNER = process.env.INT_BLEND_GATE_RUNNER === '1'

const RUN = testRunId()
const USER = `vb-user-${RUN}`
const MATE = `vb-mate-${RUN}`          // same household as USER, in the blocks that say so
const FOREIGN = `vb-foreign-${RUN}`    // never in USER's household

// The route names the key column and the component table in SQL. One failure that says what to apply.
const [present] = await directSql`
  SELECT to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'plant_varieties' AND column_name = 'blend_key') AS blend_key,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cultivar' AND column_name = 'blend_key') AS view_key`
const MISSING = [
  !present.blend_key && 'plant_varieties.blend_key',
  !present.view_key && 'cultivar.blend_key (the view)',
  !present.components && 'public.variety_blend_component',
].filter(Boolean)
const READY = MISSING.length === 0

describe('variety blend — the schema is on this branch', () => {
  it('plant_varieties.blend_key, the cultivar view\'s blend_key and variety_blend_component exist (apply migrations/v5-varietyblend-001/0a-additive-ddl.sql before the code that names them)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
let savedHousehold

function blend(ids, { create = true, as = USER } = {}) {
  setTestUserId(as)
  return callHandler(handler, {
    method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: ids, create },
  })
}
const call = (method, path, body, as = USER) => {
  setTestUserId(as)
  return callHandler(handler, { method, path, body })
}

// A fresh leaf variety, so each case owns the set it mixes and no case meets another's mix.
async function leaf(tag, { by = USER, crop = fx.crops.a, name, ...facts } = {}) {
  const [row] = await directSql`
    INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank, species, genus, lifecycle,
                                 scoville_min, scoville_max)
    VALUES (${name ?? `vb-${tag}-${RUN}-${seq++}`}, ${by}, ${crop}, 'cultivar', ${facts.species ?? null},
            ${facts.genus ?? null}, ${facts.lifecycle ?? null}, ${facts.scoville_min ?? null}, ${facts.scoville_max ?? null})
    RETURNING id, name`
  return row
}
const sorted = (...ids) => [...ids].sort()
const keyOf = (...ids) => sorted(...ids).join(',')

const varietyRow = async (id) => (await directSql`
  SELECT id, name, created_by, variety_rank, blend_key, crop_type_slug, species, genus, lifecycle,
         scoville_min, scoville_max, scoville_source, breeding_system, breeding_source, breeding_confidence,
         days_to_maturity_min, care_notes, source_url, photo_id, origin_country, growth_habit,
         deleted_at::text AS deleted_at
    FROM plant_varieties WHERE id = ${id}`)[0]
const components = (id) => directSql`
  SELECT component_variety_id, created_by, deleted_at::text AS deleted_at
    FROM variety_blend_component WHERE blend_variety_id = ${id} ORDER BY component_variety_id`

// Everything the route could write for this file's three users.
async function footprint() {
  const who = [USER, MATE, FOREIGN]
  const varieties = await directSql`
    SELECT id, name, blend_key, variety_rank, updated_at::text AS updated_at, deleted_at::text AS deleted_at
      FROM plant_varieties WHERE created_by = ANY(${who}) ORDER BY id`
  const parts = await directSql`
    SELECT id, blend_variety_id, component_variety_id, deleted_at::text AS deleted_at
      FROM variety_blend_component
     WHERE created_by = ANY(${who})
        OR blend_variety_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${who}))
     ORDER BY id`
  const profiles = await directSql`
    SELECT scope_id, profile::text AS profile FROM care_profile
     WHERE scope = 'cultivar' AND scope_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${who}))
     ORDER BY scope_id`
  const buckets = await directSql`
    SELECT actor_clerk_sub, bucket_key, window_start::text AS window_start, count
      FROM rate_limit_buckets WHERE actor_clerk_sub = ANY(${who}) ORDER BY 1, 2, 3`
  const audit = await directSql`SELECT count(*)::int AS n FROM audit_events WHERE actor_clerk_sub = ANY(${who})`
  return JSON.stringify({ varieties, parts, profiles, buckets, audit: audit[0].n })
}

// A mix row made BY HAND with its component rows, in one transaction, for the states the route cannot
// be asked to produce (a rival's uncommitted row is made in psql instead). Kept consistent with the
// row-level gates: rank 'blend', one live component per leaf.
async function handMix({ id = randomUUID(), name, by = USER, leafIds, crop = fx.crops.a }) {
  await directSql.transaction([
    directSql`
      INSERT INTO plant_varieties (id, name, created_by, variety_rank, blend_key, crop_type_slug)
      VALUES (${id}::uuid, ${name}, ${by}, 'blend', ${keyOf(...leafIds)}, ${crop})`,
    directSql`
      INSERT INTO variety_blend_component (blend_variety_id, component_variety_id, created_by)
      SELECT ${id}::uuid, u, ${by}::text FROM unnest(${leafIds}::uuid[]) AS u`,
  ])
  return id
}

// psql has no parameters on stdin; a text value reaches it only through this.
const q = (text) => {
  if (!/^[A-Za-z0-9 _+().,-]+$/.test(String(text))) throw new Error(`refusing to put "${text}" into SQL text`)
  return `'${text}'`
}

const { openSession, onOwnConnection, waitBlockedBy, closeAll } = twoSessions()

beforeAll(async () => {
  if (!READY) return
  savedHousehold = process.env.GARDEN_HOUSEHOLD_IDS
  delete process.env.GARDEN_HOUSEHOLD_IDS
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'vb' })
}, 60000)

afterAll(async () => {
  closeAll()
  if (savedHousehold === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
  else process.env.GARDEN_HOUSEHOLD_IDS = savedHousehold
  if (!READY) return
  const ids = assertFixtureId(USER, MATE, FOREIGN)
  await settle(`variety-blend teardown ${RUN}`, seedMixTeardown(ids, fx?.crops))
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Find or create
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('POST /api/varieties/blend — find or create', () => {
  let pairId
  const pair = () => [fx.v.a1, fx.v.a2]
  const autoName = () => `${fx.names.a1} + ${fx.names.a2} mix`

  it('create:false on a set nobody has mixed: 200 with id null and the automatic name, and NOTHING is written — no row, no component, no profile, no rate-limit draw, no audit row', async () => {
    const before = await footprint()
    const r = await blend(pair(), { create: false })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      id: null,
      name: autoName(),
      variety_rank: 'blend',
      crop_type_slug: fx.crops.a,
      blend_key: keyOf(fx.v.a1, fx.v.a2),
      exists: false,
      created: false,
      components: [
        { id: fx.v.a1, name: fx.names.a1, variety_rank: 'cultivar', deleted: false },
        { id: fx.v.a2, name: fx.names.a2, variety_rank: 'cultivar', deleted: false },
      ],
    })
    expect(await footprint()).toBe(before)
  })

  it('create:true: 201 created:true — the row went in THROUGH the cultivar view with its id, rank and key; one live component row per leaf; the mix\'s own care_profile row', async () => {
    const r = await blend(pair())
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body).toMatchObject({
      name: autoName(), variety_rank: 'blend', crop_type_slug: fx.crops.a,
      blend_key: keyOf(fx.v.a1, fx.v.a2), exists: true, created: true,
    })
    expect(r.body.components.map((c) => c.id)).toEqual([fx.v.a1, fx.v.a2])
    pairId = r.body.id

    const row = await varietyRow(pairId)
    expect(row).toMatchObject({
      name: autoName(), created_by: USER, variety_rank: 'blend', blend_key: keyOf(fx.v.a1, fx.v.a2),
      crop_type_slug: fx.crops.a, deleted_at: null,
      // A mix has no breeding system, and copying one parent's fact onto several would be a claim nobody made.
      breeding_system: null, breeding_source: null, breeding_confidence: null,
      days_to_maturity_min: null, care_notes: null, source_url: null, photo_id: null, origin_country: null, growth_habit: null,
    })
    expect(await components(pairId)).toEqual(sorted(fx.v.a1, fx.v.a2).map((id) => (
      { component_variety_id: id, created_by: USER, deleted_at: null })))
    const profile = await directSql`
      SELECT profile, model_version FROM care_profile WHERE scope = 'cultivar' AND scope_id = ${pairId}`
    expect(profile).toHaveLength(1)
    expect(profile[0].profile).toEqual(BLEND_PROFILE)
    // The row satisfies the open-pollinated CHECK as born, and can never be MARKED open-pollinated.
    await expect(directSql.transaction([
      directSql`SELECT set_config('app.actor_clerk_sub', ${USER}, true)`,
      directSql`UPDATE plant_varieties SET breeding_system = 'open_pollinated', breeding_source = 'grower_record' WHERE id = ${pairId}`,
    ])).rejects.toMatchObject({ code: '23514', constraint: 'chk_plant_varieties_op_requires_cultivar' })
  })

  it('the same set in any order, in capitals, with a repeat: 200 created:false and the SAME id; nothing written and no rate-limit draw', async () => {
    const before = await footprint()
    for (const ids of [[fx.v.a2, fx.v.a1], [fx.v.a1.toUpperCase(), fx.v.a2.toUpperCase()], [fx.v.a2, fx.v.a1, fx.v.a2]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await blend(ids)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.id).toBe(pairId)
      expect(r.body).toMatchObject({ exists: true, created: false, blend_key: keyOf(fx.v.a1, fx.v.a2) })
    }
    // The preview of a set that exists answers the row.
    const preview = await blend(pair(), { create: false })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ id: pairId, exists: true, created: false, name: autoName() })
    expect(await footprint()).toBe(before)
    expect((await directSql`
      SELECT count(*)::int AS n FROM plant_varieties WHERE blend_key = ${keyOf(fx.v.a1, fx.v.a2)}`)[0].n).toBe(1)
  })

  it('the REQUIRED reply keys are all there on a hit, and the row\'s own columns ride along', async () => {
    const r = await blend(pair())
    for (const key of ['id', 'name', 'variety_rank', 'crop_type_slug', 'blend_key', 'exists', 'created', 'components']) {
      expect(r.body, key).toHaveProperty(key)
    }
    for (const c of r.body.components) expect(Object.keys(c).sort()).toEqual(['deleted', 'id', 'name', 'variety_rank'])
    expect(r.body.created_by).toBe(USER)
  })

  it('the key built in JavaScript is the key Postgres builds: string_agg(u::text, \',\' ORDER BY u) over the same ids, unsorted and in capitals', async () => {
    const ids = [fx.v.a2.toUpperCase(), fx.v.a1.toUpperCase()]
    const [sqlKey] = await directSql`
      SELECT (SELECT string_agg(u::text, ',' ORDER BY u) FROM unnest(${ids}::uuid[]) u) AS key`
    expect(sqlKey.key).toBe(blendKey(ids))
    expect(sqlKey.key).toBe((await varietyRow(pairId)).blend_key)
    // uuid ORDER is byte order; JavaScript sorts lower-case hex by code unit. Twelve random ids (the
    // most a mix may hold), forty times: the two orders never part.
    for (let i = 0; i < 40; i += 1) {
      const many = Array.from({ length: 12 }, () => randomUUID())
      // eslint-disable-next-line no-await-in-loop
      const [got] = await directSql`
        SELECT (SELECT string_agg(u::text, ',' ORDER BY u) FROM unnest(${many}::uuid[]) u) AS key`
      expect(got.key).toBe(blendKey(many))
    }
  })

  it('the projections: variety_rank and blend_key are on GET /:id, on the list, and on the PUT reply', async () => {
    const detail = await call('GET', `/api/varieties/${pairId}`)
    expect(detail.status, JSON.stringify(detail.body)).toBe(200)
    expect(detail.body).toMatchObject({ id: pairId, variety_rank: 'blend', blend_key: keyOf(fx.v.a1, fx.v.a2) })
    const list = await call('GET', `/api/varieties?q=${encodeURIComponent(fx.names.a1)}`)
    expect(list.status).toBe(200)
    const rows = Array.isArray(list.body) ? list.body : list.body.varieties
    expect(rows.find((v) => v.id === pairId)).toMatchObject({ variety_rank: 'blend', blend_key: keyOf(fx.v.a1, fx.v.a2) })
    expect(rows.find((v) => v.id === fx.v.a1)).toMatchObject({ variety_rank: 'cultivar', blend_key: null })
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// What a new mix carries, and what is refused
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('POST /api/varieties/blend — birth facts and refusals', () => {
  it('species, genus and lifecycle only when EVERY leaf records the same value; a heat envelope only when every leaf has a whole range, marked "inference"', async () => {
    const hot = await leaf('hot', { species: 'Capsicum annuum', genus: 'Capsicum', lifecycle: 'annual', scoville_min: 2000, scoville_max: 8000 })
    const mild = await leaf('mild', { species: 'Capsicum annuum', genus: 'Capsicum', lifecycle: 'tender_perennial', scoville_min: 100, scoville_max: 500 })
    const r = await blend([hot.id, mild.id])
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(await varietyRow(r.body.id)).toMatchObject({
      species: 'Capsicum annuum', genus: 'Capsicum', lifecycle: null,
      scoville_min: 100, scoville_max: 8000, scoville_source: 'inference',
    })
    // One leaf with no range: no envelope and no source at all.
    const unknown = await leaf('unknown', { species: 'Capsicum chinense', genus: 'Capsicum' })
    const partial = await blend([hot.id, unknown.id])
    expect(partial.status, JSON.stringify(partial.body)).toBe(201)
    expect(await varietyRow(partial.body.id)).toMatchObject({
      species: null, genus: 'Capsicum', lifecycle: null, scoville_min: null, scoville_max: null, scoville_source: null,
    })
  })

  it('two varieties that BOTH have no crop make a mix with no crop (NULL is one value of its own)', async () => {
    const r = await blend([fx.v.n1, fx.v.n2])
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.crop_type_slug).toBeNull()
    expect((await varietyRow(r.body.id)).crop_type_slug).toBeNull()
  })

  it('a soft-deleted variety can still be a component, and the reply says so', async () => {
    const r = await blend([fx.v.a3, fx.v.gone])
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.components.find((c) => c.id === fx.v.gone)).toMatchObject({ deleted: true })
    expect(r.body.components.find((c) => c.id === fx.v.a3)).toMatchObject({ deleted: false })
    expect((await components(r.body.id)).map((c) => c.component_variety_id)).toEqual(sorted(fx.v.a3, fx.v.gone))
  })

  it('four or more leaves: the automatic name is the first two and a count', async () => {
    const four = []
    for (const t of ['n-a', 'n-b', 'n-c', 'n-d']) {
      // eslint-disable-next-line no-await-in-loop
      four.push(await leaf(t))
    }
    const names = four.map((v) => v.name).sort()
    const r = await blend(four.map((v) => v.id), { create: false })
    expect(r.status).toBe(200)
    expect(r.body.name).toBe(`${names[0]} + ${names[1]} + 2 more`)
    expect(r.body.components.map((c) => c.name)).toEqual(names)
  })

  it('every refusal writes nothing: mixed crop, each NULL-crop cell, an unknown id, fewer than two, more than twelve, and every malformed body', async () => {
    const thirteen = []
    for (let i = 0; i < 13; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      thirteen.push((await leaf(`many-${i}`)).id)
    }
    const before = await footprint()
    const coded = [
      ['two crops', [fx.v.a1, fx.v.b], 'mixed_crop_components'],
      ['a crop beside no crop', [fx.v.a1, fx.v.n1], 'mixed_crop_components'],
      ['no crop beside a crop', [fx.v.n2, fx.v.b], 'mixed_crop_components'],
      ['an id no row has', [fx.v.a1, randomUUID()], 'component_unknown'],
      ['one variety', [fx.v.a1], 'blend_needs_two'],
      ['one variety twice', [fx.v.a1, fx.v.a1.toUpperCase()], 'blend_needs_two'],
      ['thirteen leaves', thirteen, 'blend_too_many'],
    ]
    for (const [what, ids, code] of coded) {
      for (const create of [true, false]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await blend(ids, { create })
        expect(r.status, `${what}, create ${create} -> ${JSON.stringify(r.body)}`).toBe(400)
        expect(r.body).toEqual({ error: BLEND_ERRORS[code], code })
      }
    }
    const shapes = [
      {}, { component_variety_ids: [fx.v.a1, fx.v.a2] }, { component_variety_ids: [fx.v.a1, fx.v.a2], create: 'true' },
      { component_variety_ids: 'x', create: true }, { component_variety_ids: [fx.v.a1, 'not-a-uuid'], create: true },
      { component_variety_ids: Array.from({ length: 49 }, () => randomUUID()), create: true },
    ]
    for (const body of shapes) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('POST', '/api/varieties/blend', body)
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(r.body.code).toBeUndefined()
    }
    // Another verb is a 405 and "blend" is never read as a variety id (22P02 would be a 500).
    for (const method of ['GET', 'PUT', 'DELETE']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(method, '/api/varieties/blend', method === 'GET' ? null : {})
      expect(r.status, method).toBe(405)
    }
    expect(await footprint()).toBe(before)
    // Twelve of the thirteen is the most a mix may hold, and the key CHECK accepts it.
    const twelve = await blend(thirteen.slice(0, 12))
    expect(twelve.status, JSON.stringify(twelve.body)).toBe(201)
    expect((await components(twelve.body.id))).toHaveLength(12)
    expect((await varietyRow(twelve.body.id)).blend_key).toBe(keyOf(...thirteen.slice(0, 12)))
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// A mix as an input, a rename, a soft delete
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('POST /api/varieties/blend — a mix that already exists', () => {
  it('a mix named as a component FLATTENS to its leaves: {mix of X and Y, Z} is the mix of {X, Y, Z}; a mix named alone, or beside one of its own leaves, is itself', async () => {
    const [x, y, z] = [await leaf('fl-x'), await leaf('fl-y'), await leaf('fl-z')]
    const xy = await blend([x.id, y.id])
    expect(xy.status).toBe(201)

    const nested = await blend([xy.body.id, z.id])
    expect(nested.status, JSON.stringify(nested.body)).toBe(201)
    expect(nested.body.blend_key).toBe(keyOf(x.id, y.id, z.id))
    expect(nested.body.components.map((c) => c.id).sort()).toEqual(sorted(x.id, y.id, z.id))
    expect((await components(nested.body.id)).map((c) => c.component_variety_id)).toEqual(sorted(x.id, y.id, z.id))
    // The same three named flat find the same row.
    const flat = await blend([z.id, y.id, x.id])
    expect(flat.status).toBe(200)
    expect(flat.body.id).toBe(nested.body.id)
    // No component of any mix is itself a mix.
    expect(await directSql`
      SELECT c.id FROM variety_blend_component c JOIN plant_varieties v ON v.id = c.component_variety_id
       WHERE c.blend_variety_id = ${nested.body.id} AND v.blend_key IS NOT NULL`).toEqual([])

    const before = await footprint()
    const alone = await blend([xy.body.id])
    expect(alone.status, JSON.stringify(alone.body)).toBe(200)
    expect(alone.body).toMatchObject({ id: xy.body.id, created: false })
    const withLeaf = await blend([xy.body.id, x.id])
    expect(withLeaf.status).toBe(200)
    expect(withLeaf.body.id).toBe(xy.body.id)
    expect(await footprint()).toBe(before)
  })

  it('a rename keeps the key: the renamed mix is still found by its set, and answers its OWN name; marking it Open-pollinated through PUT is refused', async () => {
    const [x, y] = [await leaf('rn-x'), await leaf('rn-y')]
    const made = await blend([x.id, y.id])
    expect(made.status).toBe(201)
    const renamed = await call('PUT', `/api/varieties/${made.body.id}`, { name: `vb back fence mix ${RUN}` })
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
    expect(renamed.body).toMatchObject({ name: `vb back fence mix ${RUN}`, variety_rank: 'blend', blend_key: keyOf(x.id, y.id) })
    const row = await varietyRow(made.body.id)
    expect(row.name).toBe(`vb back fence mix ${RUN}`)
    expect(row.blend_key).toBe(keyOf(x.id, y.id))

    const found = await blend([y.id, x.id])
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({ id: made.body.id, name: `vb back fence mix ${RUN}`, created: false })

    const before = await varietyRow(made.body.id)
    const op = await call('PUT', `/api/varieties/${made.body.id}`, { breeding_system: 'open_pollinated', breeding_source: 'grower_record' })
    expect(op.status, JSON.stringify(op.body)).toBe(400)
    expect(await varietyRow(made.body.id)).toEqual(before)
  })

  it('a soft-deleted mix is not revived by a preview, and IS revived by create:true — same id, created:false, no second row, no rate-limit draw', async () => {
    const [x, y] = [await leaf('sd-x'), await leaf('sd-y')]
    const made = await blend([x.id, y.id])
    expect(made.status).toBe(201)
    expect((await call('DELETE', `/api/varieties/${made.body.id}`)).status).toBe(200)
    expect((await varietyRow(made.body.id)).deleted_at).not.toBeNull()

    const before = await footprint()
    const preview = await blend([x.id, y.id], { create: false })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ id: null, exists: false, created: false, name: made.body.name })
    expect(await footprint()).toBe(before)

    const buckets = async () => JSON.stringify(await directSql`
      SELECT bucket_key, count FROM rate_limit_buckets WHERE actor_clerk_sub = ${USER} ORDER BY 1`)
    const spent = await buckets()
    const revived = await blend([y.id, x.id])
    expect(revived.status, JSON.stringify(revived.body)).toBe(200)
    expect(revived.body).toMatchObject({ id: made.body.id, exists: true, created: false, name: made.body.name })
    expect((await varietyRow(made.body.id)).deleted_at).toBeNull()
    expect(await buckets()).toBe(spent)
    expect((await directSql`SELECT count(*)::int AS n FROM plant_varieties WHERE blend_key = ${keyOf(x.id, y.id)}`)[0].n).toBe(1)
    expect((await components(made.body.id)).map((c) => c.deleted_at)).toEqual([null, null])
  })

  it('a revive whose stored name was taken while the mix was deleted comes back as "<name> (2)", with the same key', async () => {
    const [x, y] = [await leaf('rv-x'), await leaf('rv-y')]
    const made = await blend([x.id, y.id])
    expect(made.status).toBe(201)
    expect((await call('DELETE', `/api/varieties/${made.body.id}`)).status).toBe(200)
    await leaf('squatter', { name: made.body.name })
    const revived = await blend([x.id, y.id])
    expect(revived.status, JSON.stringify(revived.body)).toBe(200)
    expect(revived.body).toMatchObject({ id: made.body.id, created: false, name: `${made.body.name} (2)`, blend_key: keyOf(x.id, y.id) })
    expect(await varietyRow(made.body.id)).toMatchObject({ name: `${made.body.name} (2)`, deleted_at: null, blend_key: keyOf(x.id, y.id) })
  })

  it('live first, then oldest: with a soft-deleted and a live row for one key the live one is answered; with two live rows (two members) the older', async () => {
    process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MATE}`
    try {
      const [x, y] = [await leaf('ord-x'), await leaf('ord-y')]
      // MATE's row is made first and soft-deleted; USER's is made later and live.
      const old = await handMix({ name: `vb ord old ${RUN}`, by: MATE, leafIds: [x.id, y.id] })
      await directSql.transaction([
        directSql`SELECT set_config('app.actor_clerk_sub', ${MATE}, true)`,
        directSql`UPDATE plant_varieties SET deleted_at = now() WHERE id = ${old}`,
      ])
      const live = await handMix({ name: `vb ord live ${RUN}`, by: USER, leafIds: [x.id, y.id] })
      const r = await blend([x.id, y.id], { create: false })
      expect(r.status).toBe(200)
      expect(r.body.id).toBe(live)

      // Two LIVE rows for one key, one per member (the residual lane V names): always the older.
      const [p, q2] = [await leaf('ord-p'), await leaf('ord-q')]
      const first = await handMix({ name: `vb ord first ${RUN}`, by: MATE, leafIds: [p.id, q2.id] })
      await handMix({ name: `vb ord second ${RUN}`, by: USER, leafIds: [p.id, q2.id] })
      for (const as of [USER, MATE]) {
        // eslint-disable-next-line no-await-in-loop
        const both = await blend([q2.id, p.id], { as })
        expect(both.status).toBe(200)
        expect(both.body.id, `asked by ${as}`).toBe(first)
      }
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// A planting SOWN under a mix, and the standing care gates (contract section 2, the item left OPEN)
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The contract asked lane V for one thing it could only reason about: "the mix's care_profile must not
// red that standing gate once the mix is sown". Lane V gave the mix its own profile row, _basis
// 'blend' (blend.js BLEND_PROFILE), and named the cost: a DIFFERENT standing gate excuses a stranded
// profile only while _basis is 'unresearched'. Both halves are run here against the gates' OWN SQL.
//
// A standing gate counts rows across the whole database, and this branch is full of other files'
// fixtures (most of their plantings name a variety with no profile at all), so its total says nothing
// about a mix. Each gate's text is therefore re-pointed to answer "is THIS row one the gate counts":
// its leading `SELECT 1` becomes the row's id and the result is filtered to the ids under test.
//
// AND ITS STAMP GUARD IS TAKEN OFF. Each of these gates arms itself on its own migration's
// schema_version row, and neither row is on staging (measured 2026-10-06 on a fork of it: no
// '%cadencerefill%' and no '%rekeystrand%' version), so as written both answer nothing here whatever
// the data says. What is under test is the gate's PREDICATE — what it will count on a database where
// it is armed, which is prod. If a gate's text stops having either shape the helper throws — re-point
// it, do not let it read as green.
const STAMP_GUARD = /\s+AND EXISTS \(SELECT 1 FROM public\.schema_version\s+WHERE version = '[^']+'\)/
function gateHits(file, name, head, id) {
  const gate = yaml.load(readFileSync(file, 'utf8')).post.find((g) => g.name === name)
  if (!gate) throw new Error(`no post gate named ${name} in ${file}`)
  if (!head.test(gate.sql)) throw new Error(`gate ${name} no longer begins as this test expects: re-point it`)
  if ((gate.sql.match(new RegExp(STAMP_GUARD.source, 'g')) ?? []).length !== 1) {
    throw new Error(`gate ${name} no longer carries exactly one stamp guard of the expected shape: re-point it`)
  }
  const pointed = gate.sql.replace(STAMP_GUARD, '').replace(head, (m) => m.replace('SELECT 1', `SELECT ${id} AS hit`))
  return async (ids) => (await directSql(`SELECT g.hit FROM (${pointed}) g WHERE g.hit = ANY($1::uuid[])`, [ids]))
    .map((r) => r.hit).sort()
}

describe.skipIf(!READY)('a planting sown under a mix, and the standing care gates', () => {
  const sow = async (tag, varietyId) => (await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id)
    VALUES (NULL, ${`vb-sown-${tag}-${RUN}`}, ${USER}, ${varietyId}) RETURNING id`)[0].id
  const rekey = (plantId, varietyId) => directSql.transaction([
    directSql`SELECT set_config('app.actor_clerk_sub', ${USER}, true)`,
    directSql`UPDATE plants SET variety_id = ${varietyId} WHERE id = ${plantId}`,
  ])
  const lacksProfile = gateHits(CADENCE_GATES_FILE, 'post_no_live_planting_lacks_a_cadence_profile',
    /^SELECT 1 FROM public\.plants p/, 'p.id')
  const restsOnPlaceholder = gateHits(CADENCE_GATES_FILE, 'post_no_live_planting_rests_on_an_unresearched_placeholder',
    /^SELECT 1 FROM public\.plants p/, 'p.id')
  const strandedProfile = gateHits(REKEY_GATES_FILE, 'post_no_rekey_stranded_care_profile',
    /SELECT 1\s+FROM rekeyed r/, 'r.old_v')
  const g = {}

  beforeAll(async () => {
    const [x, y] = [await leaf('sown-x'), await leaf('sown-y')]
    const mix = await blend([x.id, y.id])
    expect(mix.status, JSON.stringify(mix.body)).toBe(201)
    // The control: an ORDINARY new cultivar, made by the ordinary POST, which writes the placeholder profile.
    const plain = await call('POST', '/api/varieties', { name: `vb-sown-plain-${RUN}`, crop_type_slug: fx.crops.a })
    expect(plain.status, JSON.stringify(plain.body)).toBe(201)
    g.mix = mix.body.id
    g.plain = plain.body.id
    g.bare = x.id   // a variety inserted by SQL: no profile row at all
    g.onMix = await sow('mix', g.mix)
    g.onPlain = await sow('plain', g.plain)
    g.onBare = await sow('bare', g.bare)
  })

  it('the two cadence predicates count their controls: a planting of a variety with NO profile, and a planting of an ordinary new cultivar on its "unresearched" placeholder', async () => {
    expect(await lacksProfile([g.onMix, g.onPlain, g.onBare])).toEqual([g.onBare])
    expect(await restsOnPlaceholder([g.onMix, g.onPlain, g.onBare])).toEqual([g.onPlain])
  })

  it('the planting sown under the MIX is counted by neither: its variety has a profile row, and that row is not the placeholder', async () => {
    expect(await lacksProfile([g.onMix])).toEqual([])
    expect(await restsOnPlaceholder([g.onMix])).toEqual([])
    const [profile] = await directSql`
      SELECT profile->>'_basis' AS basis FROM care_profile WHERE scope = 'cultivar' AND scope_id = ${g.mix}`
    expect(profile.basis).toBe(BLEND_PROFILE._basis)
    expect(profile.basis).not.toBe('unresearched')
  })

  it('THE KNOWN COST, as it is today: re-key the mix\'s only planting to another variety and the re-key guard counts the mix\'s profile as stranded researched care — while an ordinary placeholder left behind the same way is excused', async () => {
    expect(await strandedProfile([g.mix, g.plain])).toEqual([])
    await rekey(g.onMix, g.bare)
    await rekey(g.onPlain, g.bare)
    // Lane V's finding 3b, now observed rather than predicted. No single _basis satisfies both gates:
    // the cadence gate needs it to differ from 'unresearched', this guard's exemption needs it to equal
    // it. If the guard's exclusion is widened to a 'blend' placeholder (a decision that is Dave's),
    // this expectation becomes [] — flip it then.
    expect(await strandedProfile([g.mix, g.plain])).toEqual([g.mix])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The two unique indexes, and who shares a mix
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('the two unique indexes — err.constraint carries the INDEX name', () => {
  it('a second live row for one (created_by, blend_key) is 23505 on uq_plant_varieties_creator_blend_key_live; the same name is 23505 on uq_plant_varieties_name_species', async () => {
    const [x, y] = [await leaf('ux-x'), await leaf('ux-y')]
    const made = await blend([x.id, y.id])
    expect(made.status).toBe(201)
    await expect(handMix({ name: `vb ux other name ${RUN}`, leafIds: [x.id, y.id] }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_plant_varieties_creator_blend_key_live' })
    // Another creator, another key, the SAME name: the name index, across all users.
    const [p, q2] = [await leaf('ux-p', { by: FOREIGN }), await leaf('ux-q', { by: FOREIGN })]
    await expect(handMix({ name: made.body.name, by: FOREIGN, leafIds: [p.id, q2.id] }))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_plant_varieties_name_species' })
    // Neither failed batch left a row or a component behind.
    expect((await directSql`SELECT count(*)::int AS n FROM plant_varieties WHERE blend_key = ${keyOf(p.id, q2.id)}`)[0].n).toBe(0)
    expect((await directSql`SELECT count(*)::int AS n FROM plant_varieties WHERE blend_key = ${keyOf(x.id, y.id)}`)[0].n).toBe(1)
  })

  it('the restore arm answers each index with its own sentence and 409, never a 500 and never an index name', async () => {
    // The key index: the mix is deleted, the same set is made again by hand, the first is restored.
    const [x, y] = [await leaf('rs-x'), await leaf('rs-y')]
    const made = await blend([x.id, y.id])
    expect((await call('DELETE', `/api/varieties/${made.body.id}`)).status).toBe(200)
    await handMix({ name: `vb rs again ${RUN}`, leafIds: [x.id, y.id] })
    const key = await call('POST', `/api/varieties/${made.body.id}/restore`)
    expect(key.status, JSON.stringify(key.body)).toBe(409)
    expect(key.body).toEqual({ error: RESTORE_CONFLICT_MESSAGES.uq_plant_varieties_creator_blend_key_live })
    expect((await varietyRow(made.body.id)).deleted_at).not.toBeNull()

    // The name index: an ordinary variety is deleted, its name is taken, it is restored.
    const plain = await leaf('rs-plain')
    expect((await call('DELETE', `/api/varieties/${plain.id}`)).status).toBe(200)
    await leaf('rs-taker', { name: plain.name })
    const name = await call('POST', `/api/varieties/${plain.id}/restore`)
    expect(name.status, JSON.stringify(name.body)).toBe(409)
    expect(name.body).toEqual({ error: RESTORE_CONFLICT_MESSAGES.uq_plant_varieties_name_species })
    expect((await varietyRow(plain.id)).deleted_at).not.toBeNull()
  })

  it('a second HOUSEHOLD MEMBER asking for the same set is handed the first member\'s row; someone outside the household gets a row of their own, named "… (2)"', async () => {
    const [x, y] = [await leaf('hh-x'), await leaf('hh-y')]
    const mine = await blend([x.id, y.id])
    expect(mine.status).toBe(201)

    process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MATE}`
    try {
      const before = await footprint()
      const mates = await blend([y.id, x.id], { as: MATE })
      expect(mates.status, JSON.stringify(mates.body)).toBe(200)
      expect(mates.body).toMatchObject({ id: mine.body.id, created: false, exists: true })
      expect(await footprint()).toBe(before)
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }

    // The preview for an outsider does not show the household's row...
    const peek = await blend([x.id, y.id], { create: false, as: FOREIGN })
    expect(peek.body).toMatchObject({ id: null, exists: false, name: mine.body.name })
    // ...and creating it lands on the name index (same leaves, same automatic name), which the route
    // answers by finding again, finding nothing of its own, and taking the next name.
    const theirs = await blend([x.id, y.id], { as: FOREIGN })
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201)
    expect(theirs.body.id).not.toBe(mine.body.id)
    expect(theirs.body).toMatchObject({ created: true, name: `${mine.body.name} (2)`, blend_key: mine.body.blend_key })
    expect(await varietyRow(theirs.body.id)).toMatchObject({ created_by: FOREIGN, variety_rank: 'blend' })
    expect((await components(theirs.body.id)).map((c) => c.created_by)).toEqual([FOREIGN, FOREIGN])
    // One draw on the create bucket for the whole request, though it took two INSERT attempts.
    const [bucket] = await directSql`
      SELECT sum(count)::int AS n FROM rate_limit_buckets
       WHERE actor_clerk_sub = ${FOREIGN} AND bucket_key = 'plant_varieties.create'`
    expect(bucket.n).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The race — a rival's uncommitted row, both endings
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The rival is a psql session that has INSERTed the mix (row and components) and not committed. The
// route's find cannot see it, so the route goes on to its own INSERT, which stops on the unique index
// behind the rival's transaction — shown in pg_blocking_pids() before the rival is let go.
async function rivalHolding({ id, name, by, leafIds }) {
  const rival = openSession('a rival creating the same mix')
  const rivalPid = await rival.pid()
  await rival.run(`BEGIN;
    INSERT INTO plant_varieties (id, name, created_by, variety_rank, blend_key, crop_type_slug)
    VALUES (${lit(id)}, ${q(name)}, ${q(by)}, 'blend', ${q(keyOf(...leafIds))}, ${q(fx.crops.a)});
    INSERT INTO variety_blend_component (blend_variety_id, component_variety_id, created_by)
    VALUES ${leafIds.map((l) => `(${lit(id)}, ${lit(l)}, ${q(by)})`).join(', ')};`)
  return { rival, rivalPid }
}

describe.skipIf(!READY || !HAS_PSQL)('POST /api/varieties/blend — two requests for one set at once', () => {
  it('the first COMMITS: the second is handed that row — 200, created:false, the first one\'s id — and there is one row for the key', { timeout: 90000 }, async () => {
    const [x, y] = [await leaf('race-x'), await leaf('race-y')]
    const preview = await blend([x.id, y.id], { create: false })
    const firstId = randomUUID()
    const { rival, rivalPid } = await rivalHolding({ id: firstId, name: preview.body.name, by: USER, leafIds: [x.id, y.id] })
    try {
      const second = onOwnConnection(() => blend([x.id, y.id]))
      await waitBlockedBy(rivalPid, 'the route\'s INSERT, at the unique index')
      await rival.end('COMMIT;')
      const r = await second
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body).toMatchObject({ id: firstId, created: false, exists: true, blend_key: keyOf(x.id, y.id) })
      expect(await directSql`SELECT id FROM plant_varieties WHERE blend_key = ${keyOf(x.id, y.id)}`).toEqual([{ id: firstId }])
      // The loser's batch rolled back whole: no stray component, no stray profile.
      expect(await directSql`
        SELECT DISTINCT blend_variety_id FROM variety_blend_component
         WHERE component_variety_id IN (${x.id}, ${y.id})`).toEqual([{ blend_variety_id: firstId }])
    } finally {
      await rival.end()
    }
  })

  it('the first ROLLS BACK: the second creates — 201, created:true, its own id — and the first one\'s row never existed', { timeout: 90000 }, async () => {
    const [x, y] = [await leaf('race-p'), await leaf('race-q')]
    const preview = await blend([x.id, y.id], { create: false })
    const firstId = randomUUID()
    const { rival, rivalPid } = await rivalHolding({ id: firstId, name: preview.body.name, by: USER, leafIds: [x.id, y.id] })
    try {
      const second = onOwnConnection(() => blend([x.id, y.id]))
      await waitBlockedBy(rivalPid, 'the route\'s INSERT, at the unique index')
      await rival.end('ROLLBACK;')
      const r = await second
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.body).toMatchObject({ created: true, exists: true, name: preview.body.name })
      expect(r.body.id).not.toBe(firstId)
      expect(await directSql`SELECT id FROM plant_varieties WHERE blend_key = ${keyOf(x.id, y.id)}`).toEqual([{ id: r.body.id }])
      expect((await components(r.body.id)).map((c) => c.component_variety_id)).toEqual(sorted(x.id, y.id))
      expect(await directSql`
        SELECT 1 AS x FROM care_profile WHERE scope = 'cultivar' AND scope_id = ${r.body.id}`).toHaveLength(1)
    } finally {
      await rival.end()
    }
  })

  it('two MEMBERS of one household at once land on the NAME index (the key index is per creator): the loser is handed the winner\'s row', { timeout: 90000 }, async () => {
    process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MATE}`
    const [x, y] = [await leaf('race-m'), await leaf('race-n')]
    const preview = await blend([x.id, y.id], { create: false })
    const matesId = randomUUID()
    const { rival, rivalPid } = await rivalHolding({ id: matesId, name: preview.body.name, by: MATE, leafIds: [x.id, y.id] })
    try {
      const second = onOwnConnection(() => blend([x.id, y.id]))
      await waitBlockedBy(rivalPid, 'the route\'s INSERT, at the name index')
      await rival.end('COMMIT;')
      const r = await second
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body).toMatchObject({ id: matesId, created: false, created_by: MATE })
      expect(await directSql`SELECT id FROM plant_varieties WHERE blend_key = ${keyOf(x.id, y.id)}`).toEqual([{ id: matesId }])
    } finally {
      await rival.end()
      delete process.env.GARDEN_HOUSEHOLD_IDS
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The migration's gates, after this route has written
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Every standing `post` gate of migrations/v5-varietyblend-001/gates.yml, read from the file and run as
// written. `continuous: false` gates are the apply-window receipts (false by design once the release
// after this one adds a column); a gate marked for one environment is that environment's (a role that
// exists only on prod). An unknown `expect` kind throws: a gate this cannot evaluate must not read as green.
const ROW_LEVEL = [
  'post_keyed_row_has_rank_blend', 'post_blend_key_equals_live_components',
  'post_no_live_component_under_an_unkeyed_row', 'post_every_live_component_is_a_leaf',
]
async function standingPostGates() {
  const file = yaml.load(readFileSync(GATES_FILE, 'utf8'))
  const out = []
  for (const gate of file.post) {
    if (gate.continuous === false || gate.env) continue
    // eslint-disable-next-line no-await-in-loop
    const rows = await directSql(gate.sql)
    let ok
    if (gate.expect === 'rowcount_eq') ok = rows.length === gate.value
    else if (gate.expect === 'scalar_eq') ok = rows.length === 1 && String(Object.values(rows[0])[0]) === String(gate.value)
    else throw new Error(`gate ${gate.name}: this file cannot evaluate expect "${gate.expect}"`)
    out.push({ name: gate.name, ok, rows: rows.length })
  }
  return out
}

describe.skipIf(!READY)('migrations/v5-varietyblend-001/gates.yml — green after the route has created, revived and renamed mixes', () => {
  it('this file\'s users own mixes the ROUTE made, one it revived and one it renamed, when the gates are read', async () => {
    const made = await directSql`
      SELECT count(*)::int AS n FROM plant_varieties
       WHERE created_by IN (${USER}, ${FOREIGN}) AND blend_key IS NOT NULL AND deleted_at IS NULL`
    expect(made[0].n).toBeGreaterThanOrEqual(8)
    expect((await directSql`SELECT 1 AS x FROM plant_varieties WHERE created_by = ${USER} AND name = ${`vb back fence mix ${RUN}`} AND blend_key IS NOT NULL`)).toHaveLength(1)
    expect((await directSql`SELECT 1 AS x FROM plant_varieties WHERE created_by = ${USER} AND name LIKE ${`vb-rv-x-${RUN}%(2)`} AND blend_key IS NOT NULL AND deleted_at IS NULL`)).toHaveLength(1)
  })

  it('every standing post gate passes, the four row-level ones among them', async () => {
    const results = await standingPostGates()
    expect(results.map((g) => g.name)).toEqual(expect.arrayContaining(ROW_LEVEL))
    expect(results.length).toBeGreaterThanOrEqual(20)
    expect(results.filter((g) => !g.ok), 'gates that are not green').toEqual([])
  })

  it('and they can go red: a component hung under an unkeyed variety, a keyed row whose rank is not "blend", a key that is not its components, a component that is itself a mix — each turns exactly its own gate', async () => {
    const red = async () => (await standingPostGates()).filter((g) => !g.ok).map((g) => g.name)
    const [x, y, z] = [await leaf('gate-x'), await leaf('gate-y'), await leaf('gate-z')]
    const actor = directSql`SELECT set_config('app.actor_clerk_sub', ${USER}, true)`

    // 1. A live component under a variety with no key.
    const [stray] = await directSql`
      INSERT INTO variety_blend_component (blend_variety_id, component_variety_id, created_by)
      VALUES (${x.id}, ${y.id}, ${USER}) RETURNING id`
    expect(await red()).toEqual(['post_no_live_component_under_an_unkeyed_row'])
    await directSql`DELETE FROM variety_blend_component WHERE id = ${stray.id}`
    expect(await red()).toEqual([])

    // 2. A keyed row whose rank is not 'blend'.
    const mix = await handMix({ name: `vb gate mix ${RUN}`, leafIds: [x.id, y.id] })
    await directSql.transaction([actor, directSql`UPDATE plant_varieties SET variety_rank = 'cultivar' WHERE id = ${mix}`])
    expect(await red()).toEqual(['post_keyed_row_has_rank_blend'])
    await directSql.transaction([actor, directSql`UPDATE plant_varieties SET variety_rank = 'blend' WHERE id = ${mix}`])

    // 3. A key that is no longer its live components (one retired).
    await directSql`UPDATE variety_blend_component SET deleted_at = now() WHERE blend_variety_id = ${mix} AND component_variety_id = ${y.id}`
    expect(await red()).toEqual(['post_blend_key_equals_live_components'])
    await directSql`UPDATE variety_blend_component SET deleted_at = NULL WHERE blend_variety_id = ${mix} AND component_variety_id = ${y.id}`
    expect(await red()).toEqual([])

    // 4. A component that is itself a mix (nested, with a key that says so — only its own gate reds).
    const nested = randomUUID()
    await directSql.transaction([
      directSql`
        INSERT INTO plant_varieties (id, name, created_by, variety_rank, blend_key, crop_type_slug)
        VALUES (${nested}::uuid, ${`vb gate nested ${RUN}`}, ${USER}, 'blend', ${keyOf(mix, z.id)}, ${fx.crops.a})`,
      directSql`
        INSERT INTO variety_blend_component (blend_variety_id, component_variety_id, created_by)
        VALUES (${nested}::uuid, ${mix}::uuid, ${USER}), (${nested}::uuid, ${z.id}::uuid, ${USER})`,
    ])
    expect(await red()).toEqual(['post_every_live_component_is_a_leaf'])
    await directSql`DELETE FROM variety_blend_component WHERE blend_variety_id = ${nested}`
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${nested}`
    await directSql`DELETE FROM plant_varieties WHERE id = ${nested}`
    expect(await red()).toEqual([])
  })

  it.runIf(RUN_GATE_RUNNER)('scripts/gate_runner.py --phase post, pointed at this branch, exits 0 while those rows exist', { timeout: 120000 }, () => {
    // Both URL variables are this run's own (assertEphemeralDatabase has already refused a protected
    // endpoint), so no spelling of --env can reach staging or prod. Handed over in the environment,
    // never on the command line, and the output is filtered before it is printed.
    const r = spawnSync('python3', [
      'scripts/gate_runner.py', '--migration', 'migrations/v5-varietyblend-001', '--env', 'staging', '--phase', 'post',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NEON_STAGING_URL: process.env.INT_DATABASE_URL, NEON_DATABASE_URL: process.env.INT_DATABASE_URL },
    })
    const shown = `${r.stdout}\n${r.stderr}`.split('\n')
      .filter((l) => /SUMMARY|FAIL|ERROR|PASS|n\/a/i.test(l) && !/postgres(ql)?:\/\//.test(l))
    console.log(`[gate_runner v5-varietyblend-001 post] exit ${r.status}\n${shown.join('\n')}`)
    expect(r.status, shown.join('\n')).toBe(0)
  })
})
