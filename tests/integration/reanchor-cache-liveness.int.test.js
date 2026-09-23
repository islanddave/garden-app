// tests/integration/reanchor-cache-liveness.int.test.js
// OPS-CACHEARCHIVEINTTEST-001 — BUG-CACHEORPHANREGRESS-001's events half on real Postgres.
//
// WHAT IS UNDER TEST. PUT /api/events/:id re-anchor block, the `if (newPlantId)` plant cache upsert
// (lambda/events/index.js). The route reaches an event whose planting was SOFT-DELETED — its container
// is live, so the ownership SELECT and the UPDATE both admit it — and the Deleted-Planting History Rule
// keeps such events live and editable (56 of them on 7 plantings on prod, 2026-09-23). A date edit that
// does not move the event makes that soft-deleted planting the upsert's own target. The upsert now reads
// the planting in its own FROM/WHERE (`gn.deleted_at IS NULL`), so for a soft-deleted planting it must
// create no row, and must leave an existing (orphan) row exactly as it was; the edit itself still saves.
//
// WHY THIS FILE EXISTS. lambda/events/reanchor-cache-liveness.test.js proves the statement's SHAPE on a
// model that drops every ::cast, and proves the route's JS answers 200 on stubbed rows — its stub hands
// back the same event row whatever the planting's state, so no soft-deleted planting is ever involved
// there. A cast Postgres refuses (`${newPlantId}::uuid` -> `::text` in the new WHERE: "operator does not
// exist: uuid = text") survived all 4538 unit tests (preship-qa E3/I3) and would 500 every cache-dirtying
// edit AFTER the event row had committed. reanchor-carecache.int.test.js runs this statement for LIVE
// and ARCHIVED plantings only. This file runs it for the soft-deleted arm, which is the fix.
//
// THE POSITIVE CONTROLS ARE LOAD-BEARING. A live and an archived planting get the identical edit and
// must have their rows recomputed to the new date. Without them, "no row" and "row unchanged" would also
// hold for a PUT that never sent the upsert at all (an edit the route did not treat as cache-dirty).
//
// "UNCHANGED" IS READ FROM xmin AS WELL AS THE VALUES: an ON CONFLICT DO UPDATE writes a new row version
// even when it writes the same values, and that write is what the filter exists to prevent.
//
// TEARDOWN ORDER as in reanchor-carecache.int.test.js: event_log.plant_id and entity_memory.plant_id are
// ON DELETE RESTRICT, and plants_entity_ins creates an entity row per planting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_cachelive_${RUN}`

const DAY = 24 * 3600 * 1000
const T0 = new Date(Date.now() - 40 * DAY).toISOString()  // the values seeded into the orphan row
const T1 = new Date(Date.now() - 20 * DAY).toISOString()  // every event is logged at T1
const T2 = new Date(Date.now() - 10 * DAY).toISOString()  // ...and edited to T2
const ms = (v) => (v == null ? null : new Date(v).getTime())

const post = (body) => callHandler(eventsHandler, { method: 'POST', path: '/api/events', body, userId: USER })
const put = (id, body) => callHandler(eventsHandler, { method: 'PUT', path: `/api/events/${id}`, body, userId: USER })
// The date edit under test: the planting is not moved (no plant_id), only the date, so the cache is
// dirty and the upsert's planting is the event's own.
const EDIT = { event_type: 'watering', event_date: T2 }

async function newPlanting(tag, project) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${`int-cachelive-${tag}-${RUN}`}, ${USER}) RETURNING id`
  return rows[0].id
}
async function newWatering(project, plant) {
  const res = await post({ project_id: project, plant_id: plant, event_type: 'watering', event_date: T1 })
  expect(res.status, `POST failed: ${JSON.stringify(res.body)}`).toBe(201)
  return res.body.id ?? res.body.eventId
}
// The planting's cache row as Postgres stores it, plus the id of the transaction that wrote it.
const cacheRow = async (plantId) => (await directSql`
  SELECT em.xmin::text AS xmin, to_jsonb(em) AS row FROM entity_memory em WHERE em.plant_id = ${plantId}`)[0] ?? null
const eventRow = async (id) => (await directSql`
  SELECT event_date, plant_id, project_id, deleted_at FROM event_log WHERE id = ${id}`)[0]

let project
let pGone, pOrphan, pLive, pArchived
let eGone, eOrphan, eLive, eArchived

beforeAll(async () => {
  setTestUserId(USER)
  project = (await insertProject({ name: `int-cachelive-${RUN}`, createdBy: USER })).id
  pGone = await newPlanting('gone', project)      // soft-deleted, no cache row
  pOrphan = await newPlanting('orphan', project)  // soft-deleted, carrying an orphan cache row
  pLive = await newPlanting('live', project)      // control
  pArchived = await newPlanting('archived', project)  // control: archived keeps its row
  // Logged while every planting is live, through the deployed POST, which writes each one's cache row.
  eGone = await newWatering(project, pGone)
  eOrphan = await newWatering(project, pOrphan)
  eLive = await newWatering(project, pLive)
  eArchived = await newWatering(project, pArchived)
  // Soft-delete through the deployed route, which takes the cache row with it in the same statement
  // (BUG-CACHEORPHANLEAK-001) and leaves the events live (Deleted-Planting History Rule).
  for (const id of [pGone, pOrphan]) {
    const del = await callHandler(plantsHandler, { method: 'DELETE', path: `/api/plants/${id}`, userId: USER })
    expect(del.status, `DELETE planting failed: ${JSON.stringify(del.body)}`).toBe(200)
  }
  // The prod orphan shape (migrations/v5-cacheorphan-001): a cache row on a soft-deleted planting,
  // written by something other than the route that deleted it. Values chosen to differ from anything a
  // recompute of this planting's events could produce.
  await directSql`
    INSERT INTO entity_memory (plant_id, last_event_at, last_watered_at)
    VALUES (${pOrphan}, ${T0}::timestamptz, ${T0}::timestamptz)`
  await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${pArchived}`
})

