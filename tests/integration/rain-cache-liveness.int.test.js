// tests/integration/rain-cache-liveness.int.test.js
// OPS-CACHEARCHIVEINTTEST-001 — BUG-CACHEORPHANREGRESS-001's daily-plan half on real Postgres.
//
// WHAT IS UNDER TEST. The two entity_memory upserts logRainEvents (lambda/daily-plan/handler.js) sends on
// a rain night, after its rain INSERT: the plant arm joins garden_node and the container arm joins
// container, each with `deleted_at IS NULL` in the WHERE. A soft-deleted planting or container that has
// watering history must get no cache row, and a row already sitting on one (the prod orphan shape,
// migrations/v5-cacheorphan-001) must not be rewritten. An ARCHIVED parent keeps being written
// (v4-cachemissingrow-001). lambda/daily-plan/weatherdaily.test.js proves the statements' shape on a
// model; before this file no integration test reached logRainEvents at all (preship-qa I3).
//
// HOW THE STATEMENTS ARE OBTAINED: DRIVEN, NOT COPIED. run() is imported from handler.js and driven
// exactly as weatherdaily.test.js drives it — a recording pg that answers the rain reader with a gauge
// day and every other statement with nothing — and the two upserts it SENT are taken from the
// recording. Nothing is retyped from source, so a filter left in a branch run() never reaches is not
// credited here. (The Lambda entry, index.js, cannot be driven by this harness: it requires
// @aws-sdk/client-sns and ws, which integration-test.yml does not install for daily-plan, and it loads
// them with require(), which vi.mock cannot intercept. handler.js has no package dependencies.)
//
// HOW THEY ARE RUN: VERBATIM, THEN ROLLED BACK. Both statements are household-unscoped by design — they
// recompute every cache row that has watering history. Committed on this shared branch they would
// rewrite the cache rows of every other integration file running in parallel (reanchor-carecache's
// "plantB has no cache row at all" and its manufactured missing row among them). So they run inside one
// transaction, after a SAVEPOINT, with the read-back, and the transaction rolls back to the savepoint:
// nothing is ever committed, which the last test checks. SET LOCAL lock_timeout keeps this file the one
// that gives way if another file's transaction holds one of those rows (it retries; the other file never
// waits long enough to reach a deadlock check).
//
// "NOT REWRITTEN" IS READ FROM xmin. The orphan rows are committed before the replay, so an ON CONFLICT
// DO UPDATE that touched one — even with values it already held — gives it the replay's transaction id.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import dailyPlan from '../../lambda/daily-plan/handler.js'

const { run } = dailyPlan

const RUN = testRunId()
const USER = `user_int_raincache_${RUN}`

const DAY = 24 * 3600 * 1000
const T0 = new Date(Date.now() - 60 * DAY).toISOString()  // what the orphan rows are seeded with
const TW = new Date(Date.now() - 30 * DAY).toISOString()  // every fixture watering
const ms = (v) => (v == null ? null : new Date(v).getTime())

// `watered`: a container-level watering (no planting), so only the container arm reads it. Logged
// while the container is live, then the container changes state, as on prod.
async function container(tag, state = 'live', { watered = true } = {}) {
  const { id } = await insertProject({ name: `int-raincache-${tag}-${RUN}`, createdBy: USER })
  if (watered) {
    await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, created_by)
      VALUES (${id}, 'watering', ${TW}::timestamptz, ${USER})`
  }
  if (state === 'deleted') await directSql`UPDATE plant_projects SET deleted_at = NOW() WHERE id = ${id}`
  if (state === 'archived') await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id = ${id}`
  return id
}
async function planting(tag, projectId, state = 'live') {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${`int-raincache-${tag}-${RUN}`}, ${USER}) RETURNING id`
  const { id } = rows[0]
  // The watering is logged while the planting is live, as it was on prod; then the planting changes
  // state. A direct UPDATE rather than the plants DELETE route, which would also delete a cache row
  // this file never created.
  await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, created_by)
    VALUES (${projectId}, ${id}, 'watering', ${TW}::timestamptz, ${USER})`
  if (state === 'deleted') await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${id}`
  if (state === 'archived') await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${id}`
  return id
}
// Drive run() and keep the cache upserts it sent. `today` is arbitrary: the recording answers the rain
// reader with a gauge day above threshold and the once-a-day guard with nothing, whatever the date.
async function sentCacheUpserts() {
  const sent = []
  const pg = {
    query: async (text, params) => {
      sent.push({ text, params })
      if (/select precip_in, precip_source from weather_daily/i.test(text)) {
        return { rows: [{ precip_in: 0.34, precip_source: 'gauge_merged' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  const quiet = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await run({
      pg, today: '2026-08-12', dryRun: false,
      geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => null,
      fetchStation: async () => null,
      publishAlert: async () => ({ messageId: 'stub' }),
      etHour: 2, event: { rainLog: true },
    })
  } finally {
    quiet.mockRestore()
  }
  return sent.filter((s) => /insert\s+into\s+entity_memory/i.test(s.text))
}

let cHost, cLive, cGone, cOrphan, cArchived
let pLive, pGone, pOrphan, pArchived
let plantUpsert, projectUpsert
let before, after

const readBack = () => directSql`
  SELECT em.plant_id, em.project_id, em.xmin::text AS xmin, em.last_event_at, em.last_watered_at
    FROM entity_memory em
   WHERE em.plant_id = ANY(${[pLive, pGone, pOrphan, pArchived]}::uuid[])
      OR em.project_id = ANY(${[cLive, cGone, cOrphan, cArchived]}::uuid[])`
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.plant_id ?? r.project_id, r]))

// The two SENT statements, verbatim, then the read-back, inside one transaction rolled back to a
// savepoint. Retried only on lock_timeout (55P03), which can only mean another file's transaction held a
// row these statements touch; every attempt commits nothing.
async function replayRolledBack() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = await directSql.transaction([
        directSql`SET LOCAL lock_timeout = '300ms'`,
        directSql`SAVEPOINT rain_cache_replay`,
        directSql(plantUpsert.text, plantUpsert.params ?? []),
        directSql(projectUpsert.text, projectUpsert.params ?? []),
        readBack(),
        directSql`ROLLBACK TO SAVEPOINT rain_cache_replay`,
      ])
      return out[4]
    } catch (e) {
      if (e?.code === '55P03' && attempt < 6) continue
      throw e
    }
  }
}

beforeAll(async () => {
  // The plant-arm fixtures live in a container of their own, so the container arm's fixtures below are
  // the only containers whose state this file varies.
  cHost = await container('host', 'live', { watered: false })
  pLive = await planting('live', cHost)
  pGone = await planting('gone', cHost, 'deleted')
  pOrphan = await planting('orphan', cHost, 'deleted')
  pArchived = await planting('archived', cHost, 'archived')
  cLive = await container('live')
  cGone = await container('gone', 'deleted')
  cOrphan = await container('orphan', 'deleted')
  cArchived = await container('archived', 'archived')
  // The orphan rows, committed now so the replay's transaction id is visible on any row it rewrites.
  await directSql`
    INSERT INTO entity_memory (plant_id, last_event_at, last_watered_at)
    VALUES (${pOrphan}, ${T0}::timestamptz, ${T0}::timestamptz)`
  await directSql`
    INSERT INTO entity_memory (project_id, last_event_at, last_watered_at)
    VALUES (${cOrphan}, ${T0}::timestamptz, ${T0}::timestamptz)`

  const cache = await sentCacheUpserts()
  plantUpsert = cache.find((s) => /entity_memory\s*\(\s*plant_id/i.test(s.text))
  projectUpsert = cache.find((s) => /entity_memory\s*\(\s*project_id/i.test(s.text))
  before = byKey(await readBack())
  if (cache.length === 2 && plantUpsert && projectUpsert) after = byKey(await replayRolledBack())
})

afterAll(async () => {
  assertFixtureId(USER)
  await settle('rain-cache-liveness', [
    () => directSql`DELETE FROM event_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
  ])
})

describe('logRainEvents cache upserts, as run() sends them, on real Postgres', () => {
  it('run() sent both cache upserts, one per arm, with nothing bound (so the replay is the statement verbatim)', () => {
    expect(plantUpsert, 'run() sent no plant-keyed upsert — logRainEvents was not reached').toBeTruthy()
    expect(projectUpsert, 'run() sent no container-keyed upsert').toBeTruthy()
    for (const s of [plantUpsert, projectUpsert]) expect(s.params ?? []).toEqual([])
    expect(after, 'the replay did not run').toBeTruthy()
  })

  it('PRECONDITION: only the two orphan rows exist before the replay', () => {
    expect(Object.keys(before).sort()).toEqual([pOrphan, cOrphan].sort())
    expect(ms(before[pOrphan].last_watered_at)).toBe(ms(T0))
    expect(ms(before[cOrphan].last_watered_at)).toBe(ms(T0))
  })

  it('CONTROL: a live planting and an archived one get a row at their watering (the plant arm writes)', () => {
    expect(ms(after[pLive]?.last_watered_at), 'the plant arm wrote no live planting').toBe(ms(TW))
    expect(ms(after[pArchived]?.last_watered_at), 'an archived planting lost its cache row (v4-cachemissingrow-001)').toBe(ms(TW))
  })

  it('CONTROL: a live container and an archived one get a row at their watering (the container arm writes)', () => {
    expect(ms(after[cLive]?.last_watered_at), 'the container arm wrote no live container').toBe(ms(TW))
    expect(ms(after[cArchived]?.last_watered_at), 'an archived container lost its cache row').toBe(ms(TW))
  })

  it('a soft-deleted planting and a soft-deleted container get no row', () => {
    expect(after[pGone], 'the plant arm created a row for a soft-deleted planting').toBeUndefined()
    expect(after[cGone], 'the container arm created a row for a soft-deleted container').toBeUndefined()
  })

  it('an orphan row on a soft-deleted planting or container is not rewritten', () => {
    for (const [key, what] of [[pOrphan, 'planting'], [cOrphan, 'container']]) {
      expect(after[key], `the ${what} orphan row disappeared`).toBeTruthy()
      expect(ms(after[key].last_watered_at), `the ${what} orphan row was moved forward`).toBe(ms(T0))
      expect(after[key].xmin, `the ${what} orphan row was written`).toBe(before[key].xmin)
    }
  })

  it('nothing was committed: the branch reads exactly as before the replay', async () => {
    const now = byKey(await readBack())
    expect(Object.keys(now).sort()).toEqual(Object.keys(before).sort())
    for (const key of Object.keys(before)) expect(now[key].xmin).toBe(before[key].xmin)
  })
})