afterAll(async () => {
  assertFixtureId(USER)
  await settle('reanchor-cache-liveness', [
    () => directSql`DELETE FROM xp_events WHERE user_id = ${USER}`,
    () => directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`,
    () => directSql`DELETE FROM user_stats WHERE user_id = ${USER}`,
    () => directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`,
    () => directSql`DELETE FROM event_log WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plants WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
  ])
})

describe('PUT /api/events/:id on an event whose planting is SOFT-DELETED (container live)', () => {
  it('PRECONDITION: two soft-deleted plantings with live events, one without a cache row and one carrying an orphan row', async () => {
    for (const id of [pGone, pOrphan]) {
      expect((await directSql`SELECT deleted_at FROM plants WHERE id = ${id}`)[0].deleted_at).not.toBeNull()
    }
    for (const id of [eGone, eOrphan]) expect((await eventRow(id)).deleted_at, 'the soft-delete took the event with it').toBeNull()
    expect(await cacheRow(pGone), 'the planting DELETE left its cache row').toBeNull()
    expect(ms((await cacheRow(pOrphan)).row.last_watered_at)).toBe(ms(T0))
    // And the controls start where the POST put them.
    expect(ms((await cacheRow(pLive)).row.last_watered_at)).toBe(ms(T1))
    expect(ms((await cacheRow(pArchived)).row.last_watered_at)).toBe(ms(T1))
  })

  it('CONTROL: the same date edit on a LIVE planting recomputes its row to the new date', async () => {
    const res = await put(eLive, EDIT)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const c = await cacheRow(pLive)
    expect(ms(c.row.last_watered_at), 'the upsert did not run for a live planting').toBe(ms(T2))
    expect(ms(c.row.last_event_at)).toBe(ms(T2))
  })

  it('the edit saves: 200, and the event row carries the new date', async () => {
    const res = await put(eGone, EDIT)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.id).toBe(eGone)
    expect(ms(res.body.event_date)).toBe(ms(T2))
    const ev = await eventRow(eGone)
    expect(ms(ev.event_date), 'the read-back, not the echo').toBe(ms(T2))
    expect(ev.plant_id, 'the edit moved the event off its planting').toBe(pGone)
  })

  it('no entity_memory row is created for the soft-deleted planting', async () => {
    expect(await cacheRow(pGone), 'the edit wrote a cache row for a soft-deleted planting').toBeNull()
  })

  it('an orphan row already on a soft-deleted planting is left byte-identical — not updated', async () => {
    const before = await cacheRow(pOrphan)
    const res = await put(eOrphan, EDIT)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(ms((await eventRow(eOrphan)).event_date)).toBe(ms(T2))
    const after = await cacheRow(pOrphan)
    expect(after, 'the orphan row was deleted').not.toBeNull()
    expect(after.row, 'the orphan row was rewritten').toEqual(before.row)
    expect(after.xmin, 'the orphan row was written (a new row version)').toBe(before.xmin)
  })

  it('CONTROL: an ARCHIVED planting keeps its row and it is recomputed — the filter is deleted_at only', async () => {
    const res = await put(eArchived, EDIT)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const c = await cacheRow(pArchived)
    expect(c, 'an archived planting lost its cache row (v4-cachemissingrow-001)').not.toBeNull()
    expect(ms(c.row.last_watered_at), 'an archived planting was treated as deleted').toBe(ms(T2))
  })
})
